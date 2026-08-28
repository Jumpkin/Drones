export type DroneProfileId = "camera" | "fpv" | "fixedWing" | "combustion";
export type SpoofMode = "none" | "replay" | "broadband";
export type ArrayMode = "hardware" | "wifiPhones" | "bluetoothPhones";
export type ScenarioId =
  | "quiet"
  | "fastFpv"
  | "urban"
  | "rfSilent"
  | "replay"
  | "masking"
  | "phoneMesh";

export interface Point {
  x: number;
  y: number;
}

export interface DroneProfile {
  id: DroneProfileId;
  label: string;
  sourceDb: number;
  radarFactor: number;
  rotorBlades: number;
  baseRpm: number;
  defaultSpeed: number;
}

export interface SensorToggles {
  acoustic: boolean;
  radar: boolean;
  rf: boolean;
  camera: boolean;
}

export interface SimulationConfig {
  scenario: ScenarioId;
  profile: DroneProfileId;
  dronePresent: boolean;
  speedKmh: number;
  altitudeM: number;
  windMs: number;
  ambientDb: number;
  visibility: number;
  rpmShiftPercent: number;
  radioActive: boolean;
  spoofMode: SpoofMode;
  spoofLevelDb: number;
  sensorCount: number;
  arrayMode: ArrayMode;
  droneCount: number;
  secondaryProfiles: DroneProfileId[];
  sensors: SensorToggles;
}

export interface SimulationState {
  elapsedS: number;
  drone: Point;
  target: Point;
  sensorNodes: Point[];
  secondaryDrones: Point[];
  spoofSource: Point;
}

export interface SimulationResult {
  droneDistanceToTargetM: number;
  nearestAcousticDistanceM: number;
  bladePassFrequencyHz: number;
  receivedDroneDb: number;
  effectiveNoiseDb: number;
  snrDb: number;
  acousticProbability: number;
  radarProbability: number;
  rfProbability: number;
  cameraProbability: number;
  fusionConfidence: number;
  alert: boolean;
  acousticSource: "drone" | "replay" | "noise" | "none";
  spoofRisk: number;
  bearingDeg: number;
  estimatedBearingDeg: number;
  bearingErrorDeg: number;
  arrayTimingErrorMs: number;
  arraySpatialErrorM: number;
  estimatedAltitudeM: number;
  altitudeErrorM: number;
  etaS: number;
  soundDelayS: number;
  systemLatencyS: number;
  machineMarginS: number;
  humanMarginS: number;
  nominalAcousticRangeM: number;
  status: "clear" | "possible" | "confirmed" | "jammed" | "spoof";
}

export const WORLD = { width: 700, height: 420 } as const;

export const DRONE_PROFILES: Record<DroneProfileId, DroneProfile> = {
  camera: {
    id: "camera",
    label: "Kameramultirotor",
    sourceDb: 94,
    radarFactor: 0.72,
    rotorBlades: 2,
    baseRpm: 5400,
    defaultSpeed: 58,
  },
  fpv: {
    id: "fpv",
    label: "Snabb FPV",
    sourceDb: 98,
    radarFactor: 0.52,
    rotorBlades: 3,
    baseRpm: 8500,
    defaultSpeed: 140,
  },
  fixedWing: {
    id: "fixedWing",
    label: "Elektrisk fastvinge",
    sourceDb: 90,
    radarFactor: 0.78,
    rotorBlades: 2,
    baseRpm: 4300,
    defaultSpeed: 76,
  },
  combustion: {
    id: "combustion",
    label: "Förbränningsmotor",
    sourceDb: 111,
    radarFactor: 1,
    rotorBlades: 2,
    baseRpm: 6200,
    defaultSpeed: 160,
  },
};

interface ScenarioDefinition {
  label: string;
  description: string;
  config: Omit<SimulationConfig, "scenario" | "droneCount" | "secondaryProfiles"> & {
    droneCount?: number;
    secondaryProfiles?: DroneProfileId[];
  };
  droneStart: Point;
}

const defaultSensors: SensorToggles = {
  acoustic: true,
  radar: true,
  rf: true,
  camera: true,
};

