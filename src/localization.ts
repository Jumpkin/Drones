export interface Point2D {
  x: number;
  y: number;
}

export interface ListenerNode {
  id: string;
  position: Point2D;
  clockOffsetMs: number;
  clockDriftPpm: number;
}

export interface ArrivalObservation {
  nodeId: string;
  observedArrivalS: number;
  calibratedArrivalS: number;
  clockCorrectionMs: number;
}

export interface LocalizationResult {
  estimatedPosition: Point2D;
  truePosition: Point2D;
  errorM: number;
  bearingDeg: number;
  confidence: number;
  residualMs: number;
  altitudeM: null;
  sourceCount: 1;
  observations: ArrivalObservation[];
}

const SOUND_SPEED_MS = 343;

export function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function simulateArrivals(
  listeners: ListenerNode[],
  source: Point2D,
  emissionTimeS = 1,
  recordingDurationS = 5,
): ArrivalObservation[] {
  return listeners.map((listener) => {
    const travelS = distance(listener.position, source) / SOUND_SPEED_MS;
    const driftS = recordingDurationS * listener.clockDriftPpm / 1_000_000;
    const clockErrorS = listener.clockOffsetMs / 1000 + driftS;
    const observedArrivalS = emissionTimeS + travelS + clockErrorS;
    return {
      nodeId: listener.id,
      observedArrivalS,
      calibratedArrivalS: observedArrivalS - clockErrorS,
      clockCorrectionMs: clockErrorS * 1000,
    };
  });
}

function tdoaError(
  point: Point2D,
  listeners: ListenerNode[],
  arrivals: ArrivalObservation[],
): number {
  const referenceNode = listeners[0];
  const referenceArrival = arrivals[0].calibratedArrivalS;
  let error = 0;
  for (let index = 1; index < listeners.length; index += 1) {
    const observedDifference = arrivals[index].calibratedArrivalS - referenceArrival;
    const predictedDifference = (
      distance(point, listeners[index].position) -
      distance(point, referenceNode.position)
    ) / SOUND_SPEED_MS;
    error += (observedDifference - predictedDifference) ** 2;
  }
  return error;
}

export function localizeGrid(
  listeners: ListenerNode[],
  arrivals: ArrivalObservation[],
  bounds: { width: number; height: number },
): { position: Point2D; residualMs: number } {
  if (listeners.length < 3 || arrivals.length !== listeners.length) {
    throw new Error("2D TDOA requires three matching listener observations");
  }
  let best = { position: { x: 0, y: 0 }, error: Number.POSITIVE_INFINITY };
  const scan = (origin: Point2D, radius: number, step: number): void => {
    const minX = Math.max(0, origin.x - radius);
    const maxX = Math.min(bounds.width, origin.x + radius);
    const minY = Math.max(0, origin.y - radius);
    const maxY = Math.min(bounds.height, origin.y + radius);
    for (let x = minX; x <= maxX; x += step) {
      for (let y = minY; y <= maxY; y += step) {
        const position = { x, y };
        const error = tdoaError(position, listeners, arrivals);
        if (error < best.error) best = { position, error };
      }
    }
  };
  scan({ x: bounds.width / 2, y: bounds.height / 2 }, Math.max(bounds.width, bounds.height), 5);
  scan(best.position, 10, 0.5);
  return {
    position: best.position,
    residualMs: Math.sqrt(best.error / (listeners.length - 1)) * 1000,
  };
}

export function analyzeOfflineTrial(
  listeners: ListenerNode[],
  source: Point2D,
  bounds: { width: number; height: number },
): LocalizationResult {
  const observations = simulateArrivals(listeners, source);
  const localized = localizeGrid(listeners, observations, bounds);
  const centroid = listeners.reduce(
    (sum, listener) => ({ x: sum.x + listener.position.x, y: sum.y + listener.position.y }),
    { x: 0, y: 0 },
  );
  centroid.x /= listeners.length;
  centroid.y /= listeners.length;
  const bearingDeg = (
    Math.atan2(
      localized.position.y - centroid.y,
      localized.position.x - centroid.x,
    ) * 180 / Math.PI + 360
  ) % 360;
  const errorM = distance(localized.position, source);
  return {
    estimatedPosition: localized.position,
    truePosition: source,
    errorM,
    bearingDeg,
    confidence: Math.max(0, Math.min(1, 1 - localized.residualMs / 2.5 - errorM / 120)),
    residualMs: localized.residualMs,
    altitudeM: null,
    sourceCount: 1,
    observations,
  };
}

export function estimateDelaySamples(
  reference: Float32Array,
  target: Float32Array,
  maxLagSamples: number,
): number {
  let bestLag = 0;
  let bestCorrelation = Number.NEGATIVE_INFINITY;
  for (let lag = -maxLagSamples; lag <= maxLagSamples; lag += 1) {
    let sum = 0;
    let refEnergy = 0;
    let targetEnergy = 0;
    const start = Math.max(0, -lag);
    const end = Math.min(reference.length, target.length - lag);
    for (let index = start; index < end; index += 4) {
      const a = reference[index];
      const b = target[index + lag];
      sum += a * b;
      refEnergy += a * a;
      targetEnergy += b * b;
    }
    const correlation = sum / Math.sqrt(refEnergy * targetEnergy + 1e-12);
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }
  return bestLag;
}
