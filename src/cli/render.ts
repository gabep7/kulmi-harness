import pc from "picocolors";
import type { EventBus, EventEnvelope } from "../core/events.js";
import { describeToolCall, summarizeToolResult, toolLabel } from "../core/tool-summary.js";
import type { OutputFormat } from "../core/types.js";

export function attachRenderer(bus: EventBus, format: OutputFormat, _model?: string): () => void {
  let streamedText = false;
  return bus.on((envelope) => {
    if (format === "stream-json") {
      process.stdout.write(`${JSON.stringify(envelope)}\n`);
      return;
    }
    if (format === "json") return;
    renderText(
      envelope,
      () => { streamedText = true; },
      () => streamedText,
      () => { streamedText = false; },
    );
  });
}
function renderText(
  envelope: EventEnvelope,
  markStreamed: () => void,
  wasStreamed: () => boolean,
  resetStreamed: () => void,
): void {
  const event = envelope.event;
  switch (event.type) {
    case "assistant.text.delta":
      process.stdout.write(event.text);
      markStreamed();
      break;
    case "assistant.message":
      if (!wasStreamed() && event.text) process.stdout.write(event.text);
      process.stdout.write("\n");
      resetStreamed();
      break;
    case "assistant.citations":
      for (const citation of event.citations) {
        process.stderr.write(`${pc.dim("source")} ${citation.title} ${pc.dim(citation.url)}\n`);
      }
      break;
    case "tool.started": {
      const { label, detail } = describeToolCall(event.tool, event.input);
      process.stderr.write(`${pc.dim("›")} ${label}${detail ? ` ${pc.dim(detail)}` : ""}\n`);
      break;
    }
    case "tool.finished": {
      const summary = summarizeToolResult(event.tool, event.output, event.isError);
      const glyph = event.isError ? pc.red("×") : pc.green("✓");
      const outcome = summary ? ` ${event.isError ? pc.red(summary) : summary}` : "";
      process.stderr.write(`${glyph} ${toolLabel(event.tool)}${outcome} ${pc.dim(`${event.durationMs}ms`)}\n`);
      if (event.diff) process.stderr.write(`${pc.dim(event.diff)}\n`);
      break;
    }
    case "plan.updated": {
      const done = event.steps.filter((step) => step.status === "completed").length;
      process.stderr.write(`${pc.cyan("plan")} ${done}/${event.steps.length}\n`);
      break;
    }
    case "permission.requested":
      process.stderr.write(`${pc.yellow("approval")} ${event.request.tool} ${pc.dim(event.request.reason)}\n`);
      break;
    case "permission.resolved":
      process.stderr.write(`${event.approved ? pc.green("approved") : pc.red("denied")} ${pc.dim(event.requestId)}\n`);
      break;
    case "usage":
      if (event.usage.totalTokens > 0) {
        const cacheInput = event.usage.cacheHitTokens + event.usage.cacheMissTokens;
        const cacheRate = cacheInput > 0 ? Math.round(event.usage.cacheHitTokens / cacheInput * 100) : 0;
        const searchUsage = event.usage.webSearchCalls
          ? `, ${event.usage.webSearchCalls} searches, ${event.usage.webSearchPages ?? 0} pages`
          : "";
        process.stderr.write(
          pc.dim(
            `tokens ${event.usage.totalTokens} (${cacheRate}% cache, ${event.usage.reasoningTokens ?? 0} thinking${searchUsage})\n`,
          ),
        );
      }
      break;
    case "error":
      process.stderr.write(`${pc.red("error")} ${event.message}\n`);
      break;
    case "notice":
      process.stderr.write(`${pc.dim(event.message)}\n`);
      break;
    default:
      break;
  }
}
