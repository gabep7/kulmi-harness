import Foundation

struct SessionSummary: Identifiable, Hashable {
    let id: String
    var title: String
    var model: String
    var status: String
    var cwd: String
    var updatedAt: String
}

struct ConversationItem: Identifiable, Hashable {
    enum Kind: Hashable { case user, assistant, reasoning, tool, notice, error }
    let id: UUID
    var kind: Kind
    var title: String
    var text: String
    var detail: String?

    init(kind: Kind, title: String, text: String, detail: String? = nil) {
        self.id = UUID()
        self.kind = kind
        self.title = title
        self.text = text
        self.detail = detail
    }
}

struct UsageSnapshot: Hashable {
    var prompt = 0
    var completion = 0
    var cached = 0
    var fresh = 0
    var reasoning = 0
    var webCalls = 0
    var webPages = 0

    var cacheRate: Double {
        let total = cached + fresh
        return total == 0 ? 0 : Double(cached) / Double(total)
    }
}

enum SearchMode: String, CaseIterable, Identifiable {
    case off
    case mimo
    case external
    var id: String { rawValue }
    var label: String {
        switch self {
        case .off: "Off"
        case .mimo: "MiMo native"
        case .external: "External"
        }
    }
}
