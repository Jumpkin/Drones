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
  clock jitter.

Version 0.2 added a shared detector interface and compares the transparent FFT
baseline with a tiny ONNX feature-convolution classifier. The ML detector is
loaded in the browser but remains experimental until its held-out quality gate
reaches at least 85% recall, at most 5% false positives, and beats DSP F1.

Version 0.3 adds the local phone-microphone experiment, binary session metrics,
CSV export, mobile layout, and the hardened Tael deployment contract.

## Run locally

```sh
npm install
npm run dev
```

Then open the local URL printed by Vite.

## Phone microphone experiment

Open **Ljudlabb** on a phone from an HTTPS-hosted copy of the app. Choose the
truth (`Drönarljud` or `Bakgrund / störljud`), start the five-second capture,
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

## Current limitations

- The detector is a harmonic FFT baseline, not a trained production ML model.
- The experimental ML detector reduces structured false positives sharply but
  still fails the 5% held-out false-positive gate, so DSP remains the default.
- The DSP baseline currently flags the real rural ambient fixture as a drone;
  this known failing expectation is retained in the test suite and makes the
  live negative trials a required part of evaluation.
- The distance model uses simplified free-field attenuation with an assumed
  reference gain, not calibrated sound-pressure measurements.
- The localization benchmark does not yet model reverberation or multipath.
- Three coplanar microphones provide a 2D estimate; altitude remains unknown.

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
