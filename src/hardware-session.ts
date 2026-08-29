export type CalibrationEnvironment = "quiet-room" | "traffic" | "wind" | "other";
export type CalibrationTruth = "drone" | "background";

export interface CalibrationSettings {
  soundId: string;
  expectedLabel: CalibrationTruth;
  scheduledAt: string;
  durationMs: number;
  distanceM: number;
  volumePercent: number;
  environment: CalibrationEnvironment;
}

export interface HardwareMetric {
  detectorId: string;
  playbackId?: string;
  soundId?: string;
  expectedLabel?: CalibrationTruth;
  sourceKind?: "phone" | "computer";
  distanceM?: number;
  volumePercent?: number;
  environment?: string;
  tests: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  falsePositiveRate: number;
  f1: number;
  averageProbability: number;
  averageLatencyMs: number;
}

export interface HardwareSessionSnapshot {
  id: string;
  code: string;
  status: string;
  members: Array<{ id: string; label: string; role: "source" | "listener" }>;
  playbacks: Array<{
    id: string;
    sound_id: string;
    expected_label: CalibrationTruth;
    scheduled_at: string;
    duration_ms: number;
    source_kind: "phone" | "computer";
    distance_m: number | null;
    volume_percent: number | null;
    environment: string;
  }>;
  metrics: HardwareMetric[];
  listenerMetrics: HardwareMetric[];
  playbackMetrics: HardwareMetric[];
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type FetchLike = typeof fetch;

const DEVICE_KEY = "drones.hardware.device.v1";
const SESSION_KEY = "drones.hardware.session.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateCalibration(settings: CalibrationSettings): void {
  if (!settings.soundId || settings.soundId.length > 80) throw new Error("Select a valid sound.");
  if (settings.expectedLabel !== "drone" && settings.expectedLabel !== "background") {
    throw new Error("Invalid ground truth.");
  }
  if (!Number.isFinite(Date.parse(settings.scheduledAt))) throw new Error("Invalid scheduled time.");
  if (!Number.isInteger(settings.durationMs) || settings.durationMs < 250 || settings.durationMs > 120_000) {
    throw new Error("Invalid playback duration.");
  }
  if (!Number.isFinite(settings.distanceM) || settings.distanceM < 0.1 || settings.distanceM > 100) {
    throw new Error("Distance must be between 0.1 and 100 metres.");
  }
  if (!Number.isInteger(settings.volumePercent) || settings.volumePercent < 1 || settings.volumePercent > 100) {
    throw new Error("Player gain must be between 1 and 100 percent.");
  }
  if (!["quiet-room", "traffic", "wind", "other"].includes(settings.environment)) {
    throw new Error("Invalid test environment.");
  }
}

export function detectorLabel(id: string): string {
  if (id === "dsp-v1") return "FFT / harmonic DSP";
  if (id === "ml-onnx-v1") return "Feature Conv ML";
  if (id === "crnn-pretrained-v1") return "Pretrained CRNN";
  if (id === "consensus-2-of-3") return "2-of-3 consensus";
  return id;
}

export class HardwareSessionClient {
  private deviceId?: string;
  private sessionId?: string;

  constructor(
    private readonly storage: StorageLike,
    private readonly fetcher: FetchLike = fetch,
  ) {
    const storedDevice = storage.getItem(DEVICE_KEY);
    const storedSession = storage.getItem(SESSION_KEY);
    if (storedDevice && UUID_PATTERN.test(storedDevice)) this.deviceId = storedDevice;
    if (storedSession && UUID_PATTERN.test(storedSession)) this.sessionId = storedSession;
  }

  get activeSessionId(): string | undefined { return this.sessionId; }

  private async request<T>(path: string, init: RequestInit = {}, device = true): Promise<T> {
    if (device && !this.deviceId) await this.ensureDevice();
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    if (device && this.deviceId) headers.set("X-Drones-Device-ID", this.deviceId);
    const response = await this.fetcher(path, { ...init, headers });
    const body = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
  }

  async ensureDevice(): Promise<string> {
    if (this.deviceId) return this.deviceId;
    const response = await this.request<{ device: { id: string } }>("/api/drones/v1/devices/enroll", {
      method: "POST",
      body: JSON.stringify({ label: "Computer playback", appVersion: "web", platform: "web" }),
    }, false);
    this.deviceId = response.device.id;
    this.storage.setItem(DEVICE_KEY, this.deviceId);
    return this.deviceId;
  }

  async createSession(): Promise<HardwareSessionSnapshot> {
    let response: { session: { id: string } };
    try {
      response = await this.request<{ session: { id: string } }>("/api/drones/v1/sessions", {
        method: "POST", body: JSON.stringify({ role: "source" }),
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "device_not_found") throw error;
      this.resetLocalState();
      response = await this.request<{ session: { id: string } }>("/api/drones/v1/sessions", {
        method: "POST", body: JSON.stringify({ role: "source" }),
      });
    }
    this.sessionId = response.session.id;
    this.storage.setItem(SESSION_KEY, this.sessionId);
    return this.fetchSession();
  }

  async fetchSession(): Promise<HardwareSessionSnapshot> {
    if (!this.sessionId) throw new Error("Create a hardware test session first.");
    const response = await this.request<{ session: HardwareSessionSnapshot }>(
      `/api/drones/v1/sessions/${this.sessionId}`,
    );
    return response.session;
  }

  async serverNow(): Promise<Date> {
    const started = Date.now();
    const response = await this.request<{ serverTime: string }>("/api/drones/v1/time", {}, false);
    const ended = Date.now();
    const server = Date.parse(response.serverTime);
    if (!Number.isFinite(server)) throw new Error("The server returned an invalid clock value.");
    return new Date(server + (ended - started) / 2);
  }

  async schedule(settings: CalibrationSettings): Promise<void> {
    if (!this.sessionId) throw new Error("Create a hardware test session first.");
    validateCalibration(settings);
    await this.request(`/api/drones/v1/sessions/${this.sessionId}/playbacks`, {
      method: "POST",
      body: JSON.stringify({ ...settings, sourceKind: "computer" }),
    });
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    await this.request(`/api/drones/v1/sessions/${this.sessionId}/close`, { method: "POST" });
    this.sessionId = undefined;
    this.storage.removeItem(SESSION_KEY);
  }

  forgetSession(): void {
    this.sessionId = undefined;
    this.storage.removeItem(SESSION_KEY);
  }

  resetLocalState(): void {
    this.deviceId = undefined;
    this.sessionId = undefined;
    this.storage.removeItem(DEVICE_KEY);
    this.storage.removeItem(SESSION_KEY);
  }
}
