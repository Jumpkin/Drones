import { analyzePcm, resampleLinear } from "../detector";

export const ML_SAMPLE_RATE = 16_000;
export const ML_WINDOW_SAMPLES = ML_SAMPLE_RATE;
export const ML_HOP_SAMPLES = ML_SAMPLE_RATE / 2;

export const ML_FEATURE_NAMES = [
  "dspConfidence",
  "harmonicStrength",
  "positiveFrameRatio",
  "fundamentalNormalized",
  "spectralCentroid",
  "spectralSpread",
  "spectralFlatness",
  "rms",
  "crestFactor",
  "zeroCrossingRate",
  "energyModulation",
  "fundamentalVariation",
  "chunkConfidenceVariation",
  "highLowEnergyRatio",
  "peakSharpness",
  "tonalDensity",
] as const;

export type MlFeatureName = typeof ML_FEATURE_NAMES[number];

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function standardDeviation(values: number[]): number {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length === 0 ? 0 : sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

export function extractMlFeatures(
  input: Float32Array,
  inputSampleRate: number,
): Float32Array {
  const resampled = resampleLinear(input, inputSampleRate, ML_SAMPLE_RATE);
  const samples = new Float32Array(ML_WINDOW_SAMPLES);
  samples.set(resampled.subarray(0, ML_WINDOW_SAMPLES));
  const result = analyzePcm(samples, ML_SAMPLE_RATE);
  const spectrum = result.spectrumDb.slice(5, 256);
  const binHz = result.spectrumSampleRate / 1024;
  const powers = spectrum.map((db) => 10 ** (db / 10));
  const powerSum = powers.reduce((sum, value) => sum + value, 0) + 1e-12;
  const centroidHz = powers.reduce((sum, power, index) =>
    sum + power * (index + 5) * binHz, 0) / powerSum;
  const spreadHz = Math.sqrt(powers.reduce((sum, power, index) =>
    sum + power * (((index + 5) * binHz) - centroidHz) ** 2, 0) / powerSum);
  const geometric = Math.exp(mean(powers.map((power) => Math.log(power + 1e-18))));
  const flatness = geometric / (mean(powers) + 1e-18);

  let squareSum = 0;
  let absoluteMax = 0;
  let zeroCrossings = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    squareSum += sample * sample;
    absoluteMax = Math.max(absoluteMax, Math.abs(sample));
    if (index > 0 && Math.sign(sample) !== Math.sign(samples[index - 1])) zeroCrossings += 1;
  }
  const rms = Math.sqrt(squareSum / samples.length);
  const crestFactor = absoluteMax / (rms + 1e-9);
  const envelopeRms: number[] = [];
  const envelopeSize = 800;
  for (let offset = 0; offset < samples.length; offset += envelopeSize) {
    let energy = 0;
    for (let index = offset; index < Math.min(samples.length, offset + envelopeSize); index += 1) {
      energy += samples[index] ** 2;
    }
    envelopeRms.push(Math.sqrt(energy / envelopeSize));
  }

  const chunkFundamentals: number[] = [];
  const chunkConfidences: number[] = [];
  for (let offset = 0; offset < samples.length; offset += 4000) {
    const chunk = analyzePcm(samples.slice(offset, offset + 4000), ML_SAMPLE_RATE);
    if (chunk.fundamentalHz > 0) chunkFundamentals.push(chunk.fundamentalHz);
    chunkConfidences.push(chunk.confidence);
  }

  const lowEnergy = powers.slice(0, 60).reduce((sum, value) => sum + value, 0);
  const highEnergy = powers.slice(60).reduce((sum, value) => sum + value, 0);
  const spectrumMedian = median(spectrum);
  const peakSharpness = (Math.max(...spectrum) - spectrumMedian) / 60;
  const tonalDensity = spectrum.filter((db) => db >= spectrumMedian + 12).length / spectrum.length;

  return Float32Array.from([
    result.confidence,
    sigmoid((result.harmonicScoreDb - 8.5) / 2.3),
    result.positiveFrames / Math.max(1, result.analyzedFrames),
    Math.min(1, result.fundamentalHz / 1600),
    Math.min(1, centroidHz / 4000),
    Math.min(1, spreadHz / 4000),
    Math.min(1, flatness),
    Math.min(1, rms * 5),
    Math.min(1, crestFactor / 10),
    zeroCrossings / samples.length,
    Math.min(1, standardDeviation(envelopeRms) / (mean(envelopeRms) + 1e-9)),
    Math.min(1, standardDeviation(chunkFundamentals) / (mean(chunkFundamentals) + 1e-9)),
    Math.min(1, standardDeviation(chunkConfidences)),
    Math.min(1, highEnergy / (lowEnergy + highEnergy + 1e-12)),
    Math.min(1, peakSharpness),
    Math.min(1, tonalDensity * 8),
  ]);
}

export function pcmWindows(
  input: Float32Array,
  inputSampleRate: number,
): Float32Array[] {
  const samples = resampleLinear(input, inputSampleRate, ML_SAMPLE_RATE);
  if (samples.length <= ML_WINDOW_SAMPLES) {
    const padded = new Float32Array(ML_WINDOW_SAMPLES);
    padded.set(samples);
    return [padded];
  }
  const windows: Float32Array[] = [];
  for (let offset = 0; offset + ML_WINDOW_SAMPLES <= samples.length; offset += ML_HOP_SAMPLES) {
    windows.push(samples.slice(offset, offset + ML_WINDOW_SAMPLES));
  }
  return windows;
}
