import type { DroneProfileId } from "./sim";

export interface DetectionStatistic {
  detectorId?: string;
  detectorLabel?: string;
  profile: DroneProfileId;
  label: string;
  distanceM: number;
  environment: string;
  ambientRms: number;
  trials: number;
  detected: number;
  correctTop1: number;
  detectionRate: number;
  top1Accuracy: number;
  accuracyWhenDetected: number;
  meanConfidence: number;
  classificationMethod?: "dsp" | "ml-detection+dsp-type";
}

export interface FalseAlarmStatistic {
  detectorId?: string;
  detectorLabel?: string;
  environment: string;
  ambientRms: number;
  trials: number;
  falseDetections: number;
  falsePositiveRate: number;
  meanConfidence: number;
}

export interface LocalizationStatistic {
  timingJitterMs: number;
  trials: number;
  medianErrorM: number;
  p90ErrorM: number;
  medianBearingErrorDeg: number;
  p90BearingErrorDeg: number;
  within5MRate: number;
  within10MRate: number;
  medianResidualMs: number;
}

export interface PhonePlaybackStatistic {
  detectorId: "dsp-v1" | "ml-onnx-v1" | "crnn-pretrained-v1";
  phoneId: string;
  phoneLabel: string;
  roomId: string;
  roomLabel: string;
  trialsPerClass: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  precision: number;
  recall: number;
  falsePositiveRate: number;
  f1: number;
  accuracy: number;
  meanConfidence: number;
}

export interface HeadlessReport {
  schemaVersion: number;
  generatedAt: string;
  seed: number;
  configuration: {
    trialsPerDroneCondition: number;
    localizationTrialsPerJitterLevel: number;
    phoneTrialsPerProfile?: number;
    distancesM: number[];
    attenuationModel: string;
    trainingDomain?: string;
    benchmarkDomain?: string;
    reportTimestampPolicy?: string;
    componentSeeds?: {
      detection: number;
      phonePlayback: number;
      localization: number;
    };
    phoneAudioProfiles?: Array<{
      id: string;
      label: string;
      highPassHz: number;
      lowPassHz: number;
      drive: number;
      selfNoiseRms: number;
    }>;
    playbackRoomProfiles?: Array<{
      id: string;
      label: string;
      distanceM: number;
      echoDelayMs: number;
      echoGain: number;
    }>;
    externalModels?: Array<{
      id: string;
      source: string;
      revision: string;
      license: string;
      modelSha256: string;
    }>;
  };
  caveats: string[];
  models?: DetectorModelStatistic[];
  failures?: FailureStatistic[];
  realSamples: Array<{
    file: string;
    expected: string;
    detectorId: string;
    detected: boolean;
    correctBinary: boolean;
    confidence: number;
  }>;
  phonePlayback?: PhonePlaybackStatistic[];
  detection: DetectionStatistic[];
  falseAlarms: FalseAlarmStatistic[];
  localization: LocalizationStatistic[];
}

export interface DetectorModelStatistic {
  id: "dsp-v1" | "ml-onnx-v1" | "crnn-pretrained-v1";
  label: string;
  version: string;
  threshold: number;
  isDefault: boolean;
  qualityGate: null | {
    maximumFalsePositiveRate: number;
    minimumRecall: number;
    beatsDspF1: boolean;
    passed: boolean;
  };
  overall: {
    truePositive: number;
    falsePositive: number;
    trueNegative: number;
    falseNegative: number;
    precision: number;
    recall: number;
    falsePositiveRate: number;
    f1: number;
    accuracy: number;
  };
  prAuc: number;
  rocAuc: number;
  brierScore: number;
  curve: Array<{
    threshold: number;
    precision: number;
    recall: number;
    falsePositiveRate: number;
  }>;
  detection: DetectionStatistic[];
  falseAlarms: FalseAlarmStatistic[];
}

export interface FailureStatistic {
  id: string;
  detectorId: string;
  truth: boolean;
  detected: boolean;
  probability: number;
  environment: string;
  distanceM: number | null;
  sourceLabel: string;
  license: string;
  failureKind: "false-positive" | "false-negative";
}

export type DetectionMetric = "detectionRate" | "top1Accuracy";

export interface BenchmarkCounts {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
}

export interface BenchmarkModelResult extends BenchmarkCounts {
  id: string;
  label: string;
  threshold: number | null;
  relationship: string;
}

export interface BenchmarkRun {
  id: string;
  label: string;
  domain: string;
  evidenceClass: "synthetic" | "phone-proxy" | "source-domain" | "external-fixture";
  positiveTests: number;
  negativeTests: number;
  totalTests: number;
  models: BenchmarkModelResult[];
  caveat: string;
}

