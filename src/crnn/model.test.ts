import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as ort from "onnxruntime-web";
import { describe, expect, it } from "vitest";
import {
  CRNN_MEL_BINS,
  CRNN_TIME_FRAMES,
  combineCrnnFeatures,
  crnnWindows,
  extractCrnnLogMel,
  parsePretrainedCrnnArtifact,
} from "./model";

function referenceWaveform(): Float32Array {
  return Float32Array.from({ length: 16_000 }, (_, index) => {
    const time = index / 16_000;
    return 0.18 * Math.sin(2 * Math.PI * 230 * time) +
      0.08 * Math.sin(2 * Math.PI * 460 * time + 0.1) +
      0.03 * Math.sin(2 * Math.PI * 690 * time + 0.25) +
      0.01 * Math.sin(2 * Math.PI * 37 * time);
  });
}

describe("pretrained CRNN", () => {
  it("matches the upstream PyTorch log-mel frontend", () => {
    const features = extractCrnnLogMel(referenceWaveform());
    const indices = [0, 1, 50, 100, 101, 777, 1600, 3232, 5000, 6463];
    const expected = [
      1.3282781, 1.0286722, 0.8714998, 1.3281796, 1.3566984,
      1.4858707, 0.6080351, 0.7930226, -0.3652216, 0.4080877,
    ];
    expect(features).toHaveLength(CRNN_MEL_BINS * CRNN_TIME_FRAMES);
    indices.forEach((index, position) => expect(features[index]).toBeCloseTo(expected[position], 4));
  });

  it("loads the committed ONNX model and matches PyTorch end-to-end", async () => {
    const [metadata, model] = await Promise.all([
      readFile("public/models/drone-classifier-crnn-v1.json", "utf8").then(JSON.parse),
      readFile("public/models/drone-classifier-crnn-v1.onnx"),
    ]);
    const artifact = parsePretrainedCrnnArtifact(metadata);
    expect(model.byteLength).toBe(artifact.modelBytes);
    expect(createHash("sha256").update(model).digest("hex")).toBe(artifact.modelSha256);
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(new Uint8Array(model), {
      executionProviders: ["wasm"],
    });
    const windows = crnnWindows(referenceWaveform(), 16_000);
    const tensor = new ort.Tensor(
      "float32",
      combineCrnnFeatures(windows),
      [windows.length, 1, CRNN_MEL_BINS, CRNN_TIME_FRAMES],
    );
    const output = await session.run({ [artifact.inputName]: tensor });
    expect(Number(output[artifact.outputName].data[0])).toBeCloseTo(0.0374717, 4);
  });

  it("creates five overlapping windows from a three-second clip", () => {
    expect(crnnWindows(new Float32Array(48_000), 16_000)).toHaveLength(5);
  });
});
