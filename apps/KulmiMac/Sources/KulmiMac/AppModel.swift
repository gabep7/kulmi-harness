import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
    var sessions: [SessionSummary] = []
    var selectedSessionID: String?
    var items: [ConversationItem] = []
    var draft = ""
    var workspace = FileManager.default.homeDirectoryForCurrentUser.path
    var model = "mimo-v2.5-pro"
    var searchMode: SearchMode = .external
    var forceNativeSearch = false
    var autonomy = "medium"
    var cliPath = ""
    var isRunning = false
    var connectionStatus = "Disconnected"
    var usage = UsageSnapshot()
    var inspectorVisible = true

    private let rpc = RPCClient()
    private var streamedText = ""
    private var streamedReasoning = ""
    private var assistantItemID: UUID?
    private var reasoningItemID: UUID?

    init() {
        cliPath = UserDefaults.standard.string(forKey: "kulmi.cliPath") ?? ""
        workspace = UserDefaults.standard.string(forKey: "kulmi.workspace") ?? workspace
        model = UserDefaults.standard.string(forKey: "kulmi.model") ?? model
        searchMode = SearchMode(rawValue: UserDefaults.standard.string(forKey: "kulmi.searchMode") ?? "external") ?? .external
        rpc.onNotification = { [weak self] method, params in self?.handleNotification(method, params) }
        rpc.onTermination = { [weak self] message in
            self?.connectionStatus = "Disconnected"
            self?.isRunning = false
            self?.append(.error, title: "Runtime", text: message)
        }
    }

    func connect() {
        do {
            try rpc.start(cliPath: cliPath, cwd: workspace)
            connectionStatus = "Connecting"
            rpc.request(method: "initialize") { [weak self] result in
                switch result {
                case .success:
                    self?.connectionStatus = "Connected"
                    self?.reloadSessions()
                case .failure(let error): self?.show(error)
                }
            }
        } catch { show(error) }
    }

    func newSession() {
        ensureConnected { [weak self] in
            guard let self else { return }
            let params: [String: Any] = [
                "cwd": workspace,
                "mode": "task",
                "model": model,
                "autonomy": autonomy,
                "webSearch": searchMode.rawValue,
                "forceWebSearch": forceNativeSearch,
            ]
            rpc.request(method: "session.open", params: params) { [weak self] result in
                self?.consumeOpen(result)
            }
        }
    }

    func openSession(_ summary: SessionSummary) {
        ensureConnected { [weak self] in
            guard let self else { return }
            rpc.request(method: "session.open", params: [
                "cwd": summary.cwd,
                "sessionId": summary.id,
                "mode": "task",
                "autonomy": autonomy,
                "webSearch": searchMode.rawValue,
                "forceWebSearch": forceNativeSearch,
            ]) { [weak self] result in self?.consumeOpen(result) }
        }
    }

    func sendPrompt() {
        let prompt = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !isRunning else { return }
        if selectedSessionID == nil {
            newSessionAndSend(prompt)
            return
        }
        draft = ""
        append(.user, title: "You", text: prompt)
        beginStream()
        isRunning = true
        rpc.request(method: "session.prompt", params: ["sessionId": selectedSessionID!, "prompt": prompt]) { [weak self] result in
            if case .failure(let error) = result {
                self?.isRunning = false
                self?.show(error)
            }
        }
    }

    func cancelRun() {
        guard let selectedSessionID, isRunning else { return }
        rpc.request(method: "session.cancel", params: ["sessionId": selectedSessionID]) { _ in }
    }

    func reloadSessions() {
        guard connectionStatus == "Connected" else { return }
        rpc.request(method: "sessions.list", params: ["limit": 80]) { [weak self] result in
            guard case .success(let raw) = result, let rows = raw as? [[String: Any]] else {
                if case .failure(let error) = result { self?.show(error) }
                return
            }
            self?.sessions = rows.compactMap(SessionSummary.init(json:))
        }
    }

    func saveSettings() {
        UserDefaults.standard.set(cliPath, forKey: "kulmi.cliPath")
        UserDefaults.standard.set(workspace, forKey: "kulmi.workspace")
        UserDefaults.standard.set(model, forKey: "kulmi.model")
        UserDefaults.standard.set(searchMode.rawValue, forKey: "kulmi.searchMode")
    }

    private func newSessionAndSend(_ prompt: String) {
        draft = prompt
        newSession()
    }

    private func consumeOpen(_ result: Result<Any, Error>) {
        guard case .success(let raw) = result, let object = raw as? [String: Any], let sessionID = object["sessionId"] as? String else {
            if case .failure(let error) = result { show(error) }
            return
        }
        selectedSessionID = sessionID
        items = decodeMessages(object["messages"] as? [[String: Any]] ?? [])
        usage = UsageSnapshot()
        reloadSessions()
        if !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { sendPrompt() }
    }

    private func ensureConnected(_ action: @escaping () -> Void) {
        if connectionStatus == "Connected" { action(); return }
        connect()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self] in
            guard self?.connectionStatus == "Connected" else { return }
            action()
        }
    }

    private func handleNotification(_ method: String, _ params: [String: Any]) {
        switch method {
        case "event":
            guard params["sessionId"] as? String == selectedSessionID,
                  let envelope = params["envelope"] as? [String: Any],
                  let event = envelope["event"] as? [String: Any],
                  let type = event["type"] as? String else { return }
            handleEvent(type, event)
        case "run.completed":
            guard params["sessionId"] as? String == selectedSessionID else { return }
            isRunning = false
            finishStream()
            reloadSessions()
        case "run.failed":
            guard params["sessionId"] as? String == selectedSessionID else { return }
            isRunning = false
            finishStream()
            append(.error, title: "Run failed", text: params["message"] as? String ?? "Unknown error")
        case "stderr":
            let text = params["message"] as? String ?? ""
            if !text.isEmpty { append(.notice, title: "Runtime", text: text) }
        default: break
        }
    }

    private func handleEvent(_ type: String, _ event: [String: Any]) {
        switch type {
        case "assistant.reasoning.delta":
            streamedReasoning += event["text"] as? String ?? ""
            updateItem(id: reasoningItemID, text: streamedReasoning)
        case "assistant.text.delta":
            streamedText += event["text"] as? String ?? ""
            updateItem(id: assistantItemID, text: streamedText)
        case "tool.started":
            let tool = event["tool"] as? String ?? "tool"
            append(.tool, title: tool, text: prettyJSON(event["input"]))
        case "tool.finished":
            let tool = event["tool"] as? String ?? "tool"
            let failed = event["isError"] as? Bool ?? false
            append(failed ? .error : .tool, title: failed ? "\(tool) failed" : "\(tool) finished", text: event["output"] as? String ?? "")
        case "assistant.citations":
            let citations = event["citations"] as? [[String: Any]] ?? []
            let text = citations.compactMap { citation -> String? in
                guard let title = citation["title"] as? String, let url = citation["url"] as? String else { return nil }
                return "\(title)\n\(url)"
            }.joined(separator: "\n\n")
            if !text.isEmpty { append(.notice, title: "Sources", text: text) }
        case "usage":
            if let raw = event["usage"] as? [String: Any] { accumulateUsage(raw) }
        case "notice": append(.notice, title: "Notice", text: event["message"] as? String ?? "")
        case "error": append(.error, title: "Error", text: event["message"] as? String ?? "")
        default: break
        }
    }

    private func beginStream() {
        streamedText = ""
        streamedReasoning = ""
        let reasoning = ConversationItem(kind: .reasoning, title: "Thinking", text: "")
        let assistant = ConversationItem(kind: .assistant, title: "MiMo", text: "")
        reasoningItemID = reasoning.id
        assistantItemID = assistant.id
        items.append(reasoning)
        items.append(assistant)
    }

    private func finishStream() {
        items.removeAll { ($0.id == reasoningItemID || $0.id == assistantItemID) && $0.text.isEmpty }
        reasoningItemID = nil
        assistantItemID = nil
    }

    private func updateItem(id: UUID?, text: String) {
        guard let id, let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].text = text
    }

    private func append(_ kind: ConversationItem.Kind, title: String, text: String) {
        items.append(ConversationItem(kind: kind, title: title, text: text))
    }

    private func show(_ error: Error) {
        connectionStatus = rpcErrorIsConnection(error) ? "Disconnected" : connectionStatus
        append(.error, title: "Error", text: error.localizedDescription)
    }

    private func accumulateUsage(_ raw: [String: Any]) {
        usage.prompt += raw.int("promptTokens")
        usage.completion += raw.int("completionTokens")
        usage.cached += raw.int("cacheHitTokens")
        usage.fresh += raw.int("cacheMissTokens")
        usage.reasoning += raw.int("reasoningTokens")
        usage.webCalls += raw.int("webSearchCalls")
        usage.webPages += raw.int("webSearchPages")
    }
}

