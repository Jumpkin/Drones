#!/usr/bin/env python3
"""Evaluate the local YAMNet head on a downloaded source-domain manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import runpy
from pathlib import Path

import numpy as np
import soundfile as sf


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


def load_audio(path: Path) -> tuple[np.ndarray, int]:
    samples, sample_rate = sf.read(path, always_2d=True, dtype="float32")
    return samples.mean(axis=1), int(sample_rate)


def verify_file(item: dict[str, object]) -> Path:
    path = Path(str(item["path"]))
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != item["sha256"]:
        raise RuntimeError(f"Audio checksum mismatch for {path}")
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=Path("/tmp/drones-source-audio/manifest.json"))
    parser.add_argument("--cache", type=Path, default=Path("/tmp/drones-yamnet-model"))
    parser.add_argument("--out", type=Path, default=Path("/tmp/drones-yamnet-source-audio.json"))
    arguments = parser.parse_args()
    worker = runpy.run_path(
        str(Path(__file__).with_name("yamnet-benchmark-worker.py")),
        run_name="_yamnet_benchmark_worker",
    )
    detector = worker["Detector"](arguments.cache)
    default_threshold = float(worker["THRESHOLD"])
    manifest = json.loads(arguments.manifest.read_text())
    rows = []
    for index, item in enumerate(manifest["files"], start=1):
        samples, sample_rate = load_audio(verify_file(item))
        probability = detector.score(samples, sample_rate)
        rows.append({
            "path": item["path"],
            "source": item["source"],
            "truth": item["label"] == "drone",
            "probability": round(probability, 8),
        })
        if index % 25 == 0:
            print(f"Scored {index}/{len(manifest['files'])}", flush=True)

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
        "model": {
            "id": "yamnet-pretrained-local-v1",
            "source": "https://github.com/jwehlen-cell/yamnet-drone-detector",
            "revision": worker["REVISION"],
            "modelSha256": worker["MODEL_SHA256"],
        },
        "default": metrics(rows, default_threshold),
        "exploratoryThresholdAtMaximumFivePercentFpr": selected,
        "bySourceAtDefaultThreshold": {
            source: metrics([row for row in rows if row["source"] == source], default_threshold)
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
