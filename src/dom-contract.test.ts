import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("web DOM contract", () => {
  it("defines every required element exactly once", async () => {
    const source = await readFile("src/main.ts", "utf8");
    const defined = [...source.matchAll(/\bid="([A-Za-z][A-Za-z0-9_-]*)"/g)].map((match) => match[1]);
    const required = [...source.matchAll(/requiredElement(?:<[^>]+>)?\("#([A-Za-z][A-Za-z0-9_-]*)"\)/g)]
      .map((match) => match[1]);
    const counts = new Map<string, number>();
    for (const id of defined) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect([...counts.entries()].filter(([, count]) => count !== 1)).toEqual([]);
    expect(required.filter((id) => !counts.has(id))).toEqual([]);
  });
});
