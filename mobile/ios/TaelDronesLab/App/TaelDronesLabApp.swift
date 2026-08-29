import SwiftUI

@main
struct TaelDronesLabApp: App {
    @StateObject private var state = AppState()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(state)
                .onChange(of: scenePhase) { phase in
                    if phase != .active { state.applicationEnteredBackground() }
                }
        }
    }
}
