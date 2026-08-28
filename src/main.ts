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
import { createAcousticEvent, fuseSingleNodeEvent } from "./events";
import {
  analyzeOfflineTrial,
  type ListenerNode,
  type LocalizationResult,
} from "./localization";
import { AUDIO_SAMPLES, getAudioSample } from "./samples";
import {
  compareProfiles,
  mean as statisticsMean,
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
    <nav class="view-tabs" aria-label="Arbetsläge">
      <button class="view-tab is-active" data-view="simulator" type="button">Stadssimulering</button>
      <button class="view-tab" data-view="soundLab" type="button">Ljudlabb</button>
      <button class="view-tab" data-view="experiment" type="button">Flertelefonstest</button>
      <button class="view-tab" data-view="statistics" type="button">Statistik</button>
    </nav>
    <div class="model-notice">
      <span class="notice-dot"></span>
      Simulerad uppskattning · ej operativt system
    </div>
  </header>

  <section id="simulatorView" class="app-view">
  <main class="workspace">
    <aside class="panel control-panel" aria-label="Simuleringskontroller">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Scenario</p>
          <h2>Konfiguration</h2>
        </div>
        <span class="step-label">01</span>
      </div>

      <label class="field">
        <span>Förinställning</span>
        <select id="scenarioSelect"></select>
      </label>
      <p id="scenarioDescription" class="field-help"></p>

      <div class="section-rule"></div>
      <p class="section-kicker">Farkost</p>

      <label class="field">
        <span>Drönarprofil</span>
        <select id="profileSelect"></select>
      </label>

      <label class="range-field">
        <span><span>Hastighet</span><output id="speedOutput"></output></span>
        <input id="speedInput" type="range" min="20" max="220" step="1" />
      </label>
      <label class="range-field">
        <span><span>Höjd</span><output id="altitudeOutput"></output></span>
        <input id="altitudeInput" type="range" min="5" max="250" step="1" />
      </label>
      <label class="range-field">
        <span><span>RPM-förskjutning</span><output id="rpmOutput"></output></span>
        <input id="rpmInput" type="range" min="-35" max="35" step="1" />
      </label>
      <label class="check-row">
        <span>Aktiv radiolänk</span>
        <input id="radioActive" type="checkbox" />
      </label>

      <div class="section-rule"></div>
      <p class="section-kicker">Miljö & störning</p>

      <label class="range-field">
        <span><span>Vind</span><output id="windOutput"></output></span>
        <input id="windInput" type="range" min="0" max="20" step="0.5" />
      </label>
      <label class="range-field">
        <span><span>Bakgrundsljud</span><output id="ambientOutput"></output></span>
        <input id="ambientInput" type="range" min="30" max="85" step="1" />
      </label>
      <label class="range-field">
        <span><span>Sikt</span><output id="visibilityOutput"></output></span>
        <input id="visibilityInput" type="range" min="0.1" max="1" step="0.05" />
      </label>
      <label class="field">
        <span>Akustisk attack</span>
        <select id="spoofMode">
          <option value="none">Ingen</option>
          <option value="replay">Replay från högtalare</option>
          <option value="broadband">Bredbandig maskering</option>
        </select>
      </label>
      <label class="range-field">
        <span><span>Störningsnivå</span><output id="spoofOutput"></output></span>
        <input id="spoofInput" type="range" min="55" max="115" step="1" />
      </label>
    </aside>

    <section class="simulation-column">
      <div class="simulation-toolbar">
        <div class="transport-controls">
          <button id="playButton" class="primary-button" type="button">
            <span id="playIcon" aria-hidden="true">▶</span>
            <span id="playLabel">Starta</span>
          </button>
          <button id="resetButton" class="icon-button" type="button" aria-label="Återställ scenario">↺</button>
        </div>
        <div class="toolbar-readout">
          <span>Simtid</span>
          <strong id="elapsedOutput">00:00.0</strong>
        </div>
        <label class="compact-field">
          <span>Tempo</span>
          <select id="playbackRate">
            <option value="0.5">0,5×</option>
            <option value="1" selected>1×</option>
            <option value="2">2×</option>
            <option value="4">4×</option>
          </select>
        </label>
      </div>

      <div class="map-shell">
        <canvas id="worldCanvas" aria-label="Karta över det simulerade skyddsområdet"></canvas>
        <div class="map-status" id="mapStatus">
          <span class="status-pulse"></span>
          <span id="mapStatusText">Övervakar</span>
        </div>
        <div class="map-hint">Klicka på kartan för att flytta drönaren</div>
        <div class="map-legend" aria-label="Kartförklaring">
          <span><i class="legend-drone"></i> Drönare</span>
          <span><i class="legend-sensor"></i> Sensornod</span>
          <span><i class="legend-target"></i> Skyddsobjekt</span>
        </div>
      </div>

      <div class="analysis-grid">
        <section class="subpanel signal-panel">
          <div class="subpanel-heading">
            <div>
              <p class="eyebrow">Akustisk signatur</p>
              <h3>Harmonisk analys</h3>
            </div>
            <span id="bpfBadge" class="data-badge">— Hz BPF</span>
          </div>
          <canvas id="spectrumCanvas" aria-label="Simulerat frekvensspektrum"></canvas>
          <div class="signal-footer">
            <span><i class="signal-key signal-key--drone"></i> Rotorsignatur</span>
            <span><i class="signal-key signal-key--noise"></i> Brusgolv</span>
          </div>
        </section>

        <section class="subpanel event-panel">
          <div class="subpanel-heading">
            <div>
              <p class="eyebrow">Systemlogg</p>
              <h3>Senaste händelser</h3>
            </div>
            <span class="live-tag">Live</span>
          </div>
          <ol id="eventLog" class="event-log" aria-live="polite"></ol>
        </section>
      </div>
    </section>

    <aside class="panel telemetry-panel" aria-label="Sensorresultat">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Sensorfusion</p>
          <h2>Lägesbild</h2>
        </div>
        <span class="step-label">02</span>
      </div>

      <section class="threat-card" id="threatCard">
        <div>
          <p id="threatLabel">Ingen bekräftad signatur</p>
          <strong id="fusionOutput">0%</strong>
        </div>
        <div class="confidence-ring" id="confidenceRing"><span id="ringValue">0</span></div>
      </section>

      <div class="metric-grid">
        <article class="metric-card">
          <span>Avstånd</span>
          <strong id="distanceOutput">—</strong>
          <small>till skyddsobjekt</small>
        </article>
        <article class="metric-card metric-card--accent">
          <span>Maskintid</span>
          <strong id="marginOutput">—</strong>
          <small>efter systemlatens</small>
        </article>
        <article class="metric-card">
          <span>Riktning</span>
          <strong id="bearingOutput">—</strong>
          <small id="bearingErrorOutput">ingen låsning</small>
        </article>
        <article class="metric-card">
          <span>SNR</span>
          <strong id="snrOutput">—</strong>
          <small>drönare mot brus</small>
        </article>
      </div>

      <div class="section-rule"></div>
      <div class="sensor-title-row">
        <p class="section-kicker">Sensorbidrag</p>
        <label class="node-select">Noder <select id="sensorCount"><option>1</option><option>2</option><option>3</option></select></label>
      </div>

      <label class="field array-field">
        <span>Akustiskt nät</span>
        <select id="arrayMode"></select>
      </label>
      <div class="array-readout">
        <span>Tidsfel <strong id="syncOutput">—</strong></span>
        <span>Rumsligt fel <strong id="syncDistanceOutput">—</strong></span>
      </div>

      <div class="sensor-stack">
        <article class="sensor-row">
          <label><input id="toggleAcoustic" type="checkbox" /> Akustik</label>
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
          <label><input id="toggleCamera" type="checkbox" /> Kamera/IR</label>
          <strong id="cameraValue">0%</strong>
          <div class="meter"><span id="cameraMeter"></span></div>
        </article>
      </div>
      <p class="sensor-note">ADS‑B är ett separat flygtranspondersystem. Remote ID kan sända drönarens och, beroende på typ, kontrollstationens position via Wi‑Fi/Bluetooth.</p>

      <div class="section-rule"></div>
      <p class="section-kicker">Tidsbudget</p>
      <div class="timeline-card">
        <div class="timeline-row"><span>Beräknad ankomst</span><strong id="etaOutput">—</strong></div>
        <div class="timeline-row"><span>Ljudfördröjning</span><strong id="delayOutput">—</strong></div>
        <div class="timeline-row"><span>Systemlatens</span><strong id="latencyOutput">—</strong></div>
        <div class="timeline-row timeline-row--total"><span>Efter mänskligt beslut</span><strong id="humanMarginOutput">—</strong></div>
      </div>

      <div id="spoofAlert" class="spoof-alert" hidden>
        <span aria-hidden="true">◇</span>
        <div><strong>Inkonsistent ljudkälla</strong><p id="spoofAlertText"></p></div>
      </div>
    </aside>
  </main>
  </section>

  <section id="soundLabView" class="app-view lab-view" hidden>
    <div class="lab-page-heading">
      <div><p class="eyebrow">Blind signalanalys</p><h2>Spela en ljudbild. Testa lyssnaren.</h2></div>
      <p>Spelaren känner facit. Detektorn får bara PCM-data och kan inte läsa filnamn eller etikett.</p>
    </div>
    <div class="lab-layout">
      <aside class="lab-card lab-controls">
        <p class="section-kicker">01 · Välj källa</p>
        <label class="field"><span>Ljudprov</span><select id="labSampleSelect"></select></label>
        <p id="labSampleNote" class="field-help"></p>
        <label class="range-field" id="labRpmField">
          <span><span>RPM-förskjutning</span><output id="labRpmOutput">0%</output></span>
          <input id="labRpmInput" type="range" min="-30" max="30" step="1" value="0" />
        </label>
        <div class="button-stack">
          <button id="labPlayButton" class="primary-button wide-button" type="button">▶ Spela ljudbild</button>
          <button id="labAnalyzeButton" class="secondary-button" type="button">Analysera blint</button>
        </div>
        <div class="license-box">
          <span>Proveniens</span>
          <strong id="labSourceLabel">—</strong>
          <a id="labSourceLink" href="#" target="_blank" rel="noreferrer">Öppna källa</a>
          <small id="labLicense">—</small>
        </div>
      </aside>

      <main class="lab-card lab-analysis">
        <div class="subpanel-heading">
          <div><p class="eyebrow">Lyssnarens resultat</p><h3 id="labDetectionTitle">Väntar på analys</h3></div>
          <span id="labDetectionBadge" class="data-badge">INGEN DATA</span>
        </div>
        <canvas id="labSpectrumCanvas" aria-label="FFT-spektrum från valt ljudprov"></canvas>
        <div class="detector-metrics">
          <article><span>Konfidens</span><strong id="labConfidence">—</strong></article>
          <article><span>Grundton</span><strong id="labFundamental">—</strong></article>
          <article><span>Harmonik</span><strong id="labHarmonic">—</strong></article>
          <article><span>Positiva fönster</span><strong id="labFrames">—</strong></article>
        </div>
        <div class="classification-block">
          <p class="section-kicker">Klassificering · topp 3</p>
          <ol id="labClassifications" class="classification-list"><li>Ingen analys genomförd</li></ol>
        </div>
      </main>

      <aside class="lab-card event-inspector">
        <p class="section-kicker">02 · Metadata till backend</p>
        <p class="sensor-note">Endast features och sannolikheter lämnar lyssnaren. Ingen PCM eller WAV ingår.</p>
        <pre id="labEventJson" class="event-json">{ }</pre>
        <div class="truth-card">
          <span>Facit</span>
          <strong id="labTruth">Dolt tills analys</strong>
          <small id="labVerdict">Detektorn testas utan etikettläckage.</small>
        </div>
      </aside>
    </div>
  </section>

  <section id="experimentView" class="app-view lab-view" hidden>
    <div class="lab-page-heading">
      <div><p class="eyebrow">Offline TDOA</p><h2>Tre lyssnare. En rörlig ljudkälla.</h2></div>
      <p>Simulera tre separata inspelningar, korrigera telefonklockorna och lokalisera källan i 2D.</p>
    </div>
    <div class="experiment-layout">
      <aside class="lab-card experiment-controls">
        <p class="section-kicker">Sessionens roller</p>
        <div class="role-list">
          <article><i class="role-dot role-dot--source"></i><div><strong>Källtelefon</strong><small>Kalibreringssignal + drönarljud</small></div></article>
          <article><i class="role-dot"></i><div><strong>P1–P3 Lyssnare</strong><small>PCM + lokala tidsstämplar</small></div></article>
          <article><i class="role-dot role-dot--backend"></i><div><strong>Sammanställare</strong><small>Synkning, TDOA och spår</small></div></article>
        </div>
        <label class="field"><span>Källans X-position</span><input id="sourceXInput" type="number" min="0" max="700" value="390" /></label>
        <label class="field"><span>Källans Y-position</span><input id="sourceYInput" type="number" min="0" max="420" value="220" /></label>
        <div class="button-stack">
          <button id="calibrateButton" class="secondary-button" type="button">1. Skapa & kalibrera session</button>
          <button id="localizeButton" class="primary-button wide-button" type="button" disabled>2. Synka & lokalisera</button>
        </div>
        <p class="sensor-note">Klicka på kartan för att flytta källans facit. Höjd lämnas okänd med tre plana noder.</p>
      </aside>

      <main class="lab-card experiment-map-card">
        <div class="subpanel-heading">
          <div><p class="eyebrow">Rumskarta · meter</p><h3>Facit och akustisk uppskattning</h3></div>
          <span id="experimentStatus" class="data-badge">EJ KALIBRERAD</span>
        </div>
        <canvas id="experimentCanvas" aria-label="Karta över tre telefoner och ljudkälla"></canvas>
        <div class="experiment-legend">
          <span><i class="truth-dot"></i> Facit</span>
          <span><i class="estimate-dot"></i> Uppskattning</span>
          <span><i class="phone-dot"></i> Lyssnare</span>
        </div>
      </main>

      <aside class="lab-card experiment-results">
        <p class="section-kicker">Resultat</p>
        <div class="result-stack">
          <article><span>2D-fel</span><strong id="experimentError">—</strong></article>
          <article><span>Riktning från array</span><strong id="experimentBearing">—</strong></article>
          <article><span>Residual</span><strong id="experimentResidual">—</strong></article>
          <article><span>Höjd</span><strong id="experimentAltitude">Okänd</strong></article>
          <article><span>Antal källor</span><strong id="experimentCount">1</strong></article>
        </div>
        <p class="section-kicker correction-title">Klockkorrigering</p>
        <ol id="clockCorrections" class="classification-list"><li>Ingen session skapad</li></ol>
        <div class="warning-box">För höjd krävs minst en ytterligare lyssnare på annan nivå. Resultatet visar därför aldrig en fabricerad höjd.</div>
      </aside>
    </div>
  </section>

  <section id="statisticsView" class="app-view lab-view statistics-view" hidden>
    <div class="lab-page-heading">
      <div><p class="eyebrow">Headless Monte Carlo</p><h2>Jämför detektion och lokalisering</h2></div>
      <p>Reproducerbara körningar med fast slumpfrö. Syntetiska avstånd är regressionsdata, inte fältverifierad räckvidd.</p>
    </div>

    <div class="statistics-toolbar lab-card">
      <label class="field"><span>Brusmiljö</span><select id="statisticsEnvironment">
        <option value="quiet">Tyst</option>
        <option value="urban">Stad</option>
        <option value="loud-structured">Högt + strukturerat ljud</option>
      </select></label>
      <label class="field"><span>Jämförelsemått</span><select id="statisticsMetric">
        <option value="detectionRate">Detektionsgrad</option>
        <option value="top1Accuracy">Korrekt detektion + typ</option>
      </select></label>
      <div class="statistics-run-info">
        <span>Senaste körning</span>
        <strong id="statisticsGenerated">Laddar…</strong>
        <small id="statisticsSeed">—</small>
      </div>
      <div class="statistics-downloads">
        <a href="/reports/headless/summary.json" download>JSON</a>
        <a href="/reports/headless/detection.csv" download>Detektion CSV</a>
        <a href="/reports/headless/localization.csv" download>Position CSV</a>
      </div>
    </div>

    <div id="statisticsLoading" class="statistics-loading">Läser headless-rapport…</div>
    <div id="statisticsContent" hidden>
      <div class="statistics-kpis">
        <article><span>Riktiga ljudprov</span><strong id="statisticsRealSamples">—</strong><small>korrekt detekterade och typade</small></article>
        <article><span>Genomsnittlig detektion</span><strong id="statisticsDetectionMean">—</strong><small>vald miljö, alla avstånd</small></article>
        <article><span>Falsklarm</span><strong id="statisticsFalseAlarm">—</strong><small>vald bakgrund utan drönare</small></article>
        <article><span>Position p90</span><strong id="statisticsLocalizationP90">—</strong><small>vid 0,5 ms tidsjitter</small></article>
      </div>

      <div class="statistics-chart-grid">
        <section class="lab-card statistics-chart-card">
          <div class="subpanel-heading"><div><p class="eyebrow">Avståndsjämförelse</p><h3 id="statisticsDetectionTitle">Detektionsgrad per drönartyp</h3></div><span class="data-badge">MONTE CARLO</span></div>
          <canvas id="statisticsDetectionCanvas" aria-label="Jämförelse av detektion per avstånd och drönartyp"></canvas>
          <div id="statisticsProfileLegend" class="chart-legend"></div>
        </section>
        <section class="lab-card statistics-chart-card">
          <div class="subpanel-heading"><div><p class="eyebrow">Tidsnoggrannhet</p><h3>2D-fel mot kvarvarande tidsjitter</h3></div><span class="data-badge">3 TELEFONER</span></div>
          <canvas id="statisticsLocalizationCanvas" aria-label="Jämförelse av positioneringsfel mot tidsjitter"></canvas>
          <div class="chart-legend"><span><i style="--series:#53e2bf"></i>Median</span><span><i style="--series:#ffb45c"></i>p90</span></div>
        </section>
      </div>

      <div class="statistics-table-grid">
        <section class="lab-card">
          <div class="subpanel-heading"><div><p class="eyebrow">Ranking</p><h3>Drönartyper i vald miljö</h3></div></div>
          <div class="table-scroll"><table class="statistics-table"><thead><tr><th>Typ</th><th>Genomsnitt</th><th>Bäst</th><th>Sämst</th></tr></thead><tbody id="statisticsRankingBody"></tbody></table></div>
        </section>
        <section class="lab-card">
          <div class="subpanel-heading"><div><p class="eyebrow">Synkronisering</p><h3>Positioneringsjämförelse</h3></div></div>
          <div class="table-scroll"><table class="statistics-table"><thead><tr><th>Jitter</th><th>Median</th><th>p90</th><th>≤ 5 m</th><th>Riktningsfel p90</th></tr></thead><tbody id="statisticsLocalizationBody"></tbody></table></div>
        </section>
      </div>

      <div class="statistics-caveat lab-card">
        <strong>Så ska statistiken läsas</strong>
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
  addEvent(`Scenario laddat: ${SCENARIOS[id].label}`);
  syncControls();
  syncPlayButton();
  renderAll();
}

