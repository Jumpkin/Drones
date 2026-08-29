import Foundation
import OSLog

private struct EnrollRequest: Encodable { let label: String; let appVersion: String; let platform = "ios" }
private struct EnrollResponse: Decodable { let device: Device; struct Device: Decodable { let id: UUID; let label: String } }
private struct SessionEnvelope: Decodable { let session: SessionSnapshot }
private struct CreatedSessionEnvelope: Decodable { let session: CreatedSession; struct CreatedSession: Decodable { let id: UUID; let code: String } }
private struct JoinResponse: Decodable { let sessionId: UUID }
private struct PlaybackEnvelope: Decodable { let playback: SessionPlayback }
private struct TimeEnvelope: Decodable { let serverTime: String }
private struct BatchEnvelope: Encodable { let events: [ObservationEvent] }
private struct BatchResponse: Decodable { let accepted: Int; let duplicates: Int }

enum APIClientError: LocalizedError {
    case invalidServer
    case rejected(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidServer: return "Enter a valid HTTPS server URL."
        case let .rejected(status, message): return "Server rejected the request (\(status)): \(message)"
        }
    }
}

@MainActor
final class DronesAPIClient: ObservableObject {
    @Published private(set) var pendingCount = 0
    @Published private(set) var deviceId: UUID?
    @Published var lastError: String?
    @Published var serverAddress: String {
        didSet { defaults.set(serverAddress, forKey: Self.serverKey) }
    }
    @Published var deviceLabel: String {
        didSet { defaults.set(deviceLabel, forKey: Self.labelKey) }
    }

