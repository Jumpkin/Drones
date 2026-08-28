import { generateDronePcm } from "./audio";
import type { DroneProfileId } from "./sim";

export interface BenchmarkEnvironment {
  id: "quiet" | "urban" | "loud-structured";
  ambientRms: number;
  machineryAmplitude: number;
}

export const BENCHMARK_ENVIRONMENTS: BenchmarkEnvironment[] = [
  { id: "quiet", ambientRms: 0.02, machineryAmplitude: 0 },
  { id: "urban", ambientRms: 0.05, machineryAmplitude: 0.018 },
  { id: "loud-structured", ambientRms: 0.1, machineryAmplitude: 0.05 },
];

export type HardNegativeKind =
  | "fan"
  | "engine"
  | "helicopter"
  | "traffic"
  | "lawn-mower"
  | "vacuum";

export const HARD_NEGATIVE_KINDS: HardNegativeKind[] = [
  "fan",
  "engine",
  "helicopter",
  "traffic",
  "lawn-mower",
  "vacuum",
];

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function gaussian(random: () => number): number {
  const a = Math.max(Number.EPSILON, random());
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * random());
}

function clampAudio(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

export function makeAmbient(
  length: number,
  sampleRate: number,
  environment: BenchmarkEnvironment,
  random: () => number,
  structured = true,
): Float32Array {
  const output = new Float32Array(length);
  const machineryFundamental = 105 + random() * 85;
  const machineryPhase = random() * Math.PI * 2;
  for (let index = 0; index < length; index += 1) {
    const time = index / sampleRate;
    let machinery = 0;
    if (structured) {
      for (let harmonic = 1; harmonic <= 3; harmonic += 1) {
        machinery += Math.sin(
          2 * Math.PI * machineryFundamental * harmonic * time + machineryPhase,
        ) * environment.machineryAmplitude / harmonic;
      }
    }
    output[index] = clampAudio(
      gaussian(random) * environment.ambientRms +
      Math.sin(2 * Math.PI * 57 * time) * environment.ambientRms * 0.22 +
      machinery,
    );
  }
  return output;
}

export function makeDroneObservation(
  profile: DroneProfileId,
  durationS: number,
  sampleRate: number,
  distanceM: number,
  environment: BenchmarkEnvironment,
  random: () => number,
): Float32Array {
  const drone = generateDronePcm(profile, durationS, sampleRate, -20 + random() * 40, 0);
  const observation = makeAmbient(drone.length, sampleRate, environment, random);
  const gain = Math.min(1, 0.72 * 25 / Math.max(1, distanceM)) * (0.75 + random() * 0.5);
  for (let index = 0; index < observation.length; index += 1) {
    observation[index] = clampAudio(observation[index] + drone[index] * gain);
  }
  return observation;
}

export function makeHardNegative(
  kind: HardNegativeKind,
  durationS: number,
  sampleRate: number,
  environment: BenchmarkEnvironment,
  random: () => number,
): Float32Array {
  const output = makeAmbient(Math.round(durationS * sampleRate), sampleRate, environment, random, false);
  const bases: Record<HardNegativeKind, number> = {
    fan: 90,
    engine: 135,
    helicopter: 28,
    traffic: 62,
    "lawn-mower": 118,
    vacuum: 210,
  };
  const base = bases[kind] * (0.85 + random() * 0.3);
  const phase = random() * Math.PI * 2;
  const amplitude = 0.035 + random() * 0.075;
  for (let index = 0; index < output.length; index += 1) {
    const time = index / sampleRate;
    const slowPulse = kind === "helicopter" ? 0.6 + 0.4 * Math.sin(2 * Math.PI * 3.5 * time) : 1;
    const unstable = kind === "engine" || kind === "lawn-mower"
      ? 1 + 0.003 * Math.sin(2 * Math.PI * 0.7 * time)
      : 1;
    let signal = 0;
    const harmonics = kind === "traffic" ? 2 : kind === "vacuum" ? 5 : 4;
    for (let harmonic = 1; harmonic <= harmonics; harmonic += 1) {
      signal += Math.sin(2 * Math.PI * base * unstable * harmonic * time + phase) *
        amplitude * slowPulse / harmonic ** 0.72;
    }
    if (kind === "traffic") {
      signal += gaussian(random) * 0.055 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.12 * time) ** 2);
    }
    output[index] = clampAudio(output[index] + signal);
  }
  return output;
}
