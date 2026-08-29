#!/usr/bin/env python3
"""Local JSON-lines inference worker for the pinned YAMNet drone detector.

The worker downloads only the classifier head into a temporary/local cache.
It does not copy the external weights into the product or public assets.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import urllib.request
from math import gcd
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import numpy as np
import tensorflow as tf
import tensorflow_hub as hub
from scipy.signal import resample_poly


REVISION = "b76ac1f9e5be5f103ebcbd3024cebec31e16acc7"
MODEL_NAME = "drone_classifier_binary.keras"
MODEL_SHA256 = "a7c75d0c30156f7608fd76b19d4445a5dbcde6410ac998765473783ba4b53b23"
MODEL_URL = (
    "https://raw.githubusercontent.com/jwehlen-cell/yamnet-drone-detector/"
    f"{REVISION}/models/{MODEL_NAME}"
)
YAMNET_URL = "https://tfhub.dev/google/yamnet/1"
SAMPLE_RATE = 16_000
THRESHOLD = 0.45


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def obtain_classifier(cache_directory: Path) -> Path:
    cache_directory.mkdir(parents=True, exist_ok=True)
    destination = cache_directory / MODEL_NAME
    if destination.exists() and sha256(destination) == MODEL_SHA256:
        return destination
    temporary = destination.with_suffix(".download")
    with urllib.request.urlopen(MODEL_URL, timeout=60) as response, temporary.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    actual = sha256(temporary)
    if actual != MODEL_SHA256:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"Classifier checksum mismatch: expected {MODEL_SHA256}, got {actual}")
    os.replace(temporary, destination)
    return destination


class Detector:
    def __init__(self, cache_directory: Path) -> None:
        classifier_path = obtain_classifier(cache_directory)
        self.yamnet = hub.load(YAMNET_URL)
        self.classifier = tf.keras.models.load_model(classifier_path)

    def score(self, samples: np.ndarray, sample_rate: int) -> float:
        if sample_rate != SAMPLE_RATE:
            factor = gcd(sample_rate, SAMPLE_RATE)
            samples = resample_poly(samples, SAMPLE_RATE // factor, sample_rate // factor)
        samples = np.asarray(samples, dtype=np.float32)
        peak = float(np.max(np.abs(samples))) if samples.size else 0.0
        if peak > 1.0:
            samples = samples / peak
        _scores, embeddings, _spectrogram = self.yamnet(tf.constant(samples))
        if int(tf.size(embeddings)) == 0:
            raise ValueError("Audio is too short for a YAMNet embedding")
        pooled = tf.reduce_mean(embeddings, axis=0, keepdims=True)
        return float(self.classifier(pooled, training=False).numpy()[0, 0])


def emit(payload: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path, default=Path("/tmp/drones-yamnet-model"))
    arguments = parser.parse_args()
    detector = Detector(arguments.cache)
    emit({
        "ready": True,
        "revision": REVISION,
        "modelSha256": MODEL_SHA256,
        "threshold": THRESHOLD,
    })
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            audio = base64.b64decode(request["audio"], validate=True)
            samples = np.frombuffer(audio, dtype="<f4")
            probability = detector.score(samples, int(request["sampleRate"]))
            emit({
                "id": request.get("id"),
                "probability": probability,
                "detected": probability >= THRESHOLD,
            })
        except Exception as error:  # Keep protocol failures explicit to the caller.
            emit({"id": request.get("id") if isinstance(request, dict) else None, "error": str(error)})


if __name__ == "__main__":
    main()
