import "./styles.css";
import {
  generateAmbientPcm,
  generateDronePcm,
  loadMonoPcm,
  playAudioBuffer,
  playDroneMixture,
  playPcm,
} from "./audio";
import { analyzePcm, type DetectorResult } from "./detector";
import { loadDetectorSuite } from "./detectors/ml-adapter";
import { DspDetectorAdapter } from "./detectors/dsp-adapter";
import type { DetectorAdapter, DetectorOutput } from "./detectors/types";
import { createAcousticEvent, fuseSingleNodeEvent } from "./events";
import {
  analyzeOfflineTrial,
  type ListenerNode,
  type LocalizationResult,
} from "./localization";
import { AUDIO_SAMPLES, getAudioSample } from "./samples";
import {
  captureMicrophone,
  microphoneErrorMessage,
  summarizeTrials,
  type MicrophoneTrial,
  type TrialTruth,
} from "./microphone";
import {
  compareProfiles,
  mean as statisticsMean,
  modelFor,
  rowsForEnvironment,
  type DetectionMetric,
  type HeadlessReport,
} from "./stats";
import {
  ARRAY_MODES,
  DRONE_PROFILES,
  SCENARIOS,
  WORLD,
  createConfig,
  createState,
  evaluateSimulation,
  stepSimulation,
  type DroneProfileId,
  type ArrayMode,
  type ScenarioId,
  type SimulationConfig,
  type SimulationResult,
  type SimulationState,
  type SpoofMode,
} from "./sim";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root is missing");

