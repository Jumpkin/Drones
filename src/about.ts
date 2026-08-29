import type { BenchmarkRunReport, HeadlessReport } from "./stats";

export type AboutSourceGroup = "shipped" | "local" | "data";

export interface AboutSource {
  name: string;
  url: string;
  group: AboutSourceGroup;
  relationship: string;
  license: string;
}

export const ABOUT_SOURCES: AboutSource[] = [
  {
    name: "Drones",
    url: "https://github.com/Jumpkin/Drones",
    group: "shipped",
    relationship: "Application source, simulation code, browser detectors, and reports",
    license: "No project-wide reuse license selected",
  },
  {
    name: "Batear Datasets",
    url: "https://github.com/batear-io/batear-datasets",
    group: "shipped",
    relationship: "Three drone recordings and one rural background fixture",
    license: "MIT",
  },
  {
    name: "Antoine Naccache drone-audio-detector",
    url: "https://huggingface.co/AntoineNaccache/drone-audio-detector",
    group: "shipped",
    relationship: "Pretrained CRNN converted to browser ONNX at a pinned revision",
    license: "MIT",
  },
  {
    name: "fft.js",
    url: "https://github.com/indutny/fft.js",
    group: "shipped",
    relationship: "FFT implementation used by the harmonic detector and CRNN preprocessing",
    license: "MIT",
  },
  {
    name: "ONNX Runtime Web",
    url: "https://github.com/microsoft/onnxruntime/tree/main/js/web",
    group: "shipped",
    relationship: "In-browser inference runtime for the two ONNX detectors",
    license: "MIT",
  },
  {
    name: "YAMNet drone detector",
    url: "https://github.com/jwehlen-cell/yamnet-drone-detector",
    group: "local",
    relationship: "External binary head used only by optional local benchmarks",
    license: "README claims MIT; no upstream LICENSE file found during review",
  },
  {
    name: "Google YAMNet",
    url: "https://tfhub.dev/google/yamnet/1",
    group: "local",
    relationship: "Audio embedding model loaded by the optional YAMNet benchmark",
    license: "See upstream model terms",
  },
  {
    name: "Samid AST drone detector",
    url: "https://huggingface.co/Rashidbm/samid-drone-detector",
    group: "local",
    relationship: "Heavyweight reference model evaluated locally; weights are not shipped",
    license: "See upstream model card",
  },
  {
    name: "Geronimo drone audio samples",
    url: "https://huggingface.co/datasets/geronimobasso/drone-audio-detection-samples",
    group: "data",
    relationship: "Training-source compatibility data for imported models",
    license: "MIT",
  },
  {
    name: "Sara Al-Emadi DroneAudioDataset",
    url: "https://github.com/saraalemadi/DroneAudioDataset",
    group: "data",
    relationship: "YAMNet-head source-domain compatibility data",
    license: "No explicit upstream license file",
  },
  {
    name: "Drone Visualization",
    url: "https://github.com/mackenzie-jane/drone-visualization",
    group: "data",
    relationship: "Positive source clips referenced by the external YAMNet head",
    license: "No explicit upstream license file",
  },
  {
    name: "AHLab DroneAudioSet",
    url: "https://huggingface.co/datasets/ahlab-drone-project/DroneAudioSet",
    group: "data",
    relationship: "Bounded Samid source-domain compatibility sample",
    license: "MIT",
  },
  {
    name: "FSD50K dataset and paper",
    url: "https://zenodo.org/records/4060432",
    group: "data",
    relationship: "Optional hard-negative importer; not part of the current committed run",
    license: "Per-clip; importer accepts CC0 and CC-BY only",
  },
];

export interface AboutSnapshot {
  generatedAt: string;
  seed: number;
  sampleRate: number;
  clipDurationS: number;
  syntheticTests: number;
  phoneProxyTests: number;
  benchmarkRuns: number;
  localizationTrials: number;
  localizationJitterLevels: number;
  recommendation: string;
}

export function createAboutSnapshot(
  report: HeadlessReport,
  benchmarkReport: BenchmarkRunReport,
): AboutSnapshot {
  const syntheticRun = benchmarkReport.runs.find((run) => run.evidenceClass === "synthetic");
  const phoneRun = benchmarkReport.runs.find((run) => run.evidenceClass === "phone-proxy");
  return {
    generatedAt: report.generatedAt,
    seed: report.seed,
    sampleRate: report.configuration.sampleRate,
    clipDurationS: report.configuration.clipDurationS,
    syntheticTests: syntheticRun?.totalTests ?? 0,
    phoneProxyTests: phoneRun?.totalTests ?? 0,
    benchmarkRuns: benchmarkReport.runs.length,
    localizationTrials: report.localization.reduce((sum, row) => sum + row.trials, 0),
    localizationJitterLevels: report.localization.length,
    recommendation: benchmarkReport.recommendation,
  };
}