export interface BenchmarkRunReport {
  schemaVersion: number;
  generatedAt: string;
  winnerRule: string;
  recommendation: string;
  caveats: string[];
  runs: BenchmarkRun[];
}

export interface DerivedBenchmarkMetrics {
  positiveTests: number;
  negativeTests: number;
  totalTests: number;
  precision: number | null;
  recall: number | null;
  falsePositiveRate: number | null;
  f1: number | null;
  accuracy: number | null;
}

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

export function benchmarkMetrics(counts: BenchmarkCounts): DerivedBenchmarkMetrics {
  assertCount("truePositive", counts.truePositive);
  assertCount("falsePositive", counts.falsePositive);
  assertCount("trueNegative", counts.trueNegative);
  assertCount("falseNegative", counts.falseNegative);
  const positiveTests = counts.truePositive + counts.falseNegative;
  const negativeTests = counts.falsePositive + counts.trueNegative;
  const totalTests = positiveTests + negativeTests;
  const predictedPositive = counts.truePositive + counts.falsePositive;
  const precision = predictedPositive > 0 ? counts.truePositive / predictedPositive : null;
  const recall = positiveTests > 0 ? counts.truePositive / positiveTests : null;
  const falsePositiveRate = negativeTests > 0 ? counts.falsePositive / negativeTests : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? 2 * precision * recall / (precision + recall)
    : precision === 0 || recall === 0 ? 0 : null;
  return {
    positiveTests,
    negativeTests,
    totalTests,
    precision,
    recall,
    falsePositiveRate,
    f1,
    accuracy: totalTests > 0 ? (counts.truePositive + counts.trueNegative) / totalTests : null,
  };
}

export function benchmarkWinners(run: BenchmarkRun): string[] {
  const scored = run.models
    .map((model) => ({ id: model.id, f1: benchmarkMetrics(model).f1 }))
    .filter((item): item is { id: string; f1: number } => item.f1 !== null);
  const best = Math.max(-Infinity, ...scored.map((item) => item.f1));
  return scored.filter((item) => Math.abs(item.f1 - best) <= 1e-12).map((item) => item.id);
}

export function validateBenchmarkReport(report: BenchmarkRunReport): BenchmarkRunReport {
  if (report.schemaVersion !== 1 || !Array.isArray(report.runs)) {
    throw new Error("Unsupported benchmark-run report");
  }
  const runIds = new Set<string>();
  for (const run of report.runs) {
    if (!run.id || runIds.has(run.id)) throw new Error(`Duplicate or missing benchmark run id: ${run.id}`);
    runIds.add(run.id);
    assertCount(`${run.id}.positiveTests`, run.positiveTests);
    assertCount(`${run.id}.negativeTests`, run.negativeTests);
    assertCount(`${run.id}.totalTests`, run.totalTests);
    if (run.totalTests !== run.positiveTests + run.negativeTests) {
      throw new Error(`${run.id} has inconsistent test totals`);
    }
    if (!Array.isArray(run.models) || run.models.length === 0) {
      throw new Error(`${run.id} has no model results`);
    }
    const modelIds = new Set<string>();
    for (const model of run.models) {
      if (!model.id || modelIds.has(model.id)) throw new Error(`${run.id} has a duplicate or missing model id`);
      modelIds.add(model.id);
      const metrics = benchmarkMetrics(model);
      if (metrics.positiveTests !== run.positiveTests || metrics.negativeTests !== run.negativeTests || metrics.totalTests !== run.totalTests) {
        throw new Error(`${run.id}/${model.id} does not match the run test totals`);
      }
    }
  }
  return report;
}

export function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

export function rowsForEnvironment(
  report: HeadlessReport,
  environment: string,
  detectorId = "dsp-v1",
): DetectionStatistic[] {
  const rows = report.models?.find((model) => model.id === detectorId)?.detection ?? report.detection;
  return rows.filter((row) => row.environment === environment);
}

export function compareProfiles(
  report: HeadlessReport,
  environment: string,
  metric: DetectionMetric,
  detectorId = "dsp-v1",
): Array<{ profile: DroneProfileId; label: string; average: number }> {
  const rows = rowsForEnvironment(report, environment, detectorId);
  const profileIds = [...new Set(rows.map((row) => row.profile))];
  return profileIds.map((profile) => {
    const profileRows = rows.filter((row) => row.profile === profile);
    return {
      profile,
      label: profileRows[0]?.label ?? profile,
      average: mean(profileRows.map((row) => row[metric])),
    };
  }).sort((a, b) => b.average - a.average);
}

export function modelFor(report: HeadlessReport, detectorId: string): DetectorModelStatistic | undefined {
  return report.models?.find((model) => model.id === detectorId);
}
