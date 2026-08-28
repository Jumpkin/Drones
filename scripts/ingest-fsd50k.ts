import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { DatasetManifestEntry } from "../src/data-manifest";
import { validateManifest } from "../src/data-manifest";

const TARGET_LABELS = new Set([
  "Engine",
  "Motor_vehicle_(road)",
  "Motorcycle",
  "Helicopter",
  "Lawn_mower",
  "Chainsaw",
  "Vacuum_cleaner",
  "Mechanical_fan",
  "Traffic_noise,_roadway_noise",
]);

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function normalizeLicense(value: string): string | undefined {
  const upper = value.toUpperCase().replaceAll(" ", "");
  if (upper.includes("CC0")) return "CC0";
  if ((upper.includes("CC-BY") || upper.includes("ATTRIBUTION")) && !upper.includes("NC")) return "CC-BY";
  return undefined;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) {
      cells.push(value);
      value = "";
    } else value += character;
  }
  cells.push(value);
  return cells;
}

function splitForId(id: string): "train" | "validation" | "test" {
  const bucket = createHash("sha256").update(id).digest()[0] / 256;
  return bucket < 0.7 ? "train" : bucket < 0.85 ? "validation" : "test";
}

async function main(): Promise<void> {
  const clipsInfoPath = argument("--clips-info");
  const groundTruthPath = argument("--ground-truth");
  const audioRoot = argument("--audio-root");
  const output = argument("--out");
  const clipsInfo = JSON.parse(await readFile(clipsInfoPath, "utf8")) as Record<string, {
    license?: string;
    uploader?: string;
    url?: string;
  }>;
  const rows = (await readFile(groundTruthPath, "utf8")).split(/\r?\n/).slice(1).filter(Boolean);
  const entries: DatasetManifestEntry[] = [];
  for (const row of rows) {
    const [fileName, labels = ""] = parseCsvLine(row);
    if (!labels.split(";").some((label) => TARGET_LABELS.has(label))) continue;
    const id = path.parse(fileName).name;
    const info = clipsInfo[id] ?? clipsInfo[fileName];
    const license = normalizeLicense(info?.license ?? "");
    if (!license) continue;
    const audioPath = path.join(audioRoot, fileName);
    const bytes = await readFile(audioPath);
    entries.push({
      id: `fsd50k-${id}`,
      source: "fsd50k",
      sourceRecordingId: `fsd50k-${id}`,
      sessionId: `fsd50k-${id}`,
      label: "background",
      subtype: null,
      environment: labels,
      license,
      split: splitForId(id),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      path: audioPath,
      attribution: info?.uploader,
      sourceUrl: info?.url,
    });
  }
  const errors = validateManifest(entries);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  console.log(`Wrote ${entries.length} CC0/CC-BY hard-negative entries to ${output}`);
}

await main();
