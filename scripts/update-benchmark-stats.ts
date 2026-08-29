import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  benchmarkMetrics,
  benchmarkWinners,
  validateBenchmarkReport,
  type BenchmarkCounts,
  type BenchmarkModelResult,
  type BenchmarkRun,
  type BenchmarkRunReport,
} from "../src/stats";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface CountResult extends BenchmarkCounts {
  detectorId?: string;
  threshold?: number;
}

interface HeadlessSummary {
  generatedAt: string;
  seed: number;
  models: Array<{ id: string; label: string; threshold: number; overall: CountResult }>;
  phonePlayback: Array<CountResult & { detectorId: string }>;
  realSamples: Array<{ detectorId: string; expected: string; detected: boolean }>;
}

interface YamnetComparison {
  generatedAt: string;
  models: Array<CountResult & { detectorId: string }>;
  phone: Array<CountResult & { detectorId: string }>;
  realSamples: Array<{ detectorId: string; expectedDrone: boolean; detected: boolean }>;
  yamnet: { threshold: number };
}

interface SourceReport {
  model: { id: string };
  default: CountResult;
  bySourceAtDefaultThreshold: Record<string, CountResult>;
}

const LABELS: Record<string, string> = {
  "dsp-v1": "FFT / harmonic DSP",
  "ml-onnx-v1": "Feature Conv ML",
  "crnn-pretrained-v1": "Pretrained CRNN",
  "yamnet-pretrained-local-v1": "YAMNet + external head",
  "samid-ast-pretrained-local-v1": "Samid AST",
};

const DEFAULT_THRESHOLDS: Record<string, number> = {
  "dsp-v1": 0.42,
  "ml-onnx-v1": 0.43,
  "crnn-pretrained-v1": 0.5,
  "yamnet-pretrained-local-v1": 0.45,
  "samid-ast-pretrained-local-v1": 0.5,
};

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

async function json<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.resolve(file), "utf8")) as T;
}

function counts(value: CountResult): BenchmarkCounts {
  return {
    truePositive: value.truePositive,
    falsePositive: value.falsePositive,
    trueNegative: value.trueNegative,
    falseNegative: value.falseNegative,
  };
}

function aggregate(values: CountResult[]): BenchmarkCounts {
  return values.reduce<BenchmarkCounts>((total, value) => ({
    truePositive: total.truePositive + value.truePositive,
    falsePositive: total.falsePositive + value.falsePositive,
    trueNegative: total.trueNegative + value.trueNegative,
    falseNegative: total.falseNegative + value.falseNegative,
  }), { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 });
}

function fromDecisions(rows: Array<{ expectedDrone: boolean; detected: boolean }>): BenchmarkCounts {
  return {
    truePositive: rows.filter((row) => row.expectedDrone && row.detected).length,
    falsePositive: rows.filter((row) => !row.expectedDrone && row.detected).length,
    trueNegative: rows.filter((row) => !row.expectedDrone && !row.detected).length,
    falseNegative: rows.filter((row) => row.expectedDrone && !row.detected).length,
  };
}

function model(id: string, result: CountResult | BenchmarkCounts, relationship: string, threshold = DEFAULT_THRESHOLDS[id] ?? null): BenchmarkModelResult {
  return { id, label: LABELS[id] ?? id, threshold, relationship, ...counts(result as CountResult) };
}

function run(base: Omit<BenchmarkRun, "positiveTests" | "negativeTests" | "totalTests">): BenchmarkRun {
  const first = benchmarkMetrics(base.models[0]);
  const output = {
    ...base,
    positiveTests: first.positiveTests,
    negativeTests: first.negativeTests,
    totalTests: first.totalTests,
  };
  for (const candidate of output.models) {
    const metrics = benchmarkMetrics(candidate);
    if (metrics.positiveTests !== output.positiveTests || metrics.negativeTests !== output.negativeTests) {
      throw new Error(`${output.id}: ${candidate.id} was not evaluated on the same number of positive and negative tests`);
    }
  }
  return output;
}

function sameCounts(left: BenchmarkCounts, right: BenchmarkCounts): boolean {
  return left.truePositive === right.truePositive && left.falsePositive === right.falsePositive &&
    left.trueNegative === right.trueNegative && left.falseNegative === right.falseNegative;
}

function verifyRepeatedRun(headless: HeadlessSummary, local: YamnetComparison): void {
  for (const current of headless.models) {
    const repeated = local.models.find((item) => item.detectorId === current.id);
    if (!repeated || !sameCounts(current.overall, repeated)) {
      throw new Error(`Synthetic replay drift for ${current.id}; rerun npm run simulate before publishing statistics`);
    }
    const currentPhone = aggregate(headless.phonePlayback.filter((item) => item.detectorId === current.id));
    const repeatedPhone = aggregate(local.phone.filter((item) => item.detectorId === current.id));
    if (!sameCounts(currentPhone, repeatedPhone)) {
      throw new Error(`Phone-proxy replay drift for ${current.id}`);
    }
  }
}

function sourceResult(report: SourceReport, source: string): CountResult {
  const result = report.bySourceAtDefaultThreshold[source];
  if (!result) throw new Error(`Missing ${source} in ${report.model.id}`);
  return result;
}

