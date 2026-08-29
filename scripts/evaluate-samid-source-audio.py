#!/usr/bin/env python3
"""Evaluate the pinned Samid AST on the local source-domain sample."""

from __future__ import annotations

import argparse
import hashlib
import json
from math import gcd
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from scipy.signal import resample_poly
from huggingface_hub import hf_hub_download
from transformers import AutoFeatureExtractor, AutoModelForAudioClassification


MODEL_ID = "Rashidbm/samid-drone-detector"
REVISION = "3a12f618dd8aebf180945bf04ebfeef262d65795"
MODEL_SHA256 = "10455420f5af15a7287be1d32d37ad6b681f74e3c152fe3bf386fdb0a0427489"
SAMPLE_RATE = 16_000
WINDOW_SAMPLES = 16_000
HOP_SAMPLES = 8_000
DEFAULT_THRESHOLD = 0.5
MEDIAN_FILTER_WINDOWS = 3
REQUIRED_CONSECUTIVE_WINDOWS = 3


def metrics(rows: list[dict[str, object]], threshold: float) -> dict[str, object]:
    true_positive = sum(bool(row["truth"]) and float(row["probability"]) >= threshold for row in rows)
    false_positive = sum(not bool(row["truth"]) and float(row["probability"]) >= threshold for row in rows)
    true_negative = sum(not bool(row["truth"]) and float(row["probability"]) < threshold for row in rows)
    false_negative = sum(bool(row["truth"]) and float(row["probability"]) < threshold for row in rows)
    predicted_positive = true_positive + false_positive
    positive_tests = true_positive + false_negative
    negative_tests = false_positive + true_negative
    precision = true_positive / predicted_positive if predicted_positive else None
    recall = true_positive / positive_tests if positive_tests else None
    false_positive_rate = false_positive / negative_tests if negative_tests else None
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision is not None and recall is not None and precision + recall > 0
        else 0.0 if precision == 0 or recall == 0 else None
    )
    return {
        "threshold": round(threshold, 4),
        "truePositive": true_positive,
        "falsePositive": false_positive,
        "trueNegative": true_negative,
        "falseNegative": false_negative,
        "precision": round(precision, 4) if precision is not None else None,
        "recall": round(recall, 4) if recall is not None else None,
        "falsePositiveRate": round(false_positive_rate, 4) if false_positive_rate is not None else None,
        "f1": round(f1, 4) if f1 is not None else None,
        "accuracy": round((true_positive + true_negative) / max(1, len(rows)), 4),
    }


