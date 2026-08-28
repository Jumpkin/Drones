import { describe, expect, it } from "vitest";
import { generateDronePcm } from "./audio";
import { analyzePcm } from "./detector";
import { createAcousticEvent } from "./events";

describe("acoustic event metadata", () => {
  it("reports the full FFT window coverage", () => {
    const result = analyzePcm(generateDronePcm("camera", 1), 16_000);
    const event = createAcousticEvent("P1", result, undefined, 123);
    const expectedSamples = result.spectrumDb.length * 2 + (result.analyzedFrames - 1) * 512;
    expect(event.windowMs).toBe(Math.round(expectedSamples / result.spectrumSampleRate * 1000));
    expect(event.windowMs).toBeGreaterThan(result.analyzedFrames * 512 / 16_000 * 1000);
    expect(event.snrEstimateDb).toBe(result.spectralSnrDb);
    expect(event.snrEstimateDb).not.toBe(event.harmonicScoreDb);
  });
});
