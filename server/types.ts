export type SessionRole = "source" | "listener";
export type ExpectedLabel = "drone" | "background";
export type DetectorId = "dsp-v1" | "ml-onnx-v1" | "crnn-pretrained-v1";

export interface DetectorObservation {
  detectorId: DetectorId;
  version: string;
  detected: boolean;
  probability: number;
  threshold: number;
  latencyMs: number;
  positiveWindows: number;
  analyzedWindows: number;
}

export interface ObservationEvent {
  id: string;
  capturedAt: string;
  sessionId?: string;
  playbackId?: string;
  sampleRate: number;
  windowDurationMs: number;
  location?: {
    latitude: number;
    longitude: number;
    horizontalAccuracyM: number;
    altitudeM?: number;
  };
  consensus: {
    detected: boolean;
    positiveDetectors: number;
  };
  detectors: DetectorObservation[];
  classification?: {
    profile: string;
    label: string;
    confidence: number;
  };
}

export interface AppConfig {
  databaseUrl: string;
  host: string;
  port: number;
  staticDir?: string;
  rateLimitMax: number;
}
