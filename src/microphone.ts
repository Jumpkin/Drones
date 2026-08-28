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
    return "The microphone requires HTTPS or localhost.";
  }
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Microphone permission was denied. Allow microphone access in the browser site settings and try again.";
    }
    if (error.name === "NotFoundError") return "No microphone was found on this device.";
    if (error.name === "NotReadableError") return "The microphone is in use by another app or could not be started.";
  }
  return error instanceof Error ? error.message : "Microphone capture failed.";
}

export async function captureMicrophone(
  durationMs = 5000,
  onStarted?: (settings: MediaTrackSettings) => void,
): Promise<CapturedMicrophoneAudio> {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60_000) {
    throw new Error("Microphone duration must be between 1 ms and 60 seconds.");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support microphone capture.");
  }
  if (!window.isSecureContext) {
    throw new Error("The microphone requires HTTPS or localhost.");
  }

  const requestedConstraints = { ...DEFAULT_CONSTRAINTS };
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: requestedConstraints,
    video: false,
  });
  const chunks: Float32Array[] = [];
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: ScriptProcessorNode | undefined;
  let silentOutput: GainNode | undefined;
  let sampleRate = 0;
  let appliedSettings: MediaTrackSettings = {};

  try {
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error("The microphone stream returned no audio track.");
    appliedSettings = track.getSettings();
    context = new AudioContext();
    sampleRate = context.sampleRate;
    source = context.createMediaStreamSource(stream);
    // ScriptProcessor is deliberately used for this short compatibility test:
    // it works on current mobile Safari without requiring a separately served
    // AudioWorklet module. It can be replaced after the experiment is validated.
    processor = context.createScriptProcessor(4096, 1, 1);
    silentOutput = context.createGain();
    silentOutput.gain.value = 0;
    processor.addEventListener("audioprocess", (event) => {
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    });
    source.connect(processor);
    processor.connect(silentOutput);
    silentOutput.connect(context.destination);
    await context.resume();
    onStarted?.(appliedSettings);
    await new Promise<void>((resolve) => window.setTimeout(resolve, durationMs));
  } finally {
    for (const node of [source, processor, silentOutput]) {
      try {
        node?.disconnect();
      } catch {
        // Cleanup must continue so the physical microphone track is stopped.
      }
    }
    for (const streamTrack of stream.getTracks()) streamTrack.stop();
    if (context && context.state !== "closed") {
      await context.close().catch(() => undefined);
    }
  }

  const samples = concatenate(chunks);
  if (samples.length === 0) throw new Error("The microphone returned no audio samples.");
  return {
    samples,
    sampleRate,
    durationMs: samples.length / sampleRate * 1000,
    rms: rootMeanSquare(samples),
    requestedConstraints,
    appliedSettings,
  };
}
