import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { resolve } from "node:path";
import type { Database } from "./database.js";
import { DronesRepository, type DeviceIdentity } from "./repository.js";
import { containsRawAudio } from "./security.js";
import type { AppConfig, DetectorId, ExpectedLabel, ObservationEvent, SessionRole } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    dronesDevice?: DeviceIdentity;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DETECTOR_IDS = new Set<DetectorId>(["dsp-v1", "ml-onnx-v1", "crnn-pretrained-v1"]);

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(body).every((key) => allowedKeys.has(key));
}

function stringField(body: Record<string, unknown>, name: string, maximum = 80): string | undefined {
  const value = body[name];
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum
    ? value.trim()
    : undefined;
}

function roleField(value: unknown): SessionRole | undefined {
  return value === "source" || value === "listener" ? value : undefined;
}

function expectedLabel(value: unknown): ExpectedLabel | undefined {
  return value === "drone" || value === "background" ? value : undefined;
}

function finiteRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function parseObservation(value: unknown): ObservationEvent | undefined {
  if (!object(value) || !hasOnlyKeys(value, [
    "id", "capturedAt", "sessionId", "playbackId", "sampleRate", "windowDurationMs",
    "location", "consensus", "detectors", "classification",
  ])) return undefined;
  const id = stringField(value, "id", 36);
  const capturedAt = stringField(value, "capturedAt", 40);
  if (!id || !UUID_PATTERN.test(id) || !capturedAt || !Number.isFinite(Date.parse(capturedAt))) return undefined;
  const sessionId = value.sessionId === undefined ? undefined : stringField(value, "sessionId", 36);
  const playbackId = value.playbackId === undefined ? undefined : stringField(value, "playbackId", 36);
  if ((sessionId && !UUID_PATTERN.test(sessionId)) || (playbackId && !UUID_PATTERN.test(playbackId)) ||
      (value.playbackId !== undefined && !sessionId)) return undefined;
  if (!Number.isInteger(value.sampleRate) || !finiteRange(value.sampleRate, 8_000, 192_000) ||
      !Number.isInteger(value.windowDurationMs) || !finiteRange(value.windowDurationMs, 100, 10_000) ||
      !object(value.consensus) || !hasOnlyKeys(value.consensus, ["detected", "positiveDetectors"]) ||
      typeof value.consensus.detected !== "boolean" ||
      !Number.isInteger(value.consensus.positiveDetectors) ||
      !finiteRange(value.consensus.positiveDetectors, 0, 3) || !Array.isArray(value.detectors) ||
      value.detectors.length !== 3) return undefined;
  const seen = new Set<string>();
  const detectors = value.detectors.map((candidate) => {
    if (!object(candidate) || !hasOnlyKeys(candidate, [
      "detectorId", "version", "detected", "probability", "threshold", "latencyMs",
      "positiveWindows", "analyzedWindows",
    ])) return undefined;
    const detectorId = stringField(candidate, "detectorId", 40) as DetectorId | undefined;
    const version = stringField(candidate, "version", 40);
    if (!detectorId || !DETECTOR_IDS.has(detectorId) || seen.has(detectorId) || !version ||
        typeof candidate.detected !== "boolean" || !finiteRange(candidate.probability, 0, 1) ||
        !finiteRange(candidate.threshold, 0, 1) || !finiteRange(candidate.latencyMs, 0, 120_000) ||
        !Number.isInteger(candidate.positiveWindows) || !finiteRange(candidate.positiveWindows, 0, 5) ||
        !Number.isInteger(candidate.analyzedWindows) || !finiteRange(candidate.analyzedWindows, 1, 5) ||
        candidate.positiveWindows > candidate.analyzedWindows) return undefined;
    seen.add(detectorId);
    return {
      detectorId, version, detected: candidate.detected, probability: candidate.probability,
      threshold: candidate.threshold, latencyMs: candidate.latencyMs,
      positiveWindows: candidate.positiveWindows, analyzedWindows: candidate.analyzedWindows,
    };
  });
  if (detectors.some((detector) => !detector)) return undefined;
  const positives = detectors.filter((detector) => detector?.detected).length;
  if (positives !== value.consensus.positiveDetectors || value.consensus.detected !== (positives >= 2)) {
    return undefined;
  }
  let location: ObservationEvent["location"];
  if (value.location !== undefined) {
    if (!object(value.location) || !hasOnlyKeys(value.location, [
      "latitude", "longitude", "horizontalAccuracyM", "altitudeM",
    ]) || !finiteRange(value.location.latitude, -90, 90) ||
        !finiteRange(value.location.longitude, -180, 180) ||
        !finiteRange(value.location.horizontalAccuracyM, 0, 100_000) ||
        (value.location.altitudeM !== undefined && !finiteRange(value.location.altitudeM, -1000, 100_000))) {
      return undefined;
    }
    location = {
      latitude: value.location.latitude,
      longitude: value.location.longitude,
      horizontalAccuracyM: value.location.horizontalAccuracyM,
      altitudeM: value.location.altitudeM as number | undefined,
    };
  }
  let classification: ObservationEvent["classification"];
  if (value.classification !== undefined) {
    if (!object(value.classification) || !hasOnlyKeys(value.classification, ["profile", "label", "confidence"]) ||
        !stringField(value.classification, "profile", 40) ||
        !stringField(value.classification, "label", 80) ||
        !finiteRange(value.classification.confidence, 0, 1)) return undefined;
    classification = {
      profile: String(value.classification.profile), label: String(value.classification.label),
      confidence: value.classification.confidence,
    };
  }
  return {
    id, capturedAt, sessionId, playbackId, sampleRate: value.sampleRate as number,
    windowDurationMs: value.windowDurationMs as number,
    location,
    consensus: { detected: value.consensus.detected, positiveDetectors: positives },
    detectors: detectors as ObservationEvent["detectors"], classification,
  };
}

