import { ML_FEATURE_NAMES, extractMlFeatures, pcmWindows } from "./features";

export interface BinaryMetrics {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  precision: number;
  recall: number;
  falsePositiveRate: number;
  f1: number;
  accuracy: number;
}

export interface MlModelArtifact {
  schemaVersion: 1;
  id: "ml-onnx-v1";
  label: string;
  version: string;
  inputName: "features";
  outputName: "probability";
  featureNames: string[];
  featureMean: number[];
  featureStd: number[];
  weights: number[];
  bias: number;
  threshold: number;
  temporal: { requiredPositiveWindows: number; windowCount: number };
  modelUrl: string;
  modelBytes: number;
  trainingDomain: "synthetic-only";
  trainedAt: string;
  seed: number;
  qualityGate: {
    maximumFalsePositiveRate: number;
    minimumRecall: number;
    beatsDspF1: boolean;
    passed: boolean;
  };
  validationMetrics: BinaryMetrics;
  testMetrics: BinaryMetrics;
  dspTestMetrics: BinaryMetrics;
}

export function parseMlModelArtifact(value: unknown): MlModelArtifact {
  if (!value || typeof value !== "object") throw new Error("Invalid ML metadata");
  const artifact = value as Partial<MlModelArtifact>;
  const featureCount = ML_FEATURE_NAMES.length;
  const finiteVector = (vector: unknown): vector is number[] =>
    Array.isArray(vector) && vector.length === featureCount && vector.every(Number.isFinite);
  if (artifact.schemaVersion !== 1 || artifact.id !== "ml-onnx-v1" ||
    artifact.inputName !== "features" || artifact.outputName !== "probability" ||
    !Array.isArray(artifact.featureNames) ||
    artifact.featureNames.length !== featureCount ||
    artifact.featureNames.some((name, index) => name !== ML_FEATURE_NAMES[index]) ||
    !finiteVector(artifact.featureMean) || !finiteVector(artifact.featureStd) ||
    artifact.featureStd.some((value) => value <= 0) ||
    !finiteVector(artifact.weights) || typeof artifact.bias !== "number" ||
    !Number.isFinite(artifact.bias) || typeof artifact.threshold !== "number" ||
    !Number.isFinite(artifact.threshold) || artifact.threshold < 0 || artifact.threshold > 1 ||
    typeof artifact.modelUrl !== "string" || !artifact.modelUrl.startsWith("/models/") ||
    artifact.trainingDomain !== "synthetic-only" ||
    typeof artifact.modelBytes !== "number" ||
    !Number.isInteger(artifact.modelBytes) || artifact.modelBytes <= 0 ||
    !artifact.temporal || !Number.isInteger(artifact.temporal.requiredPositiveWindows) ||
    !Number.isInteger(artifact.temporal.windowCount) || artifact.temporal.requiredPositiveWindows < 1 ||
    artifact.temporal.windowCount < artifact.temporal.requiredPositiveWindows ||
    !artifact.qualityGate || typeof artifact.qualityGate.passed !== "boolean") {
    throw new Error("ML metadata does not match the supported model schema");
  }
  return artifact as MlModelArtifact;
}

export function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, value))));
}

export function normalizeFeatures(
  features: Float32Array,
  artifact: MlModelArtifact,
): Float32Array {
  if (features.length !== artifact.featureNames.length || features.length !== ML_FEATURE_NAMES.length) {
    throw new Error("ML feature/model dimension mismatch");
  }
  return Float32Array.from(features, (value, index) =>
    (value - artifact.featureMean[index]) / Math.max(1e-6, artifact.featureStd[index])
  );
}

export function scoreNormalizedFeatures(
  normalized: Float32Array,
  artifact: MlModelArtifact,
): number {
  let logit = artifact.bias;
  for (let index = 0; index < normalized.length; index += 1) {
    logit += normalized[index] * artifact.weights[index];
  }
  return sigmoid(logit);
}

export function scoreMlFeatures(features: Float32Array, artifact: MlModelArtifact): number {
  return scoreNormalizedFeatures(normalizeFeatures(features, artifact), artifact);
}