function syncPlayButton(): void {
  setText("#playLabel", running ? "Pausa" : "Starta");
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
  addEvent(config.spoofMode === "none" ? "Akustisk störning avstängd" : "Akustisk störkälla aktiverad", config.spoofMode === "none" ? "neutral" : "warning");
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
  addEvent(`Akustiskt nät: ${ARRAY_MODES[config.arrayMode].label}`, config.arrayMode === "hardware" ? "neutral" : "warning");
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
  addEvent(running ? "Simulering startad" : "Simulering pausad");
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
  addEvent("Drönaren flyttades manuellt");
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
  if (seconds < 0) return "0,0 s";
  return `${seconds.toFixed(seconds < 10 ? 1 : 0).replace(".", ",")} s`;
}

function statusCopy(status: SimulationResult["status"]): { label: string; map: string } {
  switch (status) {
    case "confirmed": return { label: "Bekräftad drönarsignatur", map: "Bekräftat spår" };
    case "possible": return { label: "Möjlig drönarsignatur", map: "Analyserar signal" };
    case "jammed": return { label: "Akustisk kanal störd", map: "Störning upptäckt" };
    case "spoof": return { label: "Misstänkt replay-signal", map: "Spoof misstänkt" };
    default: return { label: "Ingen bekräftad signatur", map: "Övervakar" };
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
  setText("#distanceOutput", config.dronePresent ? `${Math.round(result.droneDistanceToTargetM)} m` : "Ingen");
  setText("#marginOutput", formatSeconds(result.machineMarginS));
  const hasBearing = Number.isFinite(result.estimatedBearingDeg);
  setText("#bearingOutput", hasBearing ? `${Math.round(result.estimatedBearingDeg)}°` : "Okänd");
  setText("#bearingErrorOutput", hasBearing ? `±${result.bearingErrorDeg.toFixed(1)}° beräknat` : "kräver minst 2 noder");
  setText("#syncOutput", `${result.arrayTimingErrorMs.toFixed(result.arrayTimingErrorMs < 0.1 ? 2 : 1).replace(".", ",")} ms`);
  setText("#syncDistanceOutput", `${result.arraySpatialErrorM.toFixed(result.arraySpatialErrorM < 0.1 ? 3 : 2).replace(".", ",")} m`);
  setText("#snrOutput", config.dronePresent ? `${result.snrDb.toFixed(1)} dB` : "—");
  setText("#etaOutput", formatSeconds(result.etaS));
  setText("#delayOutput", `${result.soundDelayS.toFixed(2).replace(".", ",")} s`);
  setText("#latencyOutput", `${result.systemLatencyS.toFixed(2).replace(".", ",")} s`);
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
        ? "Brusgolvet döljer den harmoniska signaturen. Andra sensorer krävs."
        : "Arrayens rumsliga data saknar stöd från radar, RF och optik.",
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
  ctx.fillText("SKYDDSOBJEKT", x(target.x) + 13, y(target.y) + 4);

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
    ctx.fillText(config.spoofMode === "replay" ? "REPLAY" : "BRUSKÄLLA", x(source.x) + 15, y(source.y) - 10);
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
  return `${(value * 100).toFixed(1).replace(".", ",")}%`;
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
  const environment = requiredElement<HTMLSelectElement>("#statisticsEnvironment").value;
  const metric = requiredElement<HTMLSelectElement>("#statisticsMetric").value as DetectionMetric;
  const rows = rowsForEnvironment(statisticsReport, environment);
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
    ctx.fillText(`${String(row.timingJitterMs).replace(".", ",")} ms`, x, top + height + 10);
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
  const environment = requiredElement<HTMLSelectElement>("#statisticsEnvironment").value;
  const metric = requiredElement<HTMLSelectElement>("#statisticsMetric").value as DetectionMetric;
  const rows = rowsForEnvironment(statisticsReport, environment);
  const profileComparison = compareProfiles(statisticsReport, environment, metric);
  const falseAlarm = statisticsReport.falseAlarms.find((row) => row.environment === environment);
  const localizationAtHalfMs = statisticsReport.localization.find((row) => row.timingJitterMs === 0.5);
  setText("#statisticsGenerated", new Date(statisticsReport.generatedAt).toLocaleString("sv-SE"));
  setText("#statisticsSeed", `Frö ${statisticsReport.seed} · ${statisticsReport.configuration.trialsPerDroneCondition} försök per villkor`);
  setText(
    "#statisticsRealSamples",
    `${statisticsReport.realSamples.filter((sample) => sample.correct).length}/${statisticsReport.realSamples.length}`,
  );
  setText("#statisticsDetectionMean", percent(statisticsMean(rows.map((row) => row.detectionRate))));
  setText("#statisticsFalseAlarm", percent(falseAlarm?.falsePositiveRate ?? 0));
  setText("#statisticsLocalizationP90", `${localizationAtHalfMs?.p90ErrorM.toFixed(1).replace(".", ",") ?? "—"} m`);
  setText(
    "#statisticsDetectionTitle",
    metric === "detectionRate" ? "Detektionsgrad per drönartyp" : "Korrekt detektion + typ",
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
    `<tr><td>${String(row.timingJitterMs).replace(".", ",")} ms</td><td>${row.medianErrorM.toFixed(1).replace(".", ",")} m</td><td>${row.p90ErrorM.toFixed(1).replace(".", ",")} m</td><td>${percent(row.within5MRate)}</td><td>${row.p90BearingErrorDeg.toFixed(1).replace(".", ",")}°</td></tr>`
  ).join("");
  requiredElement("#statisticsCaveats").innerHTML = statisticsReport.caveats
    .map((caveat) => `<li>${caveat}</li>`).join("");
  drawDetectionStatistics();
  drawLocalizationStatistics();
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
      loading.hidden = true;
      requiredElement("#statisticsContent").hidden = false;
      renderStatistics();
    } catch (error) {
      loading.textContent = `Ingen rapport kunde läsas (${String(error)}). Kör npm run simulate.`;
      statisticsPromise = undefined;
    }
  })();
  await statisticsPromise;
}

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
const labSpectrumCanvas = requiredElement<HTMLCanvasElement>("#labSpectrumCanvas");
const realAudioCache = new Map<string, Awaited<ReturnType<typeof loadMonoPcm>>>();
let labResult: DetectorResult | undefined;

