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

The product now combines a deterministic browser research environment with a
native iOS hardware-in-the-loop client. The browser has five views:

- **City simulation** starts with one phone and one drone, and demonstrates
  detection, sensor limits, spoofing, fusion, and reaction time.
- **Sound lab** plays real Batear recordings or generated signatures and runs a
  blind TypeScript FFT/harmonic detector on decoded PCM. Its phone experiment
  captures five seconds from the device microphone, analyzes it locally, and
  records binary drone/background outcomes without retaining raw audio.
- **Multi-phone experiment** simulates offline clock calibration and 2D TDOA
  localization from three fixed listener phones.
- **Statistics** compares headless Monte Carlo results across drone profiles,
  assumed distance, noise environment, false alarms, clock jitter, and a
  synthetic computer-speaker-to-phone playback channel. Its benchmark-run
  registry shows positive, negative, and total test counts plus TP/FP/TN/FN for
  every compared model. Percentages and the highest-F1 winner are derived from
  those integer counts rather than copied into the interface.
- **About** provides a public technical record of the architecture, detector
  and localization flows, report-derived simulation parameters, limitations,
  privacy behavior, source relationships, and license status. It lists only
  code, models, and data used or supported by the project; it does not present
  unrelated companies or patents as implementation sources.

The detection layer exposes the same asynchronous adapter contract for the
FFT baseline, the project-trained experimental ONNX binary classifier, and an
external pretrained CRNN imported from Antoine Naccache's MIT-licensed model.
Both learned models score overlapping one-second windows and aggregate the
latest five, requiring three positives before an event is emitted. The
project-trained model is not selected as the default unless its committed
held-out report passes the recall, false-positive, and DSP-comparison gate. The
external CRNN remains non-default until it passes independent local validation.

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

After the optional local YAMNet and Samid compatibility runs, use
`npm run stats:update` to validate their test counts against the deterministic
headless reports and rebuild `public/reports/headless/benchmark-runs.json`.

The pretrained CRNN source is pinned to Hugging Face revision
`9d4f9c7afc2b893ee8b9356f8361e14069577dce`. Its original checkpoint is
checksum-verified and loaded as tensor weights only by
`scripts/import-pretrained-crnn.py`; the product contains the converted ONNX
graph, metadata, and upstream MIT notice, not the source pickle.

The synthetic distance model uses simplified free-field 1/r attenuation with
an assumed reference gain. It is useful for regression comparisons but does
not establish real-world detection range without calibrated field data.

The headless phone proxy adds deterministic speaker/microphone bandwidth,
compression, room echo, playback distance, background sound, and microphone
self-noise. These profiles are stress-test assumptions rather than physical
phone measurements; the hardware-in-the-loop experiment remains required.

The first hardware-in-the-loop milestone is intentionally binary rather than
model-specific: play a randomized mix of drone and non-drone sounds from a
computer, capture them on a phone over HTTPS, and measure recall, false-alarm
rate, and inference latency. Laptop playback validates the capture and
classification path, not real drone range or sound pressure.

Multiple simultaneous drones are deliberately outside the current simulator
contract. They require source-separation and track-association metrics rather
than reusing a single-drone confidence value for several aircraft.

## Native iOS test client

`mobile/ios` contains **Tael Drones Lab**, a SwiftUI iOS 16 app derived from the
native operational patterns in the Status project. It is installed directly
from Xcode and has four tabs: Listener, Sounds, Session, and Settings.

The Listener uses `AVAudioEngine` in foreground-only measurement mode. It
resamples overlapping one-second windows to 16 kHz and runs all three detector
families on the same window: the FFT/harmonic DSP baseline, Feature Conv ONNX,
and the imported pretrained CRNN ONNX. The two learned models run with the
official `onnxruntime-objc` 1.29.0 package. Each detector keeps the latest five
probabilities and uses the same three-positive-window vote as the web adapters;
the displayed consensus requires at least two of the three detectors.

The bundled Sounds library contains the same three Batear drone fixtures and
rural negative control documented in `public/audio/README.md`. In a shared
six-character test session one phone is a Source and separate phones are
Listeners. A Source schedules playback three seconds against server time and
never records while playing. Listeners upload every inference window during a
scheduled test so the app can derive TP, FP, TN, FN, recall, false-positive
rate, precision, and F1 overall, by listener, and by playback. Outside a test
session only positive consensus events are retained.

The app requests precise foreground location for test metadata. Denying the
permission does not stop acoustic detection; the event then has no location.
It persists an idempotent metadata queue across network failures and batches at
most 50 observations. It never queues or uploads PCM, WAV files, clips, sample
arrays, or microphone buffers.

## Metadata API and database

The production image is now a non-root Node/Fastify service that serves the
existing Vite build and `/api/drones/v1`. A shared first-launch setup code can
enroll an owner test phone once. The server then returns a random per-device
capability; only its HMAC hash is stored, while iOS keeps the capability in
Keychain. The API provides clock synchronization, session create/join/close,
scheduled playback, idempotent observation batches, and session results. It
limits JSON requests to 64 KB, validates every field, rate-limits requests, and
explicitly rejects audio-shaped payload keys.

PostgreSQL 17 stores devices, memberships, sessions, playbacks and observation
metadata on a private network with no host port. Schema migration is an
explicit `workflow_dispatch` operation separate from ordinary image deployment;
selecting `migrate` runs the restricted migration command without switching the
application image. This owner-device
experiment deliberately has no backups and retains rows until an explicit
owner reset; there is no public reset endpoint. The owner-only CLI requires
both `DRONES_ALLOW_RESET=true` and the literal
`--confirm-disposable-drones-data` argument. Add backups and a reviewed data
lifecycle before treating the database as valuable or moving beyond testing.

Run the complete web/API checks with `npm test`, `npm run lint`, and
`npm run build`. Generate and open the mobile workspace with the commands in
`mobile/ios/README.md`.
