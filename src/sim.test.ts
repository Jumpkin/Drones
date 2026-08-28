import { describe, expect, it } from "vitest";
import {
  arrivalTime,
  bladePassFrequency,
  createConfig,
  createState,
  evaluateSimulation,
  receivedLevel,
  soundDelay,
  stepSimulation,
} from "./sim";

describe("acoustic physics", () => {
  it("calculates blade-pass frequency", () => {
    expect(bladePassFrequency(2, 6000)).toBe(200);
  });

  it("applies spherical spreading", () => {
    expect(receivedLevel(100, 10)).toBeCloseTo(80, 4);
    expect(receivedLevel(100, 100)).toBeCloseTo(60, 4);
  });

  it("calculates sound delay and arrival time", () => {
    expect(soundDelay(343)).toBeCloseTo(1, 5);
    expect(arrivalTime(100, 72)).toBeCloseTo(5, 5);
  });
});

describe("simulation", () => {
  it("moves the drone toward the protected point", () => {
    const config = createConfig("quiet");
    const state = createState("quiet");
    const next = stepSimulation(state, config, 1);
    expect(next.drone.x).toBeLessThan(state.drone.x);
    expect(next.elapsedS).toBe(1);
  });

  it("marks replay audio as a spoof risk", () => {
    const config = createConfig("replay");
    const state = createState("replay");
    const result = evaluateSimulation(state, config);
    expect(result.acousticSource).toBe("replay");
    expect(result.spoofRisk).toBeGreaterThan(0.5);
    expect(result.alert).toBe(false);
    expect(result.trueBearingDeg).toBeCloseTo(240.36, 1);
    expect(result.nearestAcousticDistanceM).toBeCloseTo(Math.hypot(33, 58), 4);
    expect(result.soundDelayS).toBeGreaterThan(0);
    expect(Number.isNaN(result.estimatedAltitudeM)).toBe(true);
  });

  it("requires at least one sensor node", () => {
    const config = createConfig("quiet");
    config.sensorCount = 0;
    expect(() => evaluateSimulation(createState("quiet"), config)).toThrow(/sensor node/);
  });

  it("does not invent bearing from one phone", () => {
    const config = createConfig("quiet");
    const state = createState("quiet");
    state.drone = { x: 220, y: 220 };
    const result = evaluateSimulation(state, config);
    expect(config.sensorCount).toBe(1);
    expect(Number.isNaN(result.estimatedBearingDeg)).toBe(true);
    expect(result.altitudeErrorM).toBe(Number.POSITIVE_INFINITY);
  });

  it("requires three nodes for a unique 2D bearing and never invents altitude", () => {
    const state = createState("phoneMesh");
    state.drone = { x: 300, y: 112 };
    const twoNodes = createConfig("phoneMesh");
    twoNodes.sensorCount = 2;
    const twoNodeResult = evaluateSimulation(state, twoNodes);
    expect(Number.isNaN(twoNodeResult.estimatedBearingDeg)).toBe(true);
    expect(Number.isNaN(twoNodeResult.estimatedAltitudeM)).toBe(true);

    const threeNodes = createConfig("phoneMesh");
    threeNodes.sensorCount = 3;
    const threeNodeResult = evaluateSimulation(state, threeNodes);
    expect(Number.isFinite(threeNodeResult.estimatedBearingDeg)).toBe(true);
    expect(Number.isNaN(threeNodeResult.estimatedAltitudeM)).toBe(true);
    expect(threeNodeResult.altitudeErrorM).toBe(Number.POSITIVE_INFINITY);
  });

  it("removes acoustic transport and phone-network latency when acoustics are disabled", () => {
    const state = createState("phoneMesh");
    state.drone = { x: 300, y: 112 };
    const acoustic = createConfig("phoneMesh");
    const nonAcoustic = createConfig("phoneMesh");
    nonAcoustic.sensors.acoustic = false;
    const acousticResult = evaluateSimulation(state, acoustic);
    const nonAcousticResult = evaluateSimulation(state, nonAcoustic);
    expect(acousticResult.soundDelayS).toBeGreaterThan(0);
    expect(nonAcousticResult.soundDelayS).toBe(0);
    expect(nonAcousticResult.systemLatencyS).toBeLessThan(acousticResult.systemLatencyS);
  });

  it("loses acoustic SNR under broadband masking", () => {
    const quietResult = evaluateSimulation(
      createState("fastFpv"),
      createConfig("fastFpv"),
    );
    const maskedResult = evaluateSimulation(
      createState("masking"),
      createConfig("masking"),
    );
    expect(maskedResult.effectiveNoiseDb).toBeGreaterThan(
      quietResult.effectiveNoiseDb,
    );
    expect(maskedResult.snrDb).toBeLessThan(quietResult.snrDb);
  });

  it("shows the localization cost of unsynchronized phone audio", () => {
    const hardware = createConfig("phoneMesh");
    hardware.arrayMode = "hardware";
    const wifi = createConfig("phoneMesh");
    wifi.arrayMode = "wifiPhones";
    const bluetooth = createConfig("phoneMesh");
    bluetooth.arrayMode = "bluetoothPhones";
    const state = createState("phoneMesh");
    state.drone = { x: 300, y: 112 };

    const hardwareResult = evaluateSimulation(state, hardware);
    const wifiResult = evaluateSimulation(state, wifi);
    const bluetoothResult = evaluateSimulation(state, bluetooth);

    expect(wifiResult.bearingErrorDeg).toBeGreaterThan(hardwareResult.bearingErrorDeg);
    expect(bluetoothResult.bearingErrorDeg).toBeGreaterThan(wifiResult.bearingErrorDeg);
    expect(wifiResult.arraySpatialErrorM).toBeCloseTo(0.8575, 3);
  });
});
