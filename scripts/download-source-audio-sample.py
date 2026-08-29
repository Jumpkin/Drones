#!/usr/bin/env python3
"""Download a small deterministic source-domain audio sample for local checks.

The files remain outside the repository because two upstream GitHub datasets
do not publish explicit license files. The manifest records provenance and
checksums; this is a compatibility test, not an independent validation split.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


USER_AGENT = "Drones-acoustic-research/0.5"
GERONIMO_DATASET = "geronimobasso/drone-audio-detection-samples"
GERONIMO_REVISION = "981b832c35b45a57518c989f0f79101adb4ae91f"
GERONIMO_NEGATIVE_END = 16_728
GERONIMO_POSITIVE_START = 16_729
GERONIMO_LAST_ROW = 180_319
SARA_REPOSITORY = "saraalemadi/DroneAudioDataset"
SARA_REVISION = "1f1ffb214c63215c95176dcb70dda246f8ad96c1"
VISUALIZATION_REPOSITORY = "mackenzie-jane/drone-visualization"
VISUALIZATION_REVISION = "d419638a4772e34d591f2c7282ba5faffcbe4416"
AHLAB_DATASET = "ahlab-drone-project/DroneAudioSet"
AHLAB_REVISION = "e794007062e2d2ad29262a5795b60d09f2b345c4"
AHLAB_SHARD = "drone-only/train_001-00000-of-00001.parquet"
AHLAB_SHARD_SHA256 = "390471fc9fbfd0bef4b32759d61f6bc97f91931f1e8681f901bbb64e7fc3f6d5"


def request(url: str) -> bytes:
    for attempt in range(6):
        try:
            with urllib.request.urlopen(
                urllib.request.Request(url, headers={"User-Agent": USER_AGENT}),
                timeout=90,
            ) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code not in (429, 502, 503, 504) or attempt == 5:
                raise
            retry_after = error.headers.get("Retry-After")
            delay = min(20, int(retry_after) if retry_after and retry_after.isdigit() else 2 ** attempt)
            time.sleep(delay)
    raise RuntimeError("Unreachable retry state")


def request_json(url: str) -> object:
    return json.loads(request(url))


def evenly_spaced(start: int, end: int, count: int) -> list[int]:
    if count == 1:
        return [start]
    return [round(start + (end - start) * index / (count - 1)) for index in range(count)]


def selected_paths(paths: list[str], count: int) -> list[str]:
    paths = sorted(paths)
    return [paths[index] for index in evenly_spaced(0, len(paths) - 1, min(count, len(paths)))]


def save_audio(
    root: Path,
    source: str,
    label: str,
    identifier: str,
    url: str,
    provenance: dict[str, object],
) -> dict[str, object]:
    extension = Path(urllib.parse.urlparse(url).path).suffix or ".wav"
    safe_identifier = identifier.replace("/", "_").replace(" ", "_")
    destination = root / source / label / f"{safe_identifier}{extension}"
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        payload = destination.read_bytes()
    else:
        payload = request(url)
        destination.write_bytes(payload)
    return {
        "path": str(destination),
        "source": source,
        "label": label,
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        **provenance,
    }


def github_tree(repository: str, revision: str) -> list[dict[str, object]]:
    value = request_json(f"https://api.github.com/repos/{repository}/git/trees/{revision}?recursive=1")
    if not isinstance(value, dict) or not isinstance(value.get("tree"), list):
        raise RuntimeError(f"Invalid GitHub tree response for {repository}")
    return value["tree"]


def download_geronimo(root: Path, per_class: int) -> list[dict[str, object]]:
    rows_url = "https://datasets-server.huggingface.co/rows"
    output = []
    for label, first_row, last_row in (
        ("background", 0, GERONIMO_NEGATIVE_END),
        ("drone", GERONIMO_POSITIVE_START, GERONIMO_LAST_ROW),
    ):
        block_count = min(5, per_class)
        block_sizes = [per_class // block_count + (index < per_class % block_count) for index in range(block_count)]
        block_starts = evenly_spaced(first_row, last_row - max(block_sizes) + 1, block_count)
        for block_start, block_size in zip(block_starts, block_sizes, strict=True):
            query = urllib.parse.urlencode({
                "dataset": GERONIMO_DATASET,
                "config": "default",
                "split": "train",
                "offset": block_start,
                "length": block_size,
            })
            value = request_json(f"{rows_url}?{query}")
            for expected_row, row in enumerate(value["rows"], start=block_start):
                actual_label = "drone" if row["row"]["label"] == 1 else "background"
                if actual_label != label or row["row_idx"] != expected_row:
                    raise RuntimeError(f"Unexpected Hugging Face row at {expected_row}")
                audio_url = row["row"]["audio"][0]["src"]
                output.append(save_audio(root, "geronimo", label, str(expected_row), audio_url, {
                    "dataset": GERONIMO_DATASET,
                    "revision": GERONIMO_REVISION,
                    "row": expected_row,
                    "license": "MIT",
                    "relationship": "Training-source distribution for both imported CRNN and Samid AST",
                }))
    return output


def download_github_sets(root: Path, per_class: int) -> list[dict[str, object]]:
    output = []
    sara_tree = github_tree(SARA_REPOSITORY, SARA_REVISION)
    for label, prefix in (
        ("background", "Binary_Drone_Audio/unknown/"),
        ("drone", "Binary_Drone_Audio/yes_drone/"),
    ):
        candidates = [
            str(item["path"])
            for item in sara_tree
            if item.get("type") == "blob" and str(item.get("path", "")).startswith(prefix)
            and str(item.get("path", "")).lower().endswith(".wav")
        ]
        for source_path in selected_paths(candidates, per_class):
            raw_url = f"https://raw.githubusercontent.com/{SARA_REPOSITORY}/{SARA_REVISION}/{urllib.parse.quote(source_path)}"
            output.append(save_audio(root, "sara-alemadi", label, Path(source_path).stem, raw_url, {
                "repository": SARA_REPOSITORY,
                "revision": SARA_REVISION,
                "sourcePath": source_path,
                "license": "No explicit upstream license file",
                "relationship": "Training-source distribution for the YAMNet head; external to Samid AST",
            }))

    visualization_tree = github_tree(VISUALIZATION_REPOSITORY, VISUALIZATION_REVISION)
    visualization_paths = sorted(
        str(item["path"])
        for item in visualization_tree
        if item.get("type") == "blob" and str(item.get("path", "")).startswith("public/droneAudio/")
        and str(item.get("path", "")).lower().endswith(".wav")
    )
    for source_path in visualization_paths:
        raw_url = f"https://raw.githubusercontent.com/{VISUALIZATION_REPOSITORY}/{VISUALIZATION_REVISION}/{urllib.parse.quote(source_path)}"
        output.append(save_audio(root, "drone-visualization", "drone", Path(source_path).stem, raw_url, {
            "repository": VISUALIZATION_REPOSITORY,
            "revision": VISUALIZATION_REVISION,
            "sourcePath": source_path,
            "license": "No explicit upstream license file",
            "relationship": "The YAMNet head README says these 32 files were used as binary positives",
        }))
    return output


def extract_ahlab(root: Path, parquet_path: Path) -> list[dict[str, object]]:
    try:
        import numpy as np
        import pyarrow.parquet as parquet
        import soundfile as sf
    except ImportError as error:
        raise RuntimeError("AHLab extraction requires numpy, pyarrow, and soundfile") from error
    actual_shard_sha = hashlib.sha256(parquet_path.read_bytes()).hexdigest()
    if actual_shard_sha != AHLAB_SHARD_SHA256:
        raise RuntimeError(f"AHLab shard checksum mismatch: {actual_shard_sha}")
    output = []
    rows = parquet.read_table(parquet_path).to_pylist()
    for row_index, row in enumerate(rows):
        source_path = str(row["file_path"])
        if "silence" in source_path.lower():
            continue
        samples = np.asarray(row["audio"]["array"], dtype=np.float32)[:, 0]
        sample_rate = int(row["audio"]["sampling_rate"])
        window_samples = sample_rate
        for segment_index, offset in enumerate(evenly_spaced(0, len(samples) - window_samples, 5)):
            destination = root / "ahlab-droneaudioset" / "drone" / f"row-{row_index}-segment-{segment_index}.wav"
            destination.parent.mkdir(parents=True, exist_ok=True)
            sf.write(destination, samples[offset:offset + window_samples], sample_rate, subtype="FLOAT")
            payload = destination.read_bytes()
            output.append({
                "path": str(destination),
                "source": "ahlab-droneaudioset",
                "label": "drone",
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "dataset": AHLAB_DATASET,
                "revision": AHLAB_REVISION,
                "sourceShard": AHLAB_SHARD,
                "sourceShardSha256": AHLAB_SHARD_SHA256,
                "sourcePath": source_path,
                "sourceRow": row_index,
                "segmentOffsetSamples": offset,
                "channel": 0,
                "license": "MIT",
                "relationship": "Samid AST training-source distribution (published splits 1-20)",
            })
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path("/tmp/drones-source-audio"))
    parser.add_argument("--per-class", type=int, default=25)
    parser.add_argument("--ahlab-parquet", type=Path)
    arguments = parser.parse_args()
    if arguments.per_class < 1 or arguments.per_class > 100:
        raise ValueError("--per-class must be between 1 and 100")
    files = download_geronimo(arguments.out, arguments.per_class)
    files.extend(download_github_sets(arguments.out, arguments.per_class))
    if arguments.ahlab_parquet:
        files.extend(extract_ahlab(arguments.out, arguments.ahlab_parquet))
    manifest = {
        "schemaVersion": 1,
        "purpose": "Local source-domain compatibility check; not independent validation",
        "files": files,
    }
    manifest_path = arguments.out / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({
        "files": len(files),
        "drone": sum(item["label"] == "drone" for item in files),
        "background": sum(item["label"] == "background" for item in files),
        "bytes": sum(int(item["bytes"]) for item in files),
        "manifest": str(manifest_path),
    }, indent=2))


if __name__ == "__main__":
    main()