app.innerHTML = `
  <header class="topbar">
    <div class="brand-lockup">
      <div class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></div>
      <div>
        <p class="eyebrow">Drones research environment</p>
        <h1>Acoustic Sensor Lab</h1>
      </div>
    </div>
    <nav class="view-tabs" aria-label="Workspace view">
      <button class="view-tab is-active" data-view="simulator" type="button">City simulation</button>
      <button class="view-tab" data-view="soundLab" type="button">Sound lab</button>
      <button class="view-tab" data-view="experiment" type="button">Multi-phone test</button>
      <button class="view-tab" data-view="statistics" type="button">Statistics</button>
    </nav>
    <div class="model-notice">
      <span class="notice-dot"></span>
      Simulated estimate · not an operational system
    </div>
  </header>

  <section id="simulatorView" class="app-view">
  <main class="workspace">
    <aside class="panel control-panel" aria-label="Simulation controls">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Scenario</p>
          <h2>Configuration</h2>
        </div>
        <span class="step-label">01</span>
      </div>

      <label class="field">
        <span>Preset</span>
        <select id="scenarioSelect"></select>
      </label>
      <p id="scenarioDescription" class="field-help"></p>

      <div class="section-rule"></div>
      <p class="section-kicker">Aircraft</p>

      <label class="field">
        <span>Drone profile</span>
        <select id="profileSelect"></select>
      </label>

      <label class="range-field">
        <span><span>Speed</span><output id="speedOutput"></output></span>
        <input id="speedInput" type="range" min="20" max="220" step="1" />
      </label>
      <label class="range-field">
        <span><span>Altitude</span><output id="altitudeOutput"></output></span>
        <input id="altitudeInput" type="range" min="5" max="250" step="1" />
      </label>
      <label class="range-field">
        <span><span>RPM shift</span><output id="rpmOutput"></output></span>
        <input id="rpmInput" type="range" min="-35" max="35" step="1" />
      </label>
      <label class="check-row">
        <span>Active radio link</span>
        <input id="radioActive" type="checkbox" />
      </label>

      <div class="section-rule"></div>
      <p class="section-kicker">Environment & interference</p>

      <label class="range-field">
        <span><span>Wind</span><output id="windOutput"></output></span>
        <input id="windInput" type="range" min="0" max="20" step="0.5" />
      </label>
      <label class="range-field">
        <span><span>Background noise</span><output id="ambientOutput"></output></span>
        <input id="ambientInput" type="range" min="30" max="85" step="1" />
      </label>
      <label class="range-field">
        <span><span>Visibility</span><output id="visibilityOutput"></output></span>
        <input id="visibilityInput" type="range" min="0.1" max="1" step="0.05" />
      </label>
      <label class="field">
        <span>Acoustic attack</span>
        <select id="spoofMode">
          <option value="none">None</option>
          <option value="replay">Speaker replay</option>
          <option value="broadband">Broadband masking</option>
        </select>
      </label>
      <label class="range-field">
        <span><span>Interference level</span><output id="spoofOutput"></output></span>
        <input id="spoofInput" type="range" min="55" max="115" step="1" />
      </label>
    </aside>

    <section class="simulation-column">
      <div class="simulation-toolbar">
        <div class="transport-controls">
          <button id="playButton" class="primary-button" type="button">
            <span id="playIcon" aria-hidden="true">▶</span>
            <span id="playLabel">Start</span>
          </button>
          <button id="resetButton" class="icon-button" type="button" aria-label="Reset scenario">↺</button>
        </div>
        <div class="toolbar-readout">
          <span>Simulation time</span>
          <strong id="elapsedOutput">00:00.0</strong>
        </div>
        <label class="compact-field">
          <span>Speed</span>
          <select id="playbackRate">
            <option value="0.5">0.5×</option>
            <option value="1" selected>1×</option>
            <option value="2">2×</option>
            <option value="4">4×</option>
          </select>
        </label>
      </div>

      <div class="map-shell">
        <canvas id="worldCanvas" aria-label="Map of the simulated protected area"></canvas>
        <div class="map-status" id="mapStatus">
          <span class="status-pulse"></span>
          <span id="mapStatusText">Monitoring</span>
        </div>
        <div class="map-hint">Click the map to move the drone</div>
        <div class="map-legend" aria-label="Map legend">
          <span><i class="legend-drone"></i> Drone</span>
          <span><i class="legend-sensor"></i> Sensor node</span>
          <span><i class="legend-target"></i> Protected asset</span>
        </div>
      </div>

      <div class="analysis-grid">
        <section class="subpanel signal-panel">
          <div class="subpanel-heading">
            <div>
              <p class="eyebrow">Acoustic signature</p>
              <h3>Harmonic analysis</h3>
            </div>
            <span id="bpfBadge" class="data-badge">— Hz BPF</span>
          </div>
          <canvas id="spectrumCanvas" aria-label="Simulated frequency spectrum"></canvas>
          <div class="signal-footer">
            <span><i class="signal-key signal-key--drone"></i> Rotor signature</span>
            <span><i class="signal-key signal-key--noise"></i> Noise floor</span>
          </div>
        </section>

        <section class="subpanel event-panel">
          <div class="subpanel-heading">
            <div>
              <p class="eyebrow">System log</p>
              <h3>Latest events</h3>
            </div>
            <span class="live-tag">Live</span>
          </div>
          <ol id="eventLog" class="event-log" aria-live="polite"></ol>
        </section>
      </div>
    </section>

    <aside class="panel telemetry-panel" aria-label="Sensor results">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Sensorfusion</p>
          <h2>Operational picture</h2>
        </div>
        <span class="step-label">02</span>
      </div>

      <section class="threat-card" id="threatCard">
        <div>
          <p id="threatLabel">No confirmed signature</p>
          <strong id="fusionOutput">0%</strong>
        </div>
        <div class="confidence-ring" id="confidenceRing"><span id="ringValue">0</span></div>
      </section>

      <div class="metric-grid">
        <article class="metric-card">
          <span>Distance</span>
          <strong id="distanceOutput">—</strong>
          <small>to protected asset</small>
        </article>
        <article class="metric-card metric-card--accent">
          <span>Machine time</span>
          <strong id="marginOutput">—</strong>
          <small>after system latency</small>
        </article>
        <article class="metric-card">
          <span>Bearing</span>
          <strong id="bearingOutput">—</strong>
          <small id="bearingErrorOutput">no lock</small>
        </article>
        <article class="metric-card">
          <span>SNR</span>
          <strong id="snrOutput">—</strong>
          <small>drone versus noise</small>
        </article>
      </div>

      <div class="section-rule"></div>
      <div class="sensor-title-row">
        <p class="section-kicker">Sensor contributions</p>
        <label class="node-select">Nodes <select id="sensorCount"><option>1</option><option>2</option><option>3</option></select></label>
      </div>

      <label class="field array-field">
        <span>Acoustic network</span>
        <select id="arrayMode"></select>
      </label>
      <div class="array-readout">
        <span>Timing error <strong id="syncOutput">—</strong></span>
        <span>Spatial error <strong id="syncDistanceOutput">—</strong></span>
      </div>

      <div class="sensor-stack">
        <article class="sensor-row">
          <label><input id="toggleAcoustic" type="checkbox" /> Acoustic</label>
          <strong id="acousticValue">0%</strong>
          <div class="meter"><span id="acousticMeter"></span></div>
        </article>
        <article class="sensor-row">
          <label><input id="toggleRadar" type="checkbox" /> Radar</label>
          <strong id="radarValue">0%</strong>
          <div class="meter"><span id="radarMeter"></span></div>
        </article>
        <article class="sensor-row">
          <label><input id="toggleRf" type="checkbox" /> RF / Remote ID</label>
          <strong id="rfValue">0%</strong>
          <div class="meter"><span id="rfMeter"></span></div>
        </article>
        <article class="sensor-row">
          <label><input id="toggleCamera" type="checkbox" /> Camera/IR</label>
          <strong id="cameraValue">0%</strong>
          <div class="meter"><span id="cameraMeter"></span></div>
        </article>
      </div>
      <p class="sensor-note">ADS-B is a separate aircraft transponder system. Remote ID can broadcast the drone position and, depending on the type, the control-station position over Wi-Fi/Bluetooth.</p>

      <div class="section-rule"></div>
      <p class="section-kicker">Time budget</p>
      <div class="timeline-card">
        <div class="timeline-row"><span>Estimated arrival</span><strong id="etaOutput">—</strong></div>
        <div class="timeline-row"><span>Sound delay</span><strong id="delayOutput">—</strong></div>
        <div class="timeline-row"><span>System latency</span><strong id="latencyOutput">—</strong></div>
        <div class="timeline-row timeline-row--total"><span>After human decision</span><strong id="humanMarginOutput">—</strong></div>
      </div>

      <div id="spoofAlert" class="spoof-alert" hidden>
        <span aria-hidden="true">◇</span>
        <div><strong>Inconsistent sound source</strong><p id="spoofAlertText"></p></div>
      </div>
    </aside>
  </main>
  </section>

  <section id="soundLabView" class="app-view lab-view" hidden>
    <div class="lab-page-heading">
      <div><p class="eyebrow">Blind signal analysis</p><h2>Play a sound signature. Test the listener.</h2></div>
      <p>The player knows the ground truth. The detector receives PCM data only and cannot read filenames or labels.</p>
    </div>
    <div class="lab-layout">
      <aside class="lab-card lab-controls">
        <p class="section-kicker">01 · Select source</p>
        <label class="field"><span>Audio sample</span><select id="labSampleSelect"></select></label>
        <label class="field"><span>Detector</span><select id="labDetectorSelect">
          <option value="dsp-v1">FFT / harmonic DSP</option>
          <option value="ml-onnx-v1">Feature Conv ML</option>
        </select></label>
        <p id="labDetectorStatus" class="field-help">Loading detectors…</p>
        <p id="labSampleNote" class="field-help"></p>
        <label class="range-field" id="labRpmField">
          <span><span>RPM shift</span><output id="labRpmOutput">0%</output></span>
          <input id="labRpmInput" type="range" min="-30" max="30" step="1" value="0" />
        </label>
        <div class="button-stack">
          <button id="labPlayButton" class="primary-button wide-button" type="button">▶ Play sound signature</button>
          <button id="labAnalyzeButton" class="secondary-button" type="button">Analyze blind</button>
        </div>
        <div class="license-box">
          <span>Provenance</span>
          <strong id="labSourceLabel">—</strong>
          <a id="labSourceLink" href="#" target="_blank" rel="noreferrer">Open source</a>
          <small id="labLicense">—</small>
        </div>
      </aside>

      <main class="lab-card lab-analysis">
        <div class="subpanel-heading">
          <div><p class="eyebrow">Listener result</p><h3 id="labDetectionTitle">Waiting for analysis</h3></div>
          <span id="labDetectionBadge" class="data-badge">NO DATA</span>
        </div>
        <canvas id="labSpectrumCanvas" aria-label="FFT spectrum from the selected audio sample"></canvas>
        <div class="detector-metrics">
          <article><span>Confidence</span><strong id="labConfidence">—</strong></article>
          <article><span>Fundamental</span><strong id="labFundamental">—</strong></article>
          <article><span>Harmonics</span><strong id="labHarmonic">—</strong></article>
          <article><span>Positive windows</span><strong id="labFrames">—</strong></article>
        </div>
        <div class="classification-block">
          <p class="section-kicker">Classification · top 3</p>
          <ol id="labClassifications" class="classification-list"><li>No analysis completed</li></ol>
        </div>
      </main>

      <aside class="lab-card event-inspector">
        <p class="section-kicker">02 · Metadata to backend</p>
        <p class="sensor-note">Only features and probabilities leave the listener. No PCM or WAV data is included.</p>
        <pre id="labEventJson" class="event-json">{ }</pre>
        <div class="truth-card">
          <span>Ground truth</span>
          <strong id="labTruth">Hidden until analysis</strong>
          <small id="labVerdict">The detector is tested without label leakage.</small>
        </div>
      </aside>
    </div>

    <section class="lab-card live-test-card">
      <div class="subpanel-heading">
        <div><p class="eyebrow">Phone test · hardware in the loop</p><h3>Listen with the device microphone</h3></div>
        <span id="microphoneBadge" class="data-badge">READY</span>
      </div>
      <div class="live-test-grid">
        <div class="live-test-controls">
          <p class="sensor-note">Open this page on the phone over HTTPS. Select the ground truth, start the five-second recording, then play audio from another device. Ground truth is never sent to the detector.</p>
          <label class="field"><span>Playback ground truth</span><select id="microphoneTruth">
            <option value="drone">Drone audio</option>
            <option value="ambient">Background / interference</option>
          </select></label>
          <button id="microphoneCaptureButton" class="primary-button wide-button" type="button">● Record 5 seconds</button>
          <p id="microphoneStatus" class="microphone-status">No microphone capture completed.</p>
          <small class="privacy-note">Audio is analyzed in the browser and is not saved. Only the test result remains in this tab.</small>
        </div>
        <div class="live-test-results">
          <div class="live-kpis">
            <article><span>Trials</span><strong id="microphoneTrialCount">0</strong></article>
            <article><span>Recall</span><strong id="microphoneRecall">—</strong></article>
            <article><span>False alarms</span><strong id="microphoneFpr">—</strong></article>
            <article><span>Latest RMS</span><strong id="microphoneRms">—</strong></article>
          </div>
          <div class="table-scroll microphone-table-scroll">
            <table class="statistics-table">
              <thead><tr><th>#</th><th>Truth</th><th>Decision</th><th>Probability</th><th>Type</th><th>Latency</th></tr></thead>
              <tbody id="microphoneTrialBody"><tr><td colspan="6">No trials yet</td></tr></tbody>
            </table>
          </div>
          <div class="microphone-actions">
            <button id="microphoneDownloadButton" class="secondary-button" type="button" disabled>Download CSV</button>
            <button id="microphoneResetButton" class="secondary-button" type="button" disabled>Reset session</button>
          </div>
        </div>
      </div>
    </section>
  </section>

  <section id="experimentView" class="app-view lab-view" hidden>
    <div class="lab-page-heading">
      <div><p class="eyebrow">Offline TDOA</p><h2>Three listeners. One moving sound source.</h2></div>
      <p>Simulate three separate recordings, correct the phone clocks, and locate the source in 2D.</p>
    </div>
    <div class="experiment-layout">
      <aside class="lab-card experiment-controls">
        <p class="section-kicker">Session roles</p>
        <div class="role-list">
          <article><i class="role-dot role-dot--source"></i><div><strong>Source phone</strong><small>Calibration signal + drone audio</small></div></article>
          <article><i class="role-dot"></i><div><strong>P1–P3 listeners</strong><small>PCM + local timestamps</small></div></article>
          <article><i class="role-dot role-dot--backend"></i><div><strong>Aggregator</strong><small>Synchronization, TDOA, and track</small></div></article>
        </div>
        <label class="field"><span>Source X position</span><input id="sourceXInput" type="number" min="0" max="700" value="390" /></label>
        <label class="field"><span>Source Y position</span><input id="sourceYInput" type="number" min="0" max="420" value="220" /></label>
        <div class="button-stack">
          <button id="calibrateButton" class="secondary-button" type="button">1. Create & calibrate session</button>
          <button id="localizeButton" class="primary-button wide-button" type="button" disabled>2. Synchronize & locate</button>
        </div>
        <p class="sensor-note">Click the map to move the source ground truth. Altitude remains unknown with three coplanar nodes.</p>
      </aside>

      <main class="lab-card experiment-map-card">
        <div class="subpanel-heading">
          <div><p class="eyebrow">Room map · metres</p><h3>Ground truth and acoustic estimate</h3></div>
          <span id="experimentStatus" class="data-badge">NOT CALIBRATED</span>
        </div>
        <canvas id="experimentCanvas" aria-label="Map of three phones and one sound source"></canvas>
        <div class="experiment-legend">
          <span><i class="truth-dot"></i> Ground truth</span>
          <span><i class="estimate-dot"></i> Estimate</span>
          <span><i class="phone-dot"></i> Listener</span>
        </div>
      </main>

      <aside class="lab-card experiment-results">
        <p class="section-kicker">Results</p>
        <div class="result-stack">
          <article><span>2D error</span><strong id="experimentError">—</strong></article>
          <article><span>Array bearing</span><strong id="experimentBearing">—</strong></article>
          <article><span>Residual</span><strong id="experimentResidual">—</strong></article>
          <article><span>Altitude</span><strong id="experimentAltitude">Unknown</strong></article>
          <article><span>Source count</span><strong id="experimentCount">1</strong></article>
        </div>
        <p class="section-kicker correction-title">Clock correction</p>
        <ol id="clockCorrections" class="classification-list"><li>No session created</li></ol>
        <div class="warning-box">Altitude requires at least one additional listener at a different elevation. The result therefore never displays a fabricated altitude.</div>
      </aside>
    </div>
  </section>

  <section id="statisticsView" class="app-view lab-view statistics-view" hidden>
    <div class="lab-page-heading">
      <div><p class="eyebrow">Headless Monte Carlo</p><h2>Compare detection and localization</h2></div>
      <p>Reproducible runs with a fixed random seed. Synthetic distances are regression data, not field-validated range.</p>
    </div>

    <div class="statistics-toolbar lab-card">
      <label class="field"><span>Detector</span><select id="statisticsDetector">
        <option value="dsp-v1">FFT / harmonic DSP</option>
        <option value="ml-onnx-v1">Feature Conv ML</option>
      </select></label>
      <label class="field"><span>Noise environment</span><select id="statisticsEnvironment">
        <option value="quiet">Quiet</option>
        <option value="urban">Urban</option>
        <option value="loud-structured">Loud + structured noise</option>
      </select></label>
      <label class="field"><span>Comparison metric</span><select id="statisticsMetric">
        <option value="detectionRate">Detection rate</option>
        <option value="top1Accuracy">Correct detection + type</option>
      </select></label>
      <div class="statistics-run-info">
        <span>Latest run</span>
        <strong id="statisticsGenerated">Loading…</strong>
        <small id="statisticsSeed">—</small>
      </div>
      <div class="statistics-downloads">
        <a href="/reports/headless/summary.json" download>JSON</a>
        <a href="/reports/headless/detection.csv" download>Detection CSV</a>
        <a href="/reports/headless/localization.csv" download>Position CSV</a>
        <a href="/reports/headless/failures.csv" download>Failures CSV</a>
      </div>
    </div>

    <div id="statisticsLoading" class="statistics-loading">Loading headless report…</div>
    <div id="statisticsContent" hidden>
      <div class="statistics-kpis">
        <article id="statisticsGateCard"><span>Quality gate</span><strong id="statisticsQualityGate">—</strong><small>≤5% FPR · ≥85% recall · better F1</small></article>
        <article><span>Recall</span><strong id="statisticsRecall">—</strong><small>all positive benchmark cases</small></article>
        <article><span>False alarms</span><strong id="statisticsFalseAlarm">—</strong><small>selected background without a drone</small></article>
        <article><span>F1</span><strong id="statisticsF1">—</strong><small>precision and recall in balance</small></article>
      </div>

      <div class="statistics-chart-grid">
        <section class="lab-card statistics-chart-card">
          <div class="subpanel-heading"><div><p class="eyebrow">Distance comparison</p><h3 id="statisticsDetectionTitle">Detection rate by drone type</h3></div><span class="data-badge">MONTE CARLO</span></div>
          <canvas id="statisticsDetectionCanvas" aria-label="Detection comparison by distance and drone type"></canvas>
          <div id="statisticsProfileLegend" class="chart-legend"></div>
        </section>
        <section class="lab-card statistics-chart-card">
          <div class="subpanel-heading"><div><p class="eyebrow">Timing accuracy</p><h3>2D error versus residual timing jitter</h3></div><span class="data-badge">3 PHONES</span></div>
          <canvas id="statisticsLocalizationCanvas" aria-label="Localization error compared with timing jitter"></canvas>
          <div class="chart-legend"><span><i style="--series:#53e2bf"></i>Median</span><span><i style="--series:#ffb45c"></i>p90</span></div>
        </section>
        <section class="lab-card statistics-chart-card">
          <div class="subpanel-heading"><div><p class="eyebrow">Threshold analysis</p><h3>Precision–recall</h3></div><span id="statisticsThresholdBadge" class="data-badge">—</span></div>
          <canvas id="statisticsCurveCanvas" aria-label="Precision and recall at different detection thresholds"></canvas>
          <div class="chart-legend"><span><i style="--series:#53e2bf"></i>Precision</span><span><i style="--series:#ff746d"></i>Recall</span></div>
        </section>
      </div>

      <div class="statistics-table-grid">
        <section class="lab-card">
          <div class="subpanel-heading"><div><p class="eyebrow">Ranking</p><h3>Drone types in the selected environment</h3></div></div>
          <div class="table-scroll"><table class="statistics-table"><thead><tr><th>Type</th><th>Average</th><th>Best</th><th>Worst</th></tr></thead><tbody id="statisticsRankingBody"></tbody></table></div>
        </section>
        <section class="lab-card">
          <div class="subpanel-heading"><div><p class="eyebrow">Synchronization</p><h3>Localization comparison</h3></div></div>
          <div class="table-scroll"><table class="statistics-table"><thead><tr><th>Jitter</th><th>Median</th><th>p90</th><th>≤ 5 m</th><th>Bearing error p90</th></tr></thead><tbody id="statisticsLocalizationBody"></tbody></table></div>
        </section>
      </div>

      <div class="statistics-table-grid">
        <section class="lab-card">
          <div class="subpanel-heading"><div><p class="eyebrow">Confusion matrix</p><h3>Binary decision</h3></div></div>
          <div class="confusion-grid">
            <span></span><strong>Pred. drone</strong><strong>Pred. background</strong>
            <strong>Drone</strong><article class="confusion-good"><span>TP</span><b id="statisticsTp">—</b></article><article class="confusion-bad"><span>FN</span><b id="statisticsFn">—</b></article>
            <strong>Background</strong><article class="confusion-bad"><span>FP</span><b id="statisticsFp">—</b></article><article class="confusion-good"><span>TN</span><b id="statisticsTn">—</b></article>
          </div>
        </section>
        <section class="lab-card">
          <div class="subpanel-heading"><div><p class="eyebrow">Failure explorer</p><h3>False alarms and misses</h3></div><span id="statisticsFailureCount" class="data-badge">—</span></div>
          <div class="table-scroll failure-scroll"><table class="statistics-table"><thead><tr><th>Failure</th><th>Source</th><th>Environment</th><th>Probability</th></tr></thead><tbody id="statisticsFailureBody"></tbody></table></div>
        </section>
      </div>

      <section class="lab-card statistics-comparison-card">
        <div class="subpanel-heading"><div><p class="eyebrow">Direct comparison</p><h3>DSP versus ML on the same benchmark</h3></div><span class="data-badge">SAME DATA · SAME SEED</span></div>
        <div class="table-scroll"><table class="statistics-table"><thead><tr><th>Detector</th><th>Default</th><th>Precision</th><th>Recall</th><th>False alarms</th><th>F1</th><th>PR-AUC</th><th>Gate</th></tr></thead><tbody id="statisticsDetectorComparisonBody"></tbody></table></div>
      </section>

      <div class="statistics-caveat lab-card">
        <strong>How to read the statistics</strong>
        <ul id="statisticsCaveats"></ul>
      </div>
    </div>
  </section>
`;

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

