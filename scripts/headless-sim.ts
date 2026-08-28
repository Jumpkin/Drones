import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BENCHMARK_ENVIRONMENTS,
  HARD_NEGATIVE_KINDS,
  makeDroneObservation,
  makeHardNegative,
  mulberry32,
} from "../src/benchmark-audio";
import { analyzePcm } from "../src/detector";
import { analyzeWithArtifact, binaryMetrics, type BinaryMetrics, type MlModelArtifact } from "../src/ml/model";
import {
  distance,
  localizeGrid,
  simulateArrivals,
  type ArrivalObservation,
  type ListenerNode,
  type Point2D,
} from "../src/localization";
import { DRONE_PROFILES, type DroneProfileId } from "../src/sim";

interface DetectionRow {
  detectorId: "dsp-v1" | "ml-onnx-v1";
  detectorLabel: string;
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
  medianLatencyMs: number;
}

interface FalseAlarmRow {
  detectorId: "dsp-v1" | "ml-onnx-v1";
  detectorLabel: string;
  environment: string;
  ambientRms: number;
  trials: number;
  falseDetections: number;
  falsePositiveRate: number;
  meanConfidence: number;
  medianLatencyMs: number;
}

interface Observation {
  id: string;
  detectorId: "dsp-v1" | "ml-onnx-v1";
  truth: boolean;
  detected: boolean;
  probability: number;
  environment: string;
  distanceM: number | null;
  sourceLabel: string;
  license: string;
}

