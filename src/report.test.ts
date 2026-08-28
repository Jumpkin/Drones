import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { HeadlessReport } from "./stats";

describe("committed headless report", () => {
  it("contains both detectors under schema v2", async () => {
    const report = JSON.parse(
      await readFile("public/reports/headless/summary.json", "utf8"),
    ) as HeadlessReport;
    expect(report.schemaVersion).toBe(2);
    expect(report.models?.map((model) => model.id)).toEqual(["dsp-v1", "ml-onnx-v1"]);
    expect(report.failures?.length).toBeGreaterThan(0);
    expect(report.realSamples.every((sample) =>
      typeof sample.detectorId === "string" && typeof sample.correctBinary === "boolean"
    )).toBe(true);
    expect(report.models?.find((model) => model.id === "ml-onnx-v1")?.detection.every(
      (row) => row.classificationMethod === "ml-detection+dsp-type",
    )).toBe(true);
  });

  it("keeps ML experimental while its quality gate fails", async () => {
    const report = JSON.parse(
      await readFile("public/reports/headless/summary.json", "utf8"),
    ) as HeadlessReport;
    const dsp = report.models?.find((model) => model.id === "dsp-v1");
    const ml = report.models?.find((model) => model.id === "ml-onnx-v1");
    expect(ml?.overall.falsePositiveRate).toBeLessThan(dsp?.overall.falsePositiveRate ?? 1);
    expect(ml?.qualityGate?.passed).toBe(false);
    expect(ml?.isDefault).toBe(false);
    expect(dsp?.isDefault).toBe(true);
  });

  it("ties the reproducible report snapshot to the committed model artifact", async () => {
    const [report, artifact] = await Promise.all([
      readFile("public/reports/headless/summary.json", "utf8").then(JSON.parse),
      readFile("public/models/drone-binary-v1.json", "utf8").then(JSON.parse),
    ]) as [{ generatedAt: string }, { trainedAt: string }];
    expect(report.generatedAt).toBe(artifact.trainedAt);
  });
});
