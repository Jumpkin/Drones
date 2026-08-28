import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzePcm } from "./detector";

function readPcm16Wav(path: string, maxSeconds = 8): { samples: Float32Array; sampleRate: number } {
  const file = readFileSync(path);
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataLength = 0;
  while (offset + 8 <= file.length) {
    const id = file.toString("ascii", offset, offset + 4);
    const length = file.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = file.readUInt16LE(offset + 10);
      sampleRate = file.readUInt32LE(offset + 12);
      bitsPerSample = file.readUInt16LE(offset + 22);
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataLength = length;
      break;
    }
    offset += 8 + length + (length % 2);
  }
  if (!dataOffset || !sampleRate || bitsPerSample !== 16) throw new Error("Unsupported WAV fixture");
  const frameCount = Math.min(
    Math.floor(dataLength / (channels * 2)),
    sampleRate * maxSeconds,
  );
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let mixed = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      mixed += file.readInt16LE(dataOffset + (frame * channels + channel) * 2) / 32768;
    }
    samples[frame] = mixed / channels;
  }
  return { samples, sampleRate };
}

describe("Batear field recordings", () => {
  for (const [fixture, expectedProfile] of [
    ["public/audio/batear-fpv-5inch.wav", "fpv"],
    ["public/audio/batear-mavic-pro.wav", "camera"],
    ["public/audio/batear-mini-4-pro.wav", "camera"],
  ]) {
    it(`analyzes ${fixture}`, () => {
      const pcm = readPcm16Wav(fixture);
      const result = analyzePcm(pcm.samples, pcm.sampleRate);
      expect(result.detected).toBe(true);
      expect(result.classifications[0].profile).toBe(expectedProfile);
      expect(Number.isFinite(result.confidence)).toBe(true);
      expect(result.analyzedFrames).toBeGreaterThan(20);
      expect(result.spectrumDb.length).toBe(512);
    });
  }
});
