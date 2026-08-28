import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import {
  BENCHMARK_ENVIRONMENTS,
  HARD_NEGATIVE_KINDS,
  makeDroneObservation,
  makeHardNegative,
  mulberry32,
} from "../src/benchmark-audio";
import { analyzePcm } from "../src/detector";
import { ML_FEATURE_NAMES, extractMlFeatures, pcmWindows } from "../src/ml/features";
import {
  aggregateProbabilities,
  binaryMetrics,
  scoreNormalizedFeatures,
  type BinaryMetrics,
  type MlModelArtifact,
} from "../src/ml/model";
import { DRONE_PROFILES, type DroneProfileId } from "../src/sim";

type Split = "train" | "validation" | "test";

interface Session {
  id: string;
  split: Split;
  positive: boolean;
  samples: Float32Array;
}

interface FeatureSession extends Session {
  features: Float32Array[];
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE_RATE = 16_000;
const DURATION_S = 3;
const SEED = 20260828;

function splitForIndex(index: number): Split {
  const bucket = index % 20;
  return bucket < 14 ? "train" : bucket < 17 ? "validation" : "test";
}

function createSessions(countPerClass = 300): Session[] {
  const random = mulberry32(SEED);
  const profiles = Object.keys(DRONE_PROFILES) as DroneProfileId[];
  const sessions: Session[] = [];
  for (let index = 0; index < countPerClass; index += 1) {
    const environment = BENCHMARK_ENVIRONMENTS[index % BENCHMARK_ENVIRONMENTS.length];
    const distance = [25, 50, 100, 200, 400][Math.floor(index / 3) % 5];
    sessions.push({
      id: `positive-${index}`,
      split: splitForIndex(index),
      positive: true,
      samples: makeDroneObservation(
        profiles[index % profiles.length],
        DURATION_S,
        SAMPLE_RATE,
        distance,
        environment,
        random,
      ),
    });
    sessions.push({
      id: `negative-${index}`,
      split: splitForIndex(index),
      positive: false,
      samples: makeHardNegative(
        HARD_NEGATIVE_KINDS[index % HARD_NEGATIVE_KINDS.length],
        DURATION_S,
        SAMPLE_RATE,
        environment,
        random,
      ),
    });
  }
  return sessions;
}

function featurize(sessions: Session[]): FeatureSession[] {
  return sessions.map((session) => ({
    ...session,
    features: pcmWindows(session.samples, SAMPLE_RATE).map((window) =>
      extractMlFeatures(window, SAMPLE_RATE)
    ),
  }));
}

function moments(rows: Float32Array[]): { mean: number[]; std: number[] } {
  const mean = ML_FEATURE_NAMES.map((_, feature) =>
    rows.reduce((sum, row) => sum + row[feature], 0) / rows.length
  );
  const std = mean.map((average, feature) => Math.sqrt(
    rows.reduce((sum, row) => sum + (row[feature] - average) ** 2, 0) / rows.length,
  ) || 1);
  return { mean, std };
}

function normalize(row: Float32Array, mean: number[], std: number[]): Float32Array {
  return Float32Array.from(row, (value, index) => (value - mean[index]) / Math.max(1e-6, std[index]));
}

function trainLogistic(
  rows: Float32Array[],
  labels: number[],
): { weights: number[]; bias: number } {
  const weights = new Array<number>(ML_FEATURE_NAMES.length).fill(0);
  let bias = 0;
  const learningRate = 0.08;
  const l2 = 0.002;
  for (let epoch = 0; epoch < 1_200; epoch += 1) {
    const gradient = new Array<number>(weights.length).fill(0);
    let biasGradient = 0;
    rows.forEach((row, rowIndex) => {
      let logit = bias;
      for (let feature = 0; feature < weights.length; feature += 1) logit += weights[feature] * row[feature];
      const probability = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, logit))));
      const error = probability - labels[rowIndex];
      for (let feature = 0; feature < weights.length; feature += 1) gradient[feature] += error * row[feature];
      biasGradient += error;
    });
    for (let feature = 0; feature < weights.length; feature += 1) {
      weights[feature] -= learningRate * (gradient[feature] / rows.length + l2 * weights[feature]);
    }
    bias -= learningRate * biasGradient / rows.length;
  }
  return { weights, bias };
}

function sessionProbabilities(
  sessions: FeatureSession[],
  artifact: Pick<MlModelArtifact, "weights" | "bias" | "threshold" | "featureNames" | "featureMean" | "featureStd">,
): number[][] {
  return sessions.map((session) => session.features.map((features) =>
    scoreNormalizedFeatures(
      normalize(features, artifact.featureMean, artifact.featureStd),
      artifact as MlModelArtifact,
    )
  ));
}

function metricsAtThreshold(
  sessions: FeatureSession[],
  probabilities: number[][],
  threshold: number,
): BinaryMetrics {
  return binaryMetrics(
    sessions.map((session) => session.positive),
    probabilities.map((values) => aggregateProbabilities(values, threshold).detected),
  );
}