export const ARRAY_MODES: Record<ArrayMode, {
  label: string;
  timingErrorMs: number;
  audioQuality: number;
  networkLatencyS: number;
}> = {
  hardware: {
    label: "Dedikerad synkroniserad array",
    timingErrorMs: 0.02,
    audioQuality: 1,
    networkLatencyS: 0.03,
  },
  wifiPhones: {
    label: "Telefonmesh · samma Wi‑Fi",
    timingErrorMs: 2.5,
    audioQuality: 0.9,
    networkLatencyS: 0.18,
  },
  bluetoothPhones: {
    label: "Telefoner · Bluetooth-råljud",
    timingErrorMs: 10,
    audioQuality: 0.72,
    networkLatencyS: 0.45,
  },
};

export const SCENARIOS: Record<ScenarioId, ScenarioDefinition> = {
  quiet: {
    label: "En telefon · en drönare",
    description: "En telefon kan detektera och klassificera, men inte ensam bestämma unik riktning eller höjd.",
    config: {
      profile: "camera",
      dronePresent: true,
      speedKmh: 58,
      altitudeM: 55,
      windMs: 2,
      ambientDb: 38,
      visibility: 0.95,
      rpmShiftPercent: 0,
      radioActive: true,
      spoofMode: "none",
      spoofLevelDb: 72,
      sensorCount: 1,
      arrayMode: "hardware",
      sensors: { ...defaultSensors },
    },
    droneStart: { x: 630, y: 92 },
  },
  fastFpv: {
    label: "Snabb FPV",
    description: "En liten FPV flyger snabbt och lågt mot skyddsområdet.",
    config: {
      profile: "fpv",
      dronePresent: true,
      speedKmh: 140,
      altitudeM: 24,
      windMs: 6,
      ambientDb: 50,
      visibility: 0.82,
      rpmShiftPercent: 8,
      radioActive: true,
      spoofMode: "none",
      spoofLevelDb: 72,
      sensorCount: 3,
      arrayMode: "hardware",
      sensors: { ...defaultSensors },
    },
    droneStart: { x: 620, y: 118 },
  },
  urban: {
    label: "Urban ljudmiljö",
    description: "Trafik, reflektioner och sämre sikt pressar alla sensorer.",
    config: {
      profile: "camera",
      dronePresent: true,
      speedKmh: 72,
      altitudeM: 42,
      windMs: 5,
      ambientDb: 63,
      visibility: 0.58,
      rpmShiftPercent: -12,
      radioActive: true,
      spoofMode: "none",
      spoofLevelDb: 72,
      sensorCount: 3,
      arrayMode: "hardware",
      sensors: { ...defaultSensors },
    },
    droneStart: { x: 610, y: 88 },
  },
  rfSilent: {
    label: "Radiotyst fastvinge",
    description: "Autonom elektrisk fastvinge utan aktiv radiolänk.",
    config: {
      profile: "fixedWing",
      dronePresent: true,
      speedKmh: 76,
      altitudeM: 115,
      windMs: 4,
      ambientDb: 43,
      visibility: 0.72,
      rpmShiftPercent: 4,
      radioActive: false,
      spoofMode: "none",
      spoofLevelDb: 72,
      sensorCount: 3,
      arrayMode: "hardware",
      sensors: { ...defaultSensors },
    },
    droneStart: { x: 640, y: 126 },
  },
  replay: {
    label: "Replay-attack",
    description: "Ingen drönare finns; en stationär högtalare spelar upp rotorljud.",
    config: {
      profile: "camera",
      dronePresent: false,
      speedKmh: 58,
      altitudeM: 40,
      windMs: 2,
      ambientDb: 40,
      visibility: 0.9,
      rpmShiftPercent: 0,
      radioActive: false,
      spoofMode: "replay",
      spoofLevelDb: 94,
      sensorCount: 3,
      arrayMode: "hardware",
      sensors: { ...defaultSensors },
    },
    droneStart: { x: 640, y: 90 },
  },
  masking: {
    label: "Akustisk maskering",
    description: "En snabb drönare kombineras med starkt bredbandigt buller nära sensorerna.",
    config: {
      profile: "fpv",
      dronePresent: true,
      speedKmh: 140,
      altitudeM: 30,
      windMs: 4,
      ambientDb: 48,
      visibility: 0.72,
      rpmShiftPercent: 18,
      radioActive: false,
      spoofMode: "broadband",
      spoofLevelDb: 94,
      sensorCount: 3,
      arrayMode: "hardware",
      sensors: { ...defaultSensors },
    },
    droneStart: { x: 610, y: 105 },
  },
  phoneMesh: {
    label: "Telefonmesh över Wi‑Fi",
    description: "Tre telefoner delar lokala ljuddetektioner; nätverket är snabbt men mikrofonklockorna är inte sampelsynkroniserade.",
    config: {
      profile: "camera",
      dronePresent: true,
      speedKmh: 58,
      altitudeM: 50,
      windMs: 3,
      ambientDb: 44,
      visibility: 0.9,
      rpmShiftPercent: 0,
      radioActive: true,
      spoofMode: "none",
      spoofLevelDb: 72,
      sensorCount: 3,
      arrayMode: "wifiPhones",
      sensors: { ...defaultSensors },
    },
    droneStart: { x: 630, y: 92 },
  },
};

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

