import {
  DRONE_PROFILES,
  bladePassFrequency,
  clamp,
  type DroneProfileId,
} from "./sim";

export interface SpectralPeak {
  frequencyHz: number;
  amplitude: number;
}

export interface ListenerClassification {
  profile: DroneProfileId;
  label: string;
  confidence: number;
  estimatedFundamentalHz: number;
}

const timbre: Record<DroneProfileId, { rolloff: number; wobbleHz: number }> = {
  camera: { rolloff: 0.72, wobbleHz: 18 },
  fpv: { rolloff: 0.56, wobbleHz: 31 },
  fixedWing: { rolloff: 0.9, wobbleHz: 11 },
  combustion: { rolloff: 0.42, wobbleHz: 8 },
};

export function createSignature(
  profileId: DroneProfileId,
  rpmShiftPercent = 0,
): SpectralPeak[] {
  const profile = DRONE_PROFILES[profileId];
  const rpm = profile.baseRpm * (1 + rpmShiftPercent / 100);
  const fundamental = bladePassFrequency(profile.rotorBlades, rpm);
  const peaks: SpectralPeak[] = [];

  for (let harmonic = 1; harmonic <= 10; harmonic += 1) {
    const frequencyHz = fundamental * harmonic;
    if (frequencyHz > 5000) break;
    const formant = 1 + Math.sin(harmonic * timbre[profileId].wobbleHz * 0.17) * 0.12;
    peaks.push({
      frequencyHz,
      amplitude: (formant / harmonic ** timbre[profileId].rolloff) *
        (profileId === "combustion" && harmonic % 2 === 1 ? 1.18 : 1),
    });
  }

  return peaks;
}

export function mixSignatures(
  profiles: DroneProfileId[],
  rpmShiftPercent = 0,
): SpectralPeak[] {
  const peaks = profiles.flatMap((profile, sourceIndex) =>
    createSignature(profile, rpmShiftPercent + sourceIndex * 3.5).map((peak) => ({
      ...peak,
      amplitude: peak.amplitude * (1 - sourceIndex * 0.12),
    })),
  );
  return peaks.sort((a, b) => a.frequencyHz - b.frequencyHz);
}

function nearestPeakScore(peaks: SpectralPeak[], targetHz: number): number {
  const tolerance = Math.max(12, targetHz * 0.035);
  let best = 0;
  for (const peak of peaks) {
    const distance = Math.abs(peak.frequencyHz - targetHz);
    if (distance <= tolerance) {
      best = Math.max(best, peak.amplitude * (1 - distance / tolerance));
    }
  }
  return best;
}

export function classifySpectrum(peaks: SpectralPeak[]): ListenerClassification[] {
  if (peaks.length === 0) return [];
  const candidates: ListenerClassification[] = [];

  for (const profile of Object.values(DRONE_PROFILES)) {
    let bestScore = 0;
    let bestFundamental = 0;
    for (let scale = 0.65; scale <= 1.351; scale += 0.025) {
      const fundamental = bladePassFrequency(
        profile.rotorBlades,
        profile.baseRpm * scale,
      );
      let score = 0;
      let weight = 0;
      for (let harmonic = 1; harmonic <= 7; harmonic += 1) {
        const harmonicWeight = 1 / harmonic ** 0.38;
        score += nearestPeakScore(peaks, fundamental * harmonic) * harmonicWeight;
        weight += harmonicWeight;
      }
      const normalized = score / Math.max(0.01, weight);
      if (normalized > bestScore) {
        bestScore = normalized;
        bestFundamental = fundamental;
      }
    }
    candidates.push({
      profile: profile.id,
      label: profile.label,
      confidence: clamp(bestScore / 0.9),
      estimatedFundamentalHz: bestFundamental,
    });
  }

  const sorted = candidates.sort((a, b) => b.confidence - a.confidence);
  const accepted: ListenerClassification[] = [];
  for (const candidate of sorted) {
    if (candidate.confidence < 0.34) continue;
    const overlaps = accepted.some(
      (item) =>
        Math.abs(item.estimatedFundamentalHz - candidate.estimatedFundamentalHz) <
        Math.max(18, candidate.estimatedFundamentalHz * 0.08),
    );
    if (!overlaps) accepted.push(candidate);
    if (accepted.length === 3) break;
  }
  return accepted;
}

let audioContext: AudioContext | undefined;

function createNoiseGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return (state / 0xffffffff) * 2 - 1;
  };
}

