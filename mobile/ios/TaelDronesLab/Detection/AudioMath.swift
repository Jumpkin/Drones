import Accelerate
import Foundation

enum AudioMath {
    private static let plan512 = FFTPlan(size: 512)
    private static let plan1024 = FFTPlan(size: 1024)
    static func resampleLinear(_ samples: [Float], sourceRate: Double, targetRate: Double = 16_000) -> [Float] {
        guard !samples.isEmpty else { return [] }
        guard sourceRate > 0, targetRate > 0 else { return [] }
        if sourceRate == targetRate { return samples }
        let count = max(1, Int((Double(samples.count) * targetRate / sourceRate).rounded()))
        let scale = sourceRate / targetRate
        return (0..<count).map { index in
            let sourceIndex = Double(index) * scale
            let lower = min(samples.count - 1, Int(sourceIndex.rounded(.down)))
            let upper = min(samples.count - 1, lower + 1)
            let mix = Float(sourceIndex - Double(lower))
            return samples[lower] * (1 - mix) + samples[upper] * mix
        }
    }

    static func median(_ values: [Float], empty: Float = 0) -> Float {
        guard !values.isEmpty else { return empty }
        let sorted = values.sorted()
        let middle = sorted.count / 2
        return sorted.count.isMultiple(of: 2) ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
    }

    static func mean(_ values: [Float]) -> Float {
        guard !values.isEmpty else { return 0 }
        return vDSP.mean(values)
    }

    static func standardDeviation(_ values: [Float]) -> Float {
        guard !values.isEmpty else { return 0 }
        let average = mean(values)
        return sqrt(mean(values.map { pow($0 - average, 2) }))
    }

    static func spectrumDb(_ input: ArraySlice<Float>, fftSize: Int = 1024) -> [Float] {
        if fftSize == 512 { return plan512.spectrumDb(input) }
        if fftSize == 1024 { return plan1024.spectrumDb(input) }
        return FFTPlan(size: fftSize).spectrumDb(input)
    }
}

private final class FFTPlan: @unchecked Sendable {
    private let fftSize: Int
    private let setup: FFTSetup
    private let window: [Float]
    private let lock = NSLock()

    init(size: Int) {
        fftSize = size
        let log2n = vDSP_Length(log2(Float(size)))
        guard let setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else {
            preconditionFailure("Could not create Accelerate FFT plan")
        }
        self.setup = setup
        var window = [Float](repeating: 0, count: size)
        vDSP_hann_window(&window, vDSP_Length(size), Int32(vDSP_HANN_DENORM))
        self.window = window
    }

    deinit { vDSP_destroy_fftsetup(setup) }

    func spectrumDb(_ input: ArraySlice<Float>) -> [Float] {
        lock.lock()
        defer { lock.unlock() }
        var frame = [Float](repeating: 0, count: fftSize)
        let source = Array(input.prefix(fftSize))
        frame.replaceSubrange(0..<source.count, with: source)
        vDSP.multiply(frame, window, result: &frame)
        let half = fftSize / 2
        var real = [Float](repeating: 0, count: half)
        var imaginary = [Float](repeating: 0, count: half)
        let log2n = vDSP_Length(log2(Float(fftSize)))
        frame.withUnsafeBytes { raw in
            real.withUnsafeMutableBufferPointer { realPointer in
                imaginary.withUnsafeMutableBufferPointer { imaginaryPointer in
                    var split = DSPSplitComplex(realp: realPointer.baseAddress!, imagp: imaginaryPointer.baseAddress!)
                    let complex = raw.baseAddress!.assumingMemoryBound(to: DSPComplex.self)
                    vDSP_ctoz(complex, 2, &split, 1, vDSP_Length(half))
                    vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(kFFTDirection_Forward))
                }
            }
        }
        var power = [Float](repeating: 0, count: half + 1)
        power[0] = real[0] * real[0] / 4
        power[half] = imaginary[0] * imaginary[0] / 4
        if half > 1 {
            for index in 1..<half {
                power[index] = (real[index] * real[index] + imaginary[index] * imaginary[index]) / 4
            }
        }
        return power.map { 10 * log10($0 + 1e-12) }
    }
}