interface LocalizationRow {
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

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE_RATE = 16_000;
const DURATION_S = 3;
const DISTANCES_M = [25, 50, 100, 200, 400];
const PROFILES = Object.keys(DRONE_PROFILES) as DroneProfileId[];

function argumentNumber(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return Math.floor(value);
}

function argumentString(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

function gaussian(random: () => number): number {
  const a = Math.max(Number.EPSILON, random());
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * random());
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

function angularDifference(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function timed<T>(callback: () => T): { value: T; elapsedMs: number } {
  const started = performance.now();
  const value = callback();
  return { value, elapsedMs: performance.now() - started };
}

function runDetectionBenchmark(
  trials: number,
  random: () => number,
  artifact: MlModelArtifact,
): { detection: DetectionRow[]; falseAlarms: FalseAlarmRow[]; observations: Observation[] } {
  const detection: DetectionRow[] = [];
  const observations: Observation[] = [];
  for (const profile of PROFILES) {
    for (const distanceM of DISTANCES_M) {
      for (const environment of BENCHMARK_ENVIRONMENTS) {
        const accumulators = new Map<"dsp-v1" | "ml-onnx-v1", {
          label: string;
          detected: number;
          correct: number;
          confidences: number[];
          latencies: number[];
        }>([
          ["dsp-v1", { label: "FFT / harmonik DSP", detected: 0, correct: 0, confidences: [] as number[], latencies: [] as number[] }],
          ["ml-onnx-v1", { label: "Feature Conv ML", detected: 0, correct: 0, confidences: [] as number[], latencies: [] as number[] }],
        ]);
        for (let trial = 0; trial < trials; trial += 1) {
          const samples = makeDroneObservation(profile, DURATION_S, SAMPLE_RATE, distanceM, environment, random);
          const dspTimed = timed(() => analyzePcm(samples, SAMPLE_RATE));
          const mlTimed = timed(() => analyzeWithArtifact(samples, SAMPLE_RATE, artifact));
          const outcomes = [
            { id: "dsp-v1" as const, detected: dspTimed.value.detected, probability: dspTimed.value.confidence, latency: dspTimed.elapsedMs },
            { id: "ml-onnx-v1" as const, detected: mlTimed.value.detected, probability: mlTimed.value.confidence, latency: mlTimed.elapsedMs },
          ];
          for (const outcome of outcomes) {
            const accumulator = accumulators.get(outcome.id)!;
            if (outcome.detected) accumulator.detected += 1;
            if (outcome.detected && dspTimed.value.classifications[0]?.profile === profile) accumulator.correct += 1;
            accumulator.confidences.push(outcome.probability);
            accumulator.latencies.push(outcome.latency);
            observations.push({
              id: `${outcome.id}-${profile}-${distanceM}-${environment.id}-${trial}`,
              detectorId: outcome.id,
              truth: true,
              detected: outcome.detected,
              probability: outcome.probability,
              environment: environment.id,
              distanceM,
              sourceLabel: DRONE_PROFILES[profile].label,
              license: "Projektgenererad",
            });
          }
        }
        for (const [detectorId, accumulator] of accumulators) {
          detection.push({
            detectorId,
            detectorLabel: accumulator.label,
            profile,
            label: DRONE_PROFILES[profile].label,
            distanceM,
            environment: environment.id,
            ambientRms: environment.ambientRms,
            trials,
            detected: accumulator.detected,
            correctTop1: accumulator.correct,
            detectionRate: round(rate(accumulator.detected, trials)),
            top1Accuracy: round(rate(accumulator.correct, trials)),
            accuracyWhenDetected: round(rate(accumulator.correct, accumulator.detected)),
            meanConfidence: round(mean(accumulator.confidences)),
            medianLatencyMs: round(percentile(accumulator.latencies, 0.5), 2),
          });
        }
      }
    }
  }

  const falseAlarms: FalseAlarmRow[] = [];
  for (const environment of BENCHMARK_ENVIRONMENTS) {
    const ambientTrials = trials * PROFILES.length;
    const accumulators = new Map<"dsp-v1" | "ml-onnx-v1", {
      label: string;
      falseDetections: number;
      confidences: number[];
      latencies: number[];
    }>([
      ["dsp-v1", { label: "FFT / harmonik DSP", falseDetections: 0, confidences: [] as number[], latencies: [] as number[] }],
      ["ml-onnx-v1", { label: "Feature Conv ML", falseDetections: 0, confidences: [] as number[], latencies: [] as number[] }],
    ]);
    for (let trial = 0; trial < ambientTrials; trial += 1) {
      const kind = HARD_NEGATIVE_KINDS[trial % HARD_NEGATIVE_KINDS.length];
      const samples = makeHardNegative(kind, DURATION_S, SAMPLE_RATE, environment, random);
      const dspTimed = timed(() => analyzePcm(samples, SAMPLE_RATE));
      const mlTimed = timed(() => analyzeWithArtifact(samples, SAMPLE_RATE, artifact));
      for (const outcome of [
        { id: "dsp-v1" as const, detected: dspTimed.value.detected, probability: dspTimed.value.confidence, latency: dspTimed.elapsedMs },
        { id: "ml-onnx-v1" as const, detected: mlTimed.value.detected, probability: mlTimed.value.confidence, latency: mlTimed.elapsedMs },
      ]) {
        const accumulator = accumulators.get(outcome.id)!;
        if (outcome.detected) accumulator.falseDetections += 1;
        accumulator.confidences.push(outcome.probability);
        accumulator.latencies.push(outcome.latency);
        observations.push({
          id: `${outcome.id}-negative-${environment.id}-${trial}`,
          detectorId: outcome.id,
          truth: false,
          detected: outcome.detected,
          probability: outcome.probability,
          environment: environment.id,
          distanceM: null,
          sourceLabel: kind,
          license: "Projektgenererad",
        });
      }
    }
    for (const [detectorId, accumulator] of accumulators) {
      falseAlarms.push({
        detectorId,
        detectorLabel: accumulator.label,
        environment: environment.id,
        ambientRms: environment.ambientRms,
        trials: ambientTrials,
        falseDetections: accumulator.falseDetections,
        falsePositiveRate: round(rate(accumulator.falseDetections, ambientTrials)),
        meanConfidence: round(mean(accumulator.confidences)),
        medianLatencyMs: round(percentile(accumulator.latencies, 0.5), 2),
      });
    }
  }
  return { detection, falseAlarms, observations };
}

function metricsFor(observations: Observation[], threshold?: number): BinaryMetrics {
  return binaryMetrics(
    observations.map((item) => item.truth),
    observations.map((item) => threshold === undefined ? item.detected : item.probability >= threshold),
  );
}

function curveFor(observations: Observation[]): Array<{ threshold: number; precision: number; recall: number; falsePositiveRate: number }> {
  const curve = [];
  for (let threshold = 0; threshold <= 1.001; threshold += 0.025) {
    const metrics = metricsFor(observations, threshold);
    curve.push({
      threshold: round(threshold, 3),
      precision: round(metrics.precision),
      recall: round(metrics.recall),
      falsePositiveRate: round(metrics.falsePositiveRate),
    });
  }
  return curve;
}

function areaUnderCurve(points: Array<{ x: number; y: number }>): number {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  let area = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    area += (sorted[index].x - sorted[index - 1].x) * (sorted[index].y + sorted[index - 1].y) / 2;
  }
  return round(Math.abs(area));
}

function modelReport(
  detectorId: "dsp-v1" | "ml-onnx-v1",
  observations: Observation[],
  detection: DetectionRow[],
  falseAlarms: FalseAlarmRow[],
  artifact: MlModelArtifact,
): Record<string, unknown> {
  const selected = observations.filter((item) => item.detectorId === detectorId);
  const curve = curveFor(selected);
  return {
    id: detectorId,
    label: detectorId === "dsp-v1" ? "FFT / harmonik DSP" : "Feature Conv ML",
    version: "1.0.0",
    threshold: detectorId === "dsp-v1" ? 0.42 : artifact.threshold,
    isDefault: detectorId === "ml-onnx-v1" ? artifact.qualityGate.passed : !artifact.qualityGate.passed,
    qualityGate: detectorId === "ml-onnx-v1" ? artifact.qualityGate : null,
    overall: metricsFor(selected),
    prAuc: areaUnderCurve(curve.map((point) => ({ x: point.recall, y: point.precision }))),
    rocAuc: areaUnderCurve(curve.map((point) => ({ x: point.falsePositiveRate, y: point.recall }))),
    brierScore: round(mean(selected.map((item) => (item.probability - Number(item.truth)) ** 2))),
    curve,
    detection: detection.filter((row) => row.detectorId === detectorId),
    falseAlarms: falseAlarms.filter((row) => row.detectorId === detectorId),
  };
}

function runLocalizationBenchmark(trials: number, random: () => number): LocalizationRow[] {
  const bounds = { width: 700, height: 440 };
  const positions: Point2D[] = [{ x: 80, y: 80 }, { x: 610, y: 90 }, { x: 270, y: 360 }];
  return [0.02, 0.1, 0.5, 2].map((timingJitterMs) => {
    const errors: number[] = [];
    const bearingErrors: number[] = [];
    const residuals: number[] = [];
    for (let trial = 0; trial < trials; trial += 1) {
      const listeners: ListenerNode[] = positions.map((position, index) => ({
        id: `P${index + 1}`,
        position,
        clockOffsetMs: -8 + random() * 16,
        clockDriftPpm: -40 + random() * 80,
      }));
      const source = { x: 100 + random() * 500, y: 80 + random() * 270 };
      const noisy: ArrivalObservation[] = simulateArrivals(listeners, source).map((observation) => ({
        ...observation,
        calibratedArrivalS: observation.calibratedArrivalS + gaussian(random) * timingJitterMs / 1000,
      }));
      const localized = localizeGrid(listeners, noisy, bounds);
      const centroid = positions.reduce(
        (sum, position) => ({ x: sum.x + position.x / 3, y: sum.y + position.y / 3 }),
        { x: 0, y: 0 },
      );
      const trueBearing = Math.atan2(source.y - centroid.y, source.x - centroid.x) * 180 / Math.PI;
      const estimatedBearing = Math.atan2(localized.position.y - centroid.y, localized.position.x - centroid.x) * 180 / Math.PI;
      errors.push(distance(localized.position, source));
      bearingErrors.push(angularDifference(trueBearing, estimatedBearing));
      residuals.push(localized.residualMs);
    }
    return {
      timingJitterMs,
      trials,
      medianErrorM: round(percentile(errors, 0.5), 2),
      p90ErrorM: round(percentile(errors, 0.9), 2),
      medianBearingErrorDeg: round(percentile(bearingErrors, 0.5), 2),
      p90BearingErrorDeg: round(percentile(bearingErrors, 0.9), 2),
      within5MRate: round(rate(errors.filter((value) => value <= 5).length, trials)),
      within10MRate: round(rate(errors.filter((value) => value <= 10).length, trials)),
      medianResidualMs: round(percentile(residuals, 0.5), 3),
    };
  });
}

function decodePcm16Wav(buffer: Buffer): { samples: Float32Array; sampleRate: number } {
  let offset = 12;
  let format: { channels: number; sampleRate: number; bits: number } | undefined;
  let dataOffset = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (buffer.readUInt16LE(body) !== 1) throw new Error("Only PCM WAV is supported");
      format = { channels: buffer.readUInt16LE(body + 2), sampleRate: buffer.readUInt32LE(body + 4), bits: buffer.readUInt16LE(body + 14) };
    } else if (id === "data") {
      dataOffset = body;
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format || format.bits !== 16 || dataSize === 0) throw new Error("Invalid PCM16 WAV");
  const frames = Math.floor(dataSize / (format.channels * 2));
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < format.channels; channel += 1) {
      samples[frame] += buffer.readInt16LE(dataOffset + (frame * format.channels + channel) * 2) / 32768 / format.channels;
    }
  }
  return { samples, sampleRate: format.sampleRate };
}

