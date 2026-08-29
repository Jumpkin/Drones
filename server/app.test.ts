import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DataType, newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { Database } from "./database.js";
import type { AppConfig } from "./types.js";

const setupCode = "drones-test-setup";
const config: AppConfig = {
  databaseUrl: "postgresql://unused",
  setupCode,
  tokenPepper: "test-token-pepper-with-at-least-thirty-two-characters",
  host: "127.0.0.1",
  port: 8080,
  rateLimitMax: 120,
};

function detector(detectorId: "dsp-v1" | "ml-onnx-v1" | "crnn-pretrained-v1", detected: boolean) {
  return {
    detectorId,
    version: "1.0.0",
    detected,
    probability: detected ? 0.9 : 0.1,
    threshold: 0.5,
    latencyMs: 12,
    positiveWindows: detected ? 3 : 0,
    analyzedWindows: 5,
  };
}

describe("Drones API", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let database: Database;

  beforeEach(async () => {
    const memory = newDb({ autoCreateForeignKeyIndices: true });
    memory.public.registerFunction({
      name: "char_length",
      args: [DataType.text],
      returns: DataType.integer,
      implementation: (value: string) => value.length,
    });
    memory.public.registerFunction({
      name: "jsonb_typeof",
      args: [DataType.jsonb],
      returns: DataType.text,
      implementation: (value: unknown) => Array.isArray(value) ? "array" : typeof value,
    });
    const migrationUrl = new URL("./migrations/001_initial.sql", import.meta.url);
    memory.public.none(await readFile(fileURLToPath(migrationUrl), "utf8"));
    const adapter = memory.adapters.createPg();
    const pool = new adapter.Pool();
    database = pool as unknown as Database;
    app = await buildApp(database, config);
  });

  afterEach(async () => app?.close());

  async function enroll(label: string, code = setupCode) {
    const response = await app!.inject({
      method: "POST",
      url: "/api/drones/v1/devices/enroll",
      headers: { "x-drones-setup-code": code },
      payload: { label, appVersion: "0.1.0", platform: "ios" },
    });
    return { response, body: response.json() as { device: { id: string }; capability: string } };
  }

  it("requires the shared setup code and stores a per-device capability", async () => {
    const denied = await enroll("Phone A", "wrong-code");
    expect(denied.response.statusCode).toBe(401);
    const enrolled = await enroll("Phone A");
    expect(enrolled.response.statusCode).toBe(201);
    expect(enrolled.body.capability).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(enrolled.body.device.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("serves the built web shell and SPA fallback without duplicate routes", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "drones-static-"));
    try {
      await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Drones shell</title>");
      await app?.close();
      app = await buildApp(database, { ...config, staticDir });
      expect((await app.inject({ method: "GET", url: "/" })).body).toContain("Drones shell");
      expect((await app.inject({ method: "GET", url: "/statistics" })).body).toContain("Drones shell");
      expect((await app.inject({ method: "GET", url: "/api/unknown" })).statusCode).toBe(404);
    } finally {
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  it("coordinates source/listener roles and derives metrics from integer observations", async () => {
    const source = await enroll("Source");
    const listener = await enroll("Listener");
    const created = await app!.inject({
      method: "POST",
      url: "/api/drones/v1/sessions",
      headers: { authorization: `Bearer ${source.body.capability}` },
      payload: { role: "source" },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as { session: { id: string; code: string } };
    expect(createdBody.session.code).toMatch(/^[A-Z2-9]{6}$/);

    const joined = await app!.inject({
      method: "POST",
      url: "/api/drones/v1/sessions/join",
      headers: { authorization: `Bearer ${listener.body.capability}` },
      payload: { code: createdBody.session.code, role: "listener" },
    });
    expect(joined.statusCode).toBe(200);

    const scheduledAt = new Date(Date.now() + 3_000);
    const playback = await app!.inject({
      method: "POST",
      url: `/api/drones/v1/sessions/${createdBody.session.id}/playbacks`,
      headers: { authorization: `Bearer ${source.body.capability}` },
      payload: {
        soundId: "batear-mavic-pro",
        expectedLabel: "drone",
        scheduledAt: scheduledAt.toISOString(),
        durationMs: 5_000,
      },
    });
    expect(playback.statusCode, playback.body).toBe(201);
    const playbackId = (playback.json() as { playback: { id: string } }).playback.id;
    const eventId = crypto.randomUUID();
    const observation = {
      id: eventId,
      capturedAt: scheduledAt.toISOString(),
      sessionId: createdBody.session.id,
      playbackId,
      sampleRate: 16_000,
      windowDurationMs: 1_000,
      consensus: { detected: true, positiveDetectors: 2 },
      detectors: [detector("dsp-v1", true), detector("ml-onnx-v1", true),
        detector("crnn-pretrained-v1", false)],
      classification: { profile: "camera", label: "Camera quadcopter", confidence: 0.72 },
    };
    const first = await app!.inject({
      method: "POST",
      url: "/api/drones/v1/events/batch",
      headers: { authorization: `Bearer ${listener.body.capability}` },
      payload: { events: [observation] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ accepted: 1, duplicates: 0 });
    const duplicate = await app!.inject({
      method: "POST",
      url: "/api/drones/v1/events/batch",
      headers: { authorization: `Bearer ${listener.body.capability}` },
      payload: { events: [observation] },
    });
    expect(duplicate.json()).toEqual({ accepted: 0, duplicates: 1 });
    const outsidePlayback = await app!.inject({
      method: "POST",
      url: "/api/drones/v1/events/batch",
      headers: { authorization: `Bearer ${listener.body.capability}` },
      payload: { events: [{
        ...observation,
        id: crypto.randomUUID(),
        capturedAt: new Date(scheduledAt.getTime() + 60_000).toISOString(),
      }] },
    });
    expect(outsidePlayback.statusCode).toBe(422);
    expect(outsidePlayback.json()).toEqual({ error: "observation_outside_playback" });

    const result = await app!.inject({
      method: "GET",
      url: `/api/drones/v1/sessions/${createdBody.session.id}`,
      headers: { authorization: `Bearer ${listener.body.capability}` },
    });
    expect(result.statusCode).toBe(200);
    const snapshot = (result.json() as { session: {
      metrics: Array<Record<string, number | string>>;
      listenerMetrics: Array<Record<string, number | string>>;
      playbackMetrics: Array<Record<string, number | string>>;
    } }).session;
    const metrics = snapshot.metrics;
    expect(metrics.find((metric) => metric.detectorId === "dsp-v1")).toMatchObject({ tests: 1, tp: 1 });
    expect(metrics.find((metric) => metric.detectorId === "crnn-pretrained-v1")).toMatchObject({ tests: 1, fn: 1 });
    expect(metrics.find((metric) => metric.detectorId === "consensus-2-of-3")).toMatchObject({ tests: 1, tp: 1 });
    expect(snapshot.listenerMetrics.find((metric) => metric.detectorId === "consensus-2-of-3"))
      .toMatchObject({ tests: 1, tp: 1, deviceId: listener.body.device.id });
    expect(snapshot.playbackMetrics.find((metric) => metric.detectorId === "consensus-2-of-3"))
      .toMatchObject({ tests: 1, tp: 1, playbackId });
  });

  it("rejects raw audio, malformed consensus, and standalone negatives", async () => {
    const listener = await enroll("Listener");
    const headers = { authorization: `Bearer ${listener.body.capability}` };
    const raw = await app!.inject({
      method: "POST", url: "/api/drones/v1/events/batch", headers,
      payload: { audioSamples: [0.1, 0.2] },
    });
    expect(raw.statusCode).toBe(422);

    const unknownData = await app!.inject({
      method: "POST", url: "/api/drones/v1/events/batch", headers,
      payload: { events: [{ id: crypto.randomUUID(), data: [0.1, 0.2] }] },
    });
    expect(unknownData.statusCode).toBe(400);

    const base = {
      id: crypto.randomUUID(), capturedAt: new Date().toISOString(), sampleRate: 16_000,
      windowDurationMs: 1_000,
      consensus: { detected: true, positiveDetectors: 1 },
      detectors: [detector("dsp-v1", true), detector("ml-onnx-v1", false),
        detector("crnn-pretrained-v1", false)],
    };
    const malformed = await app!.inject({ method: "POST", url: "/api/drones/v1/events/batch", headers,
      payload: { events: [base] } });
    expect(malformed.statusCode).toBe(400);
    const negative = await app!.inject({ method: "POST", url: "/api/drones/v1/events/batch", headers,
      payload: { events: [{ ...base, id: crypto.randomUUID(), consensus: { detected: false, positiveDetectors: 0 },
        detectors: [detector("dsp-v1", false), detector("ml-onnx-v1", false), detector("crnn-pretrained-v1", false)] }] } });
    expect(negative.statusCode).toBe(422);
  });

  it("enforces the configured request rate", async () => {
    const database = { query: async () => ({ rows: [{ version: 1 }], rowCount: 1 }) } as unknown as Database;
    const limited = await buildApp(database,
      { ...config, rateLimitMax: 2 });
    try {
      await limited.inject({ method: "GET", url: "/api/drones/v1/time" });
      await limited.inject({ method: "GET", url: "/api/drones/v1/time" });
      const response = await limited.inject({ method: "GET", url: "/api/drones/v1/time" });
      expect(response.statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
