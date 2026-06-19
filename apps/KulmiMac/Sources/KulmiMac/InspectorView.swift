import SwiftUI

struct InspectorView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Session").font(.headline)
                LabeledContent("Model", value: model.model)
                LabeledContent("Autonomy", value: model.autonomy.capitalized)
                LabeledContent("Search", value: model.searchMode.label)
                if model.searchMode == .mimo {
                    Toggle("Force search", isOn: $model.forceNativeSearch)
                }

                Divider()
                Text("Prompt cache").font(.headline)
                Gauge(value: model.usage.cacheRate) {
                    Text("Cache hit")
                } currentValueLabel: {
                    Text(model.usage.cacheRate, format: .percent.precision(.fractionLength(1)))
                }
                .gaugeStyle(.accessoryLinearCapacity)
                .tint(KulmiTheme.sage)
                MetricRow(label: "Cached", value: model.usage.cached.formatted())
                MetricRow(label: "Fresh", value: model.usage.fresh.formatted())
                MetricRow(label: "Thinking", value: model.usage.reasoning.formatted())

                Divider()
                Text("Usage").font(.headline)
                MetricRow(label: "Input", value: model.usage.prompt.formatted())
                MetricRow(label: "Output", value: model.usage.completion.formatted())
                MetricRow(label: "Web calls", value: model.usage.webCalls.formatted())
                MetricRow(label: "Web pages", value: model.usage.webPages.formatted())

                Divider()
                Text("Workspace").font(.headline)
                Text(model.workspace)
                    .font(.caption.monospaced())
                    .foregroundStyle(KulmiTheme.secondary)
                    .textSelection(.enabled)
            }
            .padding(18)
        }
        .background(KulmiTheme.surface)
    }
}

private struct MetricRow: View {
    let label: String
    let value: String
    var body: some View {
        HStack { Text(label).foregroundStyle(.secondary); Spacer(); Text(value).monospacedDigit() }
            .font(.callout)
    }
}