def windows(path: Path) -> list[np.ndarray]:
    samples, sample_rate = sf.read(path, always_2d=True, dtype="float32")
    samples = samples.mean(axis=1)
    if sample_rate != SAMPLE_RATE:
        factor = gcd(int(sample_rate), SAMPLE_RATE)
        samples = resample_poly(samples, SAMPLE_RATE // factor, int(sample_rate) // factor).astype(np.float32)
    if len(samples) <= WINDOW_SAMPLES:
        return [np.pad(samples, (0, WINDOW_SAMPLES - len(samples))).astype(np.float32)]
    output = [samples[offset:offset + WINDOW_SAMPLES] for offset in range(0, len(samples) - WINDOW_SAMPLES + 1, HOP_SAMPLES)]
    final = samples[-WINDOW_SAMPLES:]
    if not np.shares_memory(final, output[-1]) or len(samples) % HOP_SAMPLES != 0:
        output.append(final)
    return [np.asarray(window, dtype=np.float32) for window in output]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_audio(item: dict[str, object]) -> Path:
    path = Path(str(item["path"]))
    if sha256(path) != item["sha256"]:
        raise RuntimeError(f"Audio checksum mismatch for {path}")
    return path


def event_probability(probabilities: np.ndarray) -> float:
    """Return the threshold-independent score for a consecutive-window event.

    The model card recommends median filtering followed by N consecutive
    positive windows but does not publish N. This benchmark records and uses a
    conservative N=3 assumption. Single-window source clips remain testable.
    """
    probabilities = np.asarray(probabilities, dtype=np.float64)
    if probabilities.size == 0:
        raise ValueError("Cannot aggregate an empty probability sequence")
    radius = MEDIAN_FILTER_WINDOWS // 2
    padded = np.pad(probabilities, (radius, radius), mode="edge")
    smoothed = np.asarray([
        np.median(padded[index:index + MEDIAN_FILTER_WINDOWS])
        for index in range(probabilities.size)
    ])
    required = min(REQUIRED_CONSECUTIVE_WINDOWS, len(smoothed))
    return float(max(
        np.min(smoothed[start:start + required])
        for start in range(len(smoothed) - required + 1)
    ))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=Path("/tmp/drones-source-audio/manifest.json"))
    parser.add_argument("--cache", type=Path, default=Path("/tmp/drones-samid-cache"))
    parser.add_argument("--out", type=Path, default=Path("/tmp/drones-samid-source-audio.json"))
    parser.add_argument("--source", help="Evaluate only one source id from the manifest")
    arguments = parser.parse_args()
    arguments.cache.mkdir(parents=True, exist_ok=True)
    model_path = Path(hf_hub_download(
        repo_id=MODEL_ID,
        filename="model.safetensors",
        revision=REVISION,
        cache_dir=arguments.cache,
    ))
    actual_model_sha256 = sha256(model_path)
    if actual_model_sha256 != MODEL_SHA256:
        raise RuntimeError(
            f"Model checksum mismatch: expected {MODEL_SHA256}, got {actual_model_sha256}"
        )
    extractor = AutoFeatureExtractor.from_pretrained(
        MODEL_ID,
        revision=REVISION,
        cache_dir=arguments.cache,
        trust_remote_code=False,
    )
    model = AutoModelForAudioClassification.from_pretrained(
        MODEL_ID,
        revision=REVISION,
        cache_dir=arguments.cache,
        trust_remote_code=False,
        use_safetensors=True,
    ).eval()
    manifest = json.loads(arguments.manifest.read_text())
    manifest_items = [
        item for item in manifest["files"]
        if arguments.source is None or item["source"] == arguments.source
    ]
    if not manifest_items:
        raise ValueError(f"No manifest files matched source {arguments.source!r}")
    rows = []
    with torch.inference_mode():
        for index, item in enumerate(manifest_items, start=1):
            clip_windows = windows(verify_audio(item))
            inputs = extractor(clip_windows, sampling_rate=SAMPLE_RATE, return_tensors="pt")
            logits = model(**inputs).logits
            probabilities = torch.softmax(logits, dim=-1)[:, 1].cpu().numpy()
            probability = event_probability(probabilities)
            rows.append({
                "path": item["path"],
                "source": item["source"],
                "truth": item["label"] == "drone",
                "probability": round(probability, 8),
                "windows": len(clip_windows),
            })
            if index % 10 == 0:
                print(f"Scored {index}/{len(manifest_items)}", flush=True)

    curve = [metrics(rows, threshold / 100) for threshold in range(101)]
    eligible = [
        point for point in curve
        if point["falsePositiveRate"] is not None and float(point["falsePositiveRate"]) <= 0.05
    ]
    selected = max(
        eligible,
        key=lambda point: (
            float(point["recall"]) if point["recall"] is not None else -1.0,
            float(point["precision"]) if point["precision"] is not None else -1.0,
            -float(point["threshold"]),
        ),
    ) if eligible else None
    sources = sorted({str(row["source"]) for row in rows})
    report = {
        "schemaVersion": 1,
        "purpose": "Source-domain compatibility check; not independent validation",
        "sourceFilter": arguments.source,
        "model": {
            "id": "samid-ast-pretrained-local-v1",
            "source": f"https://huggingface.co/{MODEL_ID}",
            "revision": REVISION,
            "modelSha256": actual_model_sha256,
            "aggregation": (
                "1.0 s windows with 0.5 s hop; 3-window median filter; "
                "event score is the strongest run of 3 consecutive windows"
            ),
            "aggregationAssumption": (
                "The model card recommends N consecutive windows but does not publish N; this benchmark uses N=3."
            ),
        },
        "default": metrics(rows, DEFAULT_THRESHOLD),
        "exploratoryThresholdAtMaximumFivePercentFpr": selected,
        "bySourceAtDefaultThreshold": {
            source: metrics([row for row in rows if row["source"] == source], DEFAULT_THRESHOLD)
            for source in sources
        },
        "curve": curve,
        "rows": rows,
    }
    arguments.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({
        "default": report["default"],
        "exploratoryThresholdAtMaximumFivePercentFpr": selected,
        "bySourceAtDefaultThreshold": report["bySourceAtDefaultThreshold"],
        "report": str(arguments.out),
    }, indent=2))


if __name__ == "__main__":
    main()
