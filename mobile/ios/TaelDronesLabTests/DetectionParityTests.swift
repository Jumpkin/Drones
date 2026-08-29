import XCTest
@testable import TaelDronesLab

final class DetectionParityTests: XCTestCase {
    private func harmonicSignal() -> [Float] {
        (0..<16_000).map { index in
            let phase = 2 * Double.pi * Double(index) / 16_000
            return Float(0.5 * sin(220 * phase) + 0.25 * sin(440 * phase) + 0.12 * sin(660 * phase))
        }
    }

    func testLinearResamplingMatchesWebContract() {
        let output = AudioMath.resampleLinear([0, 1, 0, -1], sourceRate: 4, targetRate: 8)
        XCTAssertEqual(output, [0, 0.5, 1, 0.5, 0, -0.5, -1, -1])
    }

    func testTemporalVoteUsesThreeOfFiveContract() {
        var vote = TemporalVote(threshold: 0.5, required: 3, windowCount: 5)
        XCTAssertTrue(vote.append(0.8).detected)
        XCTAssertFalse(vote.append(0.1).detected)
        XCTAssertTrue(vote.append(0.8).detected)
        XCTAssertFalse(vote.append(0.1).detected)
        let final = vote.append(0.8)
        XCTAssertTrue(final.detected)
        XCTAssertEqual(final.positives, 3)
        XCTAssertEqual(final.analyzed, 5)
    }

    func testFeatureVectorMatchesTypeScriptGoldenSignal() {
        let actual = FeatureExtractor.extract(harmonicSignal(), sampleRate: 16_000)
        let expected: [Float] = [
            1, 1, 1, 0.13671875, 0.070360966, 0.029673109, 0.000000000116,
            1, 0.170856878, 0.0275, 0, 0, 0, 0, 1, 1,
        ]
        XCTAssertEqual(actual.count, expected.count)
        for index in expected.indices {
            XCTAssertEqual(actual[index], expected[index], accuracy: 0.025, "feature \(index)")
        }
    }

    func testCRNNLogMelShapeAndSelectedGoldenValues() {
        let actual = CRNNPreprocessor.extract(harmonicSignal(), sampleRate: 16_000)
        XCTAssertEqual(actual.count, 64 * 101)
        let expected: [(Int, Float)] = [(0, 1.5896326), (100, 1.5880438), (101, 1.6165986),
                                        (3_200, -0.1217138), (6_463, 0.6448815)]
        for (index, value) in expected {
            XCTAssertEqual(actual[index], value, accuracy: 0.08, "log-mel \(index)")
        }
    }

    func testBothONNXModelsExecuteOnSameWindow() throws {
        let output = try DetectionPipeline().analyze(harmonicSignal(), sampleRate: 16_000)
        XCTAssertEqual(Set(output.results.map(\.detectorId)), Set(DetectorID.allCases))
        XCTAssertTrue(output.results.allSatisfy { $0.probability.isFinite && (0...1).contains($0.probability) })
    }

    func testCalibrationPlaybackMetadataDecodesFromAPI() throws {
        let json = """
        {
          "id":"11111111-1111-4111-8111-111111111111",
          "source_device_id":"22222222-2222-4222-8222-222222222222",
          "sound_id":"synth-traffic",
          "expected_label":"background",
          "scheduled_at":"2026-08-29T12:00:00.000Z",
          "duration_ms":4000,
          "source_kind":"computer",
          "distance_m":3,
          "volume_percent":50,
          "environment":"traffic",
          "created_at":"2026-08-29T11:59:57.000Z"
        }
        """
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let playback = try decoder.decode(SessionPlayback.self, from: Data(json.utf8))
        XCTAssertEqual(playback.sourceKind, "computer")
        XCTAssertEqual(playback.distanceM, 3)
        XCTAssertEqual(playback.volumePercent, 50)
        XCTAssertEqual(playback.environment, "traffic")
    }
}