const scenarioSelect = requiredElement<HTMLSelectElement>("#scenarioSelect");
const profileSelect = requiredElement<HTMLSelectElement>("#profileSelect");
const arrayModeSelect = requiredElement<HTMLSelectElement>("#arrayMode");
for (const [id, scenario] of Object.entries(SCENARIOS)) {
  scenarioSelect.add(new Option(scenario.label, id));
}
for (const [id, profile] of Object.entries(DRONE_PROFILES)) {
  profileSelect.add(new Option(profile.label, id));
}
for (const [id, mode] of Object.entries(ARRAY_MODES)) {
  arrayModeSelect.add(new Option(mode.label, id));
}

const worldCanvas = requiredElement<HTMLCanvasElement>("#worldCanvas");
const spectrumCanvas = requiredElement<HTMLCanvasElement>("#spectrumCanvas");
const playButton = requiredElement<HTMLButtonElement>("#playButton");
const resetButton = requiredElement<HTMLButtonElement>("#resetButton");
const playbackRateSelect = requiredElement<HTMLSelectElement>("#playbackRate");

let config: SimulationConfig = createConfig("quiet");
let state: SimulationState = createState("quiet");
let result: SimulationResult = evaluateSimulation(state, config);
let running = false;
let playbackRate = 1;
let previousTimestamp = performance.now();
let previousStatus = result.status;
const events: Array<{ time: number; text: string; tone: string }> = [];

function setText(selector: string, value: string): void {
  requiredElement(selector).textContent = value;
}

function setRangeValue(
  inputSelector: string,
  outputSelector: string,
  value: number,
  format: (value: number) => string,
): void {
  requiredElement<HTMLInputElement>(inputSelector).value = String(value);
  setText(outputSelector, format(value));
}

