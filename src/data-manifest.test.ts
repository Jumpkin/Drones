import { describe, expect, it } from "vitest";
import { parseManifest, validateManifest, type DatasetManifestEntry } from "./data-manifest";

const valid: DatasetManifestEntry = {
  id: "one",
  source: "fixture",
  sourceRecordingId: "recording-one",
  sessionId: "session-one",
  label: "background",
  subtype: null,
  environment: "urban",
  license: "CC0",
  split: "train",
  sha256: "a".repeat(64),
  path: "audio.wav",
};

describe("dataset manifest", () => {
  it("parses JSON Lines", () => {
    expect(parseManifest(`${JSON.stringify(valid)}\n`)).toEqual([valid]);
  });

  it("rejects non-redistributable clip licenses", () => {
    expect(validateManifest([{ ...valid, license: "CC-BY-NC" }])).toContain("one: rejected license CC-BY-NC");
  });

  it("detects source recording leakage between model splits", () => {
    const errors = validateManifest([
      valid,
      { ...valid, id: "two", split: "test", sha256: "b".repeat(64) },
    ]);
    expect(errors.some((error) => error.includes("leaks across"))).toBe(true);
  });
});
