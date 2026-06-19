import { createHash } from "node:crypto";
import type { EventBus } from "../core/events.js";
import type { AutonomyLevel, CompletionRecord, RunState } from "../core/types.js";
import type { ModelProvider, ProviderMessage, ProviderTool } from "../provider/types.js";
import type { CheckpointStore } from "../runtime/checkpoints.js";
import type { ArtifactStore } from "../runtime/artifacts.js";
import type { SessionStore } from "../runtime/session-store.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionApi, SubagentApi, ToolContext } from "../tools/types.js";

export interface AgentOptions {
  provider: ModelProvider;
  tools: ToolRegistry;
  events: EventBus;
  session: SessionStore;
  checkpoint: CheckpointStore;
  artifacts: ArtifactStore;
  state: RunState;
  systemPrompt: string;
  workspaceRoot: string;
  cwd: string;
  autonomy: AutonomyLevel;
  maxSteps: number;
  commandTimeoutMs: number;
  maxOutputBytes: number;
  contextWindow: number;
  messages?: ProviderMessage[];
  subagents?: SubagentApi;
  permissions?: PermissionApi;
}

export interface AgentResult {
  status: RunState["status"];
  text: string;
  messages: ProviderMessage[];
}

export class Agent {
  readonly #options: AgentOptions;
  readonly #messages: ProviderMessage[];
  readonly #steering: string[] = [];

