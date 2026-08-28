import FFT from "fft.js";
import { DRONE_PROFILES, clamp, type DroneProfileId } from "./sim";

export interface ClassificationScore {
  profile: DroneProfileId | "ambient";
  label: string;
  confidence: number;
}

export interface DetectorResult {
  detected: boolean;
  confidence: number;
  fundamentalHz: number;
  harmonicScoreDb: number;
  spectralSnrDb: number;
  noiseFloorDb: number;
  positiveFrames: number;
  analyzedFrames: number;
  spectrumDb: number[];
  spectrumSampleRate: number;
  classifications: ClassificationScore[];
}

const FFT_SIZE = 1024;
const HOP_SIZE = 512;

export function resampleLinear(
  samples: Float32Array,
  sourceRate: number,
  targetRate = 16000,
): Float32Array {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 ||
    !Number.isFinite(targetRate) || targetRate <= 0) {
    throw new Error("Sample rates must be positive finite numbers");
  }
  if (samples.length === 0) return new Float32Array();
  if (sourceRate === targetRate) return new Float32Array(samples);
  const length = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
  const output = new Float32Array(length);
  const scale = sourceRate / targetRate;
  for (let i = 0; i < length; i += 1) {
    const sourceIndex = i * scale;
    const lower = Math.floor(sourceIndex);
    const upper = Math.min(samples.length - 1, lower + 1);
    const mix = sourceIndex - lower;
    output[i] = samples[lower] * (1 - mix) + samples[upper] * mix;
  }
  return output;
}

