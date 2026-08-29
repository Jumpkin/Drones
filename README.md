# Drones Acoustic Sensor Lab

A browser-based research environment for passive acoustic drone detection,
coarse sound classification, and multi-phone TDOA localization.

This is an educational prototype, not an operational detection or
countermeasure system. Synthetic distance results are regression benchmarks
and must not be interpreted as field-validated range.

## Included experiments

- **City simulation** compares acoustic sensing with radar, RF/Remote ID, and
  optical sensors.
- **Sound lab** plays real or synthetic recordings and analyzes decoded PCM
  with a TypeScript FFT/harmonic detector. It also includes a five-second live
  microphone test with an in-tab confusion matrix and CSV export.
- **Multi-phone test** demonstrates clock calibration and 2D TDOA localization
  with three listener nodes.
- **Statistics** compares deterministic headless Monte Carlo runs across drone
  profiles, assumed distances, noise environments, false alarms, and residual
  clock jitter. It also includes a synthetic playback-to-phone robustness proxy
  covering speaker coloration, distance, room echo, background sound, and three
  representative phone audio chains.

Version 0.2 added a shared detector interface and compares the transparent FFT
baseline with a tiny ONNX feature-convolution classifier. The ML detector is
loaded in the browser but remains experimental until its held-out quality gate
reaches at least 85% recall, at most 5% false positives, and beats DSP F1.

Version 0.3 adds the local phone-microphone experiment, binary session metrics,
CSV export, mobile layout, and the hardened Tael deployment contract.

Version 0.4 adds a deterministic headless computer-playback-to-phone proxy with
explicit synthetic phone and room-channel assumptions.