    private static let serverKey = "TaelDronesLab.Server.v1"
    private static let labelKey = "TaelDronesLab.DeviceLabel.v1"
    private static let queueKey = "TaelDronesLab.EventQueue.v1"
    private static let deviceKey = "TaelDronesLab.DeviceID.v1"
    private let defaults: UserDefaults
    private let logger = Logger(subsystem: "se.tael.drones.mobile", category: "api")
    private var queue: [ObservationEvent]
    private var flushing = false
    private(set) var serverClockOffset: TimeInterval = 0

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        serverAddress = defaults.string(forKey: Self.serverKey) ?? "https://drones.tael.se"
        deviceLabel = defaults.string(forKey: Self.labelKey) ?? "iPhone"
        queue = defaults.data(forKey: Self.queueKey).flatMap { try? JSONDecoder().decode([ObservationEvent].self, from: $0) } ?? []
        let storedDeviceId = defaults.string(forKey: Self.deviceKey).flatMap(UUID.init(uuidString:))
        deviceId = storedDeviceId
        pendingCount = queue.count
    }

    private var baseURL: URL? {
        guard let url = URL(string: serverAddress.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host, !host.isEmpty, let scheme = url.scheme?.lowercased(),
              scheme == "https" || (scheme == "http" && host == "localhost") else { return nil }
        return url
    }

    private func url(_ path: String) throws -> URL {
        guard let baseURL, let result = URL(string: path, relativeTo: baseURL)?.absoluteURL else { throw APIClientError.invalidServer }
        return result
    }

    private func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    private func deviceRequest(path: String, method: String = "GET") async throws -> URLRequest {
        let deviceId = try await ensureDevice()
        var request = URLRequest(url: try url(path))
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue(deviceId.uuidString.lowercased(), forHTTPHeaderField: "X-Drones-Device-ID")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    private func send<Response: Decodable>(_ request: URLRequest, as type: Response.Type) async throws -> Response {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: String])?["error"] ?? "unknown error"
            throw APIClientError.rejected(http.statusCode, message)
        }
        return try decoder().decode(type, from: data)
    }

    @discardableResult
    func ensureDevice() async throws -> UUID {
        if let deviceId { return deviceId }
        var request = URLRequest(url: try url("/api/drones/v1/devices/enroll"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        request.httpBody = try JSONEncoder().encode(EnrollRequest(label: deviceLabel, appVersion: version))
        let response = try await send(request, as: EnrollResponse.self)
        defaults.set(response.device.id.uuidString, forKey: Self.deviceKey)
        deviceId = response.device.id
        lastError = nil
        return response.device.id
    }

    func syncClock() async throws {
        let started = Date()
        let response = try await send(URLRequest(url: try url("/api/drones/v1/time")), as: TimeEnvelope.self)
        let ended = Date()
        guard let server = ISO8601.date(response.serverTime) else { throw URLError(.cannotParseResponse) }
        let midpoint = started.addingTimeInterval(ended.timeIntervalSince(started) / 2)
        serverClockOffset = server.timeIntervalSince(midpoint)
    }

    func serverDate(for localDate: Date) -> Date { localDate.addingTimeInterval(serverClockOffset) }
    func localDate(forServer value: String) -> Date? { ISO8601.date(value)?.addingTimeInterval(-serverClockOffset) }

    func createSession(role: SessionRole) async throws -> (UUID, String) {
        var request = try await deviceRequest(path: "/api/drones/v1/sessions", method: "POST")
        request.httpBody = try JSONEncoder().encode(["role": role.rawValue])
        let response = try await send(request, as: CreatedSessionEnvelope.self)
        return (response.session.id, response.session.code)
    }

    func joinSession(code: String, role: SessionRole) async throws -> UUID {
        var request = try await deviceRequest(path: "/api/drones/v1/sessions/join", method: "POST")
        request.httpBody = try JSONEncoder().encode(["code": code.uppercased(), "role": role.rawValue])
        return try await send(request, as: JoinResponse.self).sessionId
    }

    func createPlayback(sessionId: UUID, fixture: SoundFixture, scheduledAt: Date) async throws -> SessionPlayback {
        var request = try await deviceRequest(path: "/api/drones/v1/sessions/\(sessionId.uuidString.lowercased())/playbacks", method: "POST")
        struct Payload: Encodable { let soundId: String; let expectedLabel: ExpectedLabel; let scheduledAt: String; let durationMs: Int }
        request.httpBody = try JSONEncoder().encode(Payload(soundId: fixture.id, expectedLabel: fixture.expected,
            scheduledAt: ISO8601.string(serverDate(for: scheduledAt)), durationMs: fixture.durationMs))
        return try await send(request, as: PlaybackEnvelope.self).playback
    }

    func fetchSession(_ id: UUID) async throws -> SessionSnapshot {
        try await send(deviceRequest(path: "/api/drones/v1/sessions/\(id.uuidString.lowercased())"), as: SessionEnvelope.self).session
    }

    func closeSession(_ id: UUID) async throws {
        struct Response: Decodable { let closed: Bool }
        _ = try await send(deviceRequest(path: "/api/drones/v1/sessions/\(id.uuidString.lowercased())/close", method: "POST"), as: Response.self)
    }

    func enqueue(_ event: ObservationEvent) {
        guard event.sessionId != nil || event.consensus.detected else { return }
        queue.append(event)
        if queue.count > 2_000 { queue.removeFirst(queue.count - 2_000) }
        persistQueue()
        Task { await flush() }
    }

    func flush() async {
        guard !flushing, !queue.isEmpty else { return }
        flushing = true
        defer { flushing = false }
        while !queue.isEmpty {
            do {
                let batch = Array(queue.prefix(50))
                var request = try await deviceRequest(path: "/api/drones/v1/events/batch", method: "POST")
                request.httpBody = try JSONEncoder().encode(BatchEnvelope(events: batch))
                _ = try await send(request, as: BatchResponse.self)
                queue.removeFirst(batch.count)
                persistQueue()
                lastError = nil
            } catch {
                lastError = error.localizedDescription
                logger.error("Observation flush failed: \(error.localizedDescription, privacy: .public)")
                return
            }
        }
    }

    func clearQueue() { queue.removeAll(); persistQueue() }

    func forgetDevice() {
        defaults.removeObject(forKey: Self.deviceKey)
        clearQueue()
        deviceId = nil
    }

    private func persistQueue() {
        defaults.set(try? JSONEncoder().encode(queue), forKey: Self.queueKey)
        pendingCount = queue.count
    }
}
