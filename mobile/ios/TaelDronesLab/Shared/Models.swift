import Foundation

enum DetectorID: String, Codable, CaseIterable, Identifiable {
    case dsp = "dsp-v1"
    case featureML = "ml-onnx-v1"
    case crnn = "crnn-pretrained-v1"

    var id: String { rawValue }
    var label: String {
        switch self {
        case .dsp: return "FFT / harmonic DSP"
        case .featureML: return "Feature Conv ML"
        case .crnn: return "Pretrained CRNN"
        }
    }
}

struct DetectorResult: Codable, Equatable, Identifiable {
    var id: String { detectorId.rawValue }
    let detectorId: DetectorID
    let version: String
    let detected: Bool
    let probability: Double
    let threshold: Double
    let latencyMs: Double
    let positiveWindows: Int
    let analyzedWindows: Int
}

struct DroneClassification: Codable, Equatable {
    let profile: String
    let label: String
    let confidence: Double
}

struct DetectionLocation: Codable, Equatable {
    let latitude: Double
    let longitude: Double
    let horizontalAccuracyM: Double
    let altitudeM: Double?
}

struct DetectionConsensus: Codable, Equatable {
    let detected: Bool
    let positiveDetectors: Int
}

struct ObservationEvent: Codable, Equatable, Identifiable {
    let id: UUID
    let capturedAt: String
    let sessionId: UUID?
    let playbackId: UUID?
    let sampleRate: Int
    let windowDurationMs: Int
    let location: DetectionLocation?
    let consensus: DetectionConsensus
    let detectors: [DetectorResult]
    let classification: DroneClassification?
}

enum SessionRole: String, Codable, CaseIterable, Identifiable {
    case source
    case listener
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

enum ExpectedLabel: String, Codable, CaseIterable {
    case drone
    case background
}

struct SoundFixture: Identifiable, Hashable {
    let id: String
    let title: String
    let detail: String
    let resource: String
    let expected: ExpectedLabel
    let durationMs: Int

    static let all: [SoundFixture] = [
        .init(id: "batear-fpv-5inch", title: "FPV 5-inch", detail: "Batear drone fixture", resource: "batear-fpv-5inch", expected: .drone, durationMs: 3_319),
        .init(id: "batear-mavic-pro", title: "DJI Mavic Pro", detail: "Batear drone fixture", resource: "batear-mavic-pro", expected: .drone, durationMs: 12_000),
        .init(id: "batear-mini-4-pro", title: "DJI Mini 4 Pro", detail: "Batear drone fixture", resource: "batear-mini-4-pro", expected: .drone, durationMs: 12_000),
        .init(id: "batear-rural-8s", title: "Rural background", detail: "Negative control", resource: "batear-rural-8s", expected: .background, durationMs: 8_000),
    ]
}

struct SessionMember: Codable, Identifiable {
    let id: UUID
    let label: String
    let role: SessionRole
    let joinedAt: String
    let lastSeenAt: String
}

struct SessionPlayback: Codable, Identifiable {
    let id: UUID
    let sourceDeviceId: UUID
    let soundId: String
    let expectedLabel: ExpectedLabel
    let scheduledAt: String
    let durationMs: Int
    let sourceKind: String
    let distanceM: Double?
    let volumePercent: Int?
    let environment: String
    let createdAt: String
}

struct SessionMetric: Codable, Identifiable {
    var id: String { [deviceId?.uuidString, playbackId?.uuidString, detectorId].compactMap { $0 }.joined(separator: ":") }
    let detectorId: String
    let deviceId: UUID?
    let playbackId: UUID?
    let soundId: String?
    let expectedLabel: ExpectedLabel?
    let sourceKind: String?
    let distanceM: Double?
    let volumePercent: Int?
    let environment: String?
    let tests: Int
    let tp: Int
    let fp: Int
    let tn: Int
    let fn: Int
    let precision: Double
    let recall: Double
    let falsePositiveRate: Double
    let f1: Double
    let averageProbability: Double
    let averageLatencyMs: Double
}

struct SessionSnapshot: Codable, Identifiable {
    let id: UUID
    let code: String
    let createdBy: UUID
    let status: String
    let createdAt: String
    let expiresAt: String
    let closedAt: String?
    let members: [SessionMember]
    let playbacks: [SessionPlayback]
    let metrics: [SessionMetric]
    let listenerMetrics: [SessionMetric]
    let playbackMetrics: [SessionMetric]
}

enum ISO8601 {
    static let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static func string(_ date: Date = Date()) -> String { formatter.string(from: date) }
    static func date(_ value: String) -> Date? {
        formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