function syncControls(): void {
  scenarioSelect.value = config.scenario;
  profileSelect.value = config.profile;
  setText("#scenarioDescription", SCENARIOS[config.scenario].description);
  setRangeValue("#speedInput", "#speedOutput", config.speedKmh, (v) => `${v.toFixed(0)} km/h`);
  setRangeValue("#altitudeInput", "#altitudeOutput", config.altitudeM, (v) => `${v.toFixed(0)} m`);
  setRangeValue("#rpmInput", "#rpmOutput", config.rpmShiftPercent, (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}%`);
  setRangeValue("#windInput", "#windOutput", config.windMs, (v) => `${v.toFixed(1)} m/s`);
  setRangeValue("#ambientInput", "#ambientOutput", config.ambientDb, (v) => `${v.toFixed(0)} dB`);
  setRangeValue("#visibilityInput", "#visibilityOutput", config.visibility, (v) => `${Math.round(v * 100)}%`);
  setRangeValue("#spoofInput", "#spoofOutput", config.spoofLevelDb, (v) => `${v.toFixed(0)} dB`);
  requiredElement<HTMLInputElement>("#radioActive").checked = config.radioActive;
  requiredElement<HTMLSelectElement>("#spoofMode").value = config.spoofMode;
  requiredElement<HTMLSelectElement>("#sensorCount").value = String(config.sensorCount);
  arrayModeSelect.value = config.arrayMode;
  requiredElement<HTMLInputElement>("#toggleAcoustic").checked = config.sensors.acoustic;
  requiredElement<HTMLInputElement>("#toggleRadar").checked = config.sensors.radar;
  requiredElement<HTMLInputElement>("#toggleRf").checked = config.sensors.rf;
  requiredElement<HTMLInputElement>("#toggleCamera").checked = config.sensors.camera;
}

function addEvent(text: string, tone = "neutral"): void {
  if (events[0]?.text === text) return;
  events.unshift({ time: state.elapsedS, text, tone });
  events.splice(5);
  renderEvents();
}

function renderEvents(): void {
  const log = requiredElement<HTMLOListElement>("#eventLog");
  log.innerHTML = events
    .map(
      (event) => `
        <li class="event-item event-item--${event.tone}">
          <time>${formatClock(event.time)}</time>
          <span>${event.text}</span>
        </li>`,
    )
    .join("");
}

function loadScenario(id: ScenarioId): void {
  config = createConfig(id);
  state = createState(id);
  result = evaluateSimulation(state, config);
  running = false;
  previousStatus = result.status;
  events.splice(0);
  addEvent(`Scenario loaded: ${SCENARIOS[id].label}`);
  syncControls();
  syncPlayButton();
  renderAll();
}

function syncPlayButton(): void {
  setText("#playLabel", running ? "Pause" : "Start");
  setText("#playIcon", running ? "Ⅱ" : "▶");
  playButton.classList.toggle("is-running", running);
}

function bindRange(
  selector: string,
  key: "speedKmh" | "altitudeM" | "rpmShiftPercent" | "windMs" | "ambientDb" | "visibility" | "spoofLevelDb",
  outputSelector: string,
  format: (value: number) => string,
): void {
  requiredElement<HTMLInputElement>(selector).addEventListener("input", (event) => {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    config[key] = value;
    setText(outputSelector, format(value));
    result = evaluateSimulation(state, config);
    renderAll();
  });
}

bindRange("#speedInput", "speedKmh", "#speedOutput", (v) => `${v.toFixed(0)} km/h`);
bindRange("#altitudeInput", "altitudeM", "#altitudeOutput", (v) => `${v.toFixed(0)} m`);
bindRange("#rpmInput", "rpmShiftPercent", "#rpmOutput", (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}%`);
bindRange("#windInput", "windMs", "#windOutput", (v) => `${v.toFixed(1)} m/s`);
bindRange("#ambientInput", "ambientDb", "#ambientOutput", (v) => `${v.toFixed(0)} dB`);
bindRange("#visibilityInput", "visibility", "#visibilityOutput", (v) => `${Math.round(v * 100)}%`);
bindRange("#spoofInput", "spoofLevelDb", "#spoofOutput", (v) => `${v.toFixed(0)} dB`);

scenarioSelect.addEventListener("change", () => loadScenario(scenarioSelect.value as ScenarioId));
profileSelect.addEventListener("change", () => {
  config.profile = profileSelect.value as DroneProfileId;
  config.dronePresent = true;
  result = evaluateSimulation(state, config);
  renderAll();
});
requiredElement<HTMLInputElement>("#radioActive").addEventListener("change", (event) => {
  config.radioActive = (event.currentTarget as HTMLInputElement).checked;
  result = evaluateSimulation(state, config);
  renderAll();
});
requiredElement<HTMLSelectElement>("#spoofMode").addEventListener("change", (event) => {
  config.spoofMode = (event.currentTarget as HTMLSelectElement).value as SpoofMode;
  result = evaluateSimulation(state, config);
  addEvent(config.spoofMode === "none" ? "Acoustic interference disabled" : "Acoustic interference source enabled", config.spoofMode === "none" ? "neutral" : "warning");
  renderAll();
});
requiredElement<HTMLSelectElement>("#sensorCount").addEventListener("change", (event) => {
  config.sensorCount = Number((event.currentTarget as HTMLSelectElement).value);
  result = evaluateSimulation(state, config);
  renderAll();
});
arrayModeSelect.addEventListener("change", () => {
  config.arrayMode = arrayModeSelect.value as ArrayMode;
  result = evaluateSimulation(state, config);
  addEvent(`Acoustic network: ${ARRAY_MODES[config.arrayMode].label}`, config.arrayMode === "hardware" ? "neutral" : "warning");
  renderAll();
});

for (const [selector, key] of [
  ["#toggleAcoustic", "acoustic"],
  ["#toggleRadar", "radar"],
  ["#toggleRf", "rf"],
  ["#toggleCamera", "camera"],
] as const) {
  requiredElement<HTMLInputElement>(selector).addEventListener("change", (event) => {
    config.sensors[key] = (event.currentTarget as HTMLInputElement).checked;
    result = evaluateSimulation(state, config);
    renderAll();
  });
}

playButton.addEventListener("click", () => {
  running = !running;
  addEvent(running ? "Simulation started" : "Simulation paused");
  syncPlayButton();
});

resetButton.addEventListener("click", () => loadScenario(config.scenario));
playbackRateSelect.addEventListener("change", () => {
  playbackRate = Number(playbackRateSelect.value);
});

worldCanvas.addEventListener("click", (event) => {
  if (!config.dronePresent) return;
  const rect = worldCanvas.getBoundingClientRect();
  state = {
    ...state,
    drone: {
      x: ((event.clientX - rect.left) / rect.width) * WORLD.width,
      y: ((event.clientY - rect.top) / rect.height) * WORLD.height,
    },
  };
  running = false;
  result = evaluateSimulation(state, config);
  addEvent("Drone moved manually");
  syncPlayButton();
  renderAll();
});

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remaining.toFixed(1).padStart(4, "0")}`;
}

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 0) return "0.0 s";
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
}

function statusCopy(status: SimulationResult["status"]): { label: string; map: string } {
  switch (status) {
    case "confirmed": return { label: "Confirmed drone signature", map: "Confirmed track" };
    case "possible": return { label: "Possible drone signature", map: "Analyzing signal" };
    case "jammed": return { label: "Acoustic channel jammed", map: "Interference detected" };
    case "spoof": return { label: "Suspected replay signal", map: "Spoof suspected" };
    default: return { label: "No confirmed signature", map: "Monitoring" };
  }
}

function updateStatusEvent(): void {
  if (result.status === previousStatus) return;
  const copy = statusCopy(result.status);
  const tone = result.status === "confirmed" ? "danger" : result.status === "clear" ? "neutral" : "warning";
  addEvent(copy.map, tone);
  previousStatus = result.status;
}

function renderMetrics(): void {
  const copy = statusCopy(result.status);
  setText("#threatLabel", copy.label);
  setText("#mapStatusText", copy.map);
  setText("#fusionOutput", `${Math.round(result.fusionConfidence * 100)}%`);
  setText("#ringValue", String(Math.round(result.fusionConfidence * 100)));
  setText("#distanceOutput", config.dronePresent ? `${Math.round(result.droneDistanceToTargetM)} m` : "None");
  setText("#marginOutput", formatSeconds(result.machineMarginS));
  const hasBearing = Number.isFinite(result.estimatedBearingDeg);
  setText("#bearingOutput", hasBearing ? `${Math.round(result.estimatedBearingDeg)}°` : "Unknown");
  setText("#bearingErrorOutput", hasBearing ? `±${result.bearingErrorDeg.toFixed(1)}° estimated` : "requires at least 2 nodes");
  setText("#syncOutput", `${result.arrayTimingErrorMs.toFixed(result.arrayTimingErrorMs < 0.1 ? 2 : 1)} ms`);
  setText("#syncDistanceOutput", `${result.arraySpatialErrorM.toFixed(result.arraySpatialErrorM < 0.1 ? 3 : 2)} m`);
  setText("#snrOutput", config.dronePresent ? `${result.snrDb.toFixed(1)} dB` : "—");
  setText("#etaOutput", formatSeconds(result.etaS));
  setText("#delayOutput", `${result.soundDelayS.toFixed(2)} s`);
  setText("#latencyOutput", `${result.systemLatencyS.toFixed(2)} s`);
  setText("#humanMarginOutput", formatSeconds(result.humanMarginS));
  setText("#elapsedOutput", formatClock(state.elapsedS));
  setText("#bpfBadge", `${Math.round(result.bladePassFrequencyHz)} Hz BPF`);

  const ring = requiredElement<HTMLElement>("#confidenceRing");
  ring.style.setProperty("--confidence", `${result.fusionConfidence * 360}deg`);
  const card = requiredElement<HTMLElement>("#threatCard");
  card.dataset.status = result.status;
  requiredElement<HTMLElement>("#mapStatus").dataset.status = result.status;

  const values = {
    acoustic: result.acousticProbability,
    radar: result.radarProbability,
    rf: result.rfProbability,
    camera: result.cameraProbability,
  };
  for (const [name, value] of Object.entries(values)) {
    setText(`#${name}Value`, `${Math.round(value * 100)}%`);
    requiredElement<HTMLElement>(`#${name}Meter`).style.width = `${value * 100}%`;
  }

  const spoofAlert = requiredElement<HTMLElement>("#spoofAlert");
  const showSpoof = result.spoofRisk > 0.35 || result.status === "jammed";
  spoofAlert.hidden = !showSpoof;
  if (showSpoof) {
    setText(
      "#spoofAlertText",
      result.status === "jammed"
        ? "The noise floor obscures the harmonic signature. Other sensors are required."
        : "The array's spatial data is not supported by radar, RF, or optical sensors.",
    );
  }
}

function canvasContext(canvas: HTMLCanvasElement): {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
} {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context unavailable");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width, height };
}

