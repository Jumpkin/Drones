import { randomInt, randomUUID } from "node:crypto";
import type { Database } from "./database.js";
import type { DetectorObservation, ExpectedLabel, ObservationEvent, SessionRole } from "./types.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface MetricCounter {
  detectorId: string;
  tests: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  deviceId?: string;
  playbackId?: string;
  soundId?: string;
  expectedLabel?: ExpectedLabel;
}

function recordMetric(
  map: Map<string, MetricCounter>,
  key: string,
  seed: Omit<MetricCounter, "tests" | "tp" | "fp" | "tn" | "fn">,
  expected: ExpectedLabel,
  detected: boolean,
): void {
  const metric = map.get(key) ?? { ...seed, tests: 0, tp: 0, fp: 0, tn: 0, fn: 0 };
  metric.tests += 1;
  if (expected === "drone" && detected) metric.tp += 1;
  else if (expected === "drone") metric.fn += 1;
  else if (detected) metric.fp += 1;
  else metric.tn += 1;
  map.set(key, metric);
}

function finalizeMetrics(map: Map<string, MetricCounter>): Array<MetricCounter & {
  precision: number; recall: number; falsePositiveRate: number; f1: number;
}> {
  return [...map.values()].map((metric) => {
    const precision = metric.tp / Math.max(1, metric.tp + metric.fp);
    const recall = metric.tp / Math.max(1, metric.tp + metric.fn);
    return { ...metric, precision, recall,
      falsePositiveRate: metric.fp / Math.max(1, metric.fp + metric.tn),
      f1: (2 * precision * recall) / Math.max(1e-9, precision + recall) };
  });
}

export interface DeviceRow {
  id: string;
  label: string;
  app_version: string;
  platform: string;
  created_at: Date | string;
  last_seen_at: Date | string;
}

export interface DeviceIdentity {
  id: string;
  label: string;
}

export class DronesRepository {
  constructor(private readonly database: Database) {}

  async ready(): Promise<void> {
    await this.database.query("SELECT version FROM drones_schema_migrations ORDER BY version DESC LIMIT 1");
  }

  async createDevice(input: {
    label: string;
    appVersion: string;
  }): Promise<DeviceRow> {
    const result = await this.database.query<DeviceRow>(
      `INSERT INTO drones_devices (id, label, app_version, platform)
       VALUES ($1, $2, $3, 'ios')
       RETURNING id, label, app_version, platform, created_at, last_seen_at`,
      [randomUUID(), input.label, input.appVersion],
    );
    return result.rows[0];
  }

  async identify(deviceId: string): Promise<DeviceIdentity | undefined> {
    const result = await this.database.query<DeviceIdentity>(
      `UPDATE drones_devices SET last_seen_at = now()
       WHERE id = $1 RETURNING id, label`,
      [deviceId],
    );
    return result.rows[0];
  }

