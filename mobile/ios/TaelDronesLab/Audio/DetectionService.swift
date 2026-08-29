import AVFAudio
import Foundation
import OSLog

@MainActor
final class DetectionService: ObservableObject {
    @Published private(set) var listening = false
    @Published private(set) var results: [DetectorResult] = []
    @Published private(set) var spectrum: [Float] = []
    @Published private(set) var level: Float = 0
    @Published private(set) var inferenceCount = 0
    @Published private(set) var lastError: String?
    var onObservation: (([DetectorResult], DroneClassification?) -> Void)?

    private let engine = AVAudioEngine()
    private let worker = DetectionWorker()

    func start() {
        guard !listening else { return }
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            Task { @MainActor in
                guard let self else { return }
                if granted { self.startGranted() } else { self.lastError = "Microphone permission was denied." }
            }
        }
    }

    private func startGranted() {
        do {
            try worker.prepare()
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.allowBluetoothHFP])
            try session.setPreferredSampleRate(48_000)
            try session.setActive(true)
            let input = engine.inputNode
            let format = input.inputFormat(forBus: 0)
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 4_096, format: format) { [weak self] buffer, _ in
                guard let channel = buffer.floatChannelData?.pointee else { return }
                let samples = Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
                self?.accept(samples, sampleRate: format.sampleRate)
            }
            engine.prepare()
            try engine.start()
            listening = true
            lastError = nil
        } catch {
            lastError = error.localizedDescription
            stop()
        }
    }

    nonisolated private func accept(_ samples: [Float], sampleRate: Double) {
        worker.accept(samples, sampleRate: sampleRate) { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case let .success(output):
                    self.results = output.results
                    self.spectrum = output.spectrum
                    self.level = output.level
                    self.inferenceCount += 1
                    self.lastError = nil
                    self.onObservation?(output.results, output.classification)
                case let .failure(error):
                    self.lastError = error.localizedDescription
                }
            }
        }
    }

    func stop() {
        if listening {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        listening = false
        worker.clear()
    }
}

private struct WorkerOutput {
    let results: [DetectorResult]
    let classification: DroneClassification?
    let spectrum: [Float]
    let level: Float
}

private final class DetectionWorker: @unchecked Sendable {
    private let queue = DispatchQueue(label: "se.tael.drones.mobile.inference", qos: .userInitiated)
    private let logger = Logger(subsystem: "se.tael.drones.mobile", category: "detection")
    private var pipeline: DetectionPipeline?
    private var buffered: [Float] = []

    func prepare() throws {
        try queue.sync {
            if pipeline == nil { pipeline = try DetectionPipeline() }
            pipeline?.reset()
            buffered.removeAll(keepingCapacity: true)
        }
    }

    func accept(_ samples: [Float], sampleRate: Double, completion: @escaping @Sendable (Result<WorkerOutput, Error>) -> Void) {
        queue.async { [self] in
            buffered.append(contentsOf: samples)
            let window = Int(sampleRate)
            let hop = Int(sampleRate / 2)
            if buffered.count > window * 3 { buffered.removeFirst(buffered.count - window * 2) }
            while buffered.count >= window {
                let frame = Array(buffered.prefix(window))
                buffered.removeFirst(min(hop, buffered.count))
                do {
                    guard let pipeline else { return }
                    let analyzed = try pipeline.analyze(frame, sampleRate: sampleRate)
                    let displaySpectrum = DSPDetector.analyze(frame, sampleRate: sampleRate).spectrumDb
                    let rms = sqrt(frame.reduce(Float(0)) { $0 + $1 * $1 } / Float(max(1, frame.count)))
                    completion(.success(WorkerOutput(results: analyzed.results, classification: analyzed.classification,
                        spectrum: displaySpectrum, level: min(1, rms * 8))))
                } catch {
                    logger.error("Inference failed: \(error.localizedDescription, privacy: .public)")
                    completion(.failure(error))
                }
            }
        }
    }

    func clear() { queue.async { [self] in buffered.removeAll(keepingCapacity: true) } }
}
