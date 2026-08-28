import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as ort from "onnxruntime-web";
import { generateDronePcm } from "../audio";
import { ML_FEATURE_NAMES, extractMlFeatures, pcmWindows } from "./features";
import {
  aggregateProbabilities,
  normalizeFeatures,
  parseMlModelArtifact,
  scoreMlFeatures,
  type MlModelArtifact,
} from "./model";

describe("ML detector artifact", () => {
  it("extracts a deterministic, finite feature vector", () => {
    const pcm = generateDronePcm("fpv", 1, 16_000, 7, 0.02);
    const first = extractMlFeatures(pcm, 16_000);
    const second = extractMlFeatures(pcm, 16_000);
    expect(first).toHaveLength(ML_FEATURE_NAMES.length);
    expect([...first].every(Number.isFinite)).toBe(true);
    expect([...first]).toEqual([...second]);
  });

  it("requires three positive windows out of five", () => {
    expect(aggregateProbabilities([0.8, 0.7, 0.2, 0.9, 0.1], 0.5).detected).toBe(true);
    expect(aggregateProbabilities([0.8, 0.2, 0.2, 0.9, 0.1], 0.5).detected).toBe(false);
    expect(aggregateProbabilities([0.8, 0.2, 0.9], 0.5, {
      requiredPositiveWindows: 2,
      windowCount: 3,
    }).detected).toBe(true);
  });

  it("includes the trailing audio in a final overlapping window", () => {
    const samples = new Float32Array(16_001);
    samples[samples.length - 1] = 1;
    const windows = pcmWindows(samples, 16_000);
    expect(windows).toHaveLength(2);
    expect(windows[1][windows[1].length - 1]).toBe(1);
  });

  it("matches the committed ONNX model with the readable coefficients", async () => {
    ort.env.wasm.numThreads = 1;
    const artifact = JSON.parse(
      await readFile("public/models/drone-binary-v1.json", "utf8"),
    ) as MlModelArtifact;
    expect(parseMlModelArtifact(artifact)).toBe(artifact);
    const model = new Uint8Array(await readFile("public/models/drone-binary-v1.onnx"));
    const features = extractMlFeatures(generateDronePcm("camera", 1), 16_000);
    const normalized = normalizeFeatures(features, artifact);
    const expected = scoreMlFeatures(features, artifact);
    const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
    const outputs = await session.run({
      [artifact.inputName]: new ort.Tensor("float32", normalized, [1, normalized.length, 1]),
    });
    expect(Number(outputs[artifact.outputName].data[0])).toBeCloseTo(expected, 5);
  });

  it("rejects model metadata with a foreign model URL", async () => {
    const artifact = JSON.parse(
      await readFile("public/models/drone-binary-v1.json", "utf8"),
    ) as MlModelArtifact;
    expect(() => parseMlModelArtifact({ ...artifact, modelUrl: "https://example.com/model.onnx" }))
      .toThrow(/schema/);
  });
});
