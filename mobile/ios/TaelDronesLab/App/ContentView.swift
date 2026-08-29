import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var state: AppState
    @State private var showEnrollment = false

    var body: some View {
        TabView {
            NavigationStack { ListenView() }
                .tabItem { Label("Listen", systemImage: "waveform") }
            NavigationStack { SoundsView() }
                .tabItem { Label("Sounds", systemImage: "speaker.wave.2") }
            NavigationStack { SessionView() }
                .tabItem { Label("Session", systemImage: "iphone.gen3.radiowaves.left.and.right") }
            NavigationStack { SettingsView() }
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .tint(.orange)
        .onAppear { showEnrollment = !state.api.isEnrolled }
        .onChange(of: state.api.isEnrolled) { enrolled in showEnrollment = !enrolled }
        .sheet(isPresented: $showEnrollment) { EnrollmentView() }
        .alert("Drones Lab", isPresented: Binding(get: { state.message != nil }, set: { if !$0 { state.message = nil } })) {
            Button("OK", role: .cancel) { state.message = nil }
        } message: { Text(state.message ?? "") }
    }
}

private struct StatusPill: View {
    let title: String
    let active: Bool
    var body: some View {
        Text(title).font(.caption.bold()).padding(.horizontal, 10).padding(.vertical, 6)
            .background(active ? Color.orange.opacity(0.18) : Color.secondary.opacity(0.12))
            .foregroundStyle(active ? .orange : .secondary).clipShape(Capsule())
    }
}

struct ListenView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    StatusPill(title: state.detection.listening ? "LISTENING" : "STOPPED", active: state.detection.listening)
                    Spacer()
                    StatusPill(title: state.consensusDetected ? "DRONE 2/3+" : "NO CONSENSUS", active: state.consensusDetected)
                }
                SpectrumView(values: state.detection.spectrum, level: state.detection.level)
                    .frame(height: 170)
                Button {
                    state.detection.listening ? state.stopListening() : state.startListening()
                } label: {
                    Label(state.detection.listening ? "Stop listening" : "Start listening",
                          systemImage: state.detection.listening ? "stop.fill" : "mic.fill")
                        .frame(maxWidth: .infinity).padding()
                }
                .buttonStyle(.borderedProminent).tint(state.detection.listening ? .red : .orange)
                .disabled(state.role == .source || state.soundPlayer.playing != nil)

                if state.role == .source {
                    Text("This phone is the session Source. Source devices cannot listen.").font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(DetectorID.allCases) { id in
                    let result = state.detection.results.first { $0.detectorId == id }
                    DetectorCard(id: id, result: result)
                }
                GroupBox("Capture metadata") {
                    LabeledContent("Inference windows", value: "\(state.detection.inferenceCount)")
                    LabeledContent("Upload queue", value: "\(state.api.pendingCount)")
                    LabeledContent("Location", value: state.location.permission)
                    if let location = state.location.latest {
                        LabeledContent("GPS accuracy", value: String(format: "%.0f m", location.horizontalAccuracyM))
                    }
                }
                if let error = state.detection.lastError { Text(error).foregroundStyle(.red).font(.footnote) }
                Text("Experimental acoustic classification only. Detection ranges are not field-validated operational ranges.")
                    .font(.footnote).foregroundStyle(.secondary)
            }.padding()
        }
        .navigationTitle("Acoustic listener")
    }
}

