import Combine
import Foundation
import UIKit

@MainActor
final class AppState: ObservableObject {
    let api = DronesAPIClient()
    let detection = DetectionService()
    let location = LocationProvider()
    let soundPlayer = SoundPlayer()

    @Published private(set) var session: SessionSnapshot?
    @Published private(set) var sessionId: UUID?
    @Published private(set) var sessionCode: String?
    @Published private(set) var role: SessionRole?
    @Published var selectedRole: SessionRole = .listener
    @Published var joinCode = ""
    @Published var message: String?
    private var pollingTask: Task<Void, Never>?
    private var cancellables: Set<AnyCancellable> = []

    init() {
        api.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &cancellables)
        detection.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &cancellables)
        location.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &cancellables)
        soundPlayer.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &cancellables)
        detection.onObservation = { [weak self] results, classification in
            self?.record(results: results, classification: classification)
        }
        Task { try? await api.syncClock(); await api.flush() }
    }

    var consensusDetected: Bool { detection.results.filter(\.detected).count >= 2 }

    func startListening() {
        guard role != .source, soundPlayer.playing == nil else {
            message = "A Source phone cannot listen while it is playing a fixture."
            return
        }
        location.start()
        detection.start()
    }

    func stopListening() {
        detection.stop()
        location.stop()
    }

    func playStandalone(_ fixture: SoundFixture) {
        stopListening()
        do { try soundPlayer.play(fixture); message = "Playing \(fixture.title)." }
        catch { message = error.localizedDescription }
    }

    func createSession() async {
        guard api.isEnrolled else { message = "Enroll this phone first."; return }
        do {
            try await api.syncClock()
            let created = try await api.createSession(role: selectedRole)
            sessionId = created.0
            sessionCode = created.1
            role = selectedRole
            beginPolling()
            await refreshSession()
            message = "Session \(created.1) created."
        } catch { message = error.localizedDescription }
    }

    func joinSession() async {
        guard api.isEnrolled else { message = "Enroll this phone first."; return }
        do {
            try await api.syncClock()
            let id = try await api.joinSession(code: joinCode, role: selectedRole)
            sessionId = id
            sessionCode = joinCode.uppercased()
            role = selectedRole
            beginPolling()
            await refreshSession()
            message = "Joined as \(selectedRole.title)."
        } catch { message = error.localizedDescription }
    }

    func schedule(_ fixture: SoundFixture) async {
        guard role == .source, let sessionId else {
            message = "Join the session as Source to schedule playback."
            return
        }
        stopListening()
        do {
            try await api.syncClock()
            let localStart = Date().addingTimeInterval(3)
            _ = try await api.createPlayback(sessionId: sessionId, fixture: fixture, scheduledAt: localStart)
            message = "Scheduled \(fixture.title) in 3 seconds."
            await refreshSession()
            let delay = max(0, localStart.timeIntervalSinceNow)
            try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard self.sessionId == sessionId else { return }
            try soundPlayer.play(fixture)
        } catch is CancellationError {
            return
        } catch { message = error.localizedDescription }
    }

    func refreshSession() async {
        guard let sessionId else { return }
        do {
            session = try await api.fetchSession(sessionId)
            sessionCode = session?.code
        } catch { message = error.localizedDescription }
    }

    func closeSession() async {
        guard let sessionId else { return }
        do {
            try await api.closeSession(sessionId)
            await refreshSession()
            message = "Session closed."
        } catch { message = error.localizedDescription }
    }

    func leaveSession() {
        stopListening()
        soundPlayer.stop()
        pollingTask?.cancel()
        pollingTask = nil
        session = nil
        sessionId = nil
        sessionCode = nil
        role = nil
    }

    func applicationEnteredBackground() {
        stopListening()
        soundPlayer.stop()
    }

    private func beginPolling() {
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshSession()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private func record(results: [DetectorResult], classification: DroneClassification?) {
        let positives = results.filter(\.detected).count
        let consensus = positives >= 2
        let playback = activePlayback()
        let inListenerSession = role == .listener ? sessionId : nil
        let event = ObservationEvent(
            id: UUID(), capturedAt: ISO8601.string(api.serverDate(for: Date())),
            sessionId: inListenerSession, playbackId: inListenerSession == nil ? nil : playback?.id,
            sampleRate: 16_000, windowDurationMs: 1_000, location: location.latest,
            consensus: DetectionConsensus(detected: consensus, positiveDetectors: positives),
            detectors: results, classification: consensus ? classification : nil
        )
        api.enqueue(event)
    }

    private func activePlayback() -> SessionPlayback? {
        let serverNow = api.serverDate(for: Date())
        return session?.playbacks.first { playback in
            guard let start = ISO8601.date(playback.scheduledAt) else { return false }
            let end = start.addingTimeInterval(Double(playback.durationMs) / 1_000 + 1)
            return serverNow >= start.addingTimeInterval(-1) && serverNow <= end
        }
    }
}
