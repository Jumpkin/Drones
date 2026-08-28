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
  with a TypeScript FFT/harmonic detector.
- **Multi-phone test** demonstrates clock calibration and 2D TDOA localization
  with three listener nodes.
- **Statistics** compares deterministic headless Monte Carlo runs across drone
  profiles, assumed distances, noise environments, false alarms, and residual
  clock jitter.

## Run locally

```sh
npm install
npm run dev
```

Then open the local URL printed by Vite.

## Test and benchmark

```sh
npm test
npm run build
npm run simulate
```

The headless simulation writes aggregate JSON and CSV reports to
`public/reports/headless/`. It never writes raw audio to a report. Use
`npm run simulate:quick` for a shorter development run.

## Current limitations

- The detector is a harmonic FFT baseline, not a trained production ML model.
- Structured machinery noise currently causes severe false positives.
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

No project-wide reuse license has been selected yet. Public visibility alone
does not grant a license to reuse the source code.