async function runRealSamples(artifact: MlModelArtifact): Promise<Array<Record<string, unknown>>> {
  const fixtures: Array<{ file: string; expected: DroneProfileId | "ambient" }> = [
    { file: "batear-fpv-5inch.wav", expected: "fpv" },
    { file: "batear-mavic-pro.wav", expected: "camera" },
    { file: "batear-mini-4-pro.wav", expected: "camera" },
    { file: "batear-rural-8s.wav", expected: "ambient" },
  ];
  const rows: Array<Record<string, unknown>> = [];
  for (const fixture of fixtures) {
    const wav = decodePcm16Wav(await readFile(path.join(PROJECT_ROOT, "public/audio", fixture.file)));
    const samples = wav.samples.slice(0, wav.sampleRate * 8);
    const dsp = analyzePcm(samples, wav.sampleRate);
    const ml = analyzeWithArtifact(samples, wav.sampleRate, artifact);
    for (const outcome of [
      { detectorId: "dsp-v1", detected: dsp.detected, confidence: dsp.confidence },
      { detectorId: "ml-onnx-v1", detected: ml.detected, confidence: ml.confidence },
    ]) {
      const expectedDrone = fixture.expected !== "ambient";
      rows.push({
        file: fixture.file,
        expected: fixture.expected,
        detectorId: outcome.detectorId,
        detected: outcome.detected,
        correctBinary: outcome.detected === expectedDrone,
        confidence: round(outcome.confidence),
      });
    }
  }
  return rows;
}

