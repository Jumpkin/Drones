import * as ort from "onnxruntime-web";
import { analyzePcm } from "../detector";
import {
  CRNN_MEL_BINS,
  CRNN_TIME_FRAMES,
  aggregateCrnnProbabilities,
  combineCrnnFeatures,
  crnnWindows,
  parsePretrainedCrnnArtifact,
  type PretrainedCrnnArtifact,
} from "../crnn/model";
import { DspDetectorAdapter } from "./dsp-adapter";
import type { DetectorAdapter, DetectorOutput } from "./types";

export class PretrainedCrnnDetectorAdapter implements DetectorAdapter {
  readonly id = "crnn-pretrained-v1" as const;
  readonly label = "Pretrained CRNN";
  readonly version: string;
  readonly isOperational: boolean;
  readonly artifact: PretrainedCrnnArtifact;
  private readonly session?: ort.InferenceSession;
  private readonly fallback = new DspDetectorAdapter();
  private readonly initializationError?: string;

  private constructor(
    artifact: PretrainedCrnnArtifact,
    session?: ort.InferenceSession,
    initializationError?: string,
  ) {
    this.artifact = artifact;
    this.version = artifact.version;
    this.session = session;
    this.initializationError = initializationError;
    this.isOperational = Boolean(session);
  }

  static async create(
    artifactUrl = "/models/drone-classifier-crnn-v1.json",
  ): Promise<PretrainedCrnnDetectorAdapter> {
    const response = await fetch(artifactUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load pretrained CRNN metadata (${response.status})`);
    const artifact = parsePretrainedCrnnArtifact(await response.json());
    try {
      ort.env.wasm.numThreads = 1;
      const session = await ort.InferenceSession.create(artifact.modelUrl, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      return new PretrainedCrnnDetectorAdapter(artifact, session);
    } catch (error) {
      return new PretrainedCrnnDetectorAdapter(artifact, undefined, String(error));
    }
  }

  async analyze(samples: Float32Array, sampleRate: number): Promise<DetectorOutput> {
    if (!this.session) {
      const fallback = await this.fallback.analyze(samples, sampleRate);
      return {
        ...fallback,
        fallbackReason: `Pretrained CRNN could not start: ${this.initializationError ?? "unknown error"}`,
      };
    }
    const started = performance.now();
    const windows = crnnWindows(samples, sampleRate);
    const tensor = new ort.Tensor(
      "float32",
      combineCrnnFeatures(windows),
      [windows.length, 1, CRNN_MEL_BINS, CRNN_TIME_FRAMES],
    );
    const output = await this.session.run({ [this.artifact.inputName]: tensor });
    const probabilities = Array.from(output[this.artifact.outputName].data, Number);
    const temporal = aggregateCrnnProbabilities(probabilities, this.artifact);
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
