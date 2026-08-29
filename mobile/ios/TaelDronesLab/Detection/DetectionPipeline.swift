import Foundation

struct TemporalVote {
    private(set) var probabilities: [Double] = []
    let threshold: Double
    let required: Int
    let windowCount: Int

    mutating func append(_ probability: Double) -> (detected: Bool, positives: Int, analyzed: Int, average: Double) {
        probabilities.append(probability)
        probabilities = Array(probabilities.suffix(windowCount))
        let positives = probabilities.filter { $0 >= threshold }.count
        let scaledRequired = probabilities.count >= windowCount ? required :
            max(1, Int(ceil(Double(probabilities.count * required) / Double(windowCount))))
        return (positives >= scaledRequired, positives, probabilities.count,
            probabilities.reduce(0, +) / Double(max(1, probabilities.count)))
    }
}

final class DetectionPipeline {
    private let featureMetadata: FeatureModelMetadata
    private let crnnMetadata: CRNNMetadata
    private let featureModel: ONNXModelRunner
    private let crnnModel: ONNXModelRunner
    private var votes: [DetectorID: TemporalVote]

    init(bundle: Bundle = .main) throws {
        func decode<T: Decodable>(_ type: T.Type, resource: String) throws -> T {
            guard let url = bundle.url(forResource: resource, withExtension: "json") ??
                    bundle.url(forResource: resource, withExtension: "json", subdirectory: "Models") else {
                throw CocoaError(.fileNoSuchFile)
            }
            return try JSONDecoder().decode(type, from: Data(contentsOf: url))
        }
        featureMetadata = try decode(FeatureModelMetadata.self, resource: "drone-binary-v1")
        crnnMetadata = try decode(CRNNMetadata.self, resource: "drone-classifier-crnn-v1")
        featureModel = try ONNXModelRunner(resource: "drone-binary-v1", inputName: featureMetadata.inputName,
            outputName: featureMetadata.outputName, shape: [1, 16, 1])
        crnnModel = try ONNXModelRunner(resource: "drone-classifier-crnn-v1", inputName: crnnMetadata.inputName,
            outputName: crnnMetadata.outputName, shape: [1, 1, 64, 101])
        votes = [
            .dsp: TemporalVote(threshold: 0.42, required: 3, windowCount: 5),
            .featureML: TemporalVote(threshold: featureMetadata.threshold,
                required: featureMetadata.temporal.requiredPositiveWindows,
                windowCount: featureMetadata.temporal.windowCount),
            .crnn: TemporalVote(threshold: crnnMetadata.threshold,
                required: crnnMetadata.temporal.requiredPositiveWindows,
                windowCount: crnnMetadata.temporal.windowCount),
        ]
    }

    func analyze(_ samples: [Float], sampleRate: Double) throws -> (results: [DetectorResult], classification: DroneClassification?) {
        let dspStarted = CFAbsoluteTimeGetCurrent()
        let dsp = DSPDetector.analyze(samples, sampleRate: sampleRate)
        let dspLatency = (CFAbsoluteTimeGetCurrent() - dspStarted) * 1_000
        let featureStarted = CFAbsoluteTimeGetCurrent()
        let features = FeatureExtractor.normalize(FeatureExtractor.extract(samples, sampleRate: sampleRate), metadata: featureMetadata)
        let featureProbability = try featureModel.probability(features)
        let featureLatency = (CFAbsoluteTimeGetCurrent() - featureStarted) * 1_000
        let crnnStarted = CFAbsoluteTimeGetCurrent()
        let crnnProbability = try crnnModel.probability(CRNNPreprocessor.extract(samples, sampleRate: sampleRate))
        let crnnLatency = (CFAbsoluteTimeGetCurrent() - crnnStarted) * 1_000
        let inputs: [(DetectorID, String, Double, Double, Double)] = [
            (.dsp, "1.0.0", dsp.confidence, 0.42, dspLatency),
            (.featureML, featureMetadata.version, featureProbability, featureMetadata.threshold, featureLatency),
            (.crnn, crnnMetadata.version, crnnProbability, crnnMetadata.threshold, crnnLatency),
        ]
        let results = inputs.map { id, version, probability, threshold, latency -> DetectorResult in
            var vote = votes[id]!
            let temporal = vote.append(probability)
            votes[id] = vote
            return DetectorResult(detectorId: id, version: version, detected: temporal.detected,
                probability: temporal.average, threshold: threshold, latencyMs: latency,
                positiveWindows: temporal.positives, analyzedWindows: temporal.analyzed)
        }
        return (results, dsp.classification)
    }

    func reset() {
        votes[.dsp] = TemporalVote(threshold: 0.42, required: 3, windowCount: 5)
        votes[.featureML] = TemporalVote(threshold: featureMetadata.threshold,
            required: featureMetadata.temporal.requiredPositiveWindows,
            windowCount: featureMetadata.temporal.windowCount)
        votes[.crnn] = TemporalVote(threshold: crnnMetadata.threshold,
            required: crnnMetadata.temporal.requiredPositiveWindows,
            windowCount: crnnMetadata.temporal.windowCount)
    }
}
