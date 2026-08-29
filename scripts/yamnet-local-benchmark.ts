import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web";
import {
  BENCHMARK_ENVIRONMENTS,
  HARD_NEGATIVE_KINDS,
  PHONE_AUDIO_PROFILES,
  PLAYBACK_ROOM_PROFILES,
  makeDroneObservation,
  makeHardNegative,
  mulberry32,
  simulatePhonePlayback,
} from "../src/benchmark-audio";
import { generateDronePcm } from "../src/audio";
import { analyzePcm } from "../src/detector";
import {
  CRNN_MEL_BINS,
  CRNN_TIME_FRAMES,
  aggregateCrnnProbabilities,
  combineCrnnFeatures,
  crnnWindows,
  parsePretrainedCrnnArtifact,
  type PretrainedCrnnArtifact,
} from "../src/crnn/model";
import {
  analyzeWithArtifact,
  averagePrecision,
  binaryMetrics,
  rocAuc,
  type BinaryMetrics,
  type MlModelArtifact,
} from "../src/ml/model";
import { DRONE_PROFILES, type DroneProfileId } from "../src/sim";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE_RATE = 16_000;
const DURATION_S = 3;
const DISTANCES_M = [25, 50, 100, 200, 400];
const PROFILES = Object.keys(DRONE_PROFILES) as DroneProfileId[];
const DETECTORS = ["dsp-v1", "ml-onnx-v1", "crnn-pretrained-v1", "yamnet-pretrained-local-v1"] as const;
type BenchmarkDetectorId = typeof DETECTORS[number];

interface Outcome {
  detected: boolean;
  probability: number;
}

interface Observation extends Outcome {
  detectorId: BenchmarkDetectorId;
  truth: boolean;
  environment: string;
  distanceM: number | null;
  profile: string;
}

interface CrnnRuntime {
  artifact: PretrainedCrnnArtifact;
  session: ort.InferenceSession;
}

interface WorkerMessage {
  ready?: boolean;
  revision?: string;
  modelSha256?: string;
  threshold?: number;
  id?: number;
  probability?: number;
  detected?: boolean;
  error?: string;
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(argument(name, String(fallback)));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function roundedMetrics(metrics: BinaryMetrics): BinaryMetrics {
  return {
    truePositive: metrics.truePositive,
    falsePositive: metrics.falsePositive,
    trueNegative: metrics.trueNegative,
    falseNegative: metrics.falseNegative,
    precision: round(metrics.precision),
    recall: round(metrics.recall),
    falsePositiveRate: round(metrics.falsePositiveRate),
    f1: round(metrics.f1),
    accuracy: round(metrics.accuracy),
  };
}

class YamnetWorker {
  readonly process: ChildProcessWithoutNullStreams;
  readonly lines: Interface;
  readonly metadata: Promise<WorkerMessage>;
  private pending: Array<{
    resolve: (message: WorkerMessage) => void;
    reject: (error: Error) => void;
  }> = [];
  private requestId = 0;

  constructor(python: string, cacheDirectory: string) {
    this.process = spawn(python, [
      path.join(PROJECT_ROOT, "scripts/yamnet-benchmark-worker.py"),
      "--cache",
      cacheDirectory,
    ], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        TF_CPP_MIN_LOG_LEVEL: "2",
        TFHUB_CACHE_DIR: path.join(cacheDirectory, "tfhub"),
      },
    });
    this.process.stderr.on("data", (chunk) => process.stderr.write(chunk));
    const rejectPending = (error: Error) => {
      for (const pending of this.pending.splice(0)) pending.reject(error);
    };
    this.process.once("error", (error) => rejectPending(error));
    this.process.once("exit", (code) => {
      if (this.pending.length > 0) {
        rejectPending(new Error(`YAMNet worker exited with ${code ?? "an unknown status"} before replying`));
      }
    });
    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => {
      const pending = this.pending.shift();
      if (!pending) {
        this.process.kill();
        return;
      }
      try {
        pending.resolve(JSON.parse(line) as WorkerMessage);
      } catch (error) {
        pending.reject(new Error(`Invalid JSON from YAMNet worker: ${String(error)}`));
      }
    });
    this.metadata = this.nextMessage();
  }

  private nextMessage(): Promise<WorkerMessage> {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  async score(samples: Float32Array, sampleRate: number): Promise<Outcome> {
    const responsePromise = this.nextMessage();
    const id = ++this.requestId;
    const audio = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
    this.process.stdin.write(`${JSON.stringify({ id, sampleRate, audio })}\n`);
    const response = await responsePromise;
    if (response.error) throw new Error(`YAMNet inference failed: ${response.error}`);
    if (response.id !== id || typeof response.probability !== "number" || typeof response.detected !== "boolean") {
      throw new Error("Invalid YAMNet worker response");
    }
    return { detected: response.detected, probability: response.probability };
  }

  async close(): Promise<void> {
    this.process.stdin.end();
    if (this.process.exitCode === null && this.process.signalCode === null) {
      await new Promise<void>((resolve) => this.process.once("exit", () => resolve()));
    }
    this.lines.close();
  }
}

