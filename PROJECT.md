# Drones

Drones is an acoustic machine-learning project exploring how sound can be
turned into actionable intelligence for defence and security.

## Current focus

The current focus is detecting flying drones with microphones as an
alternative or complement to radar. Acoustic sensing can be passive and
undetectable, energy-efficient, and cost-effective.

## Acoustic Sensor Lab

The public interface and generated report labels are English-only so the
experiment can be shared consistently with an international audience.

The first product is a deterministic browser research environment with four
views:

- **City simulation** starts with one phone and one drone, and demonstrates
  detection, sensor limits, spoofing, fusion, and reaction time.
- **Sound lab** plays real Batear recordings or generated signatures and runs a
  blind TypeScript FFT/harmonic detector on decoded PCM. Its phone experiment
  captures five seconds from the device microphone, analyzes it locally, and
  records binary drone/background outcomes without retaining raw audio.
- **Multi-phone experiment** simulates offline clock calibration and 2D TDOA
  localization from three fixed listener phones.
- **Statistics** compares headless Monte Carlo results across drone profiles,
  assumed distance, noise environment, false alarms, and clock jitter.

The detection layer exposes the same asynchronous adapter contract for the
FFT baseline and an experimental ONNX binary classifier. The ML model scores
overlapping one-second windows and aggregates the latest five, requiring three
positives before an event is emitted. It is not selected as the default unless
the committed held-out report passes the recall, false-positive, and
DSP-comparison gate.

It is an educational research environment rather than an operational
detection or countermeasure system. All ranges and probabilities are treated
as simulated estimates until calibrated against controlled field trials.

The simulator compares a dedicated synchronized microphone array with
distributed phones over Wi-Fi or Bluetooth. These phone modes intentionally
model clock error: sharing a network transports audio or detection events but
does not by itself synchronize each phone's audio sampling clock.

A single phone never reports a fabricated bearing or altitude. Three calibrated
listeners can produce a 2D TDOA estimate; altitude remains unknown until a
non-coplanar fourth listener or another sensor is available.

## Research data

There is no reliable one-frequency-per-drone lookup table. Propeller blade-pass
frequency changes with blade count and RPM, and the useful signature includes
harmonics, transients, flight state, microphone response, and background noise.
The intended workflow is therefore labelled recordings plus metadata and
feature extraction rather than a fixed list of tones. Batear Datasets is one
open starting point. The local audio fixture manifest and transformations are
documented in `public/audio/README.md`.

Run it locally with:

```sh
npm install
npm run dev
```

Validate changes with `npm test` and `npm run build`.

Validate dataset licensing, split isolation, and checksums with
`npm run data:validate`. Rebuild the readable coefficients and ONNX graph with
`npm run train:model` before generating a new schema-v2 comparison report.

Run `npm run simulate` for the full deterministic headless benchmark, or
`npm run simulate:quick` for a short development check. Aggregate JSON and CSV
reports are written to `public/reports/headless/` and shown by the Statistics
view. No raw audio is written to a report.

The synthetic distance model uses simplified free-field 1/r attenuation with
an assumed reference gain. It is useful for regression comparisons but does
not establish real-world detection range without calibrated field data.

The first hardware-in-the-loop milestone is intentionally binary rather than
model-specific: play a randomized mix of drone and non-drone sounds from a
computer, capture them on a phone over HTTPS, and measure recall, false-alarm
rate, and inference latency. Laptop playback validates the capture and
classification path, not real drone range or sound pressure.
