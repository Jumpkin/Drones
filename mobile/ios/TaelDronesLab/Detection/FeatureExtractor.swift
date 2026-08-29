import Foundation

struct FeatureModelMetadata: Decodable {
    let version: String
    let inputName: String
    let outputName: String
    let featureMean: [Float]
    let featureStd: [Float]
    let threshold: Double
    let temporal: TemporalConfiguration
}

struct TemporalConfiguration: Decodable {
    let requiredPositiveWindows: Int
    let windowCount: Int
}

enum FeatureExtractor {
    static func extract(_ input: [Float], sampleRate: Double) -> [Float] {
        let resampled = AudioMath.resampleLinear(input, sourceRate: sampleRate)
        var samples = [Float](repeating: 0, count: 16_000)
        samples.replaceSubrange(0..<min(samples.count, resampled.count), with: resampled.prefix(16_000))
        let result = DSPDetector.analyze(samples, sampleRate: 16_000)
        let spectrum = Array(result.spectrumDb.dropFirst(5).prefix(251))
        let binHz = Float(16_000.0 / 1024.0)
        let powers = spectrum.map { pow(10, $0 / 10) }
        let powerSum = powers.reduce(0, +) + 1e-12
        let centroid = zip(powers.indices, powers).reduce(Float(0)) { sum, pair in
            sum + pair.1 * Float(pair.0 + 5) * binHz
        } / powerSum
        let spread = sqrt(zip(powers.indices, powers).reduce(Float(0)) { sum, pair in
            let delta = Float(pair.0 + 5) * binHz - centroid
            return sum + pair.1 * delta * delta
        } / powerSum)
        let geometric = exp(AudioMath.mean(powers.map { log($0 + 1e-18) }))
        let flatness = geometric / (AudioMath.mean(powers) + 1e-18)
        let squareSum = samples.reduce(Float(0)) { $0 + $1 * $1 }
        let rms = sqrt(squareSum / Float(samples.count))
        let crest = (samples.map(abs).max() ?? 0) / (rms + 1e-9)
        var zeroCrossings = 0
        for index in 1..<samples.count where (samples[index] >= 0) != (samples[index - 1] >= 0) {
            zeroCrossings += 1
        }
        var envelopes: [Float] = []
        for offset in stride(from: 0, to: samples.count, by: 800) {
            let chunk = samples[offset..<min(samples.count, offset + 800)]
            envelopes.append(sqrt(chunk.reduce(Float(0)) { $0 + $1 * $1 } / 800))
        }
        var fundamentals: [Float] = []
        var confidences: [Float] = []
        for offset in stride(from: 0, to: samples.count, by: 4_000) {
            let chunk = Array(samples[offset..<min(samples.count, offset + 4_000)])
            let analysis = DSPDetector.analyze(chunk, sampleRate: 16_000)
            if analysis.fundamentalHz > 0 { fundamentals.append(Float(analysis.fundamentalHz)) }
            confidences.append(Float(analysis.confidence))
        }
        let low = powers.prefix(60).reduce(0, +)
        let high = powers.dropFirst(60).reduce(0, +)
        let spectrumMedian = AudioMath.median(spectrum)
        let peakSharpness = ((spectrum.max() ?? spectrumMedian) - spectrumMedian) / 60
        let tonalDensity = Float(spectrum.filter { $0 >= spectrumMedian + 12 }.count) / Float(max(1, spectrum.count))
        func limited(_ value: Float) -> Float { min(1, value) }
        let harmonicStrength = 1 / (1 + exp(-Float((result.harmonicScoreDb - 8.5) / 2.3)))
        return [
            Float(result.confidence), harmonicStrength,
            Float(result.positiveFrames) / Float(max(1, result.analyzedFrames)),
            limited(Float(result.fundamentalHz / 1_600)), limited(centroid / 4_000),
            limited(spread / 4_000), limited(flatness), limited(rms * 5), limited(crest / 10),
            Float(zeroCrossings) / Float(samples.count),
            limited(AudioMath.standardDeviation(envelopes) / (AudioMath.mean(envelopes) + 1e-9)),
            limited(AudioMath.standardDeviation(fundamentals) / (AudioMath.mean(fundamentals) + 1e-9)),
            limited(AudioMath.standardDeviation(confidences)), limited(high / (low + high + 1e-12)),
            limited(peakSharpness), limited(tonalDensity * 8),
        ]
    }

    static func normalize(_ features: [Float], metadata: FeatureModelMetadata) -> [Float] {
        zip(features.indices, features).map { index, value in
            (value - metadata.featureMean[index]) / max(1e-6, metadata.featureStd[index])
        }
    }
}
