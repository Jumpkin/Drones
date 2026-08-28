export type DatasetSplit = "train" | "validation" | "test" | "external-test";
export type DatasetLabel = "drone" | "background";

export interface DatasetManifestEntry {
  id: string;
  source: string;
  sourceRecordingId: string;
  sessionId: string;
  label: DatasetLabel;
  subtype: string | null;
  environment: string;
  license: string;
  split: DatasetSplit;
  sha256: string;
  path: string;
  attribution?: string;
  sourceUrl?: string;
}

const VALID_SPLITS = new Set<DatasetSplit>(["train", "validation", "test", "external-test"]);
const VALID_LABELS = new Set<DatasetLabel>(["drone", "background"]);
const REDISTRIBUTABLE_LICENSES = new Set(["MIT", "CC0", "CC-BY", "CC-BY-4.0"]);

export function parseManifest(text: string): DatasetManifestEntry[] {
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as DatasetManifestEntry;
    } catch {
      throw new Error(`Invalid JSON on manifest line ${index + 1}`);
    }
  });
}

export function validateManifest(entries: DatasetManifestEntry[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const recordingSplits = new Map<string, Set<DatasetSplit>>();
  for (const entry of entries) {
    if (!entry.id || ids.has(entry.id)) errors.push(`Duplicate or missing id: ${entry.id}`);
    ids.add(entry.id);
    if (!entry.sourceRecordingId || !entry.sessionId) errors.push(`${entry.id}: missing recording/session id`);
    if (!VALID_LABELS.has(entry.label)) errors.push(`${entry.id}: invalid label ${entry.label}`);
    if (!VALID_SPLITS.has(entry.split)) errors.push(`${entry.id}: invalid split ${entry.split}`);
    if (!REDISTRIBUTABLE_LICENSES.has(entry.license)) errors.push(`${entry.id}: rejected license ${entry.license}`);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) errors.push(`${entry.id}: invalid SHA-256`);
    const splits = recordingSplits.get(entry.sourceRecordingId) ?? new Set<DatasetSplit>();
    splits.add(entry.split);
    recordingSplits.set(entry.sourceRecordingId, splits);
  }
  for (const [recording, splits] of recordingSplits) {
    const modelSplits = [...splits].filter((split) => split !== "external-test");
    if (new Set(modelSplits).size > 1) {
      errors.push(`${recording}: source recording leaks across ${modelSplits.join(", ")}`);
    }
  }
  return errors;
}