function csv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const cell = (value: unknown): string => {
    const text = String(value ?? "");
    return /[\n,"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => cell(row[column])).join(",")).join("\n")}\n`;
}

async function main(): Promise<void> {
  const trials = argumentNumber("--trials", 15);
  const localizationTrials = argumentNumber("--localization-trials", 300);
  const seed = argumentNumber("--seed", 20260828);
  const reportDirectory = path.resolve(PROJECT_ROOT, argumentString("--out", "public/reports/headless"));
  const artifact = JSON.parse(
    await readFile(path.join(PROJECT_ROOT, "public/models/drone-binary-v1.json"), "utf8"),
  ) as MlModelArtifact;
  const random = mulberry32(seed);
  const detector = runDetectionBenchmark(trials, random, artifact);
  const localization = runLocalizationBenchmark(localizationTrials, random);
  const realSamples = await runRealSamples(artifact);
  const models = (["dsp-v1", "ml-onnx-v1"] as const).map((id) => modelReport(
    id,
    detector.observations,
    detector.detection,
    detector.falseAlarms,
    artifact,
  ));
  const failures = detector.observations.filter((item) => item.truth !== item.detected)
    .sort((a, b) => Math.abs(b.probability - 0.5) - Math.abs(a.probability - 0.5))
    .slice(0, 40)
    .map((item) => ({ ...item, failureKind: item.truth ? "false-negative" : "false-positive" }));
  const summary = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    seed,
    configuration: {
      sampleRate: SAMPLE_RATE,
      clipDurationS: DURATION_S,
      trialsPerDroneCondition: trials,
      localizationTrialsPerJitterLevel: localizationTrials,
      distancesM: DISTANCES_M,
      environments: BENCHMARK_ENVIRONMENTS,
      attenuationModel: "free-field 1/r, reference gain 0.72 at 25 m",
      splitPolicy: "grouped by source recording/session; 70/15/15",
    },
    caveats: [
      "Synthetic results are regression benchmarks, not validated field range.",
      "The ML quality gate currently uses synthetic grouped sessions and is not field certification.",
      "Distance uses assumed source gain rather than calibrated SPL data.",
      "Localization omits reverberation and multipath.",
      "Three coplanar listeners estimate 2D only; altitude remains unknown.",
      "Reports contain aggregate metrics and failure metadata only, never raw audio.",
    ],
    models,
    failures,
    realSamples,
    localization,
    detection: detector.detection.filter((row) => row.detectorId === "dsp-v1"),
    falseAlarms: detector.falseAlarms.filter((row) => row.detectorId === "dsp-v1"),
  };
  await mkdir(reportDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(reportDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`),
    writeFile(path.join(reportDirectory, "detection.csv"), csv(detector.detection as unknown as Array<Record<string, unknown>>)),
    writeFile(path.join(reportDirectory, "false-alarms.csv"), csv(detector.falseAlarms as unknown as Array<Record<string, unknown>>)),
    writeFile(path.join(reportDirectory, "localization.csv"), csv(localization as unknown as Array<Record<string, unknown>>)),
    writeFile(path.join(reportDirectory, "failures.csv"), csv(failures as unknown as Array<Record<string, unknown>>)),
  ]);
  console.log(JSON.stringify({
    seed,
    models: models.map((model) => ({ id: model.id, isDefault: model.isDefault, overall: model.overall })),
    realSamples,
    reports: reportDirectory,
  }, null, 2));
}

await main();
