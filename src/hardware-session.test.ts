import { describe, expect, it, vi } from "vitest";
import { detectorLabel, HardwareSessionClient, validateCalibration } from "./hardware-session";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("hardware calibration sessions", () => {
  it("validates physical test metadata", () => {
    expect(() => validateCalibration({
      soundId: "batear-mavic-pro", expectedLabel: "drone",
      scheduledAt: new Date().toISOString(), durationMs: 4_000,
      distanceM: 3, volumePercent: 50, environment: "quiet-room",
    })).not.toThrow();
    expect(() => validateCalibration({
      soundId: "bad", expectedLabel: "background",
      scheduledAt: new Date().toISOString(), durationMs: 4_000,
      distanceM: 0, volumePercent: 50, environment: "wind",
    })).toThrow(/Distance/);
  });

  it("labels every compared detector", () => {
    expect(detectorLabel("dsp-v1")).toContain("DSP");
    expect(detectorLabel("consensus-2-of-3")).toContain("consensus");
  });

  it("registers a web coordinator and creates a source session", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith("/devices/enroll")) {
        return new Response(JSON.stringify({ device: { id: "11111111-1111-4111-8111-111111111111" } }), { status: 201 });
      }
      if (path.endsWith("/sessions")) {
        return new Response(JSON.stringify({ session: { id: "22222222-2222-4222-8222-222222222222" } }), { status: 201 });
      }
      return new Response(JSON.stringify({ session: {
        id: "22222222-2222-4222-8222-222222222222", code: "ABC234", status: "open",
        members: [], playbacks: [], metrics: [], listenerMetrics: [], playbackMetrics: [],
      } }));
    }) as unknown as typeof fetch;
    const client = new HardwareSessionClient(memoryStorage(), fetcher);
    const session = await client.createSession();
    expect(session.code).toBe("ABC234");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
