import AVFAudio
import Foundation

@MainActor
final class SoundPlayer: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published private(set) var playing: SoundFixture?
    private var player: AVAudioPlayer?
    private var stopTask: Task<Void, Never>?

    func play(_ fixture: SoundFixture) throws {
        stop()
        guard let url = Bundle.main.url(forResource: fixture.resource, withExtension: "wav") ??
                Bundle.main.url(forResource: fixture.resource, withExtension: "wav", subdirectory: "Audio") else {
            throw CocoaError(.fileNoSuchFile)
        }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
        let player = try AVAudioPlayer(contentsOf: url)
        player.delegate = self
        player.prepareToPlay()
        player.play()
        self.player = player
        playing = fixture
        stopTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(fixture.durationMs) * 1_000_000)
            guard !Task.isCancelled else { return }
            self?.stop()
        }
    }

    func stop() {
        stopTask?.cancel()
        stopTask = nil
        player?.stop()
        player = nil
        playing = nil
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.stop() }
    }
}
