import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateDronePcm } from "../src/audio";
import { analyzePcm } from "../src/detector";
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

interface FalseAlarmRow {
  environment: string;
  ambientRms: number;
  trials: number;
  falseDetections: number;
  falsePositiveRate: number;
  meanConfidence: number;
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

interface Environment {
  id: string;
  ambientRms: number;
  machineryAmplitude: number;
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE_RATE = 16_000;
const DURATION_S = 1.6;
const DISTANCES_M = [25, 50, 100, 200, 400];
const PROFILES = Object.keys(DRONE_PROFILES) as DroneProfileId[];
const ENVIRONMENTS: Environment[] = [
  { id: "quiet", ambientRms: 0.02, machineryAmplitude: 0 },
  { id: "urban", ambientRms: 0.05, machineryAmplitude: 0.018 },
  { id: "loud-structured", ambientRms: 0.1, machineryAmplitude: 0.05 },
];

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

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
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

function makeAmbient(length: number, environment: Environment, random: () => number): Float32Array {
  const output = new Float32Array(length);
  const machineryFundamental = 105 + random() * 85;
  const machineryPhase = random() * Math.PI * 2;
  for (let index = 0; index < length; index += 1) {
    const time = index / SAMPLE_RATE;
    let machinery = 0;
    for (let harmonic = 1; harmonic <= 3; harmonic += 1) {
      machinery += Math.sin(2 * Math.PI * machineryFundamental * harmonic * time + machineryPhase) *
        environment.machineryAmplitude / harmonic;
    }
    output[index] = Math.max(-1, Math.min(1,
      gaussian(random) * environment.ambientRms +
      Math.sin(2 * Math.PI * 57 * time) * environment.ambientRms * 0.22 +
      machinery,
    ));
  }
  return output;
}

function makeDroneObservation(
  profile: DroneProfileId,
  distanceM: number,
  environment: Environment,
  random: () => number,
): Float32Array {
  const drone = generateDronePcm(
    profile,
    DURATION_S,
    SAMPLE_RATE,
    -20 + random() * 40,
    0,
  );
  const observation = makeAmbient(drone.length, environment, random);
  // Förenklad fri-fältsmodell. Referensnivån är ett antagande, inte kalibrerad SPL.
  const gain = Math.min(1, 0.72 * 25 / Math.max(1, distanceM)) * (0.75 + random() * 0.5);
  for (let index = 0; index < observation.length; index += 1) {
    observation[index] = Math.max(-1, Math.min(1, observation[index] + drone[index] * gain));
  }
  return observation;
}

function runDetectionBenchmark(trials: number, random: () => number): {
  detection: DetectionRow[];
  falseAlarms: FalseAlarmRow[];
} {
  const detection: DetectionRow[] = [];
  for (const profile of PROFILES) {
    for (const distanceM of DISTANCES_M) {
      for (const environment of ENVIRONMENTS) {
        let detected = 0;
        let correctTop1 = 0;
        const confidences: number[] = [];
        for (let trial = 0; trial < trials; trial += 1) {
          const result = analyzePcm(
            makeDroneObservation(profile, distanceM, environment, random),
            SAMPLE_RATE,
          );
          if (result.detected) detected += 1;
          if (result.detected && result.classifications[0]?.profile === profile) correctTop1 += 1;
          confidences.push(result.confidence);
        }
        detection.push({
          profile,
          label: DRONE_PROFILES[profile].label,
          distanceM,
          environment: environment.id,
          ambientRms: environment.ambientRms,
          trials,
          detected,
          correctTop1,
          detectionRate: round(rate(detected, trials)),
          top1Accuracy: round(rate(correctTop1, trials)),
          accuracyWhenDetected: round(rate(correctTop1, detected)),
          meanConfidence: round(mean(confidences)),
        });
      }
    }
  }

  const falseAlarms = ENVIRONMENTS.map((environment): FalseAlarmRow => {
    const ambientTrials = trials * PROFILES.length;
    let falseDetections = 0;
    const confidences: number[] = [];
    for (let trial = 0; trial < ambientTrials; trial += 1) {
      const result = analyzePcm(
        makeAmbient(Math.round(DURATION_S * SAMPLE_RATE), environment, random),
        SAMPLE_RATE,
      );
      if (result.detected) falseDetections += 1;
      confidences.push(result.confidence);
    }
    return {
      environment: environment.id,
      ambientRms: environment.ambientRms,
      trials: ambientTrials,
      falseDetections,
      falsePositiveRate: round(rate(falseDetections, ambientTrials)),
      meanConfidence: round(mean(confidences)),
    };
  });
  return { detection, falseAlarms };
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
      const estimatedBearing = Math.atan2(
        localized.position.y - centroid.y,
        localized.position.x - centroid.x,
      ) * 180 / Math.PI;
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
      format = {
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
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
      samples[frame] += buffer.readInt16LE(dataOffset + (frame * format.channels + channel) * 2) /
        32768 / format.channels;
    }
  }
  return { samples, sampleRate: format.sampleRate };
}

async function runRealSamples(): Promise<Array<Record<string, unknown>>> {
  const fixtures: Array<{ file: string; expected: DroneProfileId }> = [
    { file: "batear-fpv-5inch.wav", expected: "fpv" },
    { file: "batear-mavic-pro.wav", expected: "camera" },
    { file: "batear-mini-4-pro.wav", expected: "camera" },
  ];
  return Promise.all(fixtures.map(async ({ file, expected }) => {
    const wav = decodePcm16Wav(await readFile(path.join(PROJECT_ROOT, "public/audio", file)));
    const result = analyzePcm(wav.samples.slice(0, wav.sampleRate * 8), wav.sampleRate);
    const top1 = result.classifications[0]?.profile ?? "ambient";
    return {
      file,
      expected,
      detected: result.detected,
      top1,
      correct: result.detected && top1 === expected,
      confidence: round(result.confidence),
    };
  }));
}

function csv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const cell = (value: unknown): string => {
    const text = String(value ?? "");
    return /[\n,"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${columns.join(",")}\n${rows.map((row) =>
    columns.map((column) => cell(row[column])).join(",")
  ).join("\n")}\n`;
}

async function main(): Promise<void> {
  const trials = argumentNumber("--trials", 30);
  const localizationTrials = argumentNumber("--localization-trials", 300);
  const seed = argumentNumber("--seed", 20260828);
  const reportDirectory = path.resolve(
    PROJECT_ROOT,
    argumentString("--out", "public/reports/headless"),
  );
  const random = mulberry32(seed);
  const detector = runDetectionBenchmark(trials, random);
  const localization = runLocalizationBenchmark(localizationTrials, random);
  const realSamples = await runRealSamples();
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    seed,
    configuration: {
      sampleRate: SAMPLE_RATE,
      clipDurationS: DURATION_S,
      trialsPerDroneCondition: trials,
      localizationTrialsPerJitterLevel: localizationTrials,
      distancesM: DISTANCES_M,
      environments: ENVIRONMENTS,
      attenuationModel: "free-field 1/r, reference gain 0.72 at 25 m",
    },
    caveats: [
      "Synthetic results are regression benchmarks, not validated field range.",
      "Distance uses assumed source gain rather than calibrated SPL data.",
      "Localization omits reverberation and multipath.",
      "Three coplanar listeners estimate 2D only; altitude remains unknown.",
      "Reports contain aggregate metrics only, never raw audio.",
    ],
    realSamples,
    detection: detector.detection,
    falseAlarms: detector.falseAlarms,
    localization,
  };
  await mkdir(reportDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(reportDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`),
    writeFile(path.join(reportDirectory, "detection.csv"), csv(detector.detection as unknown as Array<Record<string, unknown>>)),
    writeFile(path.join(reportDirectory, "false-alarms.csv"), csv(detector.falseAlarms as unknown as Array<Record<string, unknown>>)),
    writeFile(path.join(reportDirectory, "localization.csv"), csv(localization as unknown as Array<Record<string, unknown>>)),
  ]);
  console.log(`Headless simulation complete (seed ${seed}).`);
  console.log(`Mean detection: ${(mean(detector.detection.map((row) => row.detectionRate)) * 100).toFixed(1)}%`);
  console.log(`Mean correct top-1: ${(mean(detector.detection.map((row) => row.top1Accuracy)) * 100).toFixed(1)}%`);
  console.log(`Reports: ${reportDirectory}`);
}

await main();
