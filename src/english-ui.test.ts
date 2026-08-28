import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const userFacingSources = [
  "index.html",
  "src/main.ts",
  "src/sim.ts",
  "src/samples.ts",
  "src/microphone.ts",
  "src/audio.ts",
  "src/detector.ts",
  "src/detectors/dsp-adapter.ts",
  "src/detectors/ml-adapter.ts",
  "src/events.ts",
];

describe("English interface", () => {
  it("declares English as the document language", async () => {
    const index = await readFile("index.html", "utf8");
    expect(index).toContain('<html lang="en">');
  });

  it("does not reintroduce Swedish interface copy", async () => {
    const content = (await Promise.all(
      userFacingSources.map((file) => readFile(file, "utf8")),
    )).join("\n");

    expect(content).not.toMatch(/[åäöÅÄÖ]/);
    expect(content).not.toMatch(
      /\b(?:Arbetsläge|Stadssimulering|Ljudlabb|Drönare|Bakgrund|Analysen|Försök|Statistik)\b/,
    );
  });
});
