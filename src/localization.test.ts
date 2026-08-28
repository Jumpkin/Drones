import { describe, expect, it } from "vitest";
import {
  analyzeOfflineTrial,
  estimateDelaySamples,
  localizeGrid,
  simulateArrivals,
  type ListenerNode,
} from "./localization";

const listeners: ListenerNode[] = [
  { id: "P1", position: { x: 80, y: 80 }, clockOffsetMs: 3.2, clockDriftPpm: 18 },
  { id: "P2", position: { x: 520, y: 90 }, clockOffsetMs: -2.1, clockDriftPpm: -12 },
  { id: "P3", position: { x: 270, y: 360 }, clockOffsetMs: 5.4, clockDriftPpm: 24 },
];

describe("offline phone localization", () => {
  it("removes simulated clock offset and drift during calibration", () => {
    const arrivals = simulateArrivals(listeners, { x: 390, y: 220 });
    expect(arrivals.some((item) => Math.abs(item.clockCorrectionMs) > 2)).toBe(true);
    const uncorrectedDelta = arrivals[0].observedArrivalS - arrivals[0].calibratedArrivalS;
    expect(Math.abs(uncorrectedDelta)).toBeGreaterThan(0.003);
  });

  it("localizes a source in 2D without inventing altitude", () => {
    const result = analyzeOfflineTrial(listeners, { x: 390, y: 220 }, { width: 700, height: 420 });
    expect(result.errorM).toBeLessThan(2);
    expect(result.altitudeM).toBeNull();
    expect(result.sourceCount).toBe(1);
  });

  it("matches arrival observations by node ID instead of array order", () => {
    const source = { x: 390, y: 220 };
    const arrivals = simulateArrivals(listeners, source).reverse();
    const result = localizeGrid(listeners, arrivals, { width: 700, height: 420 });
    expect(Math.hypot(result.position.x - source.x, result.position.y - source.y)).toBeLessThan(2);
  });

  it("rejects mismatched observation IDs", () => {
    const arrivals = simulateArrivals(listeners, { x: 390, y: 220 });
    arrivals[2] = { ...arrivals[2], nodeId: "unknown" };
    expect(() => localizeGrid(listeners, arrivals, { width: 700, height: 420 })).toThrow(/IDs must match/);
  });

  it("finds sample delay by correlation", () => {
    const reference = new Float32Array(256);
    const delayed = new Float32Array(256);
    reference[80] = 1;
    delayed[92] = 1;
    expect(estimateDelaySamples(reference, delayed, 30)).toBe(12);
  });
});
