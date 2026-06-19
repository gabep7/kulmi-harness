import SwiftUI

@main
struct KulmiMacApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model)
                .frame(minWidth: 980, minHeight: 680)
        }
        .defaultSize(width: 1240, height: 820)
        .windowToolbarStyle(.unified(showsTitle: false))
        .commands {
            CommandGroup(after: .newItem) {
                Button("New Session") { model.newSession() }
                    .keyboardShortcut("n", modifiers: [.command])
                Button("Stop") { model.cancelRun() }
                    .keyboardShortcut(".", modifiers: [.command])
                    .disabled(!model.isRunning)
            }
        }

        Settings {
            SettingsView()
                .environment(model)
                .frame(width: 560, height: 390)
        }
    }
}
