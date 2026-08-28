import { describe, expect, it } from "vitest";
import { generateAmbientPcm, generateDronePcm } from "./audio";
import { analyzePcm, containsRawAudio, resampleLinear } from "./detector";

describe("blind acoustic detector", () => {
  it("detects a synthetic harmonic drone signature", () => {
    const result = analyzePcm(generateDronePcm("fpv", 2.5), 16000);
    expect(result.detected).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.6);
    expect(result.fundamentalHz).toBeGreaterThan(250);
    expect(result.classifications[0].profile).not.toBe("ambient");
  });

  it("keeps deterministic ambient noise below detection", () => {
    const result = analyzePcm(generateAmbientPcm(2.5), 16000);
    expect(result.detected).toBe(false);
    expect(result.classifications[0].profile).toBe("ambient");
  });

  it("resamples while preserving duration", () => {
    const input = new Float32Array(48000);
    expect(resampleLinear(input, 48000, 16000)).toHaveLength(16000);
  });

  it("rejects raw audio fields in backend metadata", () => {
    expect(containsRawAudio({ nodeId: "P1", confidence: 0.8 })).toBe(false);
    expect(containsRawAudio({ nodeId: "P1", pcmSamples: [0, 1] })).toBe(true);
  });
});
