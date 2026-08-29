import { afterEach, describe, expect, it } from "vitest";
import { resetDisposableDatabase } from "./reset.js";

describe("owner-only disposable database reset", () => {
  const previous = process.env.DRONES_ALLOW_RESET;
  afterEach(() => {
    if (previous === undefined) delete process.env.DRONES_ALLOW_RESET;
    else process.env.DRONES_ALLOW_RESET = previous;
  });

  it("fails closed before connecting without the explicit environment gate", async () => {
    delete process.env.DRONES_ALLOW_RESET;
    await expect(resetDisposableDatabase("postgresql://not-used"))
      .rejects.toThrow("Reset refused");
  });
});