  async createSession(deviceId: string, role: SessionRole): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const sessionId = randomUUID();
      const code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
      try {
        const result = await this.database.query<Record<string, unknown>>(
          `INSERT INTO drones_sessions (id, code, created_by, expires_at)
           VALUES ($1, $2, $3, now() + interval '6 hours')
           RETURNING id, code, status, created_at, expires_at`,
          [sessionId, code, deviceId],
        );
        await this.database.query(
          `INSERT INTO drones_session_memberships (session_id, device_id, role)
           VALUES ($1, $2, $3)`,
          [sessionId, deviceId, role],
        );
        return result.rows[0];
      } catch (error) {
        if ((error as { code?: string }).code !== "23505") throw error;
      }
    }
    throw new Error("Could not allocate a unique session code");
  }

  async joinSession(deviceId: string, code: string, role: SessionRole): Promise<string | undefined> {
    const session = await this.database.query<{ id: string }>(
      `SELECT id FROM drones_sessions
       WHERE code = $1 AND status = 'open' AND expires_at > now()`,
      [code],
    );
    const sessionId = session.rows[0]?.id;
    if (!sessionId) return undefined;
    await this.database.query(
      `INSERT INTO drones_session_memberships (session_id, device_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id, device_id) DO UPDATE SET role = EXCLUDED.role`,
      [sessionId, deviceId, role],
    );
    return sessionId;
  }

  async isMember(sessionId: string, deviceId: string, role?: SessionRole): Promise<boolean> {
    const values: unknown[] = [sessionId, deviceId];
    const roleClause = role ? " AND role = $3" : "";
    if (role) values.push(role);
    const result = await this.database.query(
      `SELECT 1 FROM drones_session_memberships
       WHERE session_id = $1 AND device_id = $2${roleClause}`,
      values,
    );
    return (result.rowCount ?? result.rows.length) > 0;
  }

  async createPlayback(input: {
    sessionId: string;
    deviceId: string;
    soundId: string;
    expectedLabel: ExpectedLabel;
    scheduledAt: string;
    durationMs: number;
  }): Promise<Record<string, unknown>> {
    const result = await this.database.query<Record<string, unknown>>(
      `INSERT INTO drones_playbacks
         (id, session_id, source_device_id, sound_id, expected_label, scheduled_at, duration_ms)
       SELECT $1, s.id, $3, $4, $5, $6::timestamptz, $7::integer
       FROM drones_sessions s
       JOIN drones_session_memberships m ON m.session_id = s.id
       WHERE s.id = $2 AND s.status = 'open' AND s.expires_at > now()
         AND m.device_id = $3 AND m.role = 'source'
       RETURNING id, session_id, sound_id, expected_label, scheduled_at, duration_ms, created_at`,
      [randomUUID(), input.sessionId, input.deviceId, input.soundId, input.expectedLabel,
        input.scheduledAt, input.durationMs],
    );
    if (!result.rows[0]) throw new Error("SESSION_SOURCE_REQUIRED");
    return result.rows[0];
  }

  async insertObservation(deviceId: string, event: ObservationEvent): Promise<boolean> {
    const existing = await this.database.query("SELECT 1 FROM drones_observations WHERE id = $1", [event.id]);
    if ((existing.rowCount ?? existing.rows.length) > 0) return false;
    const location = event.location;
    const classification = event.classification;
    const result = await this.database.query(
      `INSERT INTO drones_observations
         (id, device_id, session_id, playback_id, captured_at, latitude, longitude,
          horizontal_accuracy_m, altitude_m, sample_rate, window_duration_ms,
          consensus_detected, positive_detectors, classification_profile,
          classification_label, classification_confidence, detectors)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [event.id, deviceId, event.sessionId ?? null, event.playbackId ?? null, event.capturedAt,
        location?.latitude ?? null, location?.longitude ?? null,
        location?.horizontalAccuracyM ?? null, location?.altitudeM ?? null,
        event.sampleRate, event.windowDurationMs, event.consensus.detected,
        event.consensus.positiveDetectors, classification?.profile ?? null,
        classification?.label ?? null, classification?.confidence ?? null,
        JSON.stringify(event.detectors)],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async assertObservationAccess(deviceId: string, event: ObservationEvent): Promise<void> {
    if (event.sessionId && !(await this.isMember(event.sessionId, deviceId, "listener"))) {
      throw new Error("SESSION_LISTENER_REQUIRED");
    }
    if (event.playbackId) {
      const playback = await this.database.query<{ scheduled_at: Date | string; duration_ms: number }>(
        `SELECT scheduled_at, duration_ms FROM drones_playbacks WHERE id = $1 AND session_id = $2`,
        [event.playbackId, event.sessionId],
      );
      const row = playback.rows[0];
      if (!row) throw new Error("PLAYBACK_NOT_IN_SESSION");
      const capturedAt = Date.parse(event.capturedAt);
      const scheduledAt = new Date(row.scheduled_at).getTime();
      if (capturedAt < scheduledAt - 1_000 || capturedAt > scheduledAt + row.duration_ms + 1_000) {
        throw new Error("OBSERVATION_OUTSIDE_PLAYBACK");
      }
    }
  }

  async sessionSnapshot(sessionId: string, deviceId: string): Promise<Record<string, unknown> | undefined> {
    if (!(await this.isMember(sessionId, deviceId))) return undefined;
    const session = await this.database.query<Record<string, unknown>>(
      `SELECT id, code, created_by, status, created_at, expires_at, closed_at
       FROM drones_sessions WHERE id = $1`,
      [sessionId],
    );
    if (!session.rows[0]) return undefined;
    const members = await this.database.query<Record<string, unknown>>(
      `SELECT m.device_id AS id, d.label, m.role, m.joined_at, d.last_seen_at
       FROM drones_session_memberships m
       JOIN drones_devices d ON d.id = m.device_id
       WHERE m.session_id = $1 ORDER BY m.joined_at`,
      [sessionId],
    );
    const playbacks = await this.database.query<Record<string, unknown>>(
      `SELECT id, source_device_id, sound_id, expected_label, scheduled_at, duration_ms, created_at
       FROM drones_playbacks WHERE session_id = $1
       ORDER BY scheduled_at DESC`,
      [sessionId],
    );
    const observations = await this.database.query<{
      id: string;
      device_id: string;
      playback_id: string | null;
      captured_at: Date | string;
      consensus_detected: boolean;
      detectors: DetectorObservation[];
      classification_label: string | null;
    }>(
      `SELECT id, device_id, playback_id, captured_at, consensus_detected, detectors,
              classification_label
       FROM drones_observations WHERE session_id = $1
       ORDER BY captured_at DESC`,
      [sessionId],
    );
    const playbackById = new Map(playbacks.rows.map((row) => [String(row.id), row]));
    const metricMap = new Map<string, MetricCounter>();
    const listenerMetricMap = new Map<string, MetricCounter>();
    const playbackMetricMap = new Map<string, MetricCounter>();
    for (const observation of observations.rows) {
      const playback = observation.playback_id ? playbackById.get(observation.playback_id) : undefined;
      const expected = playback?.expected_label;
      if (expected !== "drone" && expected !== "background") continue;
      const decisions: Array<{ detectorId: string; detected: boolean }> = [
        ...observation.detectors.map((detector) => ({
          detectorId: detector.detectorId,
          detected: detector.detected,
        })),
        { detectorId: "consensus-2-of-3", detected: observation.consensus_detected },
      ];
      for (const decision of decisions) {
        recordMetric(metricMap, decision.detectorId, { detectorId: decision.detectorId }, expected, decision.detected);
        recordMetric(listenerMetricMap, `${observation.device_id}:${decision.detectorId}`,
          { detectorId: decision.detectorId, deviceId: observation.device_id }, expected, decision.detected);
        recordMetric(playbackMetricMap, `${observation.playback_id}:${decision.detectorId}`,
          { detectorId: decision.detectorId, playbackId: observation.playback_id ?? undefined,
            soundId: String(playback?.sound_id ?? "unknown"), expectedLabel: expected }, expected, decision.detected);
      }
    }
    const metrics = finalizeMetrics(metricMap);
    const listenerMetrics = finalizeMetrics(listenerMetricMap);
    const playbackMetrics = finalizeMetrics(playbackMetricMap);
    return { ...session.rows[0], members: members.rows, playbacks: playbacks.rows,
      observations: observations.rows.slice(0, 100), metrics, listenerMetrics, playbackMetrics };
  }

  async closeSession(sessionId: string, deviceId: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE drones_sessions SET status = 'closed', closed_at = now()
       WHERE id = $1 AND created_by = $2 AND status = 'open'`,
      [sessionId, deviceId],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
