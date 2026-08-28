export type TrialTruth = "drone" | "ambient";

export interface CapturedMicrophoneAudio {
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
  rms: number;
  requestedConstraints: MediaTrackConstraints;
  appliedSettings: MediaTrackSettings;
}

export interface MicrophoneTrial {
  id: number;
  capturedAt: string;
  truth: TrialTruth;
  detected: boolean;
  probability: number;
  latencyMs: number;
  rms: number;
  topLabel: string;
}

export interface TrialMetrics {
  total: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  recall: number | null;
  falsePositiveRate: number | null;
}

const DEFAULT_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

function concatenate(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return Math.sqrt(energy / samples.length);
}

export function summarizeTrials(trials: MicrophoneTrial[]): TrialMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  for (const trial of trials) {
    if (trial.truth === "drone" && trial.detected) truePositive += 1;
    else if (trial.truth === "drone") falseNegative += 1;
    else if (trial.detected) falsePositive += 1;
    else trueNegative += 1;
  }
  const positives = truePositive + falseNegative;
  const negatives = falsePositive + trueNegative;
  return {
    total: trials.length,
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    recall: positives > 0 ? truePositive / positives : null,
    falsePositiveRate: negatives > 0 ? falsePositive / negatives : null,
  };
}

export function microphoneErrorMessage(error: unknown): string {
  if (!window.isSecureContext) {
    return "Mikrofonen kräver HTTPS eller localhost.";
  }
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Mikrofonbehörighet nekades. Tillåt mikrofonen i webbläsarens platsinställningar och försök igen.";
    }
    if (error.name === "NotFoundError") return "Ingen mikrofon hittades på enheten.";
    if (error.name === "NotReadableError") return "Mikrofonen används av en annan app eller kunde inte startas.";
  }
  return error instanceof Error ? error.message : "Mikrofoninspelningen misslyckades.";
}

export async function captureMicrophone(
  durationMs = 5000,
  onStarted?: (settings: MediaTrackSettings) => void,
): Promise<CapturedMicrophoneAudio> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Webbläsaren saknar stöd för mikrofoninspelning.");
  }
  if (!window.isSecureContext) {
    throw new Error("Mikrofonen kräver HTTPS eller localhost.");
  }

  const requestedConstraints = { ...DEFAULT_CONSTRAINTS };
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: requestedConstraints,
    video: false,
  });
  const track = stream.getAudioTracks()[0];
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessor is deliberately used for this short compatibility test:
  // it works on current mobile Safari without requiring a separately served
  // AudioWorklet module. It can be replaced after the experiment is validated.
  const processor = context.createScriptProcessor(4096, 1, 1);
  const silentOutput = context.createGain();
  silentOutput.gain.value = 0;
  const chunks: Float32Array[] = [];

  processor.addEventListener("audioprocess", (event) => {
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  });
  source.connect(processor);
  processor.connect(silentOutput);
  silentOutput.connect(context.destination);

  try {
    await context.resume();
    onStarted?.(track?.getSettings() ?? {});
    await new Promise<void>((resolve) => window.setTimeout(resolve, durationMs));
  } finally {
    source.disconnect();
    processor.disconnect();
    silentOutput.disconnect();
    for (const streamTrack of stream.getTracks()) streamTrack.stop();
    await context.close();
  }

  const samples = concatenate(chunks);
  if (samples.length === 0) throw new Error("Mikrofonen gav inga ljudprover.");
  return {
    samples,
    sampleRate: context.sampleRate,
    durationMs: samples.length / context.sampleRate * 1000,
    rms: rootMeanSquare(samples),
    requestedConstraints,
    appliedSettings: track?.getSettings() ?? {},
  };
}
