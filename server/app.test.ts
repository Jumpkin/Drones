import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DataType, newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { Database } from "./database.js";
import type { AppConfig } from "./types.js";

const config: AppConfig = {
  databaseUrl: "postgresql://unused",
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
    const migrations = ["001_initial.sql", "002_remove_device_capabilities.sql", "003_hardware_calibration.sql"];
    for (const migration of migrations) {
      const migrationUrl = new URL(`./migrations/${migration}`, import.meta.url);
      memory.public.none(await readFile(fileURLToPath(migrationUrl), "utf8"));
    }
    const latestMigration = new URL("./migrations/003_hardware_calibration.sql", import.meta.url);
    memory.public.none(await readFile(fileURLToPath(latestMigration), "utf8"));
    const adapter = memory.adapters.createPg();
    const pool = new adapter.Pool();
    database = pool as unknown as Database;
    app = await buildApp(database, config);
  });

  afterEach(async () => app?.close());

  async function enroll(label: string) {
    const response = await app!.inject({
      method: "POST",
      url: "/api/drones/v1/devices/enroll",
      payload: { label, appVersion: "0.1.0", platform: "ios" },
    });
    return { response, body: response.json() as { device: { id: string } } };
  }

  it("registers a test device without credentials", async () => {
    const enrolled = await enroll("Phone A");
    expect(enrolled.response.statusCode).toBe(201);
    expect(enrolled.body.device.id).toMatch(/^[0-9a-f-]{36}$/);

    const missingId = await app!.inject({
      method: "POST", url: "/api/drones/v1/sessions", payload: { role: "listener" },
    });
    expect(missingId.statusCode).toBe(400);
    expect(missingId.json()).toEqual({ error: "device_id_required" });

    const unknownId = await app!.inject({
      method: "POST", url: "/api/drones/v1/sessions",
      headers: { "x-drones-device-id": crypto.randomUUID() },
      payload: { role: "listener" },
    });
    expect(unknownId.statusCode).toBe(404);
    expect(unknownId.json()).toEqual({ error: "device_not_found" });
  });

  it("registers a browser coordinator and retains calibration metadata", async () => {
    const coordinatorResponse = await app!.inject({
      method: "POST",
      url: "/api/drones/v1/devices/enroll",
      payload: { label: "Laptop coordinator", appVersion: "web", platform: "web" },
    });
    expect(coordinatorResponse.statusCode).toBe(201);
    const coordinator = coordinatorResponse.json() as { device: { id: string; platform: string } };
    expect(coordinator.device.platform).toBe("web");

    const listener = await enroll("Listener");
    const created = await app!.inject({
      method: "POST", url: "/api/drones/v1/sessions",
      headers: { "x-drones-device-id": coordinator.device.id }, payload: { role: "source" },
    });
    const session = (created.json() as { session: { id: string; code: string } }).session;
    await app!.inject({
      method: "POST", url: "/api/drones/v1/sessions/join",
      headers: { "x-drones-device-id": listener.body.device.id },
      payload: { code: session.code, role: "listener" },
    });
    const scheduledAt = new Date(Date.now() + 3_000).toISOString();
    const playbackResponse = await app!.inject({
      method: "POST", url: `/api/drones/v1/sessions/${session.id}/playbacks`,
      headers: { "x-drones-device-id": coordinator.device.id },
      payload: {
        soundId: "synth-traffic", expectedLabel: "background", scheduledAt, durationMs: 4_000,
        sourceKind: "computer", distanceM: 3, volumePercent: 50, environment: "traffic",
      },
    });
    expect(playbackResponse.statusCode, playbackResponse.body).toBe(201);
    const playback = playbackResponse.json() as { playback: Record<string, unknown> };
    expect(playback.playback).toMatchObject({
      source_kind: "computer", distance_m: 3, volume_percent: 50, environment: "traffic",
    });

    const snapshotResponse = await app!.inject({
      method: "GET", url: `/api/drones/v1/sessions/${session.id}`,
      headers: { "x-drones-device-id": coordinator.device.id },
    });
    const snapshot = (snapshotResponse.json() as { session: { playbacks: Array<Record<string, unknown>> } }).session;
    expect(snapshot.playbacks[0]).toMatchObject({
      source_kind: "computer", distance_m: 3, volume_percent: 50, environment: "traffic",
    });
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
      headers: { "x-drones-device-id": source.body.device.id },
      payload: { role: "source" },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as { session: { id: string; code: string } };
    expect(createdBody.session.code).toMatch(/^[A-Z2-9]{6}$/);

    const joined = await app!.inject({
      method: "POST",
      url: "/api/drones/v1/sessions/join",
      headers: { "x-drones-device-id": listener.body.device.id },
      payload: { code: createdBody.session.code, role: "listener" },
    });
    expect(joined.statusCode).toBe(200);

    const scheduledAt = new Date(Date.now() + 3_000);
    const playback = await app!.inject({
      method: "POST",
      url: `/api/drones/v1/sessions/${createdBody.session.id}/playbacks`,
      headers: { "x-drones-device-id": source.body.device.id },
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
      headers: { "x-drones-device-id": listener.body.device.id },
      payload: { events: [observation] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ accepted: 1, duplicates: 0 });
    const duplicate = await app!.inject({
      method: "POST",
      url: "/api/drones/v1/events/batch",
      headers: { "x-drones-device-id": listener.body.device.id },
      payload: { events: [observation] },
    });
    expect(duplicate.json()).toEqual({ accepted: 0, duplicates: 1 });
    const outsidePlayback = await app!.inject({
      method: "POST",
      url: "/api/drones/v1/events/batch",
      headers: { "x-drones-device-id": listener.body.device.id },
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
      headers: { "x-drones-device-id": listener.body.device.id },
    });
    expect(result.statusCode).toBe(200);
    const snapshot = (result.json() as { session: {
      metrics: Array<Record<string, number | string>>;
      listenerMetrics: Array<Record<string, number | string>>;
      playbackMetrics: Array<Record<string, number | string>>;
    } }).session;
    const metrics = snapshot.metrics;
    expect(metrics.find((metric) => metric.detectorId === "dsp-v1")).toMatchObject({
      tests: 1, tp: 1, averageProbability: 0.9, averageLatencyMs: 12,
    });
    expect(metrics.find((metric) => metric.detectorId === "crnn-pretrained-v1")).toMatchObject({ tests: 1, fn: 1 });
    expect(metrics.find((metric) => metric.detectorId === "consensus-2-of-3")).toMatchObject({ tests: 1, tp: 1 });
    expect(snapshot.listenerMetrics.find((metric) => metric.detectorId === "consensus-2-of-3"))
      .toMatchObject({ tests: 1, tp: 1, deviceId: listener.body.device.id });
    expect(snapshot.playbackMetrics.find((metric) => metric.detectorId === "consensus-2-of-3"))
      .toMatchObject({ tests: 1, tp: 1, playbackId });
  });

  it("rejects raw audio, malformed consensus, and standalone negatives", async () => {
    const listener = await enroll("Listener");
    const headers = { "x-drones-device-id": listener.body.device.id };
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
