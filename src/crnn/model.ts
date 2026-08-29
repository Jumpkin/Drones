import FFT from "fft.js";
import { resampleLinear } from "../detector";
import { aggregateProbabilities, type TemporalMlResult } from "../ml/model";

export const CRNN_SAMPLE_RATE = 16_000;
export const CRNN_WINDOW_SAMPLES = 16_000;
export const CRNN_WINDOW_HOP_SAMPLES = 8_000;
export const CRNN_FFT_SIZE = 512;
export const CRNN_FFT_HOP_SAMPLES = 160;
export const CRNN_MEL_BINS = 64;
export const CRNN_TIME_FRAMES = 101;

export interface PretrainedCrnnArtifact {
  schemaVersion: 1;
  id: "crnn-pretrained-v1";
  label: string;
  version: string;
  inputName: "log_mel";
  outputName: "probability";
  modelUrl: string;
  modelBytes: number;
  modelSha256: string;
  threshold: number;
  temporal: { requiredPositiveWindows: number; windowCount: number };
  preprocessing: {
    sampleRate: 16000;
    windowSamples: 16000;
    hopSamples: 8000;
    fftSize: 512;
    fftHopSamples: 160;
    melBins: 64;
    minimumHz: 50;
    maximumHz: 5500;
    melScale: "htk";
    topDb: 80;
    normalization: "(powerDb + 40) / 40";
  };
  source: {
    repository: string;
    revision: string;
    weightsFile: string;
    weightsSha256: string;
    license: "MIT";
    copyright: string;
  };
  trainingDomain: string;
  limitations: string[];
}

export function parsePretrainedCrnnArtifact(value: unknown): PretrainedCrnnArtifact {
  if (!value || typeof value !== "object") throw new Error("Invalid pretrained CRNN metadata");
  const artifact = value as Partial<PretrainedCrnnArtifact>;
  const preprocessing = artifact.preprocessing;
  if (artifact.schemaVersion !== 1 || artifact.id !== "crnn-pretrained-v1" ||
    artifact.inputName !== "log_mel" || artifact.outputName !== "probability" ||
    typeof artifact.modelUrl !== "string" || !artifact.modelUrl.startsWith("/models/") ||
    !Number.isInteger(artifact.modelBytes) || (artifact.modelBytes ?? 0) <= 0 ||
    typeof artifact.modelSha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.modelSha256) ||
    typeof artifact.threshold !== "number" || artifact.threshold < 0 || artifact.threshold > 1 ||
    !artifact.temporal || !Number.isInteger(artifact.temporal.requiredPositiveWindows) ||
    !Number.isInteger(artifact.temporal.windowCount) ||
    artifact.temporal.requiredPositiveWindows < 1 ||
    artifact.temporal.requiredPositiveWindows > artifact.temporal.windowCount ||
    preprocessing?.sampleRate !== CRNN_SAMPLE_RATE ||
    preprocessing.windowSamples !== CRNN_WINDOW_SAMPLES ||
    preprocessing.hopSamples !== CRNN_WINDOW_HOP_SAMPLES ||
    preprocessing.fftSize !== CRNN_FFT_SIZE ||
    preprocessing.fftHopSamples !== CRNN_FFT_HOP_SAMPLES ||
    preprocessing.melBins !== CRNN_MEL_BINS ||
    preprocessing.minimumHz !== 50 || preprocessing.maximumHz !== 5500 ||
    preprocessing.melScale !== "htk" || preprocessing.topDb !== 80 ||
    preprocessing.normalization !== "(powerDb + 40) / 40" ||
    artifact.source?.license !== "MIT" || !Array.isArray(artifact.limitations)) {
    throw new Error("Pretrained CRNN metadata does not match the supported model schema");
  }
  return artifact as PretrainedCrnnArtifact;
}

function hzToMel(frequencyHz: number): number {
  return 2595 * Math.log10(1 + frequencyHz / 700);
}

function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1);
}

function makeMelFilterbank(): Float64Array[] {
  const frequencyBins = CRNN_FFT_SIZE / 2 + 1;
  const minimumMel = hzToMel(50);
  const maximumMel = hzToMel(5500);
  const melPoints = Array.from({ length: CRNN_MEL_BINS + 2 }, (_, index) =>
    minimumMel + (maximumMel - minimumMel) * index / (CRNN_MEL_BINS + 1)
  );
  const frequencyPoints = melPoints.map(melToHz);
  return Array.from({ length: CRNN_MEL_BINS }, (_, melIndex) => {
    const lower = frequencyPoints[melIndex];
    const center = frequencyPoints[melIndex + 1];
    const upper = frequencyPoints[melIndex + 2];
    const weights = new Float64Array(frequencyBins);
    for (let bin = 0; bin < frequencyBins; bin += 1) {
      const frequency = bin * CRNN_SAMPLE_RATE / CRNN_FFT_SIZE;
      const ascending = (frequency - lower) / (center - lower);
      const descending = (upper - frequency) / (upper - center);
      weights[bin] = Math.max(0, Math.min(ascending, descending));
    }
    return weights;
  });
}

