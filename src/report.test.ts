import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  benchmarkWinners,
  validateBenchmarkReport,
  type BenchmarkRunReport,
  type HeadlessReport,
} from "./stats";

describe("committed headless report", () => {
  it("contains all three detectors under schema v2", async () => {
    const report = JSON.parse(
      await readFile("public/reports/headless/summary.json", "utf8"),
    ) as HeadlessReport;
    expect(report.schemaVersion).toBe(2);
    expect(report.models?.map((model) => model.id)).toEqual([
      "dsp-v1",
      "ml-onnx-v1",
      "crnn-pretrained-v1",
    ]);
    expect(report.failures?.length).toBeGreaterThan(0);
    expect(report.realSamples.every((sample) =>
      typeof sample.detectorId === "string" && typeof sample.correctBinary === "boolean"
    )).toBe(true);
    expect(report.models?.find((model) => model.id === "ml-onnx-v1")?.detection.every(
      (row) => row.classificationMethod === "ml-detection+dsp-type",
    )).toBe(true);
    expect(report.phonePlayback?.length).toBe(36);
    expect(report.phonePlayback?.every((row) =>
      row.trialsPerClass > 0 && row.recall >= 0 && row.recall <= 1 &&
      row.falsePositiveRate >= 0 && row.falsePositiveRate <= 1 &&
      row.truePositive + row.falseNegative === row.trialsPerClass &&
      row.falsePositive + row.trueNegative === row.trialsPerClass
    )).toBe(true);
    expect(report.configuration.externalModels?.[0]).toMatchObject({
      id: "crnn-pretrained-v1",
      license: "MIT",
    });
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
    expect(report.models?.find((model) => model.id === "crnn-pretrained-v1")?.isDefault).toBe(false);
  });

  it("ties the reproducible report snapshot to the committed model artifact", async () => {
    const [report, artifact] = await Promise.all([
      readFile("public/reports/headless/summary.json", "utf8").then(JSON.parse),
      readFile("public/models/drone-binary-v1.json", "utf8").then(JSON.parse),
    ]) as [{ generatedAt: string }, { trainedAt: string }];
    expect(report.generatedAt).toBe(artifact.trainedAt);
  });

  it("keeps every benchmark run internally consistent and identifies a winner", async () => {
    const report = validateBenchmarkReport(JSON.parse(
      await readFile("public/reports/headless/benchmark-runs.json", "utf8"),
    ) as BenchmarkRunReport);
    expect(report.runs).toHaveLength(7);
    expect(report.runs.every((run) => benchmarkWinners(run).length > 0)).toBe(true);
    expect(report.runs.find((run) => run.id.startsWith("synthetic-headless"))).toMatchObject({
      positiveTests: 900,
      negativeTests: 180,
      totalTests: 1080,
    });
    expect(benchmarkWinners(report.runs.find((run) => run.id.startsWith("synthetic-headless"))!))
      .toEqual(["ml-onnx-v1"]);
  });
});