Version 0.5 adds [Antoine Naccache's external pretrained CRNN](https://huggingface.co/AntoineNaccache/drone-audio-detector) as a third,
non-default detector. Its pinned MIT-licensed PyTorch checkpoint is converted
to ONNX and compared against the DSP and project-trained feature model on the
same inputs. Upstream metrics are not treated as Drones validation results.

## Run locally

```sh
npm install
npm run dev
```

Then open the local URL printed by Vite.

## Phone microphone experiment

Open **Sound lab** on a phone from an HTTPS-hosted copy of the app. Choose the
truth (`Drone audio` or `Background / interference`), start the five-second capture,
and play a sample from a separate computer. The selected truth is used only
after inference to score the trial; it is never passed to the detector.

The browser requests mono audio with echo cancellation, noise suppression, and
automatic gain control disabled, although individual phones may ignore those
preferences. PCM remains in the browser and is discarded after analysis. Only
the test row can be exported as CSV.

Microphone access requires HTTPS or `localhost`. A phone cannot use the
computer's `localhost`, so testing across devices requires an HTTPS deployment
or a trusted HTTPS development endpoint.

The reviewed public target is `https://drones.tael.se`. It is a static,
unauthenticated experiment: the server delivers assets but receives no
microphone PCM. The Tael gateway permits same-origin microphone access and
applies a restrictive content security policy.

Recommended first session:

- 10 drone playbacks split across the three real Batear samples.
- 20 negative playbacks including silence, speech, music, fan, vacuum, traffic,
  and the rural ambient fixture.
- Treat model-level classification as exploratory; score only drone versus
  background initially.

## Test and benchmark

```sh
npm test
npm run build
npm run data:validate
npm run train:model
npm run simulate
```

The headless simulation writes aggregate JSON and CSV reports to
`public/reports/headless/`. It never writes raw audio to a report. Use
`npm run simulate:quick` for a shorter development run.

The Statistics view also reads `benchmark-runs.json`, whose rows preserve the
positive-test count, negative-test count, and integer TP/FP/TN/FN values for
each model and run. After producing the optional local YAMNet and Samid reports,
run `npm run stats:update` to verify matching corpora and rebuild that registry.
Rates and per-run F1 winners are recomputed from the integer counts; a missing
negative class is displayed as an undefined false-alarm rate, not as 0%.

The phone playback proxy is intentionally a pre-hardware stress test. Its
flagship, budget, and processed-phone profiles are engineering assumptions,
not measurements of named devices, and cannot establish real microphone range.

The pretrained CRNN import is reproducible but intentionally separate from the
normal npm install because PyTorch is only needed for conversion:

```sh
python3 -m venv /tmp/drones-crnn-import
/tmp/drones-crnn-import/bin/pip install -r scripts/requirements-crnn-import.txt
/tmp/drones-crnn-import/bin/python scripts/import-pretrained-crnn.py
```

An additional YAMNet-based detector can be compared locally without copying
its weights into the web product. This path is deliberately excluded from the
default simulation because TensorFlow is a large optional dependency and the
external classifier head has unresolved derivative-dataset licensing. Create
an isolated Python environment, install
`scripts/requirements-yamnet-benchmark.txt`, then run:

```sh
YAMNET_PYTHON=/path/to/venv/bin/python npm run simulate:yamnet-local
```

The pinned classifier head is checksum-verified, downloaded only to `/tmp`,
and evaluated against the same deterministic synthetic and phone-playback
corpus as the three built-in detectors. Aggregate results default to
`/tmp/drones-yamnet-comparison.json`; no raw audio or external model weights
are added to the repository.

For a clearly labelled source-domain sanity check, download a small balanced
sample from the public datasets used by the external models with:

```sh
python scripts/download-source-audio-sample.py
```

The default sample stays under `/tmp/drones-source-audio`. Its manifest records
source revision identifiers and file checksums and marks datasets without
explicit license files. Source-domain scores must never be reported as
independent validation.
Run `scripts/evaluate-yamnet-source-audio.py` in the same optional Python
environment to produce the aggregate compatibility report under `/tmp`.
The heavyweight Samid AST reference has its own pinned optional environment in
`scripts/requirements-samid-benchmark.txt` and can be run against that same
manifest with `scripts/evaluate-samid-source-audio.py`. Its 345 MB weights also
remain in a temporary cache and are not bundled with the web product.
Use `--source ahlab-droneaudioset` when a fast, reproducible single-source
report is needed for `npm run stats:update`.
The 42.6 GB AHLab DroneAudioSet is intentionally not downloaded wholesale;
`download-source-audio-sample.py --ahlab-parquet /path/to/pinned/shard.parquet`
can extract short, checksummed channel-0 clips from one explicitly supplied
MIT-licensed shard for a bounded local compatibility check.

The importer pins the upstream revision and checkpoint checksum, loads tensors
with `weights_only=True`, verifies PyTorch-to-ONNX numerical parity, and keeps
the source pickle out of the product. The committed ONNX model and its metadata
are in `public/models/`; the upstream MIT notice is included beside them.

## Current limitations

- The detector is a harmonic FFT baseline, not a trained production ML model.
- The experimental ML detector reduces structured false positives sharply but
  still fails the 5% held-out false-positive gate, so DSP remains the default.
- The external pretrained CRNN is not a default detector and has no local
  quality gate until it passes independent phone and field recordings.
- ML training and the Monte Carlo benchmark currently use the same synthetic
  generator family. Real Batear files remain external-test fixtures and are
  not represented as independent field validation.
- The DSP baseline currently flags the real rural ambient fixture as a drone;
  this known false positive is asserted explicitly in the regression suite and
  makes the live negative trials a required part of evaluation.
- The distance model uses simplified free-field attenuation with an assumed
  reference gain, not calibrated sound-pressure measurements.
- The localization benchmark does not yet model reverberation or multipath.
- Three coplanar microphones provide a 2D estimate; altitude remains unknown.
- Multiple simultaneous drones are not modeled yet; that requires explicit
  source separation and track association rather than duplicated map icons.

See [PROJECT.md](PROJECT.md) for the complete research context.

## Audio data

The local Batear audio fixtures come from
[`batear-io/batear-datasets`](https://github.com/batear-io/batear-datasets),
published under the MIT license. File-level provenance and local conversions
are documented in [public/audio/README.md](public/audio/README.md).

The optional FSD50K importer accepts only CC0/CC-BY hard-negative clips and
keeps bulk data outside Git. See [data/README.md](data/README.md).

No project-wide reuse license has been selected yet. Public visibility alone
does not grant a license to reuse the source code.
