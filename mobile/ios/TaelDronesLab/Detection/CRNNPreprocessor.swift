import Foundation

struct CRNNMetadata: Decodable {
    let version: String
    let inputName: String
    let outputName: String
    let threshold: Double
    let temporal: TemporalConfiguration
}

enum CRNNPreprocessor {
    static let sampleRate = 16_000
    static let windowSamples = 16_000
    static let fftSize = 512
    static let hopSamples = 160
    static let melBins = 64
    static let timeFrames = 101

    private static func hzToMel(_ hz: Double) -> Double { 2_595 * log10(1 + hz / 700) }
    private static func melToHz(_ mel: Double) -> Double { 700 * (pow(10, mel / 2_595) - 1) }

    private static let filters: [[Float]] = {
        let minimum = hzToMel(50)
        let maximum = hzToMel(5_500)
        let points = (0..<(melBins + 2)).map { index in
            melToHz(minimum + (maximum - minimum) * Double(index) / Double(melBins + 1))
        }
        return (0..<melBins).map { mel in
            let lower = points[mel], center = points[mel + 1], upper = points[mel + 2]
            return (0...(fftSize / 2)).map { bin -> Float in
                let frequency = Double(bin * sampleRate) / Double(fftSize)
                let ascending = (frequency - lower) / (center - lower)
                let descending = (upper - frequency) / (upper - center)
                return Float(max(0, min(ascending, descending)))
            }
        }
    }()

    private static func reflected(_ samples: [Float], index original: Int) -> Float {
        var index = original
        while index < 0 || index >= samples.count {
            index = index < 0 ? -index : 2 * samples.count - 2 - index
        }
        return samples[index]
    }

    static func extract(_ input: [Float], sampleRate inputRate: Double) -> [Float] {
        let resampled = AudioMath.resampleLinear(input, sourceRate: inputRate)
        var samples = [Float](repeating: 0, count: windowSamples)
        samples.replaceSubrange(0..<min(samples.count, resampled.count), with: resampled.prefix(windowSamples))
        var melPower = [Float](repeating: 0, count: melBins * timeFrames)
        for frameIndex in 0..<timeFrames {
            let start = frameIndex * hopSamples - fftSize / 2
            let frame = (0..<fftSize).map { reflected(samples, index: start + $0) }
            let db = AudioMath.spectrumDb(frame[0..<frame.count], fftSize: fftSize)
            let power = db.map { pow(10, $0 / 10) }
            for mel in 0..<melBins {
                var energy: Float = 0
                for bin in power.indices { energy += power[bin] * filters[mel][bin] }
                melPower[mel * timeFrames + frameIndex] = max(1e-10, energy)
            }
        }
        var db = melPower.map { 10 * log10($0) }
        let minimum = (db.max() ?? -120) - 80
        db = db.map { (max(minimum, $0) + 40) / 40 }
        return db
    }
}