export async function buildApp(
  database: Database,
  config: AppConfig,
  options: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 64 * 1024,
    trustProxy: false,
  });
  const repository = new DronesRepository(database);
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: "1 minute",
  });

  app.addHook("preValidation", async (request, reply) => {
    if (containsRawAudio(request.body)) {
      await reply.code(422).send({ error: "raw_audio_not_accepted" });
    }
  });

  const identifyDevice = async (request: FastifyRequest, reply: FastifyReply) => {
    const deviceId = request.headers["x-drones-device-id"];
    if (typeof deviceId !== "string" || !UUID_PATTERN.test(deviceId)) {
      return reply.code(400).send({ error: "device_id_required" });
    }
    const device = await repository.identify(deviceId);
    if (!device) {
      return reply.code(404).send({ error: "device_not_found" });
    }
    request.dronesDevice = device;
  };

  app.get("/health/ready", async (_request, reply) => {
    try {
      await repository.ready();
      return { status: "ready", database: true };
    } catch {
      return reply.code(503).send({ status: "not_ready", database: false });
    }
  });

  app.get("/api/drones/v1/time", async () => ({ serverTime: new Date().toISOString() }));

  app.post("/api/drones/v1/devices/enroll", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    if (!object(request.body) || !hasOnlyKeys(request.body, ["label", "appVersion", "platform"])) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const label = stringField(request.body, "label");
    const appVersion = stringField(request.body, "appVersion", 40);
    if (!label || !appVersion || request.body.platform !== "ios") {
      return reply.code(400).send({ error: "invalid_device" });
    }
    const device = await repository.createDevice({
      label, appVersion,
    });
    return reply.code(201).send({
      device: { id: device.id, label: device.label, platform: device.platform },
    });
  });

  app.post("/api/drones/v1/sessions", { preHandler: identifyDevice }, async (request, reply) => {
    if (!request.dronesDevice || !object(request.body) || !hasOnlyKeys(request.body, ["role"])) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const role = roleField(request.body.role);
    if (!role) return reply.code(400).send({ error: "invalid_role" });
    return reply.code(201).send({ session: await repository.createSession(request.dronesDevice.id, role) });
  });

  app.post("/api/drones/v1/sessions/join", { preHandler: identifyDevice }, async (request, reply) => {
    if (!request.dronesDevice || !object(request.body) || !hasOnlyKeys(request.body, ["code", "role"])) {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const code = stringField(request.body, "code", 6)?.toUpperCase();
    const role = roleField(request.body.role);
    if (!code || !/^[A-Z2-9]{6}$/.test(code) || !role) {
      return reply.code(400).send({ error: "invalid_session_join" });
    }
    const sessionId = await repository.joinSession(request.dronesDevice.id, code, role);
    if (!sessionId) return reply.code(404).send({ error: "session_not_found" });
    return { sessionId };
  });

  app.post<{ Params: { id: string } }>(
    "/api/drones/v1/sessions/:id/playbacks",
    { preHandler: identifyDevice },
    async (request, reply) => {
      if (!request.dronesDevice || !UUID_PATTERN.test(request.params.id) || !object(request.body) ||
          !hasOnlyKeys(request.body, ["soundId", "expectedLabel", "scheduledAt", "durationMs"])) {
        return reply.code(400).send({ error: "invalid_playback" });
      }
      const soundId = stringField(request.body, "soundId");
      const label = expectedLabel(request.body.expectedLabel);
      const scheduledAt = stringField(request.body, "scheduledAt", 40);
      const durationMs = request.body.durationMs;
      const timestamp = scheduledAt ? Date.parse(scheduledAt) : Number.NaN;
      if (!soundId || !label || !scheduledAt || !Number.isFinite(timestamp) ||
          timestamp < Date.now() - 5_000 || timestamp > Date.now() + 10 * 60_000 ||
          !Number.isInteger(durationMs) || !finiteRange(durationMs, 250, 120_000)) {
        return reply.code(400).send({ error: "invalid_playback" });
      }
      try {
        const playback = await repository.createPlayback({
          sessionId: request.params.id, deviceId: request.dronesDevice.id,
          soundId, expectedLabel: label, scheduledAt, durationMs,
        });
        return reply.code(201).send({ playback });
      } catch (error) {
        if ((error as Error).message === "SESSION_SOURCE_REQUIRED") {
          return reply.code(403).send({ error: "session_source_required" });
        }
        throw error;
      }
    },
  );

  app.post("/api/drones/v1/events/batch", { preHandler: identifyDevice }, async (request, reply) => {
    if (!request.dronesDevice || !object(request.body) || !hasOnlyKeys(request.body, ["events"]) ||
        !Array.isArray(request.body.events) ||
        request.body.events.length < 1 || request.body.events.length > 50) {
      return reply.code(400).send({ error: "invalid_event_batch" });
    }
    const events = request.body.events.map(parseObservation);
    if (events.some((event) => !event)) return reply.code(400).send({ error: "invalid_observation" });
    if (events.some((event) => !event?.sessionId && !event?.consensus.detected)) {
      return reply.code(422).send({ error: "standalone_negative_not_retained" });
    }
    let inserted = 0;
    try {
      for (const event of events as ObservationEvent[]) {
        await repository.assertObservationAccess(request.dronesDevice.id, event);
      }
      for (const event of events as ObservationEvent[]) {
        if (await repository.insertObservation(request.dronesDevice.id, event)) inserted += 1;
      }
    } catch (error) {
      const message = (error as Error).message;
      if (message === "SESSION_LISTENER_REQUIRED" || message === "PLAYBACK_NOT_IN_SESSION") {
        return reply.code(403).send({ error: message.toLowerCase() });
      }
      if (message === "OBSERVATION_OUTSIDE_PLAYBACK") {
        return reply.code(422).send({ error: message.toLowerCase() });
      }
      throw error;
    }
    return { accepted: inserted, duplicates: events.length - inserted };
  });

  app.get<{ Params: { id: string } }>(
    "/api/drones/v1/sessions/:id",
    { preHandler: identifyDevice },
    async (request, reply) => {
      if (!request.dronesDevice || !UUID_PATTERN.test(request.params.id)) {
        return reply.code(400).send({ error: "invalid_session" });
      }
      const session = await repository.sessionSnapshot(request.params.id, request.dronesDevice.id);
      return session ? { session } : reply.code(404).send({ error: "session_not_found" });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/drones/v1/sessions/:id/close",
    { preHandler: identifyDevice },
    async (request, reply) => {
      if (!request.dronesDevice || !UUID_PATTERN.test(request.params.id)) {
        return reply.code(400).send({ error: "invalid_session" });
      }
      const closed = await repository.closeSession(request.params.id, request.dronesDevice.id);
      return closed ? { closed: true } : reply.code(403).send({ error: "session_owner_required" });
    },
  );

  if (config.staticDir) {
    await app.register(fastifyStatic, { root: resolve(config.staticDir), wildcard: false });
    app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/health/")) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const appError = error as Error & { statusCode?: number };
    const status = appError.statusCode && appError.statusCode >= 400 && appError.statusCode < 500
      ? appError.statusCode
      : 500;
    reply.code(status).send({ error: status === 500 ? "internal_error" : appError.message });
  });
  return app;
}