  constructor(options: AgentOptions) {
    this.#options = options;
    this.#messages = sanitizeToolPairing(
      options.messages?.length
        ? options.messages
        : [{ role: "system", content: options.systemPrompt }],
    );
  }

  get messages(): ProviderMessage[] {
    return this.#messages;
  }

  steer(message: string): void {
    const value = message.trim();
    if (!value) throw new Error("steering message cannot be empty");
    this.#steering.push(value);
  }

  async run(prompt: string, signal: AbortSignal): Promise<AgentResult> {
    const { state, events } = this.#options;
    state.status = "running";
    delete state.completion;
    await this.#options.checkpoint.beginTurn(this.#messages.length, state.agentId);
    await events.emit({
      type: "agent.started",
      agentId: state.agentId,
      ...(state.parentAgentId ? { parentAgentId: state.parentAgentId } : {}),
      prompt,
    });
    this.#messages.push({ role: "user", content: prompt });
    await this.#options.session.saveMessages(this.#messages);

    let consecutiveBareFinals = 0;
    let previousCall = "";
    let repeatedCalls = 0;
    let previousError = "";
    let repeatedErrors = 0;
    let providerTools = this.#providerTools();
    let promptTokens = estimateTokens(this.#messages, providerTools);

    try {
      for (let step = 0; step < this.#options.maxSteps; step++) {
        if (signal.aborted) throw signal.reason ?? new Error("agent cancelled");
        if (this.#steering.length > 0) {
          const steering = this.#steering.splice(0);
          this.#messages.push({
            role: "user",
            content: `<parent-steering>\n${steering.join("\n\n")}\n</parent-steering>`,
          });
          await this.#options.session.saveMessages(this.#messages);
        }
        if (promptTokens >= this.#options.contextWindow * 0.78) {
          await this.#compact(signal);
          providerTools = this.#providerTools();
          promptTokens = estimateTokens(this.#messages, providerTools);
        }
        const response = await this.#options.provider.complete({
          messages: this.#messages,
          tools: providerTools,
          signal,
          cacheScope: `${state.agentId}:${state.mode}`,
          onReasoningDelta: (text) => events.emit({
            type: "assistant.reasoning.delta",
            agentId: state.agentId,
            text,
          }).then(() => undefined),
          onTextDelta: (text) => events.emit({
            type: "assistant.text.delta",
            agentId: state.agentId,
            text,
          }).then(() => undefined),
          onCitations: (citations) => events.emit({
            type: "assistant.citations",
            agentId: state.agentId,
            citations,
          }).then(() => undefined),
        });
        await events.emit({ type: "usage", agentId: state.agentId, usage: response.usage });
        if (response.searchError) {
          await events.emit({
            type: "notice",
            agentId: state.agentId,
            message: `MiMo web search: ${response.searchError}`,
          });
        }
        promptTokens = response.usage.promptTokens || estimateTokens(this.#messages, providerTools);

        if (response.finishReason === "length") {
          throw new Error("MiMo stopped because the output limit was reached");
        }
        if (response.finishReason === "content_filter") {
          throw new Error("MiMo stopped because content was filtered");
        }
        if (response.finishReason === "insufficient_system_resource") {
          throw new Error("MiMo stopped because inference resources were unavailable");
        }
        if (response.finishReason === "repetition_truncation") {
          throw new Error("MiMo stopped after detecting repetitive output");
        }

        const calls = response.message.tool_calls ?? [];
        this.#messages.push(response.message);
        await this.#options.session.saveMessages(this.#messages);

        if (calls.length > 0) {
          consecutiveBareFinals = 0;
          const context = this.#toolContext(signal);
          const runCall = async (call: (typeof calls)[number]) => {
            const fingerprint = hashCall(call.function.name, call.function.arguments);
            if (fingerprint === previousCall) repeatedCalls += 1;
            else {
              previousCall = fingerprint;
              repeatedCalls = 1;
            }

            let result;
            if (repeatedCalls >= 10) {
              result = {
                content: `repeated identical tool call blocked after ${repeatedCalls} attempts; change approach`,
                isError: true,
              };
            } else {
              result = await this.#options.tools.execute({
                name: call.function.name,
                argumentsJson: call.function.arguments,
                callId: call.id,
                context,
              });
            }
            if (result.isError) {
              if (result.content === previousError) repeatedErrors += 1;
              else {
                previousError = result.content;
                repeatedErrors = 1;
              }
            } else {
              previousError = "";
              repeatedErrors = 0;
            }
            return { call, result };
          };

          const parallel = calls.every((call) =>
            this.#options.tools.isParallelSafe(call.function.name, call.function.arguments)
          );
          const appendResult = async ({ call, result }: Awaited<ReturnType<typeof runCall>>) => {
            this.#messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: result.content,
            });
            await this.#options.session.saveMessages(this.#messages);
            await this.#options.session.saveRunState(state);
          };
          if (parallel) {
            const results = await Promise.all(calls.map(runCall));
            for (const result of results) await appendResult(result);
          } else {
            for (const call of calls) await appendResult(await runCall(call));
          }
          providerTools = this.#providerTools();
          promptTokens = Math.max(promptTokens, estimateTokens(this.#messages, providerTools));
          if (repeatedErrors >= 10) throw new Error("agent repeated the same tool error ten times");
          continue;
        }

        const text = response.message.content?.trim() ?? "";
        const completion = currentCompletion(state);
        if (!text && completion === undefined && state.mode !== "task") {
          consecutiveBareFinals += 1;
          if (consecutiveBareFinals >= 3) throw new Error("agent returned three empty final responses");
          this.#messages.push({
            role: "user",
            content: "Your previous response was empty. Provide a concrete answer or use the available tools.",
          });
          await this.#options.session.saveMessages(this.#messages);
          continue;
        }
        if (state.mode !== "task" || completion !== undefined) {
          state.status = completion?.status ?? "completed";
          await this.#options.session.saveRunState(state);
          await events.emit({ type: "assistant.message", agentId: state.agentId, text });
          await events.emit({ type: "agent.finished", agentId: state.agentId, status: state.status, result: text });
          return { status: state.status, text: text || completion?.summary || "", messages: this.#messages };
        }

        consecutiveBareFinals += 1;
        if (consecutiveBareFinals >= 3) {
          throw new Error("agent stopped without satisfying the completion gate");
        }
        this.#messages.push({
          role: "user",
          content:
            "The task is not complete until complete_task accepts it. Continue working, verify changes, update the plan, then call complete_task. Do not only restate progress.",
        });
        await this.#options.session.saveMessages(this.#messages);
      }
      throw new Error(`agent exceeded the ${this.#options.maxSteps}-step limit`);
    } catch (error) {
      state.status = signal.aborted ? "cancelled" : "failed";
      await this.#options.session.saveRunState(state);
      const message = error instanceof Error ? error.message : String(error);
      await events.emit({ type: "agent.finished", agentId: state.agentId, status: state.status, result: message });
      throw error;
    }
  }

  #toolContext(signal: AbortSignal): ToolContext {
    const options = this.#options;
    return {
      workspaceRoot: options.workspaceRoot,
      cwd: options.cwd,
      autonomy: options.autonomy,
      signal,
      events: options.events,
      state: options.state,
      checkpoint: options.checkpoint,
      artifacts: options.artifacts,
      commandTimeoutMs: options.commandTimeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      ...(options.subagents ? { subagents: options.subagents } : {}),
      ...(options.permissions ? { permissions: options.permissions } : {}),
    };
  }

  #providerTools(): ProviderTool[] {
    if (this.#options.state.mode === "chat") {
      return this.#options.tools.providerTools(["start_task"]);
    }
    return this.#options.tools.providerTools().filter((tool) => tool.function.name !== "start_task");
  }

  async #compact(signal: AbortSignal): Promise<void> {
    if (this.#messages.length < 16) {
      throw new Error("context limit reached before a safe compaction boundary was available");
    }
    let boundary = this.#messages.length - 12;
    while (boundary > 1 && this.#messages[boundary]?.role === "tool") boundary -= 1;
    if (boundary <= 1) throw new Error("context limit reached before a safe compaction boundary was available");

    const compacted = this.#messages.slice(1, boundary);
    const response = await this.#options.provider.complete({
      messages: [
        {
          role: "system",
          content:
            "Summarize this coding-agent history for continuation. Preserve user requirements, decisions, files changed, commands and outcomes, open plan steps, blockers, and exact artifact IDs. Do not include hidden chain-of-thought.",
        },
        { role: "user", content: JSON.stringify(compacted) },
      ],
      tools: [],
      signal,
      thinking: false,
      maxCompletionTokens: 8_192,
    });
    const summary = response.message.content?.trim();
    if (!summary || response.message.tool_calls?.length) throw new Error("context compaction did not produce a summary");
    await this.#options.session.archiveMessages(this.#messages, "compaction");
    this.#messages.splice(
      1,
      boundary - 1,
      { role: "user", content: `<compaction-summary>\n${summary}\n</compaction-summary>` },
    );
    await this.#options.session.saveMessages(this.#messages);
    await this.#options.events.emit({
      type: "notice",
      agentId: this.#options.state.agentId,
      message: `compacted ${compacted.length} messages after reaching the context threshold`,
    });
    await this.#options.events.emit({
      type: "usage",
      agentId: this.#options.state.agentId,
      usage: response.usage,
    });
  }
}

function hashCall(name: string, argumentsJson: string): string {
  return createHash("sha256").update(name).update("\0").update(argumentsJson).digest("hex");
}

function currentCompletion(state: RunState): CompletionRecord | undefined {
  return state.completion;
}

function estimateTokens(messages: ProviderMessage[], tools: ProviderTool[] = []): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify({ messages, tools }), "utf8") / 3);
}

export function sanitizeToolPairing(messages: ProviderMessage[]): ProviderMessage[] {
  const output: ProviderMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) continue;
    if (message.role !== "assistant" || !message.tool_calls?.length) {
      output.push(message);
      continue;
    }
    const results = new Map<string, Extract<ProviderMessage, { role: "tool" }>>();
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]?.role === "tool") {
      const result = messages[cursor];
      if (result?.role === "tool") results.set(result.tool_call_id, result);
      cursor += 1;
    }
    output.push(message);
    for (const call of message.tool_calls) {
      output.push(results.get(call.id) ?? {
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify({
          error: "execution outcome is uncertain after an interrupted session; do not blindly repeat this side effect",
        }),
      });
    }
    index = cursor - 1;
  }
  return output;
}
