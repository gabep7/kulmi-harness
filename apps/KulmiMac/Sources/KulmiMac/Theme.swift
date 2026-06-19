import SwiftUI

enum KulmiTheme {
    static let canvas = Color(red: 0.957, green: 0.925, blue: 0.874)
    static let sidebar = Color(red: 0.925, green: 0.882, blue: 0.812)
    static let surface = Color(red: 0.992, green: 0.973, blue: 0.937)
    static let elevated = Color(red: 1.0, green: 0.988, blue: 0.965)
    static let ink = Color(red: 0.20, green: 0.17, blue: 0.14)
    static let secondary = Color(red: 0.43, green: 0.38, blue: 0.33)
    static let hairline = Color(red: 0.72, green: 0.65, blue: 0.56).opacity(0.42)
    static let accent = Color(red: 0.60, green: 0.31, blue: 0.23)
    static let sage = Color(red: 0.39, green: 0.45, blue: 0.35)
}

struct WarmCard: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(KulmiTheme.elevated.opacity(0.86), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(KulmiTheme.hairline, lineWidth: 0.7)
            }
    }
}

extension View {
    func warmCard() -> some View { modifier(WarmCard()) }
}