private struct DetectorCard: View {
    let id: DetectorID
    let result: DetectorResult?
    var body: some View {
        GroupBox {
            HStack {
                VStack(alignment: .leading) {
                    Text(id.label).font(.headline)
                    Text(result.map { "\($0.positiveWindows)/\($0.analyzedWindows) positive windows" } ?? "Waiting for audio")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text(result.map { String(format: "%.0f%%", $0.probability * 100) } ?? "—").font(.title3.monospacedDigit())
            }
            if let result {
                ProgressView(value: result.probability).tint(result.detected ? .orange : .blue)
                Text(String(format: "Threshold %.0f%% · %.0f ms", result.threshold * 100, result.latencyMs))
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}

private struct SpectrumView: View {
    let values: [Float]
    let level: Float
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                RoundedRectangle(cornerRadius: 16).fill(Color.black.opacity(0.92))
                Path { path in
                    guard values.count > 1 else { return }
                    let displayed = Array(values.prefix(320))
                    for (index, value) in displayed.enumerated() {
                        let x = geometry.size.width * CGFloat(index) / CGFloat(displayed.count - 1)
                        let normalized = min(1, max(0, (CGFloat(value) + 100) / 100))
                        let y = geometry.size.height * (1 - normalized)
                        index == 0 ? path.move(to: CGPoint(x: x, y: y)) : path.addLine(to: CGPoint(x: x, y: y))
                    }
                }.stroke(.orange, lineWidth: 1.5)
                VStack { Spacer(); ProgressView(value: level).tint(.green).padding() }
            }
        }
    }
}

struct SoundsView: View {
    @EnvironmentObject private var state: AppState
    var body: some View {
        List {
            Section("Playback library") {
                ForEach(SoundFixture.all) { fixture in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            VStack(alignment: .leading) { Text(fixture.title); Text(fixture.detail).font(.caption).foregroundStyle(.secondary) }
                            Spacer()
                            Text(fixture.expected.rawValue.uppercased()).font(.caption.bold()).foregroundStyle(fixture.expected == .drone ? .orange : .green)
                        }
                        HStack {
                            Button("Play locally") { state.playStandalone(fixture) }.buttonStyle(.bordered)
                            if state.role == .source, state.sessionId != nil {
                                Button("Schedule test") { Task { await state.schedule(fixture) } }.buttonStyle(.borderedProminent).tint(.orange)
                            }
                        }
                    }.padding(.vertical, 4)
                }
            }
            Section { Text("Use one Source phone for playback and separate Listener phones for analysis. A phone never records while it plays.") }
        }.navigationTitle("Test sounds")
    }
}