const MEL_FILTERBANK = makeMelFilterbank();
const HANN_WINDOW = Float64Array.from(
  { length: CRNN_FFT_SIZE },
  (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / CRNN_FFT_SIZE),
);

function reflectedSample(samples: Float32Array, index: number): number {
  let reflected = index;
  while (reflected < 0 || reflected >= samples.length) {
    reflected = reflected < 0 ? -reflected : 2 * samples.length - 2 - reflected;
  }
  return samples[reflected] ?? 0;
}

export function crnnWindows(input: Float32Array, sampleRate: number): Float32Array[] {
  const samples = resampleLinear(input, sampleRate, CRNN_SAMPLE_RATE);
  if (samples.length <= CRNN_WINDOW_SAMPLES) {
    const padded = new Float32Array(CRNN_WINDOW_SAMPLES);
    padded.set(samples);
    return [padded];
  }
  const windows: Float32Array[] = [];
  let lastOffset = -1;
  for (let offset = 0; offset + CRNN_WINDOW_SAMPLES <= samples.length; offset += CRNN_WINDOW_HOP_SAMPLES) {
    windows.push(samples.slice(offset, offset + CRNN_WINDOW_SAMPLES));
    lastOffset = offset;
  }
  const finalOffset = samples.length - CRNN_WINDOW_SAMPLES;
  if (finalOffset !== lastOffset) windows.push(samples.slice(finalOffset));
  return windows;
}

export function extractCrnnLogMel(window: Float32Array): Float32Array {
  if (window.length !== CRNN_WINDOW_SAMPLES) {
    throw new Error(`Pretrained CRNN expects ${CRNN_WINDOW_SAMPLES} samples per window`);
  }
  const fft = new FFT(CRNN_FFT_SIZE);
  const frame = new Array<number>(CRNN_FFT_SIZE).fill(0);
  const complex = fft.createComplexArray();
  const power = new Float64Array(CRNN_FFT_SIZE / 2 + 1);
  const melPower = new Float64Array(CRNN_MEL_BINS * CRNN_TIME_FRAMES);
  for (let frameIndex = 0; frameIndex < CRNN_TIME_FRAMES; frameIndex += 1) {
    const start = frameIndex * CRNN_FFT_HOP_SAMPLES - CRNN_FFT_SIZE / 2;
    for (let index = 0; index < CRNN_FFT_SIZE; index += 1) {
      frame[index] = reflectedSample(window, start + index) * HANN_WINDOW[index];
    }
    fft.realTransform(complex, frame);
    for (let bin = 0; bin < power.length; bin += 1) {
      const real = complex[bin * 2];
      const imaginary = complex[bin * 2 + 1];
      power[bin] = real * real + imaginary * imaginary;
    }
    for (let mel = 0; mel < CRNN_MEL_BINS; mel += 1) {
      let energy = 0;
      const filter = MEL_FILTERBANK[mel];
      for (let bin = 0; bin < power.length; bin += 1) energy += power[bin] * filter[bin];
      melPower[mel * CRNN_TIME_FRAMES + frameIndex] = Math.max(1e-10, energy);
    }
  }
  let maximumDb = -Infinity;
  for (let index = 0; index < melPower.length; index += 1) {
    melPower[index] = 10 * Math.log10(melPower[index]);
    maximumDb = Math.max(maximumDb, melPower[index]);
  }
  const minimumDb = maximumDb - 80;
  return Float32Array.from(melPower, (value) => (Math.max(minimumDb, value) + 40) / 40);
}

export function combineCrnnFeatures(windows: Float32Array[]): Float32Array {
  const features = new Float32Array(windows.length * CRNN_MEL_BINS * CRNN_TIME_FRAMES);
  windows.forEach((window, index) => {
    features.set(extractCrnnLogMel(window), index * CRNN_MEL_BINS * CRNN_TIME_FRAMES);
  });
  return features;
}

export function aggregateCrnnProbabilities(
  probabilities: number[],
  artifact: Pick<PretrainedCrnnArtifact, "threshold" | "temporal">,
): TemporalMlResult {
  return aggregateProbabilities(probabilities, artifact.threshold, artifact.temporal);
}
