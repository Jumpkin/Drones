import type { DetectorResult } from "./detector";

export interface AcousticEvent {
  schemaVersion: 1;
  nodeId: string;
  capturedAtMs: number;
  windowMs: number;
  snrEstimateDb: number;
  fundamentalHz: number;
  harmonicScoreDb: number;
  detectionConfidence: number;
  classificationTopK: Array<{
    label: string;
    confidence: number;
  }>;
  clockUncertaintyMs: number;
}

export interface FusedTrack {
  trackId: string;
  classLabel: string;
  confidence: number;
  rangeBandM: [number, number] | null;
  radialState: "approaching" | "receding" | "unknown";
  bearingDeg: number | null;
  headingDeg: number | null;
  altitudeM: number | null;
  origin: null;
  lastSeenMs: number;
}

export function createAcousticEvent(
  nodeId: string,
  result: DetectorResult,
  capturedAtMs = Date.now(),
): AcousticEvent {
  return {
    schemaVersion: 1,
    nodeId,
    capturedAtMs,
    windowMs: Math.round(result.analyzedFrames * 512 / result.spectrumSampleRate * 1000),
    snrEstimateDb: result.harmonicScoreDb,
    fundamentalHz: result.fundamentalHz,
    harmonicScoreDb: result.harmonicScoreDb,
    detectionConfidence: result.confidence,
    classificationTopK: result.classifications.map((item) => ({
      label: item.label,
      confidence: item.confidence,
    })),
    clockUncertaintyMs: 2.5,
  };
}

export function fuseSingleNodeEvent(event: AcousticEvent): FusedTrack {
  return {
    trackId: `track-${event.nodeId}`,
    classLabel: event.classificationTopK[0]?.label ?? "Okänd",
    confidence: event.detectionConfidence,
    rangeBandM: event.detectionConfidence > 0.4 ? [20, 160] : null,
    radialState: "unknown",
    bearingDeg: null,
    headingDeg: null,
    altitudeM: null,
    origin: null,
    lastSeenMs: event.capturedAtMs,
  };
}
