import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView {
            Form {
                TextField("Workspace", text: $model.workspace)
                TextField("Kulmi CLI path", text: $model.cliPath, prompt: Text("Leave blank to use kulmi from PATH"))
                Picker("Default model", selection: $model.model) {
                    Text("MiMo V2.5 Pro").tag("mimo-v2.5-pro")
                    Text("MiMo V2.5").tag("mimo-v2.5")
                    Text("Pro Token Plan").tag("mimo-v2.5-pro-token-plan")
                    Text("V2.5 Token Plan").tag("mimo-v2.5-token-plan")
                }
                Picker("Autonomy", selection: $model.autonomy) {
                    Text("Read only").tag("read")
                    Text("Low").tag("low")
                    Text("Medium").tag("medium")
                    Text("High").tag("high")
                }
                HStack {
                    Spacer()
                    Button("Save and reconnect") {
                        model.saveSettings()
                        model.connect()
                    }
                }
            }
            .padding(22)
            .tabItem { Label("General", systemImage: "gearshape") }

            Form {
                Picker("Search mode", selection: $model.searchMode) {
                    ForEach(SearchMode.allCases) { Text($0.label).tag($0) }
                }
                Toggle("Force MiMo native search", isOn: $model.forceNativeSearch)
                    .disabled(model.searchMode != .mimo)
                Text("External search uses the SearXNG or Brave backend configured in .kulmi/config.toml. MiMo native search is billed per keyword call and adds fetched pages to input tokens.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .padding(22)
            .tabItem { Label("Search", systemImage: "network") }
        }
        .tint(KulmiTheme.accent)
        .background(KulmiTheme.canvas)
    }
}
