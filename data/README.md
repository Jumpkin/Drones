# Dataset manifest

`manifest.jsonl` is the canonical registry for local audio fixtures. Every row
contains a source recording/session identifier, binary label, environment,
license, split, SHA-256 digest, and local path. The validator rejects duplicate
IDs, non-redistributable licenses, invalid checksums, and a source recording
appearing in more than one model split.

```sh
npm run data:validate
```

## Optional FSD50K hard negatives

Large external datasets are never committed. After downloading the official
FSD50K audio, clip-info JSON, and ground-truth CSV, create a filtered local
manifest with:

```sh
npm run data:fsd50k -- \
  --clips-info /path/to/dev_clips_info_FSD50K.json \
  --ground-truth /path/to/ground_truth/dev.csv \
  --audio-root /path/to/FSD50K.dev_audio \
  --out data/generated/fsd50k-manifest.jsonl
```

The importer keeps only selected mechanical/traffic hard negatives whose
individual clip license is CC0 or CC-BY. CC-BY-NC and Sampling+ clips are
rejected.
