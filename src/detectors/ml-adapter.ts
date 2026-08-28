import * as ort from "onnxruntime-web";
import { analyzePcm } from "../detector";
import { extractMlFeatures, pcmWindows } from "../ml/features";
import {
  aggregateProbabilities,
  normalizeFeatures,
  parseMlModelArtifact,
  type MlModelArtifact,
} from "../ml/model";
import { DspDetectorAdapter } from "./dsp-adapter";
import type { DetectorAdapter, DetectorOutput } from "./types";

export class MlOnnxDetectorAdapter implements DetectorAdapter {
  readonly id = "ml-onnx-v1" as const;
  readonly label = "Feature Conv ML";
  readonly version = "1.0.0";
  readonly isOperational: boolean;
  readonly artifact: MlModelArtifact;
  private readonly session?: ort.InferenceSession;
  private readonly fallback = new DspDetectorAdapter();
  private readonly initializationError?: string;

  private constructor(
    artifact: MlModelArtifact,
    session?: ort.InferenceSession,
    initializationError?: string,
  ) {
    this.artifact = artifact;
    this.session = session;
    this.initializationError = initializationError;
    this.isOperational = Boolean(session);
  }

  static async create(
    artifactUrl = "/models/drone-binary-v1.json",
  ): Promise<MlOnnxDetectorAdapter> {
    const response = await fetch(artifactUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load ML metadata (${response.status})`);
    const artifact = parseMlModelArtifact(await response.json());
    try {
      ort.env.wasm.numThreads = 1;
      const session = await ort.InferenceSession.create(artifact.modelUrl, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      return new MlOnnxDetectorAdapter(artifact, session);
    } catch (error) {
      return new MlOnnxDetectorAdapter(artifact, undefined, String(error));
    }
  }

  async analyze(samples: Float32Array, sampleRate: number): Promise<DetectorOutput> {
    if (!this.session) {
      const fallback = await this.fallback.analyze(samples, sampleRate);
      return {
        ...fallback,
        fallbackReason: `ONNX could not start: ${this.initializationError ?? "unknown error"}`,
      };
    }
    const started = performance.now();
    const probabilities: number[] = [];
    for (const window of pcmWindows(samples, sampleRate)) {
      const features = extractMlFeatures(window, 16_000);
      const normalized = normalizeFeatures(features, this.artifact);
      const tensor = new ort.Tensor("float32", normalized, [1, normalized.length, 1]);
      const output = await this.session.run({ [this.artifact.inputName]: tensor });
      probabilities.push(Number(output[this.artifact.outputName].data[0]));
    }
    const temporal = aggregateProbabilities(
      probabilities,
      this.artifact.threshold,
      this.artifact.temporal,
    );
    const dsp = analyzePcm(samples, sampleRate);
    return {
      detectorId: this.id,
      detectorLabel: this.label,
      version: this.version,
      detected: temporal.detected,
      probability: temporal.confidence,
      threshold: this.artifact.threshold,
      latencyMs: performance.now() - started,
      positiveWindows: temporal.positiveWindows,
      analyzedWindows: temporal.analyzedWindows,
      classifications: temporal.detected
        ? dsp.classifications
        : [{ profile: "ambient", label: "Background / unknown", confidence: 1 - temporal.confidence }],
    };
  }
}

export async function loadDetectorSuite(): Promise<{
  dsp: DspDetectorAdapter;
  ml: MlOnnxDetectorAdapter;
  defaultDetector: DetectorAdapter;
}> {
  const dsp = new DspDetectorAdapter();
  const ml = await MlOnnxDetectorAdapter.create();
  return {
    dsp,
    ml,
    defaultDetector: ml.isOperational && ml.artifact.qualityGate.passed ? ml : dsp,
  };
}
