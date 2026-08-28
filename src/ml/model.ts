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
  temporal: { requiredPositiveWindows: 3; windowCount: 5 };
  modelUrl: string;
  modelBytes: number;
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
): TemporalMlResult {
  const recent = probabilities.slice(-5);
  const positiveWindows = recent.filter((value) => value >= threshold).length;
  const required = recent.length >= 5 ? 3 : Math.max(1, Math.ceil(recent.length * 0.6));
  return {
    detected: positiveWindows >= required,
    confidence: recent.reduce((sum, value) => sum + value, 0) / Math.max(1, recent.length),
    positiveWindows,
    analyzedWindows: recent.length,
    probabilities: recent,
  };
}

export function analyzeWithArtifact(
  samples: Float32Array,
  sampleRate: number,
  artifact: MlModelArtifact,
): TemporalMlResult {
  const probabilities = pcmWindows(samples, sampleRate).map((window) =>
    scoreMlFeatures(extractMlFeatures(window, 16_000), artifact)
  );
  return aggregateProbabilities(probabilities, artifact.threshold);
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