function selectThreshold(sessions: FeatureSession[], probabilities: number[][]): number {
  let best = { threshold: 0.5, recall: -1, f1: -1 };
  for (let threshold = 0.05; threshold <= 0.951; threshold += 0.01) {
    const metrics = metricsAtThreshold(sessions, probabilities, threshold);
    if (metrics.falsePositiveRate <= 0.05 &&
      (metrics.recall > best.recall || (metrics.recall === best.recall && metrics.f1 > best.f1))) {
      best = { threshold, recall: metrics.recall, f1: metrics.f1 };
    }
  }
  return Number(best.threshold.toFixed(2));
}

function floatBytes(values: number[]): Uint8Array {
  const floats = Float32Array.from(values);
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

async function writeOnnx(weights: number[], bias: number, outputPath: string): Promise<number> {
  const root = await protobuf.load(path.join(ROOT, "model/onnx-minimal.proto"));
  const ModelProto = root.lookupType("onnx.ModelProto");
  const dimension = (value: number) => ({ dimValue: value });
  const tensorType = (dims: number[]) => ({
    tensorType: { elemType: 1, shape: { dim: dims.map(dimension) } },
  });
  const payload = {
    irVersion: 9,
    producerName: "drones-acoustic-simulator",
    producerVersion: "0.2.0",
    domain: "io.github.jumpkin.drones",
    modelVersion: 1,
    docString: "Binary drone/background classifier over normalized acoustic features",
    opsetImport: [{ domain: "", version: 13 }],
    graph: {
      name: "drone_binary_feature_conv",
      input: [{ name: "features", type: tensorType([1, weights.length, 1]) }],
      output: [{ name: "probability", type: tensorType([1, 1, 1]) }],
      initializer: [
        { name: "classifier_weight", dims: [1, weights.length, 1], dataType: 1, rawData: floatBytes(weights) },
        { name: "classifier_bias", dims: [1], dataType: 1, rawData: floatBytes([bias]) },
      ],
      node: [
        { name: "feature_conv", opType: "Conv", input: ["features", "classifier_weight", "classifier_bias"], output: ["logit"] },
        { name: "probability", opType: "Sigmoid", input: ["logit"], output: ["probability"] },
      ],
    },
  };
  const error = ModelProto.verify(payload);
  if (error) throw new Error(error);
  const bytes = ModelProto.encode(ModelProto.create(payload)).finish();
  await writeFile(outputPath, bytes);
  return bytes.length;
}

async function main(): Promise<void> {
  const sessions = featurize(createSessions());
  const trainSessions = sessions.filter((session) => session.split === "train");
  const validationSessions = sessions.filter((session) => session.split === "validation");
  const testSessions = sessions.filter((session) => session.split === "test");
  const trainRows = trainSessions.flatMap((session) => session.features);
  const { mean, std } = moments(trainRows);
  const normalizedRows = trainRows.map((row) => normalize(row, mean, std));
  const labels = trainSessions.flatMap((session) => session.features.map(() => session.positive ? 1 : 0));
  const fitted = trainLogistic(normalizedRows, labels);
  const draft = {
    weights: fitted.weights,
    bias: fitted.bias,
    threshold: 0.5,
    featureNames: [...ML_FEATURE_NAMES],
    featureMean: mean,
    featureStd: std,
  };
  const validationProbabilities = sessionProbabilities(validationSessions, draft);
  const threshold = selectThreshold(validationSessions, validationProbabilities);
  draft.threshold = threshold;
  const validationMetrics = metricsAtThreshold(validationSessions, validationProbabilities, threshold);
  const testProbabilities = sessionProbabilities(testSessions, draft);
  const testMetrics = metricsAtThreshold(testSessions, testProbabilities, threshold);
  const dspTestMetrics = binaryMetrics(
    testSessions.map((session) => session.positive),
    testSessions.map((session) => analyzePcm(session.samples, SAMPLE_RATE).detected),
  );
  const outputDirectory = path.join(ROOT, "public/models");
  await mkdir(outputDirectory, { recursive: true });
  const onnxPath = path.join(outputDirectory, "drone-binary-v1.onnx");
  const modelBytes = await writeOnnx(fitted.weights, fitted.bias, onnxPath);
  const beatsDspF1 = testMetrics.f1 > dspTestMetrics.f1;
  const passed = testMetrics.falsePositiveRate <= 0.05 && testMetrics.recall >= 0.85 && beatsDspF1;
  const artifact: MlModelArtifact = {
    schemaVersion: 1,
    id: "ml-onnx-v1",
    label: "Feature Conv ML",
    version: "1.0.0",
    inputName: "features",
    outputName: "probability",
    featureNames: [...ML_FEATURE_NAMES],
    featureMean: mean,
    featureStd: std,
    weights: fitted.weights,
    bias: fitted.bias,
    threshold,
    temporal: { requiredPositiveWindows: 3, windowCount: 5 },
    modelUrl: "/models/drone-binary-v1.onnx",
    modelBytes,
    trainedAt: new Date().toISOString(),
    seed: SEED,
    qualityGate: {
      maximumFalsePositiveRate: 0.05,
      minimumRecall: 0.85,
      beatsDspF1,
      passed,
    },
    validationMetrics,
    testMetrics,
    dspTestMetrics,
  };
  await writeFile(
    path.join(outputDirectory, "drone-binary-v1.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  console.log(JSON.stringify({ threshold, validationMetrics, testMetrics, dspTestMetrics, passed, modelBytes }, null, 2));
}

await main();
