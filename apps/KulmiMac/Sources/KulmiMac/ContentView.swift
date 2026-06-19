import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 220, ideal: 250, max: 310)
        } content: {
            conversation
                .navigationSplitViewColumnWidth(min: 520, ideal: 720)
        } detail: {
            InspectorView()
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
        }
        .navigationSplitViewStyle(.balanced)
        .tint(KulmiTheme.accent)
        .background(KulmiTheme.canvas)
        .toolbar { toolbar }
        .onAppear {
            if model.connectionStatus == "Disconnected" { model.connect() }
        }
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Kulmi").font(.title2.weight(.semibold))
                Spacer()
                Button(action: model.newSession) { Image(systemName: "square.and.pencil") }
                    .buttonStyle(.plain)
                    .help("New session")
            }
            .padding(.horizontal, 14).padding(.vertical, 12)

            List(selection: Binding(
                get: { model.selectedSessionID },
                set: { id in
                    guard let id, let session = model.sessions.first(where: { $0.id == id }) else { return }
                    model.openSession(session)
                }
            )) {
                Section("Sessions") {
                    ForEach(model.sessions) { session in
                        SessionRow(session: session).tag(session.id)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .listStyle(.sidebar)

            HStack(spacing: 7) {
                Circle().fill(model.connectionStatus == "Connected" ? KulmiTheme.sage : .orange).frame(width: 7, height: 7)
                Text(model.connectionStatus).font(.caption).foregroundStyle(KulmiTheme.secondary)
                Spacer()
                Button(action: model.reloadSessions) { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain)
            }
            .padding(12)
        }
        .background(KulmiTheme.sidebar)
    }

    private var conversation: some View {
        VStack(spacing: 0) {
            if model.selectedSessionID == nil && model.items.isEmpty {
                EmptySessionView()
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 13) {
                            ForEach(model.items) { item in
                                ConversationRow(item: item).id(item.id)
                            }
                        }
                        .padding(.horizontal, 24).padding(.vertical, 20)
                    }
                    .onChange(of: model.items) { _, items in
                        if let last = items.last { withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(last.id, anchor: .bottom) } }
                    }
                }
            }
            Divider().overlay(KulmiTheme.hairline)
            composer
        }
        .background(KulmiTheme.canvas)
    }

    private var composer: some View {
        VStack(spacing: 8) {
            TextField("Ask MiMo to inspect, plan, or build…", text: Bindable(model).draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(2...8)
                .font(.body)
                .padding(12)
                .warmCard()
                .onSubmit { model.sendPrompt() }
            HStack {
                Label(model.model, systemImage: "cpu").font(.caption)
                Label(model.searchMode.label, systemImage: model.searchMode == .off ? "network.slash" : "network")
                    .font(.caption)
                Spacer()
                if model.isRunning {
                    Button("Stop", systemImage: "stop.fill", action: model.cancelRun)
                } else {
                    Button("Send", systemImage: "arrow.up", action: model.sendPrompt)
                        .keyboardShortcut(.return, modifiers: [.command])
                        .disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .foregroundStyle(KulmiTheme.secondary)
        }
        .padding(14)
        .background(KulmiTheme.surface)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Picker("Model", selection: Bindable(model).model) {
                Text("MiMo V2.5 Pro").tag("mimo-v2.5-pro")
                Text("MiMo V2.5").tag("mimo-v2.5")
                Text("Pro Token Plan").tag("mimo-v2.5-pro-token-plan")
                Text("V2.5 Token Plan").tag("mimo-v2.5-token-plan")
            }
            .frame(width: 170)
            Picker("Search", selection: Bindable(model).searchMode) {
                ForEach(SearchMode.allCases) { Text($0.label).tag($0) }
            }
            .frame(width: 130)
        }
    }
}

private struct SessionRow: View {
    let session: SessionSummary
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(session.title).lineLimit(2).font(.callout.weight(.medium))
            HStack {
                Text(session.model.replacingOccurrences(of: "mimo-", with: ""))
                Spacer()
                Text(session.status)
            }
            .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.vertical, 3)
    }
}

private struct EmptySessionView: View {
    var body: some View {
        ContentUnavailableView {
            Label("MiMo V2.5 Pro", systemImage: "sparkles.rectangle.stack")
        } description: {
            Text("Start a coding session. The runtime, tools, permissions, and subagents stay in the headless Kulmi process.")
        }
        .foregroundStyle(KulmiTheme.ink)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct ConversationRow: View {
    let item: ConversationItem

    var body: some View {
        HStack {
            if item.kind == .user { Spacer(minLength: 70) }
            VStack(alignment: .leading, spacing: 7) {
                Label(item.title, systemImage: icon).font(.caption.weight(.semibold)).foregroundStyle(labelColor)
                Text(item.text.isEmpty ? "…" : item.text)
                    .font(item.kind == .tool ? .system(.callout, design: .monospaced) : .body)
                    .textSelection(.enabled)
                    .foregroundStyle(item.kind == .reasoning ? KulmiTheme.secondary : KulmiTheme.ink)
            }
            .padding(12)
            .frame(maxWidth: item.kind == .user ? 620 : .infinity, alignment: .leading)
            .warmCard()
            if item.kind != .user { Spacer(minLength: 24) }
        }
    }

    private var icon: String {
        switch item.kind {
        case .user: "person.fill"
        case .assistant: "sparkles"
        case .reasoning: "brain"
        case .tool: "wrench.and.screwdriver"
        case .notice: "info.circle"
        case .error: "exclamationmark.triangle"
        }
    }
    private var labelColor: Color { item.kind == .error ? .red : item.kind == .tool ? KulmiTheme.sage : KulmiTheme.accent }
}
