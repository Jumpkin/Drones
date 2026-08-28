import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseManifest, validateManifest } from "../src/data-manifest";

const manifestPath = path.resolve("data/manifest.jsonl");
const entries = parseManifest(await readFile(manifestPath, "utf8"));
const errors = validateManifest(entries);
for (const entry of entries) {
  try {
    const bytes = await readFile(path.resolve(entry.path));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== entry.sha256) errors.push(`${entry.id}: checksum mismatch`);
  } catch {
    errors.push(`${entry.id}: missing file ${entry.path}`);
  }
}
if (errors.length > 0) throw new Error(errors.join("\n"));
console.log(`Validated ${entries.length} manifest entries with no split leakage or checksum errors.`);
