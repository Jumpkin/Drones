import { describe, expect, it } from "vitest";
import { summarizeTrials, type MicrophoneTrial } from "./microphone";

function trial(truth: MicrophoneTrial["truth"], detected: boolean): MicrophoneTrial {
  return {
    id: 1,
    capturedAt: "2026-08-28T00:00:00.000Z",
    truth,
    detected,
    probability: detected ? 0.8 : 0.2,
    latencyMs: 12,
    rms: 0.1,
    topLabel: detected ? "Camera multirotor" : "Background / unknown",
  };
}

describe("microphone trial metrics", () => {
  it("calculates the binary confusion matrix", () => {
    const metrics = summarizeTrials([
      trial("drone", true),
      trial("drone", true),
      trial("drone", false),
      trial("ambient", true),
      trial("ambient", false),
      trial("ambient", false),
      trial("ambient", false),
    ]);
    expect(metrics).toEqual({
      total: 7,
      truePositive: 2,
      falsePositive: 1,
      trueNegative: 3,
      falseNegative: 1,
      recall: 2 / 3,
      falsePositiveRate: 1 / 4,
    });
  });

  it("does not invent rates without matching trials", () => {
    const metrics = summarizeTrials([trial("drone", true)]);
    expect(metrics.recall).toBe(1);
    expect(metrics.falsePositiveRate).toBeNull();
  });
});
