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

export interface HeadlessReport {
  schemaVersion: number;
  generatedAt: string;
  seed: number;
  configuration: {
    trialsPerDroneCondition: number;
    localizationTrialsPerJitterLevel: number;
    distancesM: number[];
    attenuationModel: string;
  };
  caveats: string[];
  models?: DetectorModelStatistic[];
  failures?: FailureStatistic[];
  realSamples: Array<{
    file: string;
    expected: string;
    detected: boolean;
    top1: string;
    correct: boolean;
    confidence: number;
  }>;
  detection: DetectionStatistic[];
  falseAlarms: FalseAlarmStatistic[];
  localization: LocalizationStatistic[];
}

export interface DetectorModelStatistic {
  id: "dsp-v1" | "ml-onnx-v1";
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