function median(values: number[]): number {
  if (values.length === 0) return -120;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function localPeak(spectrum: number[], index: number): number {
  return Math.max(
    spectrum[Math.max(0, index - 1)] ?? -120,
    spectrum[index] ?? -120,
    spectrum[Math.min(spectrum.length - 1, index + 1)] ?? -120,
  );
}

function peakProminence(spectrum: number[], index: number): number {
  const neighbors: number[] = [];
  for (let offset = -7; offset <= 7; offset += 1) {
    if (Math.abs(offset) <= 1) continue;
    const value = spectrum[index + offset];
    if (value !== undefined) neighbors.push(value);
  }
  return localPeak(spectrum, index) - median(neighbors);
}

function classify(
  fundamentalHz: number,
  spectrumDb: number[],
  noiseFloorDb: number,
  sampleRate: number,
  detected: boolean,
): ClassificationScore[] {
  if (!detected || fundamentalHz <= 0) {
    return [{ profile: "ambient", label: "Background / unknown", confidence: 0.82 }];
  }

  const binHz = sampleRate / FFT_SIZE;
  const centroidBins = spectrumDb
    .slice(Math.round(100 / binHz), Math.round(4000 / binHz))
    .map((db, index) => ({
      hz: (index + Math.round(100 / binHz)) * binHz,
      energy: Math.max(0, db - noiseFloorDb),
    }));
  const totalEnergy = centroidBins.reduce((sum, item) => sum + item.energy, 0);
  const centroid = totalEnergy > 0
    ? centroidBins.reduce((sum, item) => sum + item.hz * item.energy, 0) / totalEnergy
    : fundamentalHz;

  const results = Object.values(DRONE_PROFILES).map((profile) => {
    const nominal = profile.rotorBlades * profile.baseRpm / 60;
    const ratio = fundamentalHz / nominal;
    const rpmCompatibility = Math.exp(-Math.abs(Math.log(Math.max(0.1, ratio))) / 0.42);
    const centroidTarget = profile.id === "fpv" ? 1750
      : profile.id === "combustion" ? 1050
        : profile.id === "fixedWing" ? 850
          : 1250;
    const centroidCompatibility = Math.exp(-Math.abs(centroid - centroidTarget) / 1500);
    const h2 = localPeak(spectrumDb, Math.round((fundamentalHz * 2) / binHz));
    const h3 = localPeak(spectrumDb, Math.round((fundamentalHz * 3) / binHz));
    const harmonicBalance = clamp(((h2 + h3) / 2 - noiseFloorDb) / 24);
    const classPrior = profile.id === "camera" && fundamentalHz >= 85 && fundamentalHz <= 300
      ? 0.24
      : profile.id === "fpv" && fundamentalHz > 300
        ? 0.2
        : 0;
    return {
      profile: profile.id,
      label: profile.label,
      confidence: clamp(
        0.5 * rpmCompatibility +
        0.22 * centroidCompatibility +
        0.18 * harmonicBalance +
        classPrior,
      ),
    };
  });

  return results.sort((a, b) => b.confidence - a.confidence).slice(0, 3);
}

export function analyzePcm(
  input: Float32Array,
  inputSampleRate: number,
): DetectorResult {
  const sampleRate = 16000;
  const samples = resampleLinear(input, inputSampleRate, sampleRate);
  const fft = new FFT(FFT_SIZE);
  const frame = new Array<number>(FFT_SIZE).fill(0);
  const complex = fft.createComplexArray();
  let analyzedFrames = 0;
  let positiveFrames = 0;
  let positiveStreak = 0;
  let maxPositiveStreak = 0;
  let confidenceSum = 0;
  let weightedFundamental = 0;
  let fundamentalWeight = 0;
  let bestScore = -120;
  let bestNoiseFloor = -120;
  let bestSignalPeak = -120;
  let accumulatedSpectrum = new Array<number>(FFT_SIZE / 2).fill(0);
  const positiveFundamentalBins: number[] = [];

  const frameCount = Math.max(1, Math.floor((samples.length - FFT_SIZE) / HOP_SIZE) + 1);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const offset = frameIndex * HOP_SIZE;
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
      frame[i] = (samples[offset + i] ?? 0) * window;
    }
    fft.realTransform(complex, frame);
    const spectrum = new Array<number>(FFT_SIZE / 2);
    for (let bin = 0; bin < spectrum.length; bin += 1) {
      const real = complex[2 * bin];
      const imaginary = complex[2 * bin + 1];
      spectrum[bin] = 10 * Math.log10(real * real + imaginary * imaginary + 1e-12);
      accumulatedSpectrum[bin] += spectrum[bin];
    }

    const binHz = sampleRate / FFT_SIZE;
    const noiseBins = spectrum.slice(Math.round(100 / binHz), Math.round(5000 / binHz));
    const noiseFloor = median(noiseBins);
    let frameBestFundamental = 0;
    let frameBestScore = -120;
    for (let bin = Math.ceil(80 / binHz); bin <= Math.floor(1600 / binHz); bin += 1) {
      const harmonic2 = bin * 2;
      const harmonic3 = bin * 3;
      if (harmonic3 >= spectrum.length) break;
      const snr1 = localPeak(spectrum, bin) - noiseFloor;
      const snr2 = localPeak(spectrum, harmonic2) - noiseFloor;
      const snr3 = localPeak(spectrum, harmonic3) - noiseFloor;
      const harmonicFloor = Math.min(snr1, snr2 + 2, snr3 + 4);
      const prominenceFloor = Math.min(
        peakProminence(spectrum, bin),
        peakProminence(spectrum, harmonic2),
        peakProminence(spectrum, harmonic3),
      );
      const combined =
        harmonicFloor +
        0.16 * (snr1 + snr2 + snr3) +
        0.72 * prominenceFloor;
      if (combined > frameBestScore) {
        frameBestScore = combined;
        frameBestFundamental = bin * binHz;
      }
    }

    const frameConfidence = clamp(sigmoid((frameBestScore - 8.5) / 2.3));
    const framePositive = frameConfidence >= 0.62;
    positiveStreak = framePositive ? positiveStreak + 1 : 0;
    maxPositiveStreak = Math.max(maxPositiveStreak, positiveStreak);
    if (framePositive) {
      positiveFrames += 1;
      positiveFundamentalBins.push(Math.round(frameBestFundamental / binHz));
      weightedFundamental += frameBestFundamental * frameConfidence;
      fundamentalWeight += frameConfidence;
    }
    confidenceSum += frameConfidence;
    if (frameBestScore > bestScore) {
      bestScore = frameBestScore;
      bestNoiseFloor = noiseFloor;
      bestSignalPeak = localPeak(spectrum, Math.round(frameBestFundamental / binHz));
    }
    analyzedFrames += 1;
  }

  accumulatedSpectrum = accumulatedSpectrum.map((value) => value / analyzedFrames);
  let stableFrames = 0;
  for (const candidate of positiveFundamentalBins) {
    const nearby = positiveFundamentalBins.filter((bin) => Math.abs(bin - candidate) <= 2).length;
    stableFrames = Math.max(stableFrames, nearby);
  }
  const frequencyStability = positiveFrames > 0 ? stableFrames / positiveFrames : 0;
  const confidence = clamp((confidenceSum / analyzedFrames) * (0.35 + 0.65 * frequencyStability));
  const detected =
    maxPositiveStreak >= 2 &&
    confidence >= 0.42 &&
    frequencyStability >= 0.28;
  const fundamentalHz = fundamentalWeight > 0 ? weightedFundamental / fundamentalWeight : 0;
  return {
    detected,
    confidence,
    fundamentalHz,
    harmonicScoreDb: bestScore,
    spectralSnrDb: Math.max(0, bestSignalPeak - bestNoiseFloor),
    noiseFloorDb: bestNoiseFloor,
    positiveFrames,
    analyzedFrames,
    spectrumDb: accumulatedSpectrum,
    spectrumSampleRate: sampleRate,
    classifications: classify(
      fundamentalHz,
      accumulatedSpectrum,
      bestNoiseFloor,
      sampleRate,
      detected,
    ),
  };
}

export function containsRawAudio(payload: unknown, visited = new WeakSet<object>()): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (ArrayBuffer.isView(payload) || payload instanceof ArrayBuffer) return true;
  if (visited.has(payload)) return false;
  visited.add(payload);
  return Object.entries(payload as Record<string, unknown>).some(([key, value]) => {
    if (/pcm|audio|samples|wav/i.test(key)) return true;
    return value && typeof value === "object" ? containsRawAudio(value, visited) : false;
  });
}
