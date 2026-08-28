import type { DroneProfileId } from "./sim";

export type SampleKind = "real" | "synthetic" | "ambient";

export interface AudioSampleDefinition {
  id: string;
  label: string;
  kind: SampleKind;
  expectedProfile: DroneProfileId | "ambient";
  localUrl?: string;
  sourceUrl?: string;
  sourceLabel: string;
  license: string;
  note: string;
}

export const AUDIO_SAMPLES: AudioSampleDefinition[] = [
  {
    id: "batear-fpv-5in",
    label: "5-tums FPV · verklig WAV",
    kind: "real",
    expectedProfile: "fpv",
    localUrl: "/audio/batear-fpv-5inch.wav",
    sourceUrl: "https://github.com/batear-io/batear-datasets/blob/main/field-tests/FPV/5inch_resampled/20260415_192504.wav",
    sourceLabel: "Batear Datasets",
    license: "MIT",
    note: "Fältinspelning, 16 kHz stereo. Detektorn får inte läsa denna etikett.",
  },
  {
    id: "batear-mavic-pro",
    label: "DJI Mavic Pro · verklig WAV",
    kind: "real",
    expectedProfile: "camera",
    localUrl: "/audio/batear-mavic-pro.wav",
    sourceUrl: "https://github.com/batear-io/batear-datasets/blob/main/field-tests/DJI/mavic-pro/20260428/2474750763FAA288_20260428_072210.WAV",
    sourceLabel: "Batear Datasets",
    license: "MIT",
    note: "Fältinspelning. Avståndet är inte angivet i det publika manifestet.",
  },
  {
    id: "batear-mini-4-pro",
    label: "DJI Mini 4 Pro · verklig WAV",
    kind: "real",
    expectedProfile: "camera",
    localUrl: "/audio/batear-mini-4-pro.wav",
    sourceUrl: "https://github.com/batear-io/batear-datasets/blob/main/field-tests/DJI/mini-4-pro/20260428/2474750763FAA288_20260428_080410.WAV",
    sourceLabel: "Batear Datasets",
    license: "MIT",
    note: "Fältinspelning. Exakt modell-ID används bara som facit i UI:t.",
  },
  {
    id: "synth-camera",
    label: "Kameramultirotor · syntetisk",
    kind: "synthetic",
    expectedProfile: "camera",
    sourceLabel: "Drones signalgenerator",
    license: "Projektgenererad",
    note: "Kontrollerad grundfrekvens, övertoner och amplitudmodulation.",
  },
  {
    id: "synth-fpv",
    label: "Snabb FPV · syntetisk",
    kind: "synthetic",
    expectedProfile: "fpv",
    sourceLabel: "Drones signalgenerator",
    license: "Projektgenererad",
    note: "Kontrollerad FPV-signatur för reproducerbara tester.",
  },
  {
    id: "synth-ambient",
    label: "Bakgrundsbrus · negativt test",
    kind: "ambient",
    expectedProfile: "ambient",
    sourceLabel: "Drones signalgenerator",
    license: "Projektgenererad",
    note: "Filtrerat deterministiskt brus utan harmonisk rotorstege.",
  },
];

export function getAudioSample(id: string): AudioSampleDefinition {
  return AUDIO_SAMPLES.find((sample) => sample.id === id) ?? AUDIO_SAMPLES[0];
}
