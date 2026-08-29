#!/usr/bin/env python3
"""Import Antoine Naccache's pretrained drone CRNN as a browser-safe ONNX model.

The upstream checkpoint is pinned and checksum-verified before it is opened.
Only tensor weights are accepted (`weights_only=True`); upstream Python code is
never executed. The original pickle checkpoint is kept in a temporary folder
and is not copied into the product.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from torch import nn


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIRECTORY = ROOT / "public" / "models"
SOURCE_REPOSITORY = "https://huggingface.co/AntoineNaccache/drone-audio-detector"
SOURCE_REVISION = "9d4f9c7afc2b893ee8b9356f8361e14069577dce"
WEIGHTS_FILE = "drone_classifier_aug_mixed.pt"
WEIGHTS_SHA256 = "3ca418d3fa97ed59568a7a3abf807e4a54fbd6fb6d5f513aaa4e257672fde382"
LICENSE_SHA256 = "34358d8eb571c91914bda27438277d182948539da222550d99507d087bfb3b84"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download(filename: str, destination: Path, expected_sha256: str) -> None:
    url = f"{SOURCE_REPOSITORY}/resolve/{SOURCE_REVISION}/{filename}"
    urllib.request.urlretrieve(url, destination)
    actual = sha256(destination)
    if actual != expected_sha256:
        raise RuntimeError(f"Checksum mismatch for {filename}: {actual}")


def conv_block(input_channels: int, output_channels: int) -> nn.Sequential:
    return nn.Sequential(
        nn.Conv2d(input_channels, output_channels, kernel_size=3, padding=1, bias=False),
        nn.BatchNorm2d(output_channels),
        nn.ReLU(inplace=True),
        nn.Conv2d(output_channels, output_channels, kernel_size=3, padding=1, bias=False),
        nn.BatchNorm2d(output_channels),
        nn.ReLU(inplace=True),
    )


class DroneClassifier(nn.Module):
    """Upstream 1,486,113-parameter CNN + bidirectional GRU architecture."""

    def __init__(self) -> None:
        super().__init__()
        self.encoder = nn.Module()
        self.encoder.enc1 = conv_block(1, 32)
        self.encoder.pool1 = nn.MaxPool2d(2, 2)
        self.encoder.enc2 = conv_block(32, 64)
        self.encoder.pool2 = nn.MaxPool2d(2, 2)
        self.encoder.enc3 = conv_block(64, 128)
        self.encoder.pool3 = nn.MaxPool2d(kernel_size=(2, 1), stride=(2, 1))
        self.encoder.gru = nn.GRU(
            128 * 8,
            128,
            num_layers=2,
            batch_first=True,
            bidirectional=True,
            dropout=0.2,
        )
        self.classifier = nn.Module()
        self.classifier.fc = nn.Sequential(
            nn.Linear(256, 64),
            nn.ReLU(inplace=True),
            nn.Dropout(0.3),
            nn.Linear(64, 1),
        )

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        value = self.encoder.pool1(self.encoder.enc1(value))
        value = self.encoder.pool2(self.encoder.enc2(value))
        value = self.encoder.pool3(self.encoder.enc3(value))
        batch, channels, frequencies, frames = value.shape
        value = value.permute(0, 3, 1, 2).reshape(batch, frames, channels * frequencies)
        value, _ = self.encoder.gru(value)
        return self.classifier.fc(value.mean(dim=1))


class ProbabilityModel(nn.Module):
    def __init__(self, classifier: DroneClassifier) -> None:
        super().__init__()
        self.classifier = classifier

    def forward(self, log_mel: torch.Tensor) -> torch.Tensor:
        return torch.sigmoid(self.classifier(log_mel))


def main() -> None:
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="drones-crnn-") as temporary:
        temporary_directory = Path(temporary)
        checkpoint_path = temporary_directory / WEIGHTS_FILE
        license_path = temporary_directory / "LICENSE"
        download(WEIGHTS_FILE, checkpoint_path, WEIGHTS_SHA256)
        download("LICENSE", license_path, LICENSE_SHA256)

        checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
        if not isinstance(checkpoint, dict):
            raise RuntimeError("The checkpoint does not contain a tensor dictionary")
        state = checkpoint.get("model_state_dict", checkpoint)
        model = DroneClassifier()
        missing, unexpected = model.load_state_dict(state, strict=False)
        if missing or any(not key.startswith("separator.") for key in unexpected):
            raise RuntimeError(f"Unexpected checkpoint structure: missing={missing}, unexpected={unexpected}")
        wrapped = ProbabilityModel(model.eval()).eval()

        temporary_onnx = temporary_directory / "drone-classifier-crnn-v1.onnx"
        torch.onnx.export(
            wrapped,
            torch.zeros(1, 1, 64, 101, dtype=torch.float32),
            temporary_onnx,
            input_names=["log_mel"],
            output_names=["probability"],
            dynamic_axes={"log_mel": {0: "batch"}, "probability": {0: "batch"}},
            opset_version=17,
            do_constant_folding=True,
            dynamo=False,
        )
        graph = onnx.load(temporary_onnx)
        onnx.checker.check_model(graph)

        random = np.random.default_rng(20260829)
        parity_input = random.normal(0, 0.5, (5, 1, 64, 101)).astype(np.float32)
        with torch.no_grad():
            expected = wrapped(torch.from_numpy(parity_input)).numpy()
        session = ort.InferenceSession(str(temporary_onnx), providers=["CPUExecutionProvider"])
        actual = session.run(["probability"], {"log_mel": parity_input})[0]
        maximum_error = float(np.max(np.abs(expected - actual)))
        if maximum_error >= 1e-5:
            raise RuntimeError(f"ONNX parity failed: maximum absolute error {maximum_error}")

        output_onnx = OUTPUT_DIRECTORY / "drone-classifier-crnn-v1.onnx"
        output_onnx.write_bytes(temporary_onnx.read_bytes())
        output_license = OUTPUT_DIRECTORY / "drone-classifier-crnn-v1.LICENSE.txt"
        output_license.write_bytes(license_path.read_bytes())
        artifact = {
            "schemaVersion": 1,
            "id": "crnn-pretrained-v1",
            "label": "Pretrained CRNN",
            "version": "1.0.0",
            "inputName": "log_mel",
            "outputName": "probability",
            "modelUrl": "/models/drone-classifier-crnn-v1.onnx",
            "modelBytes": output_onnx.stat().st_size,
            "modelSha256": sha256(output_onnx),
            "threshold": 0.5,
            "temporal": {"requiredPositiveWindows": 3, "windowCount": 5},
            "preprocessing": {
                "sampleRate": 16000,
                "windowSamples": 16000,
                "hopSamples": 8000,
                "fftSize": 512,
                "fftHopSamples": 160,
                "melBins": 64,
                "minimumHz": 50,
                "maximumHz": 5500,
                "melScale": "htk",
                "topDb": 80,
                "normalization": "(powerDb + 40) / 40",
            },
            "source": {
                "repository": SOURCE_REPOSITORY,
                "revision": SOURCE_REVISION,
                "weightsFile": WEIGHTS_FILE,
                "weightsSha256": WEIGHTS_SHA256,
                "license": "MIT",
                "copyright": "Copyright (c) 2025 Antoine Naccache",
            },
            "trainingDomain": "geronimobasso/drone-audio-detection-samples",
            "limitations": [
                "Upstream metrics are self-reported and primarily in-distribution.",
                "The upstream model card does not validate helicopters, fixed-wing aircraft, or other rotary-wing craft.",
                "This imported model has not been field-validated on phone microphones by the Drones project.",
            ],
            "conversion": {
                "torchVersion": torch.__version__,
                "onnxVersion": onnx.__version__,
                "onnxRuntimeVersion": ort.__version__,
                "maximumParityError": maximum_error,
            },
        }
        output_metadata = OUTPUT_DIRECTORY / "drone-classifier-crnn-v1.json"
        output_metadata.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({
            "model": str(output_onnx),
            "bytes": artifact["modelBytes"],
            "sha256": artifact["modelSha256"],
            "maximumParityError": maximum_error,
        }, indent=2))


if __name__ == "__main__":
    main()