struct SessionView: View {
    @EnvironmentObject private var state: AppState
    var body: some View {
        List {
            if state.sessionId == nil {
                Section("Role") { Picker("Role", selection: $state.selectedRole) { ForEach(SessionRole.allCases) { Text($0.title).tag($0) } }.pickerStyle(.segmented) }
                Section("Create") { Button("Create six-character session") { Task { await state.createSession() } } }
                Section("Join") {
                    TextField("Session code", text: $state.joinCode).textInputAutocapitalization(.characters).autocorrectionDisabled()
                    Button("Join session") { Task { await state.joinSession() } }.disabled(state.joinCode.count != 6)
                }
            } else {
                Section("Active session") {
                    LabeledContent("Code", value: state.sessionCode ?? "—").font(.title3.monospaced())
                    LabeledContent("Role", value: state.role?.title ?? "—")
                    LabeledContent("Status", value: state.session?.status ?? "loading")
                    Button("Refresh") { Task { await state.refreshSession() } }
                    Button("Leave this phone", role: .destructive) { state.leaveSession() }
                    if state.session?.createdBy == state.api.deviceId {
                        Button("Close session", role: .destructive) { Task { await state.closeSession() } }
                    }
                }
                Section("Phones") {
                    ForEach(state.session?.members ?? []) { member in
                        LabeledContent(member.label, value: member.role.title)
                    }
                }
                Section("Playback runs") {
                    if state.session?.playbacks.isEmpty != false { Text("No scheduled fixtures yet.").foregroundStyle(.secondary) }
                    ForEach(state.session?.playbacks ?? []) { playback in
                        VStack(alignment: .leading) {
                            Text(SoundFixture.all.first { $0.id == playback.soundId }?.title ?? playback.soundId)
                            Text("\(playback.expectedLabel.rawValue) · \(playback.scheduledAt)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Section("Measured comparison") {
                    if state.session?.metrics.isEmpty != false { Text("Metrics appear after Listener windows overlap scheduled playback.").foregroundStyle(.secondary) }
                    ForEach(state.session?.metrics ?? []) { metric in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(metric.detectorId).font(.headline)
                            Text("Tests \(metric.tests) · TP \(metric.tp) · FP \(metric.fp) · TN \(metric.tn) · FN \(metric.fn)").font(.caption.monospaced())
                            Text(String(format: "Recall %.1f%% · false alarms %.1f%% · F1 %.3f", metric.recall * 100, metric.falsePositiveRate * 100, metric.f1)).font(.caption)
                        }
                    }
                }
                Section("Per listener") {
                    if state.session?.listenerMetrics.isEmpty != false { Text("No listener breakdown yet.").foregroundStyle(.secondary) }
                    ForEach((state.session?.listenerMetrics ?? []).filter { $0.detectorId == "consensus-2-of-3" }) { metric in
                        let name = state.session?.members.first { $0.id == metric.deviceId }?.label ?? "Listener"
                        VStack(alignment: .leading) {
                            Text(name).font(.headline)
                            Text(String(format: "%d tests · recall %.1f%% · false alarms %.1f%% · F1 %.3f",
                                        metric.tests, metric.recall * 100, metric.falsePositiveRate * 100, metric.f1)).font(.caption)
                        }
                    }
                }
                Section("Per playback") {
                    if state.session?.playbackMetrics.isEmpty != false { Text("No playback breakdown yet.").foregroundStyle(.secondary) }
                    ForEach((state.session?.playbackMetrics ?? []).filter { $0.detectorId == "consensus-2-of-3" }) { metric in
                        VStack(alignment: .leading) {
                            Text(SoundFixture.all.first { $0.id == metric.soundId }?.title ?? metric.soundId ?? "Playback").font(.headline)
                            Text("\(metric.tests) windows · TP \(metric.tp) · FP \(metric.fp) · TN \(metric.tn) · FN \(metric.fn)").font(.caption.monospaced())
                        }
                    }
                }
            }
        }.navigationTitle("Shared session")
    }
}

struct SettingsView: View {
    @EnvironmentObject private var state: AppState
    @State private var showReset = false
    var body: some View {
        Form {
            Section("Connection") {
                TextField("Server", text: Binding(get: { state.api.serverAddress }, set: { state.api.serverAddress = $0 }))
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .keyboardType(.URL)
                TextField("Device label", text: Binding(get: { state.api.deviceLabel }, set: { state.api.deviceLabel = $0 }))
                LabeledContent("Enrollment", value: state.api.isEnrolled ? "Ready" : "Required")
                Button("Sync and upload now") { Task { try? await state.api.syncClock(); await state.api.flush() } }
            }
            Section("Local data") {
                LabeledContent("Pending metadata events", value: "\(state.api.pendingCount)")
                Button("Clear pending queue", role: .destructive) { state.api.clearQueue() }
                Button("Reset device enrollment", role: .destructive) { state.api.resetEnrollment() }
            }
            Section("Detector versions") {
                LabeledContent("DSP", value: "1.0.0")
                LabeledContent("Feature Conv", value: "1.0.0")
                LabeledContent("Pretrained CRNN", value: "1.0.0")
                LabeledContent("ONNX Runtime", value: "1.29.0")
            }
            Section("Data contract") {
                Text("Only detector decisions, probabilities, latency, optional precise GPS, and session identifiers are uploaded. Raw microphone buffers and audio files never leave this phone.")
            }
            if let error = state.api.lastError { Section("Last network error") { Text(error).foregroundStyle(.red) } }
        }.navigationTitle("Settings")
    }
}

struct EnrollmentView: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var setupCode = ""
    @State private var working = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("Test enrollment") {
                    Text("Enter the shared setup code once. This phone then receives its own capability token stored in Keychain.")
                    SecureField("Setup code", text: $setupCode)
                    TextField("Phone label", text: Binding(get: { state.api.deviceLabel }, set: { state.api.deviceLabel = $0 }))
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
                Button(working ? "Enrolling…" : "Enroll phone") {
                    working = true
                    Task {
                        do { try await state.api.enroll(setupCode: setupCode); dismiss() }
                        catch { self.error = error.localizedDescription }
                        working = false
                    }
                }.disabled(working || setupCode.isEmpty || state.api.deviceLabel.isEmpty)
            }.navigationTitle("Tael Drones Lab").interactiveDismissDisabled(!state.api.isEnrolled)
        }
    }
}