function syncLabSample(): void {
  const sample = getAudioSample(labSampleSelect.value);
  setText("#labSampleNote", sample.note);
  setText("#labSourceLabel", sample.sourceLabel);
  setText("#labLicense", `Licens: ${sample.license}`);
  const sourceLink = requiredElement<HTMLAnchorElement>("#labSourceLink");
  sourceLink.hidden = !sample.sourceUrl;
  sourceLink.href = sample.sourceUrl ?? "#";
  requiredElement<HTMLElement>("#labRpmField").hidden = sample.kind === "real";
  setText("#labTruth", "Dolt tills analys");
  setText("#labVerdict", "Detektorn testas utan etikettläckage.");
  labResult = undefined;
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
  if (!sample.localUrl) throw new Error("Ljudprovet saknar lokal fil");
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
  if (!labResult) {
    setText("#labDetectionTitle", "Väntar på analys");
    setText("#labDetectionBadge", "INGEN DATA");
    setText("#labConfidence", "—");
    setText("#labFundamental", "—");
    setText("#labHarmonic", "—");
    setText("#labFrames", "—");
    requiredElement<HTMLOListElement>("#labClassifications").innerHTML = "<li>Ingen analys genomförd</li>";
    setText("#labEventJson", "{ }");
    drawLabSpectrum();
    return;
  }
  setText("#labDetectionTitle", labResult.detected ? "Harmonisk drönarsignatur hittad" : "Ingen stabil drönarsignatur");
  setText("#labDetectionBadge", labResult.detected ? "DETEKTERAD" : "NEGATIV");
  setText("#labConfidence", `${Math.round(labResult.confidence * 100)}%`);
  setText("#labFundamental", `${Math.round(labResult.fundamentalHz)} Hz`);
  setText("#labHarmonic", `${labResult.harmonicScoreDb.toFixed(1)} dB`);
  setText("#labFrames", `${labResult.positiveFrames}/${labResult.analyzedFrames}`);
  requiredElement<HTMLOListElement>("#labClassifications").innerHTML = labResult.classifications
    .map((item, index) => `<li><span>${index + 1}. ${item.label}</span><strong>${Math.round(item.confidence * 100)}%</strong></li>`)
    .join("");
  const event = createAcousticEvent("P1", labResult);
  const track = fuseSingleNodeEvent(event);
  setText("#labEventJson", JSON.stringify({ event, fusedTrack: track }, null, 2));
  const sample = getAudioSample(labSampleSelect.value);
  const truthLabel = sample.expectedProfile === "ambient"
    ? "Bakgrund / ingen drönare"
    : DRONE_PROFILES[sample.expectedProfile].label;
  const topProfile = labResult.classifications[0]?.profile;
  const correct = topProfile === sample.expectedProfile ||
    (sample.expectedProfile === "ambient" && !labResult.detected);
  setText("#labTruth", truthLabel);
  setText("#labVerdict", correct ? "Lyssnaren matchade facit." : "Lyssnaren matchade inte facit — ett viktigt negativt resultat.");
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
    ctx.fillText("Kör en blind analys för att visa FFT-spektrum", left, height / 2);
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
  button.textContent = "Analyserar…";
  try {
    const pcm = await getLabPcm();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 30));
    labResult = analyzePcm(pcm.samples, pcm.sampleRate);
    renderLabResult();
  } catch (error) {
    setText("#labDetectionTitle", error instanceof Error ? error.message : "Analysen misslyckades");
  } finally {
    button.disabled = false;
    button.textContent = "Analysera blint";
  }
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
  setText("#experimentStatus", "EJ KALIBRERAD");
  setText("#experimentError", "—");
  setText("#experimentBearing", "—");
  setText("#experimentResidual", "—");
  setText("#experimentAltitude", "Okänd");
  requiredElement<HTMLOListElement>("#clockCorrections").innerHTML = "<li>Ingen session skapad</li>";
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
  ctx.fillStyle = "#ffb1ac"; ctx.fillText("FACIT", px(experimentSource.x) + 12, py(experimentSource.y) - 10);
  if (visibleExperiment) {
    const estimate = visibleExperiment.estimatedPosition;
    const radius = Math.max(8, 12 + visibleExperiment.errorM) * Math.min(sx, sy);
    ctx.fillStyle = "rgba(255,180,92,.12)";
    ctx.strokeStyle = "#ffb45c";
    ctx.beginPath(); ctx.arc(px(estimate.x), py(estimate.y), radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px(estimate.x) - 9, py(estimate.y)); ctx.lineTo(px(estimate.x) + 9, py(estimate.y));
    ctx.moveTo(px(estimate.x), py(estimate.y) - 9); ctx.lineTo(px(estimate.x), py(estimate.y) + 9); ctx.stroke();
    ctx.fillStyle = "#ffe0b8"; ctx.fillText("UPPSKATTNING", px(estimate.x) + 13, py(estimate.y) + 18);
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
  setText("#experimentStatus", "KALIBRERAD");
  requiredElement<HTMLOListElement>("#clockCorrections").innerHTML = pendingExperiment.observations
    .map((item) => `<li><span>${item.nodeId}</span><strong>${item.clockCorrectionMs >= 0 ? "+" : ""}${item.clockCorrectionMs.toFixed(2)} ms</strong></li>`)
    .join("");
  drawExperiment();
});
requiredElement<HTMLButtonElement>("#localizeButton").addEventListener("click", () => {
  if (!pendingExperiment) return;
  visibleExperiment = pendingExperiment;
  setText("#experimentStatus", "2D-SPÅR LÅST");
  setText("#experimentError", `${visibleExperiment.errorM.toFixed(1).replace(".", ",")} m`);
  setText("#experimentBearing", `${Math.round(visibleExperiment.bearingDeg)}°`);
  setText("#experimentResidual", `${visibleExperiment.residualMs.toFixed(3).replace(".", ",")} ms`);
  setText("#experimentAltitude", "Okänd · 3 noder i plan");
  setText("#experimentCount", String(visibleExperiment.sourceCount));
  drawExperiment();
});

syncLabSample();
syncExperimentInputs();
resetExperiment();

syncControls();
addEvent(`Scenario laddat: ${SCENARIOS.quiet.label}`);
syncPlayButton();
renderAll();
requestAnimationFrame(animate);