async function main(): Promise<void> {
  const [headless, local, yamnetSource, samidSource, samidAhlab, samidBatear] = await Promise.all([
    json<HeadlessSummary>(argument("--headless", path.join(PROJECT_ROOT, "public/reports/headless/summary.json"))),
    json<YamnetComparison>(argument("--local", "/tmp/drones-yamnet-comparison.json")),
    json<SourceReport>(argument("--yamnet-source", "/tmp/drones-yamnet-source-audio.json")),
    json<SourceReport>(argument("--samid-source", "/tmp/drones-samid-source-audio.json")),
    json<SourceReport>(argument("--samid-ahlab", "/tmp/drones-samid-ahlab.json")),
    json<SourceReport>(argument("--samid-batear", "/tmp/drones-samid-batear.json")),
  ]);
  verifyRepeatedRun(headless, local);

  const syntheticModels = local.models.map((item) => model(
    item.detectorId ?? "unknown",
    item,
    item.detectorId === "ml-onnx-v1" || item.detectorId === "dsp-v1"
      ? "In-domain: benchmark uses the project's synthetic generator family"
      : "Imported model evaluated out of its source domain",
  ));
  const phoneModels = [...new Set(local.phone.map((item) => item.detectorId))].map((id) => model(
    id,
    aggregate(local.phone.filter((item) => item.detectorId === id)),
    "Synthetic playback, room, and phone-channel proxy; no physical phone used",
  ));
  const sourceRun = (
    id: string,
    label: string,
    source: string,
    domain: string,
    relationships: [string, string],
  ) => run({
    id,
    label,
    domain,
    evidenceClass: "source-domain",
    models: [
      model("yamnet-pretrained-local-v1", sourceResult(yamnetSource, source), relationships[0]),
      model("samid-ast-pretrained-local-v1", sourceResult(samidSource, source), relationships[1]),
    ],
    caveat: "Compatibility test on downloaded source clips; not a held-out field test.",
  });

  const ahlabYamnet = sourceResult(yamnetSource, "ahlab-droneaudioset");
  const ahlabSamid = sourceResult(samidAhlab, "ahlab-droneaudioset");
  const batearModels = [...new Set(local.realSamples.map((item) => item.detectorId))].map((id) => model(
    id,
    fromDecisions(local.realSamples.filter((item) => item.detectorId === id)),
    "External Batear fixture set; only four hand-selected clips",
  ));
  batearModels.push(model(
    "samid-ast-pretrained-local-v1",
    samidBatear.default,
    "External Batear fixture set; only four hand-selected clips",
  ));

  const runs: BenchmarkRun[] = [
    run({
      id: `synthetic-headless-seed-${String(headless.seed)}`,
      label: "Synthetic distance + hard-negative run",
      domain: "4 drone profiles × 5 distances × 3 environments, plus structured backgrounds",
      evidenceClass: "synthetic",
      models: syntheticModels,
      caveat: "In-domain regression benchmark; range is not field validated.",
    }),
    run({
      id: "phone-playback-proxy",
      label: "Playback-to-phone proxy run",
      domain: "3 simulated phone responses × 4 simulated rooms",
      evidenceClass: "phone-proxy",
      models: phoneModels,
      caveat: "Digital channel simulation, not measurements from physical phones.",
    }),
    sourceRun(
      "geronimo-source",
      "Geronimo source-audio run",
      "geronimo",
      "25 drone and 25 background clips",
      ["External to this YAMNet head", "Training-source distribution"],
    ),
    sourceRun(
      "sara-source",
      "Sara Al-Emadi source-audio run",
      "sara-alemadi",
      "25 drone and 25 background clips",
      ["Training-source distribution", "External to Samid"],
    ),
    sourceRun(
      "visualization-source",
      "Drone Visualization source-audio run",
      "drone-visualization",
      "32 drone clips and no background clips",
      ["Training-source distribution", "External to Samid"],
    ),
    run({
      id: "ahlab-source",
      label: "AHLab DroneAudioSet source-audio run",
      domain: "20 one-second drone clips and no background clips",
      evidenceClass: "source-domain",
      models: [
        model("yamnet-pretrained-local-v1", ahlabYamnet, "External to this YAMNet head"),
        model("samid-ast-pretrained-local-v1", ahlabSamid, "Training-source distribution"),
      ],
      caveat: "Positive-only sample from one published shard; false-alarm rate cannot be calculated.",
    }),
    run({
      id: "batear-fixtures",
      label: "Batear real-audio fixture run",
      domain: "3 drone clips and 1 rural background clip",
      evidenceClass: "external-fixture",
      models: batearModels,
      caveat: "Only four clips, including one negative; ranking is highly uncertain.",
    }),
  ];

  const report: BenchmarkRunReport = validateBenchmarkReport({
    schemaVersion: 1,
    generatedAt: local.generatedAt,
    winnerRule: "Best means highest F1 computed from integer TP/FP/TN/FN counts within that run. Exact ties share the win. A dash means the rate is undefined because that class was not tested.",
    recommendation: "Feature Conv ML is the strongest current simulator baseline: it has the best F1 in both the 1,080-case synthetic run and the 480-case phone-channel proxy. No tested model is yet the best overall field detector; source-domain and four-file results are not independent field validation.",
    caveats: [
      "Benchmark percentages in the run registry are calculated in the browser from the saved integer confusion counts.",
      "The source-audio runs overlap one or both imported models' training distributions and must not be read as independent validation.",
      "Runs without background clips cannot measure false alarms; those cells intentionally show a dash instead of 0%.",
      "The Samid aggregation uses 1.0 s windows, 0.5 s hop, a 3-window median filter, and an explicit N=3 consecutive-window assumption because its model card does not publish N.",
    ],
    runs,
  });
  const outputPath = path.resolve(argument("--out", path.join(PROJECT_ROOT, "public/reports/headless/benchmark-runs.json")));
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    report: outputPath,
    runs: report.runs.map((item) => ({
      id: item.id,
      positiveTests: item.positiveTests,
      negativeTests: item.negativeTests,
      totalTests: item.totalTests,
      winners: benchmarkWinners(item),
    })),
  }, null, 2));
}

await main();