export function distance2d(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distance3d(a: Point, b: Point, altitudeM: number): number {
  return Math.hypot(a.x - b.x, a.y - b.y, altitudeM);
}

export function bladePassFrequency(
  rotorBlades: number,
  rpm: number,
): number {
  return (rotorBlades * rpm) / 60;
}

export function soundDelay(distanceM: number): number {
  return distanceM / 343;
}

export function arrivalTime(distanceM: number, speedKmh: number): number {
  return distanceM / Math.max(0.1, speedKmh / 3.6);
}

export function receivedLevel(sourceDb: number, distanceM: number): number {
  return sourceDb - 20 * Math.log10(Math.max(1, distanceM));
}

export function combineDb(a: number, b: number): number {
  return 10 * Math.log10(10 ** (a / 10) + 10 ** (b / 10));
}

export function createConfig(scenario: ScenarioId): SimulationConfig {
  const source = SCENARIOS[scenario].config;
  return {
    ...source,
    scenario,
    droneCount: source.droneCount ?? (source.dronePresent ? 1 : 0),
    secondaryProfiles: [...(source.secondaryProfiles ?? ["fpv", "fixedWing"])],
    sensors: { ...source.sensors },
  };
}

export function createState(scenario: ScenarioId): SimulationState {
  return {
    elapsedS: 0,
    drone: { ...SCENARIOS[scenario].droneStart },
    target: { x: 92, y: 220 },
    sensorNodes: [
      { x: 150, y: 220 },
      { x: 245, y: 112 },
      { x: 245, y: 328 },
    ],
    secondaryDrones: [
      { x: 585, y: 335 },
      { x: 665, y: 245 },
    ],
    spoofSource: { x: 212, y: 270 },
  };
}

export function stepSimulation(
  state: SimulationState,
  config: SimulationConfig,
  deltaSeconds: number,
): SimulationState {
  if (!config.dronePresent) {
    return { ...state, elapsedS: state.elapsedS + deltaSeconds };
  }

  const movePoint = (point: Point, speedFactor: number): Point => {
    const distance = distance2d(point, state.target);
    if (distance < 2) return point;
    const travel = Math.min(distance, (config.speedKmh / 3.6) * speedFactor * deltaSeconds);
    return {
      x: point.x + ((state.target.x - point.x) / distance) * travel,
      y: point.y + ((state.target.y - point.y) / distance) * travel,
    };
  };
  return {
    ...state,
    elapsedS: state.elapsedS + deltaSeconds,
    drone: movePoint(state.drone, 1),
    secondaryDrones: state.secondaryDrones.map((point, index) =>
      movePoint(point, index === 0 ? 0.82 : 1.12),
    ),
  };
}

function deterministicNoise(time: number, salt: number): number {
  return (
    Math.sin(time * 1.71 + salt * 8.13) * 0.54 +
    Math.sin(time * 0.43 + salt * 2.77) * 0.31
  );
}

function probabilityAtRange(distanceM: number, usefulRangeM: number): number {
  return sigmoid((usefulRangeM - distanceM) / Math.max(20, usefulRangeM * 0.12));
}

export function evaluateSimulation(
  state: SimulationState,
  config: SimulationConfig,
): SimulationResult {
  const profile = DRONE_PROFILES[config.profile];
  const arrayMode = ARRAY_MODES[config.arrayMode];
  const nodes = state.sensorNodes.slice(0, config.sensorCount);
  const nearestNode = nodes.reduce((best, node) =>
    distance2d(state.drone, node) < distance2d(state.drone, best) ? node : best,
  );
  const droneDistance3d = distance3d(
    state.drone,
    nearestNode,
    config.altitudeM,
  );
  const targetDistance = distance2d(state.drone, state.target);
  const rpm = profile.baseRpm * (1 + config.rpmShiftPercent / 100);
  const bpf = bladePassFrequency(profile.rotorBlades, rpm);

  const receivedDrone = config.dronePresent
    ? receivedLevel(profile.sourceDb, droneDistance3d)
    : -120;
  const windNoise = config.ambientDb + config.windMs * 0.72;
  const spoofDistance = Math.min(
    ...nodes.map((node) => distance2d(node, state.spoofSource)),
  );
  const spoofReceived =
    config.spoofMode === "none"
      ? -120
      : receivedLevel(config.spoofLevelDb, spoofDistance);
  const effectiveNoise =
    config.spoofMode === "broadband"
      ? combineDb(windNoise, spoofReceived)
      : windNoise;
  const snr = receivedDrone - effectiveNoise;

  const shiftPenalty = Math.abs(config.rpmShiftPercent) * 0.0035;
  const harmonicConfidence = clamp(0.96 - shiftPenalty, 0.62, 0.98);
  const realAcoustic = config.dronePresent
    ? sigmoid((snr - 2.8) / 2.6) * harmonicConfidence
    : 0;
  const replaySnr = spoofReceived - windNoise;
  const replayAcoustic =
    config.spoofMode === "replay" ? sigmoid((replaySnr - 2) / 2.3) * 0.91 : 0;
  const nodeDiversity = 1 + Math.max(0, config.sensorCount - 1) * 0.035;
  const acousticProbability = config.sensors.acoustic
    ? clamp(Math.max(realAcoustic, replayAcoustic) * arrayMode.audioQuality * nodeDiversity)
    : 0;

  let acousticSource: SimulationResult["acousticSource"] = "none";
  if (config.spoofMode === "broadband" && spoofReceived > receivedDrone + 3) {
    acousticSource = "noise";
  } else if (replayAcoustic > realAcoustic) {
    acousticSource = "replay";
  } else if (realAcoustic > 0.1) {
    acousticSource = "drone";
  }

  const radarRange = 500 * profile.radarFactor;
  const radarProbability =
    config.sensors.radar && config.dronePresent
      ? probabilityAtRange(targetDistance, radarRange)
      : 0;
  const rfProbability =
    config.sensors.rf && config.dronePresent && config.radioActive
      ? probabilityAtRange(targetDistance, 820) * 0.94
      : 0;
  const cameraRange = 330 * config.visibility;
  const cameraProbability =
    config.sensors.camera && config.dronePresent
      ? probabilityAtRange(targetDistance, cameraRange) * config.visibility
      : 0;

  const activeScores: Array<[number, number]> = [];
  if (config.sensors.acoustic) activeScores.push([acousticProbability, 0.34]);
  if (config.sensors.radar) activeScores.push([radarProbability, 0.31]);
  if (config.sensors.rf) activeScores.push([rfProbability, 0.19]);
  if (config.sensors.camera) activeScores.push([cameraProbability, 0.16]);
  const totalWeight = activeScores.reduce((sum, [, weight]) => sum + weight, 0);
  const weighted = activeScores.reduce(
    (sum, [probability, weight]) => sum + probability * weight,
    0,
  );
  const corroboratingSensors = activeScores.filter(([score]) => score >= 0.55).length;
  const corroborationBonus = corroboratingSensors >= 2 ? 0.13 : 0;
  const fusionConfidence = clamp(
    totalWeight > 0 ? weighted / totalWeight + corroborationBonus : 0,
  );

  const replaySpatialMismatch =
    config.spoofMode === "replay"
      ? clamp(0.68 + 0.1 * deterministicNoise(state.elapsedS, 3))
      : 0;
  const noCorroboration = acousticProbability > 0.65 && corroboratingSensors <= 1 ? 0.22 : 0;
  const spoofRisk = clamp(Math.max(replaySpatialMismatch, noCorroboration));

  const trueBearing =
    ((Math.atan2(state.drone.y - nearestNode.y, state.drone.x - nearestNode.x) *
      180) /
      Math.PI +
      360) %
    360;
  const arraySpatialError = arrayMode.timingErrorMs * 0.343;
  const timingAngularPenalty =
    (Math.atan2(arraySpatialError, 18) * 180) / Math.PI;
  const bearingObservable = config.sensorCount >= 2 && acousticProbability > 0.1;
  const bearingError =
    bearingObservable
      ? Math.max(
          0.35,
          (1 - acousticProbability) * 16 + config.windMs * 0.17 + timingAngularPenalty,
        )
      : Number.POSITIVE_INFINITY;
  const estimatedBearing =
    bearingObservable
      ? (trueBearing + bearingError * deterministicNoise(state.elapsedS, 7) + 360) % 360
      : Number.NaN;

  const altitudeObservable = config.sensorCount >= 2 && acousticProbability > 0.22;
  const altitudeError = altitudeObservable
    ? Math.max(
        7,
        (1 - acousticProbability) * 65 +
          arraySpatialError * 7 +
          (config.sensorCount === 2 ? 14 : 0),
      )
    : Number.POSITIVE_INFINITY;
  const estimatedAltitude = altitudeObservable
    ? Math.max(
        0,
        config.altitudeM +
          altitudeError * 0.55 * deterministicNoise(state.elapsedS, 11),
      )
    : Number.NaN;

  const eta = config.dronePresent
    ? arrivalTime(targetDistance, config.speedKmh)
    : Number.POSITIVE_INFINITY;
  const delay = config.dronePresent ? soundDelay(droneDistance3d) : 0;
  const systemLatency =
    delay + 0.8 + arrayMode.networkLatencyS + (fusionConfidence < 0.6 ? 0.7 : 0);
  const machineMargin = Number.isFinite(eta) ? eta - systemLatency : eta;
  const humanMargin = Number.isFinite(machineMargin) ? machineMargin - 3 : machineMargin;
  const nominalAcousticRange = Math.max(
    12,
    10 ** ((profile.sourceDb - effectiveNoise - 3) / 20),
  );

  let status: SimulationResult["status"] = "clear";
  if (config.spoofMode === "broadband" && spoofReceived > receivedDrone + 3) {
    status = "jammed";
  } else if (spoofRisk > 0.58 && acousticSource === "replay") {
    status = "spoof";
  } else if (fusionConfidence >= 0.64) {
    status = "confirmed";
  } else if (fusionConfidence >= 0.32 || acousticProbability >= 0.45) {
    status = "possible";
  }

  return {
    droneDistanceToTargetM: targetDistance,
    nearestAcousticDistanceM: droneDistance3d,
    bladePassFrequencyHz: bpf,
    receivedDroneDb: receivedDrone,
    effectiveNoiseDb: effectiveNoise,
    snrDb: snr,
    acousticProbability,
    radarProbability,
    rfProbability,
    cameraProbability,
    fusionConfidence,
    alert: status === "confirmed",
    acousticSource,
    spoofRisk,
    bearingDeg: trueBearing,
    estimatedBearingDeg: estimatedBearing,
    bearingErrorDeg: bearingError,
    arrayTimingErrorMs: arrayMode.timingErrorMs,
    arraySpatialErrorM: arraySpatialError,
    estimatedAltitudeM: estimatedAltitude,
    altitudeErrorM: altitudeError,
    etaS: eta,
    soundDelayS: delay,
    systemLatencyS: systemLatency,
    machineMarginS: machineMargin,
    humanMarginS: humanMargin,
    nominalAcousticRangeM: nominalAcousticRange,
    status,
  };
}