function drawWorld(): void {
  const { ctx, width, height } = canvasContext(worldCanvas);
  const sx = width / WORLD.width;
  const sy = height / WORLD.height;
  const x = (value: number) => value * sx;
  const y = (value: number) => value * sy;

  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#0c1b21");
  background.addColorStop(1, "#071116");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(153, 190, 187, 0.08)";
  ctx.lineWidth = 1;
  for (let gx = 0; gx <= WORLD.width; gx += 50) {
    ctx.beginPath(); ctx.moveTo(x(gx), 0); ctx.lineTo(x(gx), height); ctx.stroke();
  }
  for (let gy = 0; gy <= WORLD.height; gy += 50) {
    ctx.beginPath(); ctx.moveTo(0, y(gy)); ctx.lineTo(width, y(gy)); ctx.stroke();
  }

  if (config.scenario === "urban") {
    const buildings = [
      [315, 42, 74, 78], [430, 300, 94, 72], [500, 65, 62, 60], [295, 275, 62, 92],
    ];
    for (const [bx, by, bw, bh] of buildings) {
      ctx.fillStyle = "rgba(89, 110, 112, 0.2)";
      ctx.strokeStyle = "rgba(139, 167, 164, 0.2)";
      ctx.fillRect(x(bx), y(by), x(bw), y(bh));
      ctx.strokeRect(x(bx), y(by), x(bw), y(bh));
    }
  }

  const target = state.target;
  ctx.setLineDash([5, 6]);
  ctx.strokeStyle = "rgba(255, 185, 97, 0.34)";
  ctx.lineWidth = 1;
  for (const radius of [28, 50]) {
    ctx.beginPath(); ctx.arc(x(target.x), y(target.y), radius * Math.min(sx, sy), 0, Math.PI * 2); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffb45c";
  ctx.beginPath(); ctx.arc(x(target.x), y(target.y), 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#d8e5e3";
  ctx.font = "600 11px Inter, system-ui, sans-serif";
  ctx.fillText("PROTECTED ASSET", x(target.x) + 13, y(target.y) + 4);

  const visibleNodes = state.sensorNodes.slice(0, config.sensorCount);
  if (config.sensors.acoustic) {
    for (const node of visibleNodes) {
      const radius = Math.min(result.nominalAcousticRangeM, 240) * Math.min(sx, sy);
      const rangeGradient = ctx.createRadialGradient(x(node.x), y(node.y), 0, x(node.x), y(node.y), radius);
      rangeGradient.addColorStop(0, "rgba(83, 226, 191, 0.09)");
      rangeGradient.addColorStop(0.7, "rgba(83, 226, 191, 0.035)");
      rangeGradient.addColorStop(1, "rgba(83, 226, 191, 0)");
      ctx.fillStyle = rangeGradient;
      ctx.beginPath(); ctx.arc(x(node.x), y(node.y), radius, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(83, 226, 191, 0.18)";
      ctx.setLineDash([3, 6]);
      ctx.beginPath(); ctx.arc(x(node.x), y(node.y), radius, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  visibleNodes.forEach((node, index) => {
    ctx.save();
    ctx.translate(x(node.x), y(node.y));
    ctx.strokeStyle = "#53e2bf";
    ctx.fillStyle = "#0f2728";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(8, 7); ctx.lineTo(-8, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2); ctx.strokeStyle = "rgba(83, 226, 191, 0.25)"; ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "rgba(216, 229, 227, 0.75)";
    ctx.font = "500 10px Inter, system-ui, sans-serif";
    const nodePrefix = config.arrayMode === "hardware" ? "A" : "P";
    ctx.fillText(`${nodePrefix}${index + 1}`, x(node.x) + 12, y(node.y) - 11);
  });

  if (config.dronePresent) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    ctx.setLineDash([6, 8]);
    ctx.beginPath(); ctx.moveTo(x(state.drone.x), y(state.drone.y)); ctx.lineTo(x(target.x), y(target.y)); ctx.stroke();
    ctx.setLineDash([]);

    if (result.acousticProbability > 0.15 && config.sensors.acoustic) {
      const nearestNode = visibleNodes.reduce((best, node) =>
        Math.hypot(state.drone.x - node.x, state.drone.y - node.y) < Math.hypot(state.drone.x - best.x, state.drone.y - best.y) ? node : best,
      );
      ctx.strokeStyle = `rgba(83, 226, 191, ${0.16 + result.acousticProbability * 0.5})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x(nearestNode.x), y(nearestNode.y)); ctx.lineTo(x(state.drone.x), y(state.drone.y)); ctx.stroke();
    }

    const angle = Math.atan2(target.y - state.drone.y, target.x - state.drone.x);
    ctx.save();
    ctx.translate(x(state.drone.x), y(state.drone.y));
    ctx.rotate(angle);
    ctx.strokeStyle = "#ff746d";
    ctx.fillStyle = "rgba(255, 116, 109, 0.12)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(10, 0); ctx.moveTo(0, -10); ctx.lineTo(0, 10); ctx.stroke();
    for (const [dx, dy] of [[-9, -9], [9, -9], [-9, 9], [9, 9]]) {
      ctx.beginPath(); ctx.arc(dx, dy, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = "#ff746d";
    ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#ffb1ac";
    ctx.font = "600 10px Inter, system-ui, sans-serif";
    ctx.fillText(`${DRONE_PROFILES[config.profile].label} · ${Math.round(config.altitudeM)} m`, x(state.drone.x) + 18, y(state.drone.y) - 14);
  }

  if (config.spoofMode !== "none") {
    const source = state.spoofSource;
    ctx.save();
    ctx.translate(x(source.x), y(source.y));
    ctx.strokeStyle = "#bf8cff";
    ctx.fillStyle = "rgba(191, 140, 255, 0.15)";
    ctx.lineWidth = 2;
    ctx.fillRect(-7, -7, 14, 14); ctx.strokeRect(-7, -7, 14, 14);
    for (const radius of [14, 22]) {
      ctx.beginPath(); ctx.arc(0, 0, radius, -0.8, 0.8); ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = "#d8baff";
    ctx.font = "600 10px Inter, system-ui, sans-serif";
    ctx.fillText(config.spoofMode === "replay" ? "REPLAY" : "NOISE SOURCE", x(source.x) + 15, y(source.y) - 10);
  }

  ctx.fillStyle = "rgba(216, 229, 227, 0.42)";
  ctx.font = "500 9px ui-monospace, SFMono-Regular, monospace";
  ctx.fillText("700 m", width - 42, height - 12);
}

function drawSpectrum(): void {
  const { ctx, width, height } = canvasContext(spectrumCanvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#081418";
  ctx.fillRect(0, 0, width, height);
  const left = 35;
  const bottom = height - 23;
  const usableWidth = width - left - 12;
  const usableHeight = height - 34;
  ctx.strokeStyle = "rgba(153, 190, 187, 0.11)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const py = 8 + (usableHeight / 4) * i;
    ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(width - 8, py); ctx.stroke();
  }
  for (let i = 0; i <= 4; i += 1) {
    const px = left + (usableWidth / 4) * i;
    ctx.beginPath(); ctx.moveTo(px, 8); ctx.lineTo(px, bottom); ctx.stroke();
    ctx.fillStyle = "rgba(216, 229, 227, 0.4)";
    ctx.font = "9px ui-monospace, SFMono-Regular, monospace";
    ctx.fillText(`${i * 500}`, px - 8, height - 7);
  }

  const noiseLevel = Math.min(0.8, Math.max(0.08, (result.effectiveNoiseDb - 25) / 75));
  ctx.strokeStyle = "rgba(191, 140, 255, 0.58)";
  ctx.beginPath();
  for (let px = left; px <= width - 8; px += 2) {
    const wave = Math.sin(px * 0.19 + state.elapsedS * 2) * 3 + Math.sin(px * 0.047) * 2;
    const py = bottom - noiseLevel * usableHeight * 0.36 - wave;
    if (px === left) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();

  if (config.dronePresent || config.spoofMode === "replay") {
    const maxFrequency = 2000;
    const base = result.bladePassFrequencyHz;
    for (let harmonic = 1; harmonic <= 10; harmonic += 1) {
      const frequency = base * harmonic;
      if (frequency > maxFrequency) break;
      const px = left + (frequency / maxFrequency) * usableWidth;
      const strength = Math.max(0.08, result.acousticProbability * (1 / harmonic ** 0.58));
      const peakHeight = usableHeight * strength * 0.88;
      const gradient = ctx.createLinearGradient(0, bottom - peakHeight, 0, bottom);
      gradient.addColorStop(0, "rgba(83, 226, 191, 0.95)");
      gradient.addColorStop(1, "rgba(83, 226, 191, 0.08)");
      ctx.fillStyle = gradient;
      ctx.fillRect(px - 2, bottom - peakHeight, 4, peakHeight);
    }
  }
}

function renderAll(): void {
  renderMetrics();
  drawWorld();
  drawSpectrum();
}

function animate(timestamp: number): void {
  const rawDelta = Math.min(0.05, (timestamp - previousTimestamp) / 1000);
  previousTimestamp = timestamp;
  if (running) {
    state = stepSimulation(state, config, rawDelta * playbackRate);
    result = evaluateSimulation(state, config);
    updateStatusEvent();
  }
  renderAll();
  requestAnimationFrame(animate);
}

type AppViewId = "simulator" | "soundLab" | "experiment" | "statistics";

const viewElements: Record<AppViewId, HTMLElement> = {
  simulator: requiredElement("#simulatorView"),
  soundLab: requiredElement("#soundLabView"),
  experiment: requiredElement("#experimentView"),
  statistics: requiredElement("#statisticsView"),
};

function selectView(view: AppViewId): void {
  for (const [id, element] of Object.entries(viewElements)) {
    element.hidden = id !== view;
  }
  document.querySelectorAll<HTMLButtonElement>(".view-tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  if (view === "soundLab") drawLabSpectrum();
  if (view === "experiment") drawExperiment();
  if (view === "statistics") void loadStatistics();
}

document.querySelectorAll<HTMLButtonElement>(".view-tab").forEach((button) => {
  button.addEventListener("click", () => selectView(button.dataset.view as AppViewId));
});

const statisticsColors: Record<DroneProfileId, string> = {
  camera: "#53e2bf",
  fpv: "#ff746d",
  fixedWing: "#ffb45c",
  combustion: "#bf8cff",
};
let statisticsReport: HeadlessReport | undefined;
let statisticsPromise: Promise<void> | undefined;

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function drawChartFrame(
  canvas: HTMLCanvasElement,
  maximum: number,
  yFormatter: (value: number) => string,
): { ctx: CanvasRenderingContext2D; left: number; top: number; width: number; height: number } {
  const { ctx, width, height } = canvasContext(canvas);
  ctx.clearRect(0, 0, width, height);
  const plot = { left: 48, top: 18, width: width - 66, height: height - 52 };
  ctx.font = "9px JetBrains Mono, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let step = 0; step <= 4; step += 1) {
    const value = maximum * step / 4;
    const y = plot.top + plot.height - plot.height * step / 4;
    ctx.strokeStyle = "rgba(153,190,187,.12)";
    ctx.beginPath(); ctx.moveTo(plot.left, y); ctx.lineTo(plot.left + plot.width, y); ctx.stroke();
    ctx.fillStyle = "#78918f";
    ctx.fillText(yFormatter(value), plot.left - 8, y);
  }
  return { ctx, ...plot };
}

function drawDetectionStatistics(): void {
  if (!statisticsReport) return;
  const detectorId = requiredElement<HTMLSelectElement>("#statisticsDetector").value;
  const environment = requiredElement<HTMLSelectElement>("#statisticsEnvironment").value;
  const metric = requiredElement<HTMLSelectElement>("#statisticsMetric").value as DetectionMetric;
  const rows = rowsForEnvironment(statisticsReport, environment, detectorId);
  const distances = [...new Set(rows.map((row) => row.distanceM))].sort((a, b) => a - b);
  const canvas = requiredElement<HTMLCanvasElement>("#statisticsDetectionCanvas");
  const { ctx, left, top, width, height } = drawChartFrame(canvas, 1, percent);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  distances.forEach((distanceM, index) => {
    const x = left + width * index / Math.max(1, distances.length - 1);
    ctx.fillStyle = "#78918f";
    ctx.fillText(`${distanceM} m`, x, top + height + 10);
  });
  for (const profile of Object.keys(DRONE_PROFILES) as DroneProfileId[]) {
    const profileRows = rows.filter((row) => row.profile === profile)
      .sort((a, b) => a.distanceM - b.distanceM);
    ctx.strokeStyle = statisticsColors[profile];
    ctx.fillStyle = statisticsColors[profile];
    ctx.lineWidth = 2;
    ctx.beginPath();
    profileRows.forEach((row, index) => {
      const x = left + width * distances.indexOf(row.distanceM) / Math.max(1, distances.length - 1);
      const y = top + height * (1 - row[metric]);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    profileRows.forEach((row) => {
      const x = left + width * distances.indexOf(row.distanceM) / Math.max(1, distances.length - 1);
      const y = top + height * (1 - row[metric]);
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
    });
  }
}

function drawDetectorCurve(): void {
  if (!statisticsReport) return;
  const detectorId = requiredElement<HTMLSelectElement>("#statisticsDetector").value;
  const model = modelFor(statisticsReport, detectorId);
  const canvas = requiredElement<HTMLCanvasElement>("#statisticsCurveCanvas");
  const { ctx, left, top, width, height } = drawChartFrame(canvas, 1, percent);
  if (!model) return;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let step = 0; step <= 4; step += 1) {
    const threshold = step / 4;
    const x = left + width * threshold;
    ctx.fillStyle = "#78918f";
    ctx.fillText(threshold.toFixed(2), x, top + height + 10);
  }
  for (const [key, color] of [["precision", "#53e2bf"], ["recall", "#ff746d"]] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    model.curve.forEach((point, index) => {
      const x = left + width * point.threshold;
      const y = top + height * (1 - point[key]);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  const thresholdX = left + width * model.threshold;
  ctx.strokeStyle = "#ffb45c";
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(thresholdX, top); ctx.lineTo(thresholdX, top + height); ctx.stroke();
  ctx.setLineDash([]);
}

function drawLocalizationStatistics(): void {
  if (!statisticsReport) return;
  const rows = statisticsReport.localization;
  const maximum = Math.max(5, ...rows.map((row) => row.p90ErrorM)) * 1.08;
  const canvas = requiredElement<HTMLCanvasElement>("#statisticsLocalizationCanvas");
  const { ctx, left, top, width, height } = drawChartFrame(canvas, maximum, (value) => `${value.toFixed(0)} m`);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  rows.forEach((row, index) => {
    const x = left + width * index / Math.max(1, rows.length - 1);
    ctx.fillStyle = "#78918f";
    ctx.fillText(`${String(row.timingJitterMs)} ms`, x, top + height + 10);
  });
  for (const [key, color] of [["medianErrorM", "#53e2bf"], ["p90ErrorM", "#ffb45c"]] as const) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    rows.forEach((row, index) => {
      const x = left + width * index / Math.max(1, rows.length - 1);
      const y = top + height * (1 - row[key] / maximum);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    rows.forEach((row, index) => {
      const x = left + width * index / Math.max(1, rows.length - 1);
      const y = top + height * (1 - row[key] / maximum);
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
    });
  }
}

function renderStatistics(): void {
  if (!statisticsReport) return;
  const detectorId = requiredElement<HTMLSelectElement>("#statisticsDetector").value;
  const environment = requiredElement<HTMLSelectElement>("#statisticsEnvironment").value;
  const metric = requiredElement<HTMLSelectElement>("#statisticsMetric").value as DetectionMetric;
  const model = modelFor(statisticsReport, detectorId);
  const rows = rowsForEnvironment(statisticsReport, environment, detectorId);
  const profileComparison = compareProfiles(statisticsReport, environment, metric, detectorId);
  const falseAlarmRows = model?.falseAlarms ?? statisticsReport.falseAlarms;
  const falseAlarm = falseAlarmRows.find((row) => row.environment === environment);
  setText("#statisticsGenerated", new Date(statisticsReport.generatedAt).toLocaleString("en-GB"));
  setText("#statisticsSeed", `Seed ${statisticsReport.seed} · ${statisticsReport.configuration.trialsPerDroneCondition} trials per condition`);
  const gatePassed = model?.qualityGate?.passed;
  setText("#statisticsQualityGate", model?.qualityGate ? (gatePassed ? "PASSED" : "FAILED") : "BASELINE");
  requiredElement("#statisticsGateCard").dataset.status = gatePassed ? "passed" : model?.qualityGate ? "failed" : "baseline";
  setText("#statisticsRecall", model ? percent(model.overall.recall) : percent(statisticsMean(rows.map((row) => row.detectionRate))));
  setText("#statisticsFalseAlarm", percent(falseAlarm?.falsePositiveRate ?? 0));
  setText("#statisticsF1", model ? percent(model.overall.f1) : "—");
  setText("#statisticsThresholdBadge", model ? `THRESHOLD ${model.threshold.toFixed(2)}` : "V1 REPORT");
  setText(
    "#statisticsDetectionTitle",
    metric === "detectionRate" ? "Detection rate by drone type" : "Correct detection + type",
  );
  requiredElement("#statisticsProfileLegend").innerHTML = profileComparison.map((item) =>
    `<span><i style="--series:${statisticsColors[item.profile]}"></i>${item.label}</span>`
  ).join("");
  requiredElement<HTMLTableSectionElement>("#statisticsRankingBody").innerHTML = profileComparison.map((item) => {
    const profileRows = rows.filter((row) => row.profile === item.profile);
    const values = profileRows.map((row) => row[metric]);
    return `<tr><td><i class="table-series" style="--series:${statisticsColors[item.profile]}"></i>${item.label}</td><td>${percent(item.average)}</td><td>${percent(Math.max(...values))}</td><td>${percent(Math.min(...values))}</td></tr>`;
  }).join("");
  requiredElement<HTMLTableSectionElement>("#statisticsLocalizationBody").innerHTML = statisticsReport.localization.map((row) =>
    `<tr><td>${String(row.timingJitterMs)} ms</td><td>${row.medianErrorM.toFixed(1)} m</td><td>${row.p90ErrorM.toFixed(1)} m</td><td>${percent(row.within5MRate)}</td><td>${row.p90BearingErrorDeg.toFixed(1)}°</td></tr>`
  ).join("");
  if (model) {
    setText("#statisticsTp", String(model.overall.truePositive));
    setText("#statisticsFp", String(model.overall.falsePositive));
    setText("#statisticsTn", String(model.overall.trueNegative));
    setText("#statisticsFn", String(model.overall.falseNegative));
  }
  const failures = (statisticsReport.failures ?? []).filter((failure) => failure.detectorId === detectorId);
  setText("#statisticsFailureCount", `${failures.length} SHOWN`);
  requiredElement<HTMLTableSectionElement>("#statisticsFailureBody").innerHTML = failures.length > 0
    ? failures.slice(0, 12).map((failure) =>
      `<tr><td>${failure.failureKind === "false-positive" ? "False alarm" : "Miss"}</td><td>${failure.sourceLabel}</td><td>${failure.environment}</td><td>${percent(failure.probability)}</td></tr>`
    ).join("")
    : `<tr><td colspan="4">No saved failures for the selected detector.</td></tr>`;
  requiredElement<HTMLTableSectionElement>("#statisticsDetectorComparisonBody").innerHTML = (statisticsReport.models ?? []).map((item) =>
    `<tr><td>${item.label}</td><td>${item.isDefault ? "Yes" : "No"}</td><td>${percent(item.overall.precision)}</td><td>${percent(item.overall.recall)}</td><td>${percent(item.overall.falsePositiveRate)}</td><td>${percent(item.overall.f1)}</td><td>${item.prAuc.toFixed(3)}</td><td>${item.qualityGate ? (item.qualityGate.passed ? "Passed" : "Failed") : "Baseline"}</td></tr>`
  ).join("");
  requiredElement("#statisticsCaveats").innerHTML = statisticsReport.caveats
    .map((caveat) => `<li>${caveat}</li>`).join("");
  drawDetectionStatistics();
  drawLocalizationStatistics();
  drawDetectorCurve();
}

async function loadStatistics(): Promise<void> {
  if (statisticsReport) {
    renderStatistics();
    return;
  }
  statisticsPromise ??= (async () => {
    const loading = requiredElement("#statisticsLoading");
    try {
      const response = await fetch("/reports/headless/summary.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      statisticsReport = await response.json() as HeadlessReport;
      const defaultModel = statisticsReport.models?.find((model) => model.isDefault);
      if (defaultModel) requiredElement<HTMLSelectElement>("#statisticsDetector").value = defaultModel.id;
      loading.hidden = true;
      requiredElement("#statisticsContent").hidden = false;
      renderStatistics();
    } catch (error) {
      loading.textContent = `The report could not be loaded (${String(error)}). Run npm run simulate.`;
      statisticsPromise = undefined;
    }
  })();
  await statisticsPromise;
}

requiredElement<HTMLSelectElement>("#statisticsDetector").addEventListener("change", renderStatistics);
requiredElement<HTMLSelectElement>("#statisticsEnvironment").addEventListener("change", renderStatistics);
requiredElement<HTMLSelectElement>("#statisticsMetric").addEventListener("change", renderStatistics);
window.addEventListener("resize", () => {
  if (!viewElements.statistics.hidden && statisticsReport) renderStatistics();
});

const labSampleSelect = requiredElement<HTMLSelectElement>("#labSampleSelect");
for (const sample of AUDIO_SAMPLES) {
  labSampleSelect.add(new Option(sample.label, sample.id));
}
const labRpmInput = requiredElement<HTMLInputElement>("#labRpmInput");
const labDetectorSelect = requiredElement<HTMLSelectElement>("#labDetectorSelect");
const labSpectrumCanvas = requiredElement<HTMLCanvasElement>("#labSpectrumCanvas");
const realAudioCache = new Map<string, Awaited<ReturnType<typeof loadMonoPcm>>>();
let labResult: DetectorResult | undefined;
let labDetectorOutput: DetectorOutput | undefined;
let labInputMode: "sample" | "microphone" = "sample";
let microphoneTruthForResult: TrialTruth = "drone";
const initialDspDetector = new DspDetectorAdapter();
let detectorAdapters = new Map<string, DetectorAdapter>([[initialDspDetector.id, initialDspDetector]]);
let selectedDetector: DetectorAdapter = initialDspDetector;

void loadDetectorSuite().then((suite) => {
  detectorAdapters = new Map<string, DetectorAdapter>([
    [suite.dsp.id, suite.dsp],
    [suite.ml.id, suite.ml],
  ]);
  selectedDetector = suite.defaultDetector;
  labDetectorSelect.value = selectedDetector.id;
  const gate = suite.ml.artifact.qualityGate;
  setText(
    "#labDetectorStatus",
    gate.passed
      ? "ML passed the quality gate and is the default."
      : `ML is experimental: FPR ${Math.round(suite.ml.artifact.testMetrics.falsePositiveRate * 100)}%, recall ${Math.round(suite.ml.artifact.testMetrics.recall * 100)}%. DSP is the default.`,
  );
}).catch((error) => {
  setText("#labDetectorStatus", `ML could not be loaded: ${String(error)}. DSP is in use.`);
});

function syncLabSample(): void {
  labInputMode = "sample";
  const sample = getAudioSample(labSampleSelect.value);
  setText("#labSampleNote", sample.note);
  setText("#labSourceLabel", sample.sourceLabel);
  setText("#labLicense", `License: ${sample.license}`);
  const sourceLink = requiredElement<HTMLAnchorElement>("#labSourceLink");
  sourceLink.hidden = !sample.sourceUrl;
  sourceLink.href = sample.sourceUrl ?? "#";
  requiredElement<HTMLElement>("#labRpmField").hidden = sample.kind === "real";
  setText("#labTruth", "Hidden until analysis");
  setText("#labVerdict", "The detector is tested without label leakage.");
  labResult = undefined;
  labDetectorOutput = undefined;
  renderLabResult();
}

async function getLabPcm(): Promise<{
  samples: Float32Array;
  sampleRate: number;
  buffer?: AudioBuffer;
}> {
  const sample = getAudioSample(labSampleSelect.value);
  const rpmShift = Number(labRpmInput.value);
  if (sample.kind === "synthetic") {
    return {
      samples: generateDronePcm(sample.expectedProfile as DroneProfileId, 4, 16000, rpmShift),
      sampleRate: 16000,
    };
  }
  if (sample.kind === "ambient") {
    return { samples: generateAmbientPcm(4), sampleRate: 16000 };
  }
  if (!sample.localUrl) throw new Error("The audio sample has no local file");
  let loaded = realAudioCache.get(sample.id);
  if (!loaded) {
    loaded = await loadMonoPcm(sample.localUrl);
    realAudioCache.set(sample.id, loaded);
  }
  const maxSamples = Math.min(loaded.samples.length, loaded.sampleRate * 8);
  return {
    samples: loaded.samples.slice(0, maxSamples),
    sampleRate: loaded.sampleRate,
    buffer: loaded.buffer,
  };
}

function renderLabResult(): void {
  if (!labResult || !labDetectorOutput) {
    setText("#labDetectionTitle", "Waiting for analysis");
    setText("#labDetectionBadge", "NO DATA");
    setText("#labConfidence", "—");
    setText("#labFundamental", "—");
    setText("#labHarmonic", "—");
    setText("#labFrames", "—");
    requiredElement<HTMLOListElement>("#labClassifications").innerHTML = "<li>No analysis completed</li>";
    setText("#labEventJson", "{ }");
    drawLabSpectrum();
    return;
  }
  setText("#labDetectionTitle", labDetectorOutput.detected ? "Drone signature detected" : "No stable drone signature");
  setText("#labDetectionBadge", labDetectorOutput.detected ? "DETECTED" : "NEGATIVE");
  setText("#labConfidence", `${Math.round(labDetectorOutput.probability * 100)}%`);
  setText("#labFundamental", `${Math.round(labResult.fundamentalHz)} Hz`);
  setText("#labHarmonic", `${labResult.harmonicScoreDb.toFixed(1)} dB`);
  setText("#labFrames", `${labDetectorOutput.positiveWindows}/${labDetectorOutput.analyzedWindows}`);
  requiredElement<HTMLOListElement>("#labClassifications").innerHTML = labDetectorOutput.classifications
    .map((item, index) => `<li><span>${index + 1}. ${item.label}</span><strong>${Math.round(item.confidence * 100)}%</strong></li>`)
    .join("");
  const event = createAcousticEvent("P1", labResult, labDetectorOutput);
  const track = fuseSingleNodeEvent(event);
  setText("#labEventJson", JSON.stringify({ event, fusedTrack: track }, null, 2));
  const sample = getAudioSample(labSampleSelect.value);
  const truthLabel = labInputMode === "microphone"
    ? microphoneTruthForResult === "drone" ? "Drone audio via microphone" : "Background / interference via microphone"
    : sample.expectedProfile === "ambient"
      ? "Background / no drone"
      : DRONE_PROFILES[sample.expectedProfile].label;
  const topProfile = labDetectorOutput.classifications[0]?.profile;
  const correct = labInputMode === "microphone"
    ? labDetectorOutput.detected === (microphoneTruthForResult === "drone")
    : topProfile === sample.expectedProfile ||
      (sample.expectedProfile === "ambient" && !labDetectorOutput.detected);
  setText("#labTruth", truthLabel);
  setText("#labVerdict", correct ? "The listener matched the ground truth." : "The listener did not match the ground truth — an important negative result.");
  drawLabSpectrum();
}

function drawLabSpectrum(): void {
  const { ctx, width, height } = canvasContext(labSpectrumCanvas);
  ctx.fillStyle = "#071216";
  ctx.fillRect(0, 0, width, height);
  const left = 42;
  const bottom = height - 26;
  const top = 12;
  const maxHz = 4000;
  ctx.strokeStyle = "rgba(153,190,187,.12)";
  ctx.fillStyle = "rgba(216,229,227,.42)";
  ctx.font = "9px ui-monospace, monospace";
  for (let hz = 0; hz <= maxHz; hz += 1000) {
    const px = left + (hz / maxHz) * (width - left - 12);
    ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
    ctx.fillText(String(hz), px - 9, height - 8);
  }
  if (!labResult) {
    ctx.fillStyle = "rgba(216,229,227,.32)";
    ctx.font = "12px system-ui";
    ctx.fillText("Run a blind analysis to display the FFT spectrum", left, height / 2);
    return;
  }
  const spectrum = labResult.spectrumDb;
  const binHz = labResult.spectrumSampleRate / (spectrum.length * 2);
  const visibleBins = Math.min(spectrum.length, Math.floor(maxHz / binHz));
  const minDb = Math.min(...spectrum.slice(0, visibleBins));
  const maxDb = Math.max(...spectrum.slice(0, visibleBins));
  ctx.strokeStyle = "#53e2bf";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let bin = 1; bin < visibleBins; bin += 1) {
    const px = left + (bin / visibleBins) * (width - left - 12);
    const normalized = (spectrum[bin] - minDb) / Math.max(1, maxDb - minDb);
    const py = bottom - normalized * (bottom - top);
    if (bin === 1) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();
  if (labResult.fundamentalHz > 0) {
    const px = left + (labResult.fundamentalHz / maxHz) * (width - left - 12);
    ctx.strokeStyle = "#ffb45c";
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
    ctx.setLineDash([]);
  }
}

labSampleSelect.addEventListener("change", syncLabSample);
labRpmInput.addEventListener("input", () => {
  setText("#labRpmOutput", `${Number(labRpmInput.value) > 0 ? "+" : ""}${labRpmInput.value}%`);
  labResult = undefined;
  labDetectorOutput = undefined;
  renderLabResult();
});
labDetectorSelect.addEventListener("change", () => {
  selectedDetector = detectorAdapters.get(labDetectorSelect.value) ?? initialDspDetector;
  labResult = undefined;
  labDetectorOutput = undefined;
  renderLabResult();
});
requiredElement<HTMLButtonElement>("#labPlayButton").addEventListener("click", async () => {
  const button = requiredElement<HTMLButtonElement>("#labPlayButton");
  button.disabled = true;
  try {
    const sample = getAudioSample(labSampleSelect.value);
    const pcm = await getLabPcm();
    if (pcm.buffer) await playAudioBuffer(pcm.buffer);
    else if (sample.kind === "synthetic") {
      await playDroneMixture([sample.expectedProfile as DroneProfileId], Number(labRpmInput.value));
    } else await playPcm(pcm.samples, pcm.sampleRate);
  } finally {
    window.setTimeout(() => { button.disabled = false; }, 500);
  }
});
requiredElement<HTMLButtonElement>("#labAnalyzeButton").addEventListener("click", async () => {
  const button = requiredElement<HTMLButtonElement>("#labAnalyzeButton");
  button.disabled = true;
  button.textContent = "Analyzing…";
  try {
    const pcm = await getLabPcm();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
    labResult = analyzePcm(pcm.samples, pcm.sampleRate);
    const detector = selectedDetector ?? detectorAdapters.get("dsp-v1");
    if (!detector) throw new Error("The detector is still loading");
    labDetectorOutput = await detector.analyze(pcm.samples, pcm.sampleRate);
    setText(
      "#labDetectorStatus",
      labDetectorOutput.fallbackReason
        ? `Fallback: ${labDetectorOutput.fallbackReason}`
        : `${labDetectorOutput.detectorLabel} · ${labDetectorOutput.latencyMs.toFixed(1)} ms`,
    );
    renderLabResult();
  } catch (error) {
    setText("#labDetectionTitle", error instanceof Error ? error.message : "Analysis failed");
  } finally {
    button.disabled = false;
    button.textContent = "Analyze blind";
  }
});

const microphoneTruth = requiredElement<HTMLSelectElement>("#microphoneTruth");
const microphoneCaptureButton = requiredElement<HTMLButtonElement>("#microphoneCaptureButton");
const microphoneDownloadButton = requiredElement<HTMLButtonElement>("#microphoneDownloadButton");
const microphoneResetButton = requiredElement<HTMLButtonElement>("#microphoneResetButton");
let microphoneTrials: MicrophoneTrial[] = [];

function formatOptionalRate(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function renderMicrophoneTrials(): void {
  const metrics = summarizeTrials(microphoneTrials);
  setText("#microphoneTrialCount", String(metrics.total));
  setText("#microphoneRecall", formatOptionalRate(metrics.recall));
  setText("#microphoneFpr", formatOptionalRate(metrics.falsePositiveRate));
  microphoneDownloadButton.disabled = metrics.total === 0;
  microphoneResetButton.disabled = metrics.total === 0;
  const body = requiredElement<HTMLTableSectionElement>("#microphoneTrialBody");
  if (microphoneTrials.length === 0) {
    body.innerHTML = '<tr><td colspan="6">No trials yet</td></tr>';
    return;
  }
  body.innerHTML = [...microphoneTrials].reverse().map((trial) => {
    const correct = trial.detected === (trial.truth === "drone");
    return `<tr data-verdict="${correct ? "correct" : "incorrect"}">
      <td>${trial.id}</td>
      <td>${trial.truth === "drone" ? "Drone" : "Background"}</td>
      <td>${trial.detected ? "Detected" : "Negative"}</td>
      <td>${Math.round(trial.probability * 100)}%</td>
      <td>${trial.topLabel}</td>
      <td>${trial.latencyMs.toFixed(1)} ms</td>
    </tr>`;
  }).join("");
}

function microphoneTrialsCsv(): string {
  const rows = [
    ["trial", "captured_at", "truth", "detected", "probability", "latency_ms", "rms", "top_label"],
    ...microphoneTrials.map((trial) => [
      trial.id,
      trial.capturedAt,
      trial.truth,
      trial.detected,
      trial.probability,
      trial.latencyMs,
      trial.rms,
      trial.topLabel,
    ]),
  ];
  return rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
}

microphoneCaptureButton.addEventListener("click", async () => {
  const truth = microphoneTruth.value as TrialTruth;
  const detector = selectedDetector ?? detectorAdapters.get("dsp-v1");
  if (!detector) return;
  microphoneCaptureButton.disabled = true;
  microphoneTruth.disabled = true;
  setText("#microphoneBadge", "REQUESTING ACCESS");
  setText("#microphoneStatus", "Allow microphone access. Recording begins only after permission is granted.");
  try {
    const capture = await captureMicrophone(5000, () => {
      setText("#microphoneBadge", "PLAY NOW · 5 S");
      setText("#microphoneStatus", "The microphone is listening — play the drone or background audio from the computer now.");
    });
    setText("#microphoneBadge", "ANALYZING");
    labInputMode = "microphone";
    microphoneTruthForResult = truth;
    labResult = analyzePcm(capture.samples, capture.sampleRate);
    labDetectorOutput = await detector.analyze(capture.samples, capture.sampleRate);
    const topLabel = labDetectorOutput.classifications[0]?.label ?? "Unknown";
    const trial: MicrophoneTrial = {
      id: microphoneTrials.length + 1,
      capturedAt: new Date().toISOString(),
      truth,
      detected: labDetectorOutput.detected,
      probability: labDetectorOutput.probability,
      latencyMs: labDetectorOutput.latencyMs,
      rms: capture.rms,
      topLabel,
    };
    microphoneTrials.push(trial);
    const correct = trial.detected === (truth === "drone");
    const dbFs = 20 * Math.log10(Math.max(1e-7, capture.rms));
    setText("#microphoneRms", `${dbFs.toFixed(1)} dBFS`);
    setText("#microphoneBadge", correct ? "MATCH" : "MISMATCH");
    setText(
      "#microphoneStatus",
      `${correct ? "The result matched the ground truth" : "The result did not match the ground truth"}: ${trial.detected ? "drone detected" : "no drone detected"}. ${Math.round(capture.durationMs)} ms of audio at ${capture.sampleRate} Hz was analyzed locally.`,
    );
    renderLabResult();
    renderMicrophoneTrials();
  } catch (error) {
    setText("#microphoneBadge", "ERROR");
    setText("#microphoneStatus", microphoneErrorMessage(error));
  } finally {
    microphoneCaptureButton.disabled = false;
    microphoneTruth.disabled = false;
  }
});

microphoneResetButton.addEventListener("click", () => {
  microphoneTrials = [];
  setText("#microphoneBadge", "READY");
  setText("#microphoneStatus", "The session has been reset. No raw audio was saved.");
  setText("#microphoneRms", "—");
  renderMicrophoneTrials();
});

microphoneDownloadButton.addEventListener("click", () => {
  const blob = new Blob([microphoneTrialsCsv()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `drones-microphone-trials-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
});

const experimentCanvas = requiredElement<HTMLCanvasElement>("#experimentCanvas");
const experimentListeners: ListenerNode[] = [
  { id: "P1", position: { x: 80, y: 80 }, clockOffsetMs: 3.2, clockDriftPpm: 18 },
  { id: "P2", position: { x: 610, y: 90 }, clockOffsetMs: -2.1, clockDriftPpm: -12 },
  { id: "P3", position: { x: 270, y: 360 }, clockOffsetMs: 5.4, clockDriftPpm: 24 },
];
let experimentSource = { x: 390, y: 220 };
let pendingExperiment: LocalizationResult | undefined;
let visibleExperiment: LocalizationResult | undefined;

function syncExperimentInputs(): void {
  requiredElement<HTMLInputElement>("#sourceXInput").value = String(Math.round(experimentSource.x));
  requiredElement<HTMLInputElement>("#sourceYInput").value = String(Math.round(experimentSource.y));
}

function resetExperiment(): void {
  pendingExperiment = undefined;
  visibleExperiment = undefined;
  requiredElement<HTMLButtonElement>("#localizeButton").disabled = true;
  setText("#experimentStatus", "NOT CALIBRATED");
  setText("#experimentError", "—");
  setText("#experimentBearing", "—");
  setText("#experimentResidual", "—");
  setText("#experimentAltitude", "Unknown");
  requiredElement<HTMLOListElement>("#clockCorrections").innerHTML = "<li>No session created</li>";
  drawExperiment();
}

function drawExperiment(): void {
  const { ctx, width, height } = canvasContext(experimentCanvas);
  const sx = width / WORLD.width;
  const sy = height / WORLD.height;
  const px = (x: number) => x * sx;
  const py = (y: number) => y * sy;
  ctx.fillStyle = "#071216";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(153,190,187,.1)";
  for (let x = 0; x <= WORLD.width; x += 50) {
    ctx.beginPath(); ctx.moveTo(px(x), 0); ctx.lineTo(px(x), height); ctx.stroke();
  }
  for (let y = 0; y <= WORLD.height; y += 50) {
    ctx.beginPath(); ctx.moveTo(0, py(y)); ctx.lineTo(width, py(y)); ctx.stroke();
  }
  ctx.strokeStyle = "rgba(83,226,191,.25)";
  ctx.setLineDash([5, 6]);
  ctx.beginPath();
  experimentListeners.forEach((listener, index) => {
    if (index === 0) ctx.moveTo(px(listener.position.x), py(listener.position.y));
    else ctx.lineTo(px(listener.position.x), py(listener.position.y));
  });
  ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
  experimentListeners.forEach((listener) => {
    ctx.fillStyle = "#53e2bf";
    ctx.beginPath(); ctx.arc(px(listener.position.x), py(listener.position.y), 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#dce8e6"; ctx.font = "600 11px system-ui";
    ctx.fillText(listener.id, px(listener.position.x) + 12, py(listener.position.y) - 10);
  });
  ctx.fillStyle = "#ff746d";
  ctx.beginPath(); ctx.arc(px(experimentSource.x), py(experimentSource.y), 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#ffb1ac"; ctx.fillText("GROUND TRUTH", px(experimentSource.x) + 12, py(experimentSource.y) - 10);
  if (visibleExperiment) {
    const estimate = visibleExperiment.estimatedPosition;
    const radius = Math.max(8, 12 + visibleExperiment.errorM) * Math.min(sx, sy);
    ctx.fillStyle = "rgba(255,180,92,.12)";
    ctx.strokeStyle = "#ffb45c";
    ctx.beginPath(); ctx.arc(px(estimate.x), py(estimate.y), radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px(estimate.x) - 9, py(estimate.y)); ctx.lineTo(px(estimate.x) + 9, py(estimate.y));
    ctx.moveTo(px(estimate.x), py(estimate.y) - 9); ctx.lineTo(px(estimate.x), py(estimate.y) + 9); ctx.stroke();
    ctx.fillStyle = "#ffe0b8"; ctx.fillText("ESTIMATE", px(estimate.x) + 13, py(estimate.y) + 18);
  }
}

experimentCanvas.addEventListener("click", (event) => {
  const rect = experimentCanvas.getBoundingClientRect();
  experimentSource = {
    x: ((event.clientX - rect.left) / rect.width) * WORLD.width,
    y: ((event.clientY - rect.top) / rect.height) * WORLD.height,
  };
  syncExperimentInputs();
  resetExperiment();
});
for (const [selector, key] of [["#sourceXInput", "x"], ["#sourceYInput", "y"]] as const) {
  requiredElement<HTMLInputElement>(selector).addEventListener("change", (event) => {
    experimentSource[key] = Number((event.currentTarget as HTMLInputElement).value);
    resetExperiment();
  });
}
requiredElement<HTMLButtonElement>("#calibrateButton").addEventListener("click", () => {
  pendingExperiment = analyzeOfflineTrial(experimentListeners, experimentSource, WORLD);
  visibleExperiment = undefined;
  requiredElement<HTMLButtonElement>("#localizeButton").disabled = false;
  setText("#experimentStatus", "CALIBRATED");
  requiredElement<HTMLOListElement>("#clockCorrections").innerHTML = pendingExperiment.observations
    .map((item) => `<li><span>${item.nodeId}</span><strong>${item.clockCorrectionMs >= 0 ? "+" : ""}${item.clockCorrectionMs.toFixed(2)} ms</strong></li>`)
    .join("");
  drawExperiment();
});
requiredElement<HTMLButtonElement>("#localizeButton").addEventListener("click", () => {
  if (!pendingExperiment) return;
  visibleExperiment = pendingExperiment;
  setText("#experimentStatus", "2D TRACK LOCKED");
  setText("#experimentError", `${visibleExperiment.errorM.toFixed(1)} m`);
  setText("#experimentBearing", `${Math.round(visibleExperiment.bearingDeg)}°`);
  setText("#experimentResidual", `${visibleExperiment.residualMs.toFixed(3)} ms`);
  setText("#experimentAltitude", "Unknown · 3 coplanar nodes");
  setText("#experimentCount", String(visibleExperiment.sourceCount));
  drawExperiment();
});

syncLabSample();
syncExperimentInputs();
resetExperiment();

syncControls();
addEvent(`Scenario loaded: ${SCENARIOS.quiet.label}`);
syncPlayButton();
renderAll();
requestAnimationFrame(animate);
