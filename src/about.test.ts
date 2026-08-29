import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ABOUT_SOURCES, createAboutSnapshot } from "./about";
import type { BenchmarkRunReport, HeadlessReport } from "./stats";

describe("About view data", () => {
  it("derives its changing benchmark facts from the committed reports", async () => {
    const [headless, benchmarks] = await Promise.all([
      readFile("public/reports/headless/summary.json", "utf8").then(JSON.parse) as Promise<HeadlessReport>,
      readFile("public/reports/headless/benchmark-runs.json", "utf8").then(JSON.parse) as Promise<BenchmarkRunReport>,
    ]);
    const snapshot = createAboutSnapshot(headless, benchmarks);
    const synthetic = benchmarks.runs.find((run) => run.evidenceClass === "synthetic");
    const phone = benchmarks.runs.find((run) => run.evidenceClass === "phone-proxy");

    expect(snapshot.generatedAt).toBe(headless.generatedAt);
    expect(snapshot.seed).toBe(headless.seed);
    expect(snapshot.sampleRate).toBe(headless.configuration.sampleRate);
    expect(snapshot.clipDurationS).toBe(headless.configuration.clipDurationS);
    expect(snapshot.syntheticTests).toBe(synthetic?.totalTests);
    expect(snapshot.phoneProxyTests).toBe(phone?.totalTests);
    expect(snapshot.benchmarkRuns).toBe(benchmarks.runs.length);
    expect(snapshot.localizationTrials).toBe(
      headless.localization.reduce((total, row) => total + row.trials, 0),
    );
    expect(snapshot.recommendation).toBe(benchmarks.recommendation);
  });

  it("publishes explicit HTTPS provenance with usage and license context", () => {
    expect(ABOUT_SOURCES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(ABOUT_SOURCES.map((source) => source.group))).toEqual(
      new Set(["shipped", "local", "data"]),
    );
    for (const source of ABOUT_SOURCES) {
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.relationship.length).toBeGreaterThan(20);
      expect(source.license.length).toBeGreaterThan(2);
    }
    expect(ABOUT_SOURCES.find((source) => source.name === "Batear Datasets")?.relationship)
      .toContain("recordings");
    expect(ABOUT_SOURCES.find((source) => source.name === "Samid AST drone detector")?.group)
      .toBe("local");
  });

  it("does not present Monava or the Batear firmware as used project code", () => {
    const serialized = JSON.stringify(ABOUT_SOURCES).toLowerCase();
    expect(serialized).not.toContain("monava");
    expect(ABOUT_SOURCES.some((source) => source.url === "https://github.com/batear-io/batear"))
      .toBe(false);
  });
});
