import type { ClassificationScore } from "../detector";

export type DetectorId = "dsp-v1" | "ml-onnx-v1";

export interface DetectorOutput {
  detectorId: DetectorId;
  detectorLabel: string;
  version: string;
  detected: boolean;
  probability: number;
  threshold: number;
  latencyMs: number;
  positiveWindows: number;
  analyzedWindows: number;
  classifications: ClassificationScore[];
  fallbackReason?: string;
}

export interface DetectorAdapter {
  readonly id: DetectorId;
  readonly label: string;
  readonly version: string;
  readonly isOperational: boolean;
  analyze(samples: Float32Array, sampleRate: number): Promise<DetectorOutput>;
}
