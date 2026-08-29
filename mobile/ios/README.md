# Tael Drones Lab for iOS

Native iOS 16 test client for the Drones acoustic experiment. It runs the DSP,
Feature Conv ONNX, and pretrained CRNN ONNX detectors locally, can play the
licensed test fixtures in a separate Source role, and uploads metadata-only
observations to the Drones API.

For guided calibration, create a computer test session in the website's Sound
lab and join its six-character code as Listener. The microphone starts
automatically, and the Session tab displays ground truth, measured distance,
web-player gain, environment, model probability, latency, and TP/FP/TN/FN-based
metrics. The web source includes real fixtures plus generated background,
traffic, wind, and motor-hum negative controls.

The app never uploads PCM, WAV files, microphone buffers, or audio clips. It
listens only while visible and explicitly started. One device cannot be Source
and Listener in the same session.

## Open and install

```sh
cd mobile/ios
xcodegen generate
pod install
open TaelDronesLab.xcworkspace
```

Select an attached iPhone, keep the `K6GVLS864D` development team (or select
your own team), and press Run. The test phone registers automatically with no
setup code, login, or secret token.

The checked-in sounds retain the provenance and licence notes from
`public/audio/README.md`. The imported CRNN retains its MIT notice in the app
resources.
