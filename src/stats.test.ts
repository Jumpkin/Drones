import { describe, expect, it } from "vitest";
import {
  benchmarkMetrics,
  benchmarkWinners,
  compareProfiles,
  mean,
  rowsForEnvironment,
  validateBenchmarkReport,
  type BenchmarkRun,
  type HeadlessReport,
} from "./stats";

const report = {
  detection: [
    { profile: "camera", label: "Camera", environment: "quiet", distanceM: 25, detectionRate: 1, top1Accuracy: 0.8 },
    { profile: "camera", label: "Camera", environment: "quiet", distanceM: 50, detectionRate: 0.5, top1Accuracy: 0.4 },
    { profile: "fpv", label: "FPV", environment: "quiet", distanceM: 25, detectionRate: 0.9, top1Accuracy: 0.9 },
    { profile: "fpv", label: "FPV", environment: "urban", distanceM: 25, detectionRate: 0.1, top1Accuracy: 0.1 },
  ],
} as HeadlessReport;

describe("statistics comparisons", () => {
  it("filters rows by environment", () => {
    expect(rowsForEnvironment(report, "quiet")).toHaveLength(3);
  });

  it("compares profile averages for the selected metric", () => {
    const profiles = compareProfiles(report, "quiet", "detectionRate");
    expect(profiles[0]).toMatchObject({ profile: "fpv", average: 0.9 });
    expect(profiles[1]).toMatchObject({ profile: "camera", average: 0.75 });
  });

  it("returns a safe mean for an empty series", () => {
    expect(mean([])).toBe(0);
  });
});

describe("benchmark run registry", () => {
  const run: BenchmarkRun = {
    id: "example",
    label: "Example",
    domain: "Test",
    evidenceClass: "synthetic",
    positiveTests: 10,
    negativeTests: 10,
    totalTests: 20,
    caveat: "Test fixture",
    models: [
      { id: "a", label: "A", threshold: 0.5, relationship: "test", truePositive: 9, falsePositive: 1, trueNegative: 9, falseNegative: 1 },
      { id: "b", label: "B", threshold: 0.5, relationship: "test", truePositive: 8, falsePositive: 0, trueNegative: 10, falseNegative: 2 },
    ],
  };

  it("derives every rate from integer confusion counts", () => {
    expect(benchmarkMetrics(run.models[0])).toEqual({
      positiveTests: 10,
      negativeTests: 10,
      totalTests: 20,
      precision: 0.9,
      recall: 0.9,
      falsePositiveRate: 0.1,
      f1: 0.9,
      accuracy: 0.9,
    });
  });

  it("does not report a zero false-positive rate when no negatives were tested", () => {
    const metrics = benchmarkMetrics({ truePositive: 8, falsePositive: 0, trueNegative: 0, falseNegative: 2 });
    expect(metrics.falsePositiveRate).toBeNull();
    expect(metrics.negativeTests).toBe(0);
  });

  it("selects the highest F1 and preserves exact ties", () => {
    expect(benchmarkWinners(run)).toEqual(["a"]);
    const tied = { ...run, models: [...run.models, { ...run.models[0], id: "c", label: "C" }] };
    expect(benchmarkWinners(tied)).toEqual(["a", "c"]);
  });

  it("rejects model counts that disagree with the run totals", () => {
    expect(() => validateBenchmarkReport({
      schemaVersion: 1,
      generatedAt: "2026-08-29T00:00:00.000Z",
      winnerRule: "F1",
      recommendation: "Example",
      caveats: [],
      runs: [{ ...run, totalTests: 21 }],
    })).toThrow("inconsistent test totals");
  });

  it("accepts a consistent report", () => {
    expect(validateBenchmarkReport({
      schemaVersion: 1,
      generatedAt: "2026-08-29T00:00:00.000Z",
      winnerRule: "F1",
      recommendation: "Example",
      caveats: [],
      runs: [run],
    }).runs).toHaveLength(1);
  });
});
