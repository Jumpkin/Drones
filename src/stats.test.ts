import { describe, expect, it } from "vitest";
import { compareProfiles, mean, rowsForEnvironment, type HeadlessReport } from "./stats";

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
