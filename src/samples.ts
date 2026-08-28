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
    label: "5-inch FPV · real WAV",
    kind: "real",
    expectedProfile: "fpv",
    localUrl: "/audio/batear-fpv-5inch.wav",
    sourceUrl: "https://github.com/batear-io/batear-datasets/blob/main/field-tests/FPV/5inch_resampled/20260415_192504.wav",
    sourceLabel: "Batear Datasets",
    license: "MIT",
    note: "Field recording, 16 kHz stereo. The detector cannot read this label.",
  },
  {
    id: "batear-mavic-pro",
    label: "DJI Mavic Pro · real WAV",
    kind: "real",
    expectedProfile: "camera",
    localUrl: "/audio/batear-mavic-pro.wav",
    sourceUrl: "https://github.com/batear-io/batear-datasets/blob/main/field-tests/DJI/mavic-pro/20260428/2474750763FAA288_20260428_072210.WAV",
    sourceLabel: "Batear Datasets",
    license: "MIT",
    note: "Field recording. Distance is not specified in the public manifest.",
  },
  {
    id: "batear-mini-4-pro",
    label: "DJI Mini 4 Pro · real WAV",
    kind: "real",
    expectedProfile: "camera",
    localUrl: "/audio/batear-mini-4-pro.wav",
    sourceUrl: "https://github.com/batear-io/batear-datasets/blob/main/field-tests/DJI/mini-4-pro/20260428/2474750763FAA288_20260428_080410.WAV",
    sourceLabel: "Batear Datasets",
    license: "MIT",
    note: "Field recording. The exact model ID is used only as ground truth in the UI.",
  },
  {
    id: "batear-rural-8s",
    label: "Rural ambience · real negative WAV",
    kind: "real",
    expectedProfile: "ambient",
    localUrl: "/audio/batear-rural-8s.wav",
    sourceUrl: "https://github.com/batear-io/batear-datasets/blob/main/field-tests/ambient/rural/20230701_054200.WAV",
    sourceLabel: "Batear Datasets",
    license: "MIT",
    note: "Eight seconds of real background audio without a labelled drone.",
  },
  {
    id: "synth-camera",
    label: "Camera multirotor · synthetic",
    kind: "synthetic",
    expectedProfile: "camera",
    sourceLabel: "Drones signal generator",
    license: "Project-generated",
    note: "Controlled fundamental frequency, harmonics, and amplitude modulation.",
  },
  {
    id: "synth-fpv",
    label: "Fast FPV · synthetic",
    kind: "synthetic",
    expectedProfile: "fpv",
    sourceLabel: "Drones signal generator",
    license: "Project-generated",
    note: "Controlled FPV signature for reproducible tests.",
  },
  {
    id: "synth-ambient",
    label: "Background noise · negative test",
    kind: "ambient",
    expectedProfile: "ambient",
    sourceLabel: "Drones signal generator",
    license: "Project-generated",
    note: "Filtered deterministic noise without a harmonic rotor ladder.",
  },
];

export function getAudioSample(id: string): AudioSampleDefinition {
  return AUDIO_SAMPLES.find((sample) => sample.id === id) ?? AUDIO_SAMPLES[0];
}
