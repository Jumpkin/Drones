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

export interface PhoneAudioProfile {
  id: "flagship" | "budget" | "processed";
  label: string;
  highPassHz: number;
  lowPassHz: number;
  drive: number;
  selfNoiseRms: number;
}

export interface PlaybackRoomProfile {
  id: "desk" | "living-room" | "office" | "traffic";
  label: string;
  distanceM: number;
  echoDelayMs: number;
  echoGain: number;
  environment: BenchmarkEnvironment;
}

export const PHONE_AUDIO_PROFILES: PhoneAudioProfile[] = [
  { id: "flagship", label: "Flagship phone", highPassHz: 75, lowPassHz: 7_500, drive: 1.05, selfNoiseRms: 0.003 },
  { id: "budget", label: "Budget phone", highPassHz: 150, lowPassHz: 5_200, drive: 1.45, selfNoiseRms: 0.008 },
  { id: "processed", label: "Processed phone", highPassHz: 220, lowPassHz: 4_200, drive: 1.8, selfNoiseRms: 0.006 },
];

export const PLAYBACK_ROOM_PROFILES: PlaybackRoomProfile[] = [
  { id: "desk", label: "Desk · 1.5 m", distanceM: 1.5, echoDelayMs: 18, echoGain: 0.08, environment: { id: "quiet", ambientRms: 0.006, machineryAmplitude: 0 } },
  { id: "living-room", label: "Living room · 4 m", distanceM: 4, echoDelayMs: 54, echoGain: 0.24, environment: { id: "quiet", ambientRms: 0.014, machineryAmplitude: 0.003 } },
  { id: "office", label: "Office · 8 m", distanceM: 8, echoDelayMs: 92, echoGain: 0.34, environment: { id: "urban", ambientRms: 0.032, machineryAmplitude: 0.012 } },
  { id: "traffic", label: "Traffic · 4 m", distanceM: 4, echoDelayMs: 38, echoGain: 0.18, environment: { id: "loud-structured", ambientRms: 0.07, machineryAmplitude: 0.028 } },
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

export function simulatePhonePlayback(
  input: Float32Array,
  sampleRate: number,
  phone: PhoneAudioProfile,
  room: PlaybackRoomProfile,
  random: () => number,
): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("Sample rate must be positive");
  const output = new Float32Array(input.length);
  const ambient = makeAmbient(input.length, sampleRate, room.environment, random);
  const echoDelay = Math.max(1, Math.round(room.echoDelayMs * sampleRate / 1000));
  const distanceGain = 0.78 / (1 + Math.max(0, room.distanceM - 1) * 0.22);
  const lowPassRc = 1 / (2 * Math.PI * phone.lowPassHz);
  const highPassRc = 1 / (2 * Math.PI * phone.highPassHz);
  const dt = 1 / sampleRate;
  const lowPassAlpha = dt / (lowPassRc + dt);
  const highPassAlpha = highPassRc / (highPassRc + dt);
  const driveScale = Math.tanh(phone.drive);
  let lowPassed = 0;
  let highPassed = 0;
  let previousLowPassed = 0;
  for (let index = 0; index < input.length; index += 1) {
    const direct = input[index] * distanceGain;
    const echoed = index >= echoDelay ? input[index - echoDelay] * distanceGain * room.echoGain : 0;
    const roomSignal = direct + echoed + ambient[index] + gaussian(random) * phone.selfNoiseRms;
    lowPassed += lowPassAlpha * (roomSignal - lowPassed);
    highPassed = highPassAlpha * (highPassed + lowPassed - previousLowPassed);
    previousLowPassed = lowPassed;
    output[index] = clampAudio(Math.tanh(highPassed * phone.drive) / driveScale);
  }
  return output;
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
