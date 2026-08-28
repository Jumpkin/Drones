import type { DroneProfileId } from "./sim";

export interface DetectionStatistic {
  profile: DroneProfileId;
  label: string;
  distanceM: number;
  environment: string;
  ambientRms: number;
  trials: number;
  detected: number;
  correctTop1: number;
  detectionRate: number;
  top1Accuracy: number;
  accuracyWhenDetected: number;
  meanConfidence: number;
}

export interface FalseAlarmStatistic {
  environment: string;
  ambientRms: number;
  trials: number;
  falseDetections: number;
  falsePositiveRate: number;
  meanConfidence: number;
}

export interface LocalizationStatistic {
  timingJitterMs: number;
  trials: number;
  medianErrorM: number;
  p90ErrorM: number;
  medianBearingErrorDeg: number;
  p90BearingErrorDeg: number;
  within5MRate: number;
  within10MRate: number;
  medianResidualMs: number;
}

export interface HeadlessReport {
  schemaVersion: number;
  generatedAt: string;
  seed: number;
  configuration: {
    trialsPerDroneCondition: number;
    localizationTrialsPerJitterLevel: number;
    distancesM: number[];
    attenuationModel: string;
  };
  caveats: string[];
  realSamples: Array<{
    file: string;
    expected: string;
    detected: boolean;
    top1: string;
    correct: boolean;
    confidence: number;
  }>;
  detection: DetectionStatistic[];
  falseAlarms: FalseAlarmStatistic[];
  localization: LocalizationStatistic[];
}

export type DetectionMetric = "detectionRate" | "top1Accuracy";

export function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

export function rowsForEnvironment(
  report: HeadlessReport,
  environment: string,
): DetectionStatistic[] {
  return report.detection.filter((row) => row.environment === environment);
}

export function compareProfiles(
  report: HeadlessReport,
  environment: string,
  metric: DetectionMetric,
): Array<{ profile: DroneProfileId; label: string; average: number }> {
  const rows = rowsForEnvironment(report, environment);
  const profileIds = [...new Set(rows.map((row) => row.profile))];
  return profileIds.map((profile) => {
    const profileRows = rows.filter((row) => row.profile === profile);
    return {
      profile,
      label: profileRows[0]?.label ?? profile,
      average: mean(profileRows.map((row) => row[metric])),
    };
  }).sort((a, b) => b.average - a.average);
}