private extension SessionSummary {
    init?(json: [String: Any]) {
        guard let id = json["id"] as? String, let cwd = json["cwd"] as? String else { return nil }
        self.init(
            id: id,
            title: (json["prompt"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "New session",
            model: json["model"] as? String ?? "mimo-v2.5-pro",
            status: json["status"] as? String ?? "idle",
            cwd: cwd,
            updatedAt: json["updatedAt"] as? String ?? ""
        )
    }
}

private extension AppModel {
    func decodeMessages(_ messages: [[String: Any]]) -> [ConversationItem] {
        messages.compactMap { message in
            guard let role = message["role"] as? String else { return nil }
            switch role {
            case "user": return ConversationItem(kind: .user, title: "You", text: message["content"] as? String ?? "")
            case "assistant": return ConversationItem(kind: .assistant, title: "MiMo", text: message["content"] as? String ?? "")
            case "tool": return ConversationItem(kind: .tool, title: message["name"] as? String ?? "Tool", text: message["content"] as? String ?? "")
            default: return nil
            }
        }
    }

    func prettyJSON(_ value: Any?) -> String {
        guard let value, JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) else {
            return value.map(String.init(describing:)) ?? ""
        }
        return String(data: data, encoding: .utf8) ?? ""
    }

    func rpcErrorIsConnection(_ error: Error) -> Bool {
        error.localizedDescription.localizedCaseInsensitiveContains("not running")
    }
}

private extension [String: Any] {
    func int(_ key: String) -> Int { self[key] as? Int ?? 0 }
}