export interface TemporalMlResult {
  detected: boolean;
  confidence: number;
  positiveWindows: number;
  analyzedWindows: number;
  probabilities: number[];
}

export function aggregateProbabilities(
  probabilities: number[],
  threshold: number,
  temporal = { requiredPositiveWindows: 3, windowCount: 5 },
): TemporalMlResult {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1 ||
    probabilities.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("ML probabilities and threshold must be finite values between zero and one");
  }
  if (!Number.isInteger(temporal.requiredPositiveWindows) ||
    !Number.isInteger(temporal.windowCount) || temporal.requiredPositiveWindows < 1 ||
    temporal.windowCount < temporal.requiredPositiveWindows) {
    throw new Error("Invalid temporal ML configuration");
  }
  const recent = probabilities.slice(-temporal.windowCount);
  const positiveWindows = recent.filter((value) => value >= threshold).length;
  const required = recent.length >= temporal.windowCount
    ? temporal.requiredPositiveWindows
    : Math.max(
        1,
        Math.ceil(recent.length * temporal.requiredPositiveWindows / temporal.windowCount),
      );
  return {
    detected: positiveWindows >= required,
    confidence: recent.reduce((sum, value) => sum + value, 0) / Math.max(1, recent.length),
    positiveWindows,
    analyzedWindows: recent.length,
    probabilities: recent,
  };
}

export function averagePrecision(truth: boolean[], probabilities: number[]): number {
  if (truth.length !== probabilities.length || probabilities.some((value) => !Number.isFinite(value))) {
    throw new Error("Metric inputs must have matching lengths and finite probabilities");
  }
  const positives = truth.filter(Boolean).length;
  if (positives === 0) return 0;
  const ranked = probabilities.map((probability, index) => ({ probability, positive: truth[index] }))
    .sort((a, b) => b.probability - a.probability);
  let truePositive = 0;
  let predictedPositive = 0;
  let area = 0;
  for (let start = 0; start < ranked.length;) {
    let end = start;
    let groupTruePositive = 0;
    while (end < ranked.length && ranked[end].probability === ranked[start].probability) {
      if (ranked[end].positive) groupTruePositive += 1;
      end += 1;
    }
    truePositive += groupTruePositive;
    predictedPositive += end - start;
    area += (groupTruePositive / positives) * (truePositive / predictedPositive);
    start = end;
  }
  return area;
}

export function rocAuc(truth: boolean[], probabilities: number[]): number {
  if (truth.length !== probabilities.length || probabilities.some((value) => !Number.isFinite(value))) {
    throw new Error("Metric inputs must have matching lengths and finite probabilities");
  }
  const positives = probabilities.filter((_, index) => truth[index]);
  const negatives = probabilities.filter((_, index) => !truth[index]);
  if (positives.length === 0 || negatives.length === 0) return 0;
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive > negative) wins += 1;
      else if (positive === negative) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}

export function analyzeWithArtifact(
  samples: Float32Array,
  sampleRate: number,
  artifact: MlModelArtifact,
): TemporalMlResult {
  const probabilities = pcmWindows(samples, sampleRate).map((window) =>
    scoreMlFeatures(extractMlFeatures(window, 16_000), artifact)
  );
  return aggregateProbabilities(probabilities, artifact.threshold, artifact.temporal);
}

export function binaryMetrics(truth: boolean[], predicted: boolean[]): BinaryMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  truth.forEach((positive, index) => {
    const decision = predicted[index];
    if (positive && decision) truePositive += 1;
    else if (!positive && decision) falsePositive += 1;
    else if (!positive && !decision) trueNegative += 1;
    else falseNegative += 1;
  });
  const precision = truePositive / Math.max(1, truePositive + falsePositive);
  const recall = truePositive / Math.max(1, truePositive + falseNegative);
  const falsePositiveRate = falsePositive / Math.max(1, falsePositive + trueNegative);
  return {
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    precision,
    recall,
    falsePositiveRate,
    f1: 2 * precision * recall / Math.max(1e-9, precision + recall),
    accuracy: (truePositive + trueNegative) / Math.max(1, truth.length),
  };
}