async function analyzeCrnn(samples: Float32Array, sampleRate: number, runtime: CrnnRuntime): Promise<Outcome> {
  const windows = crnnWindows(samples, sampleRate);
  const tensor = new ort.Tensor(
    "float32",
    combineCrnnFeatures(windows),
    [windows.length, 1, CRNN_MEL_BINS, CRNN_TIME_FRAMES],
  );
  const output = await runtime.session.run({ [runtime.artifact.inputName]: tensor });
  const probabilities = Array.from(output[runtime.artifact.outputName].data, Number);
  const result = aggregateCrnnProbabilities(probabilities, runtime.artifact);
  return { detected: result.detected, probability: result.confidence };
}

async function scoreAll(
  samples: Float32Array,
  sampleRate: number,
  artifact: MlModelArtifact,
  crnn: CrnnRuntime,
  yamnet: YamnetWorker,
): Promise<Record<BenchmarkDetectorId, Outcome>> {
  const dspResult = analyzePcm(samples, sampleRate);
  const mlResult = analyzeWithArtifact(samples, sampleRate, artifact);
  const [crnnResult, yamnetResult] = await Promise.all([
    analyzeCrnn(samples, sampleRate, crnn),
    yamnet.score(samples, sampleRate),
  ]);
  return {
    "dsp-v1": { detected: dspResult.detected, probability: dspResult.confidence },
    "ml-onnx-v1": { detected: mlResult.detected, probability: mlResult.confidence },
    "crnn-pretrained-v1": crnnResult,
    "yamnet-pretrained-local-v1": yamnetResult,
  };
}

function record(
  observations: Observation[],
  outcomes: Record<BenchmarkDetectorId, Outcome>,
  truth: boolean,
  environment: string,
  distanceM: number | null,
  profile: string,
): void {
  for (const detectorId of DETECTORS) {
    observations.push({ detectorId, truth, environment, distanceM, profile, ...outcomes[detectorId] });
  }
}

function decodePcm16Wav(buffer: Buffer): { samples: Float32Array; sampleRate: number } {
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (buffer.readUInt16LE(body) !== 1) throw new Error("Only PCM WAV is supported");
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataOffset = body;
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!channels || !sampleRate || bits !== 16 || !dataSize) throw new Error("Invalid PCM16 WAV");
  const frames = Math.floor(dataSize / channels / 2);
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      samples[frame] += buffer.readInt16LE(dataOffset + (frame * channels + channel) * 2) / 32768 / channels;
    }
  }
  return { samples, sampleRate };
}

function summaryFor(observations: Observation[], detectorId: BenchmarkDetectorId): Record<string, unknown> {
  const selected = observations.filter((item) => item.detectorId === detectorId);
  const truth = selected.map((item) => item.truth);
  const detected = selected.map((item) => item.detected);
  const probabilities = selected.map((item) => item.probability);
  return {
    detectorId,
    ...roundedMetrics(binaryMetrics(truth, detected)),
    prAuc: round(averagePrecision(truth, probabilities)),
    rocAuc: round(rocAuc(truth, probabilities)),
    brierScore: round(mean(selected.map((item) => (item.probability - Number(item.truth)) ** 2))),
  };
}