export function generateDronePcm(
  profileId: DroneProfileId,
  durationS = 3.2,
  sampleRate = 16000,
  rpmShiftPercent = 0,
  noiseLevel = 0.035,
): Float32Array {
  const signature = createSignature(profileId, rpmShiftPercent).slice(0, 8);
  const length = Math.round(durationS * sampleRate);
  const output = new Float32Array(length);
  const noise = createNoiseGenerator(0xd04e + profileId.length * 97);
  const wobble = timbre[profileId].wobbleHz;
  for (let index = 0; index < length; index += 1) {
    const time = index / sampleRate;
    const envelope = 0.82 + Math.sin(2 * Math.PI * wobble * time) * 0.12;
    let sample = 0;
    for (const peak of signature) {
      const driftedFrequency = peak.frequencyHz * (1 + 0.018 * time / durationS);
      sample += Math.sin(2 * Math.PI * driftedFrequency * time) *
        Math.min(0.24, peak.amplitude * 0.08);
    }
    output[index] = Math.max(-1, Math.min(1, sample * envelope + noise() * noiseLevel));
  }
  return output;
}

export function generateAmbientPcm(
  durationS = 3.2,
  sampleRate = 16000,
): Float32Array {
  const length = Math.round(durationS * sampleRate);
  const output = new Float32Array(length);
  const noise = createNoiseGenerator(0xa11ce);
  for (let index = 0; index < length; index += 1) {
    const broadband = noise() * 0.11;
    const trafficRumble = Math.sin(2 * Math.PI * 57 * index / sampleRate) * 0.018;
    output[index] = broadband + trafficRumble;
  }
  return output;
}

export async function loadMonoPcm(
  url: string,
): Promise<{ samples: Float32Array; sampleRate: number; buffer: AudioBuffer }> {
  audioContext ??= new AudioContext();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load audio file (${response.status})`);
  const encoded = await response.arrayBuffer();
  const buffer = await audioContext.decodeAudioData(encoded.slice(0));
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < mono.length; index += 1) {
      mono[index] += data[index] / buffer.numberOfChannels;
    }
  }
  return { samples: mono, sampleRate: buffer.sampleRate, buffer };
}

export async function playAudioBuffer(buffer: AudioBuffer, maxDurationS = 8): Promise<void> {
  audioContext ??= new AudioContext();
  await audioContext.resume();
  const source = audioContext.createBufferSource();
  const gain = audioContext.createGain();
  gain.gain.value = 0.42;
  source.buffer = buffer;
  source.connect(gain);
  gain.connect(audioContext.destination);
  source.start(0, 0, Math.min(buffer.duration, maxDurationS));
}

export async function playPcm(
  samples: Float32Array,
  sampleRate: number,
): Promise<void> {
  audioContext ??= new AudioContext();
  await audioContext.resume();
  const buffer = audioContext.createBuffer(1, samples.length, sampleRate);
  buffer.getChannelData(0).set(samples);
  await playAudioBuffer(buffer);
}

export async function playDroneMixture(
  profiles: DroneProfileId[],
  rpmShiftPercent = 0,
  durationS = 3.2,
): Promise<void> {
  audioContext ??= new AudioContext();
  await audioContext.resume();
  const now = audioContext.currentTime;
  const master = audioContext.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.16, now + 0.08);
  master.gain.setValueAtTime(0.16, now + durationS - 0.12);
  master.gain.exponentialRampToValueAtTime(0.0001, now + durationS);
  master.connect(audioContext.destination);

  profiles.forEach((profileId, sourceIndex) => {
    const signature = createSignature(
      profileId,
      rpmShiftPercent + sourceIndex * 3.5,
    );
    const sourceGain = audioContext!.createGain();
    sourceGain.gain.value = 0.42 / Math.max(1, profiles.length);
    sourceGain.connect(master);

    const lfo = audioContext!.createOscillator();
    const lfoGain = audioContext!.createGain();
    lfo.frequency.value = timbre[profileId].wobbleHz;
    lfoGain.gain.value = 0.07;
    lfo.connect(lfoGain);
    lfoGain.connect(sourceGain.gain);
    lfo.start(now);
    lfo.stop(now + durationS);

    signature.slice(0, 8).forEach((peak) => {
      const oscillator = audioContext!.createOscillator();
      const harmonicGain = audioContext!.createGain();
      oscillator.type = profileId === "combustion" ? "sawtooth" : "sine";
      oscillator.frequency.setValueAtTime(peak.frequencyHz, now);
      oscillator.frequency.linearRampToValueAtTime(
        peak.frequencyHz * 1.018,
        now + durationS,
      );
      harmonicGain.gain.value = Math.min(0.2, peak.amplitude * 0.075);
      oscillator.connect(harmonicGain);
      harmonicGain.connect(sourceGain);
      oscillator.start(now);
      oscillator.stop(now + durationS);
    });
  });
}
