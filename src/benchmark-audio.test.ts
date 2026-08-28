import { describe, expect, it } from "vitest";
import { generateDronePcm } from "./audio";
import {
  PHONE_AUDIO_PROFILES,
  PLAYBACK_ROOM_PROFILES,
  mulberry32,
  simulatePhonePlayback,
} from "./benchmark-audio";

describe("headless phone playback channel", () => {
  it("is deterministic, finite, and preserves clip length", () => {
    const input = generateDronePcm("camera", 1, 16_000);
    const first = simulatePhonePlayback(
      input,
      16_000,
      PHONE_AUDIO_PROFILES[0],
      PLAYBACK_ROOM_PROFILES[1],
      mulberry32(42),
    );
    const second = simulatePhonePlayback(
      input,
      16_000,
      PHONE_AUDIO_PROFILES[0],
      PLAYBACK_ROOM_PROFILES[1],
      mulberry32(42),
    );
    expect(first).toHaveLength(input.length);
    expect([...first].every(Number.isFinite)).toBe(true);
    expect(first).toEqual(second);
    expect(first).not.toEqual(input);
  });

  it("rejects an invalid sample rate", () => {
    expect(() => simulatePhonePlayback(
      new Float32Array(10),
      0,
      PHONE_AUDIO_PROFILES[0],
      PLAYBACK_ROOM_PROFILES[0],
      mulberry32(1),
    )).toThrow(/sample rate/i);
  });
});