async function main(): Promise<void> {
  const trials = positiveInteger("--trials", 15);
  const phoneTrials = positiveInteger("--phone-trials", Math.max(3, Math.ceil(trials / 3)));
  const seed = positiveInteger("--seed", 20260828);
  const outputPath = path.resolve(argument("--out", "/tmp/drones-yamnet-comparison.json"));
  const python = argument("--python", process.env.YAMNET_PYTHON ?? "/tmp/drones-yamnet-venv/bin/python");
  const cacheDirectory = path.resolve(argument("--cache", "/tmp/drones-yamnet-model"));
  const artifact = JSON.parse(await readFile(path.join(PROJECT_ROOT, "public/models/drone-binary-v1.json"), "utf8")) as MlModelArtifact;
  const crnnArtifact = parsePretrainedCrnnArtifact(JSON.parse(
    await readFile(path.join(PROJECT_ROOT, "public/models/drone-classifier-crnn-v1.json"), "utf8"),
  ));
  ort.env.wasm.numThreads = 1;
  const crnn: CrnnRuntime = {
    artifact: crnnArtifact,
    session: await ort.InferenceSession.create(
      new Uint8Array(await readFile(path.join(PROJECT_ROOT, "public/models/drone-classifier-crnn-v1.onnx"))),
      { executionProviders: ["wasm"], graphOptimizationLevel: "all" },
    ),
  };
  const yamnet = new YamnetWorker(python, cacheDirectory);
  const yamnetMetadata = await yamnet.metadata;
  if (!yamnetMetadata.ready) throw new Error("YAMNet worker did not become ready");

  const observations: Observation[] = [];
  const detectionRandom = mulberry32(seed);
  let completed = 0;
  const totalDetection = PROFILES.length * DISTANCES_M.length * BENCHMARK_ENVIRONMENTS.length * trials +
    BENCHMARK_ENVIRONMENTS.length * trials * PROFILES.length;
  for (const profile of PROFILES) {
    for (const distanceM of DISTANCES_M) {
      for (const environment of BENCHMARK_ENVIRONMENTS) {
        for (let trial = 0; trial < trials; trial += 1) {
          const samples = makeDroneObservation(profile, DURATION_S, SAMPLE_RATE, distanceM, environment, detectionRandom);
          record(observations, await scoreAll(samples, SAMPLE_RATE, artifact, crnn, yamnet), true, environment.id, distanceM, profile);
          completed += 1;
          if (completed % 100 === 0) console.error(`Detection corpus: ${completed}/${totalDetection}`);
        }
      }
    }
  }
  for (const environment of BENCHMARK_ENVIRONMENTS) {
    const ambientTrials = trials * PROFILES.length;
    for (let trial = 0; trial < ambientTrials; trial += 1) {
      const kind = HARD_NEGATIVE_KINDS[trial % HARD_NEGATIVE_KINDS.length];
      const samples = makeHardNegative(kind, DURATION_S, SAMPLE_RATE, environment, detectionRandom);
      record(observations, await scoreAll(samples, SAMPLE_RATE, artifact, crnn, yamnet), false, environment.id, null, kind);
      completed += 1;
      if (completed % 100 === 0) console.error(`Detection corpus: ${completed}/${totalDetection}`);
    }
  }

  const phoneGroups = new Map<string, { detectorId: BenchmarkDetectorId; phoneId: string; roomId: string; truth: boolean[]; detected: boolean[] }>();
  const phoneRandom = mulberry32((seed ^ 0x50484f4e) >>> 0);
  const sourceEnvironment = { id: "quiet" as const, ambientRms: 0, machineryAmplitude: 0 };
  for (const phone of PHONE_AUDIO_PROFILES) {
    for (const room of PLAYBACK_ROOM_PROFILES) {
      for (const detectorId of DETECTORS) {
        phoneGroups.set(`${phone.id}/${room.id}/${detectorId}`, { detectorId, phoneId: phone.id, roomId: room.id, truth: [], detected: [] });
      }
      for (let trial = 0; trial < phoneTrials; trial += 1) {
        for (let profileIndex = 0; profileIndex < PROFILES.length; profileIndex += 1) {
          const profile = PROFILES[profileIndex];
          const droneSource = generateDronePcm(profile, DURATION_S, SAMPLE_RATE, -20 + phoneRandom() * 40, 0);
          const droneCapture = simulatePhonePlayback(droneSource, SAMPLE_RATE, phone, room, phoneRandom);
          const positive = await scoreAll(droneCapture, SAMPLE_RATE, artifact, crnn, yamnet);
          const kind = HARD_NEGATIVE_KINDS[(trial * PROFILES.length + profileIndex) % HARD_NEGATIVE_KINDS.length];
          const negativeSource = makeHardNegative(kind, DURATION_S, SAMPLE_RATE, sourceEnvironment, phoneRandom);
          const negativeCapture = simulatePhonePlayback(negativeSource, SAMPLE_RATE, phone, room, phoneRandom);
          const negative = await scoreAll(negativeCapture, SAMPLE_RATE, artifact, crnn, yamnet);
          for (const detectorId of DETECTORS) {
            const group = phoneGroups.get(`${phone.id}/${room.id}/${detectorId}`)!;
            group.truth.push(true, false);
            group.detected.push(positive[detectorId].detected, negative[detectorId].detected);
          }
        }
      }
      console.error(`Phone corpus: ${phone.label} / ${room.label}`);
    }
  }
  const phone = [...phoneGroups.values()].map((group) => ({
    detectorId: group.detectorId,
    phoneId: group.phoneId,
    roomId: group.roomId,
    ...roundedMetrics(binaryMetrics(group.truth, group.detected)),
  }));

  const fixtures: Array<{ file: string; expectedDrone: boolean }> = [
    { file: "batear-fpv-5inch.wav", expectedDrone: true },
    { file: "batear-mavic-pro.wav", expectedDrone: true },
    { file: "batear-mini-4-pro.wav", expectedDrone: true },
    { file: "batear-rural-8s.wav", expectedDrone: false },
  ];
  const realSamples = [];
  for (const fixture of fixtures) {
    const wav = decodePcm16Wav(await readFile(path.join(PROJECT_ROOT, "public/audio", fixture.file)));
    const outcomes = await scoreAll(wav.samples.slice(0, wav.sampleRate * 8), wav.sampleRate, artifact, crnn, yamnet);
    for (const detectorId of DETECTORS) {
      realSamples.push({
        file: fixture.file,
        expectedDrone: fixture.expectedDrone,
        detectorId,
        detected: outcomes[detectorId].detected,
        confidence: round(outcomes[detectorId].probability),
        correct: outcomes[detectorId].detected === fixture.expectedDrone,
      });
    }
  }
  await yamnet.close();

  const phoneSummary = DETECTORS.map((detectorId) => {
    const selected = phone.filter((row) => row.detectorId === detectorId);
    return {
      detectorId,
      meanRecall: round(mean(selected.map((row) => row.recall))),
      meanFalsePositiveRate: round(mean(selected.map((row) => row.falsePositiveRate))),
      worstFalsePositiveRate: round(Math.max(...selected.map((row) => row.falsePositiveRate))),
    };
  });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    seed,
    trials,
    phoneTrials,
    domain: "Project-generated synthetic benchmark plus four Batear fixtures; not field validation.",
    yamnet: {
      source: "https://github.com/jwehlen-cell/yamnet-drone-detector",
      revision: yamnetMetadata.revision,
      modelSha256: yamnetMetadata.modelSha256,
      threshold: yamnetMetadata.threshold,
      runtime: "Google YAMNet v1 plus mean-pooled external binary classifier head",
      distribution: "Weights are downloaded to a local temporary cache and are not copied into public assets.",
      licensing: "The repository README declares MIT, but has no LICENSE file and notes unclear licenses for two derivative datasets.",
    },
    models: DETECTORS.map((detectorId) => summaryFor(observations, detectorId)),
    phoneSummary,
    phone,
    realSamples,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ models: report.models, phoneSummary, realSamples, report: outputPath }, null, 2));
}

await main();
