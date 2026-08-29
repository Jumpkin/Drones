import Foundation

struct DSPAnalysis: Equatable {
    let detected: Bool
    let confidence: Double
    let fundamentalHz: Double
    let harmonicScoreDb: Double
    let noiseFloorDb: Double
    let positiveFrames: Int
    let analyzedFrames: Int
    let spectrumDb: [Float]
    let classification: DroneClassification?
}

enum DSPDetector {
    static let fftSize = 1024
    static let hopSize = 512

    private static func clamp(_ value: Double) -> Double { min(1, max(0, value)) }
    private static func sigmoid(_ value: Double) -> Double { 1 / (1 + exp(-value)) }

    private static func localPeak(_ spectrum: [Float], _ index: Int) -> Double {
        let valid = [index - 1, index, index + 1].filter { spectrum.indices.contains($0) }
        return Double(valid.map { spectrum[$0] }.max() ?? -120)
    }

    private static func prominence(_ spectrum: [Float], _ index: Int) -> Double {
        let neighbors = (-7...7).filter { abs($0) > 1 && spectrum.indices.contains(index + $0) }
            .map { spectrum[index + $0] }
        return localPeak(spectrum, index) - Double(AudioMath.median(neighbors, empty: -120))
    }

    static func analyze(_ input: [Float], sampleRate inputRate: Double) -> DSPAnalysis {
        let sampleRate = 16_000.0
        let samples = AudioMath.resampleLinear(input, sourceRate: inputRate, targetRate: sampleRate)
        let frameCount = max(1, Int(floor(Double(samples.count - fftSize) / Double(hopSize))) + 1)
        var analyzedFrames = 0
        var positiveFrames = 0
        var positiveStreak = 0
        var maxPositiveStreak = 0
        var confidenceSum = 0.0
        var weightedFundamental = 0.0
        var fundamentalWeight = 0.0
        var bestScore = -120.0
        var bestNoiseFloor = -120.0
        var accumulated = [Float](repeating: 0, count: fftSize / 2)
        var positiveBins: [Int] = []
        let binHz = sampleRate / Double(fftSize)

        for frameIndex in 0..<frameCount {
            let offset = frameIndex * hopSize
            let end = min(samples.count, offset + fftSize)
            let slice = offset < samples.count ? samples[offset..<end] : ArraySlice<Float>()
            let spectrum = AudioMath.spectrumDb(slice, fftSize: fftSize)
            for index in accumulated.indices { accumulated[index] += spectrum[index] }
            let lowerNoise = Int((100 / binHz).rounded())
            let upperNoise = min(spectrum.count, Int((5_000 / binHz).rounded()))
            let noiseFloor = Double(AudioMath.median(Array(spectrum[lowerNoise..<upperNoise]), empty: -120))
            var frameFundamental = 0.0
            var frameScore = -120.0
            for bin in Int(ceil(80 / binHz))...Int(floor(1_600 / binHz)) {
                guard bin * 3 < spectrum.count else { break }
                let snr1 = localPeak(spectrum, bin) - noiseFloor
                let snr2 = localPeak(spectrum, bin * 2) - noiseFloor
                let snr3 = localPeak(spectrum, bin * 3) - noiseFloor
                let harmonicFloor = min(snr1, snr2 + 2, snr3 + 4)
                let prominenceFloor = min(prominence(spectrum, bin), prominence(spectrum, bin * 2), prominence(spectrum, bin * 3))
                let score = harmonicFloor + 0.16 * (snr1 + snr2 + snr3) + 0.72 * prominenceFloor
                if score > frameScore { frameScore = score; frameFundamental = Double(bin) * binHz }
            }
            let frameConfidence = clamp(sigmoid((frameScore - 8.5) / 2.3))
            let positive = frameConfidence >= 0.62
            positiveStreak = positive ? positiveStreak + 1 : 0
            maxPositiveStreak = max(maxPositiveStreak, positiveStreak)
            if positive {
                positiveFrames += 1
                positiveBins.append(Int((frameFundamental / binHz).rounded()))
                weightedFundamental += frameFundamental * frameConfidence
                fundamentalWeight += frameConfidence
            }
            confidenceSum += frameConfidence
            if frameScore > bestScore { bestScore = frameScore; bestNoiseFloor = noiseFloor }
            analyzedFrames += 1
        }
        accumulated = accumulated.map { $0 / Float(max(1, analyzedFrames)) }
        var stableFrames = 0
        for candidate in positiveBins {
            stableFrames = max(stableFrames, positiveBins.filter { abs($0 - candidate) <= 2 }.count)
        }
        let stability = positiveFrames > 0 ? Double(stableFrames) / Double(positiveFrames) : 0
        let confidence = clamp((confidenceSum / Double(max(1, analyzedFrames))) * (0.35 + 0.65 * stability))
        let detected = maxPositiveStreak >= 2 && confidence >= 0.42 && stability >= 0.28
        let fundamental = fundamentalWeight > 0 ? weightedFundamental / fundamentalWeight : 0
        return DSPAnalysis(
            detected: detected, confidence: confidence, fundamentalHz: fundamental,
            harmonicScoreDb: bestScore, noiseFloorDb: bestNoiseFloor,
            positiveFrames: positiveFrames, analyzedFrames: analyzedFrames,
            spectrumDb: accumulated, classification: classify(fundamental, spectrum: accumulated,
                noiseFloor: bestNoiseFloor, detected: detected)
        )
    }

    private static func classify(_ fundamental: Double, spectrum: [Float], noiseFloor: Double, detected: Bool) -> DroneClassification? {
        guard detected, fundamental > 0 else { return nil }
        let profiles: [(String, String, Double, Double)] = [
            ("camera", "Camera quadcopter", 2, 5_400),
            ("fpv", "FPV racing quadcopter", 3, 14_000),
            ("fixedWing", "Fixed-wing electric", 2, 7_200),
            ("combustion", "Combustion fixed-wing", 2, 4_800),
        ]
        let binHz = 16_000.0 / 1024.0
        return profiles.map { id, label, blades, rpm -> DroneClassification in
            let nominal = blades * rpm / 60
            let compatibility = exp(-abs(log(max(0.1, fundamental / nominal))) / 0.42)
            let h2 = localPeak(spectrum, Int((fundamental * 2 / binHz).rounded()))
            let h3 = localPeak(spectrum, Int((fundamental * 3 / binHz).rounded()))
            let balance = clamp(((h2 + h3) / 2 - noiseFloor) / 24)
            let prior = id == "camera" && (85...300).contains(fundamental) ? 0.24 :
                (id == "fpv" && fundamental > 300 ? 0.2 : 0)
            return DroneClassification(profile: id, label: label,
                confidence: clamp(0.68 * compatibility + 0.18 * balance + prior))
        }.max { $0.confidence < $1.confidence }
    }
}
