import { analyzePcm } from "../detector";
import type { DetectorAdapter, DetectorOutput } from "./types";

export class DspDetectorAdapter implements DetectorAdapter {
  readonly id = "dsp-v1" as const;
  readonly label = "FFT / harmonik DSP";
  readonly version = "1.0.0";
  readonly isOperational = true;

  async analyze(samples: Float32Array, sampleRate: number): Promise<DetectorOutput> {
    const started = performance.now();
    const result = analyzePcm(samples, sampleRate);
    return {
      detectorId: this.id,
      detectorLabel: this.label,
      version: this.version,
      detected: result.detected,
      probability: result.confidence,
      threshold: 0.42,
      latencyMs: performance.now() - started,
      positiveWindows: result.positiveFrames,
      analyzedWindows: result.analyzedFrames,
      classifications: result.classifications,
    };
  }
}
