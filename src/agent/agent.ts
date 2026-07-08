import { createHash } from "node:crypto";
import { extname } from "node:path";
import { readFile } from "node:fs/promises";
import type { EventBus } from "../core/events.js";
import type { AutonomyLevel, CompletionRecord, RunState } from "../core/types.js";
import type { ModelProvider, ProviderContentPart, ProviderMessage, ProviderTool } from "../provider/types.js";
import type { CheckpointStore } from "../runtime/checkpoints.js";
import type { ArtifactStore } from "../runtime/artifacts.js";
import type { SessionStore } from "../runtime/session-store.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionApi, SubagentApi, ToolContext } from "../tools/types.js";
import type { HooksConfig, SandboxConfig } from "../config/config.js";
import { assertNotSensitivePath, resolveWorkspacePath } from "../security/paths.js";

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
  sandbox?: SandboxConfig;
  messages?: ProviderMessage[];
  subagents?: SubagentApi;
  permissions?: PermissionApi;
  hooks?: HooksConfig;
}

export interface AgentResult {
  status: RunState["status"];
  text: string;
  messages: ProviderMessage[];
}

export interface AgentUndoTransaction {
  removedMessages: ProviderMessage[];
  rollback(): Promise<void>;
}

const identicalCallWarningAt = 3;
const identicalCallStopAt = 4;
const repeatedErrorLimit = 5;

export class Agent {
  readonly #options: AgentOptions;
  readonly #messages: ProviderMessage[];
  readonly #steering: string[] = [];
  #stickyContext = "";
  #cacheEpoch = 0;
  #running = false;

  constructor(options: AgentOptions) {
    this.#options = options;
    const history = options.messages?.length
      ? options.messages
      : [{ role: "system" as const, content: options.systemPrompt }];
    this.#messages = sanitizeToolPairing(
      history[0]?.role === "system"
        ? history
        : [{ role: "system", content: options.systemPrompt }, ...history],
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

  setAutonomy(autonomy: AutonomyLevel): void {
    this.#options.autonomy = autonomy;
  }

  async appendRuntimeContext(message: string): Promise<void> {
    if (this.#running) throw new Error("cannot change runtime context while the agent is running");
    const context: ProviderMessage = { role: "user", content: `<runtime-context>${message}</runtime-context>` };
    this.#messages.push(context);
    try {
      await this.#options.session.saveMessages(this.#messages);
    } catch (error) {
      if (this.#messages.at(-1) === context) this.#messages.pop();
      throw error;
    }
  }

  setStickyContext(content: string): void {
    this.#stickyContext = content;
  }

  async applyUndo(options: {
    messageCount: number;
    state: RunState;
    history: "truncate" | "keep";
    checkpointId: string;
  }): Promise<AgentUndoTransaction> {
    if (this.#running) throw new Error("cannot undo while the agent is running");
    if (options.messageCount < 1 || options.messageCount > this.#messages.length) {
      throw new Error(`undo checkpoint has invalid message boundary ${options.messageCount}`);
    }
    const originalMessages = structuredClone(this.#messages);
    const originalState = cloneRunState(this.#options.state);
    const removedMessages = options.history === "truncate"
      ? structuredClone(this.#messages.slice(options.messageCount))
      : [];
    if (options.history === "truncate") {
      this.#messages.splice(options.messageCount);
    } else if (!isUndoContext(this.#messages.at(-1), options.checkpointId)) {
      this.#messages.push({
        role: "user",
        content: `<undo-context checkpoint="${options.checkpointId}">The previous turn's file changes and run state were reverted. Its messages remain visible only because undo.message_history=keep. Treat the reverted files as absent and continue from the restored workspace.</undo-context>`,
      });
    }
    replaceRunState(this.#options.state, options.state);
    this.#cacheEpoch += 1;
    try {
      await this.#options.session.saveMessages(this.#messages);
      await this.#options.session.saveRunState(this.#options.state);
    } catch (error) {
      this.#messages.splice(0, this.#messages.length, ...originalMessages);
      replaceRunState(this.#options.state, originalState);
      await this.#options.session.saveMessages(this.#messages).catch(() => undefined);
      await this.#options.session.saveRunState(this.#options.state).catch(() => undefined);
      throw error;
    }
    let rolledBack = false;
    return {
      removedMessages,
      rollback: async () => {
        if (rolledBack) return;
        this.#messages.splice(0, this.#messages.length, ...originalMessages);
        replaceRunState(this.#options.state, originalState);
        this.#cacheEpoch += 1;
        await this.#options.session.saveMessages(this.#messages);
        await this.#options.session.saveRunState(this.#options.state);
        rolledBack = true;
      },
    };
  }

  async run(prompt: string, signal: AbortSignal): Promise<AgentResult> {
    if (this.#running) throw new Error("agent is already running");
    this.#running = true;
    const { state, events } = this.#options;
    const stateBeforeTurn = cloneRunState(state);
    state.status = "running";
    delete state.completion;
    try {
      await this.#options.checkpoint.beginTurn(this.#messages.length, state.agentId, stateBeforeTurn);
      await this.#options.session.saveRunState(state);
      await events.emit({
        type: "agent.started",
        agentId: state.agentId,
        ...(state.parentAgentId ? { parentAgentId: state.parentAgentId } : {}),
        prompt,
      });
      this.#messages.push({ role: "user", content: await promptContent(prompt, this.#options.workspaceRoot, this.#options.cwd, this.#options.artifacts) });
      await this.#options.session.saveMessages(this.#messages);

      let consecutiveBareFinals = 0;
      let previousCall = "";
      let repeatedCalls = 0;
      let previousError = "";
      let repeatedErrors = 0;
      let providerTools = this.#providerTools();
      let promptTokens = estimateTokens(this.#messages, providerTools);

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
          messages: await materializeMessageAttachments(this.#messages),
          tools: providerTools,
          signal,
          cacheScope: `${state.agentId}:${state.mode}:${this.#cacheEpoch}`,
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
          // Commit any visible narration from this tool-call turn to the transcript
          // before the tool rows, so the conversation reads in true order
          // (narration → tools → ... → final answer) instead of stacking every
          // tool above a single closing message.
          const narration = response.message.content?.trim();
          if (narration) await events.emit({ type: "assistant.message", agentId: state.agentId, text: narration });
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
            if (repeatedCalls >= identicalCallWarningAt) {
              result = {
                content: "repeated identical tool call blocked; change the arguments or approach",
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
            await this.#options.session.saveRunState(state);
            await this.#options.session.saveMessages(this.#messages);
          };
          if (parallel) {
            const results = await Promise.all(calls.map(runCall));
            for (const result of results) await appendResult(result);
          } else {
            for (const call of calls) await appendResult(await runCall(call));
          }
          providerTools = this.#providerTools();
          promptTokens = Math.max(promptTokens, estimateTokens(this.#messages, providerTools));
          if (repeatedCalls >= identicalCallStopAt) {
            throw new Error("agent repeated an identical tool call after being told to change approach");
          }
          if (repeatedErrors >= repeatedErrorLimit) {
            throw new Error(`agent repeated the same tool error ${repeatedErrorLimit} times`);
          }
          continue;
        }

        const text = response.message.content?.trim() ?? "";
        const completion = currentCompletion(state);
        const completionRequired = state.mode !== "chat";
        if (!text && completion === undefined && !completionRequired) {
          consecutiveBareFinals += 1;
          if (consecutiveBareFinals >= 3) throw new Error("agent returned three empty final responses");
          this.#messages.push({
            role: "user",
            content: "Your previous response was empty. Provide a concrete answer or use the available tools.",
          });
          await this.#options.session.saveMessages(this.#messages);
          continue;
        }
        if (!completionRequired || completion !== undefined) {
          const resultText = completion?.summary ?? text;
          state.status = completion?.status ?? "completed";
          await this.#options.session.saveRunState(state);
          await events.emit({ type: "assistant.message", agentId: state.agentId, text });
          await events.emit({ type: "agent.finished", agentId: state.agentId, status: state.status, result: resultText });
          return { status: state.status, text: resultText, messages: this.#messages };
        }

        consecutiveBareFinals += 1;
        if (consecutiveBareFinals >= 3) {
          throw new Error("agent stopped without satisfying the completion gate");
        }
        this.#messages.push({
          role: "user",
          content: state.mode === "subagent"
            ? "Your worker assignment is not complete until report_worker accepts it. Continue working, verify changes, then call report_worker with evidence."
            : "The task is not complete until complete_task accepts it. Continue working, verify changes, update the plan, then call complete_task. Do not only restate progress.",
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
    } finally {
      try {
        await this.#options.checkpoint.finalizeTurn();
      } catch (error) {
        await events.emit({
          type: "error",
          agentId: state.agentId,
          message: `turn checkpoint could not be finalized: ${error instanceof Error ? error.message : String(error)}`,
        }).catch(() => undefined);
      }
      this.#running = false;
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
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      ...(options.subagents ? { subagents: options.subagents } : {}),
      ...(options.permissions ? { permissions: options.permissions } : {}),
      ...(options.hooks ? { hooks: options.hooks } : {}),
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

    const { messages: compacted, prunedToolResults } = pruneCompactionMessages(this.#messages.slice(1, boundary));
    const { readFiles, modifiedFiles } = extractFileOps(compacted);
    const fileOpsSection = formatFileOpsSection(readFiles, modifiedFiles);
    const fileOpsMsg: ProviderMessage[] = fileOpsSection
      ? [{ role: "user", content: fileOpsSection }]
      : [];
    const response = await this.#options.provider.complete({
      messages: [
        {
          role: "system",
          content:
            "Summarize this coding-agent history for continuation. Preserve user requirements, decisions, files changed, commands and outcomes, open plan steps, blockers, and exact artifact IDs. Do not include hidden chain-of-thought.",
        },
        { role: "user", content: JSON.stringify(compacted) },
        ...fileOpsMsg,
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
      { role: "user", content: `<compaction-summary>\n${summary}\n</compaction-summary>${fileOpsSection ? `\n${fileOpsSection}` : ""}` },
    );
    if (this.#stickyContext) {
      const last = this.#messages.at(-1);
      if (!(last?.role === "user" && typeof last.content === "string" && last.content.includes("<sticky-context>"))) {
        this.#messages.push({ role: "user", content: `<sticky-context>\n${this.#stickyContext}\n</sticky-context>` });
      }
    }
    this.#cacheEpoch += 1;
    await this.#options.session.saveMessages(this.#messages);
    await this.#options.events.emit({
      type: "notice",
      agentId: this.#options.state.agentId,
      message: `compacted ${compacted.length} messages after reaching the context threshold${prunedToolResults > 0 ? `; pruned ${prunedToolResults} old tool results from the summary input` : ""}`,
    });
    await this.#options.events.emit({
      type: "usage",
      agentId: this.#options.state.agentId,
      usage: response.usage,
    });
  }
}
async function promptContent(prompt: string, workspaceRoot: string, cwd: string, artifacts: ArtifactStore): Promise<string | ProviderContentPart[]> {
  const matches = [...prompt.matchAll(/@image\s+([^\s]+)/g)];
  if (matches.length === 0) return prompt;
  const parts: ProviderContentPart[] = [
    { type: "text", text: prompt.replace(/@image\s+([^\s]+)/g, "").trim() || "Inspect the attached image." },
  ];
  for (const match of matches) {
    const rawPath = match[1];
    if (!rawPath) continue;
    const path = await resolveWorkspacePath({ workspaceRoot, cwd, input: rawPath, mustExist: true });
    assertNotSensitivePath(path);
    const bytes = await readFile(path);
    if (bytes.length > 50 * 1024 * 1024) throw new Error(`image attachment is too large: ${rawPath}`);
    const mimeType = mimeTypeFor(path);
    const attachment = await artifacts.storeAttachment({
      source: rawPath,
      bytes,
      mimeType,
      extension: extname(path).slice(1).toLowerCase(),
    });
    parts.push({
      type: "image_attachment",
      attachment_id: attachment.attachmentId,
      mime_type: attachment.mimeType,
      path: attachment.path,
    });
  }
  return parts;
}

async function materializeMessageAttachments(messages: ProviderMessage[]): Promise<ProviderMessage[]> {
  const out: ProviderMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) {
      out.push(message);
      continue;
    }
    const content: ProviderContentPart[] = [];
    for (const part of message.content) {
      if (part.type !== "image_attachment") {
        content.push(part);
        continue;
      }
      const bytes = await readFile(part.path);
      content.push({
        type: "image_url",
        image_url: { url: `data:${part.mime_type};base64,${bytes.toString("base64")}` },
      });
    }
    out.push({ ...message, content });
  }
  return out;
}

function mimeTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      throw new Error(`unsupported image attachment type: ${path}`);
  }
}


function pruneCompactionMessages(messages: ProviderMessage[]): { messages: ProviderMessage[]; prunedToolResults: number } {
  let prunedToolResults = 0;
  const pruned = messages.map((message): ProviderMessage => {
    if (message.role !== "tool") return structuredClone(message);
    const content = message.content.trim();
    if (content === "no matches" || content === "[]" || content === "{}") {
      prunedToolResults += 1;
      return { ...message, content: "[Uneventful result elided]" };
    }
    const bytes = Buffer.byteLength(message.content, "utf8");
    if (bytes <= 8_000 || message.content.startsWith("[tool output truncated:")) {
      return structuredClone(message);
    }
    prunedToolResults += 1;
    const encoded = Buffer.from(message.content, "utf8");
    const head = encoded.subarray(0, 1_500).toString("utf8");
    const tail = encoded.subarray(Math.max(0, encoded.length - 800)).toString("utf8");
    return {
      ...message,
      content: `[Tool result pruned before compaction: ${bytes} bytes]\n${head}\n\n[...pruned...]\n\n${tail}`,
    };
  });
  return { messages: pruned, prunedToolResults };
}

function hashCall(name: string, argumentsJson: string): string {
  return createHash("sha256").update(name).update("\0").update(argumentsJson).digest("hex");
}

function currentCompletion(state: RunState): CompletionRecord | undefined {
  return state.completion;
}

function cloneRunState(state: RunState): RunState {
  return structuredClone(state);
}

function replaceRunState(target: RunState, source: RunState): void {
  target.agentId = source.agentId;
  if (source.parentAgentId === undefined) delete target.parentAgentId;
  else target.parentAgentId = source.parentAgentId;
  target.mode = source.mode;
  target.status = source.status;
  target.plan = structuredClone(source.plan);
  target.modifiedFiles = new Set(source.modifiedFiles);
  target.verifications = structuredClone(source.verifications);
  target.revision = source.revision;
  if (source.completion === undefined) delete target.completion;
  else target.completion = structuredClone(source.completion);
}

function isUndoContext(message: ProviderMessage | undefined, checkpointId: string): boolean {
  return message?.role === "user" && typeof message.content === "string" && message.content.includes(`<undo-context checkpoint="${checkpointId}">`);
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
function extractFileOps(messages: ProviderMessage[]): { readFiles: Set<string>; modifiedFiles: Set<string> } {
  const readFiles = new Set<string>();
  const modifiedFiles = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) {
      let filePath: string | undefined;
      try {
        const args = JSON.parse(call.function.arguments);
        if (typeof args.path === "string") filePath = args.path;
      } catch {
        continue;
      }
      if (!filePath) continue;
      if (call.function.name === "read_file") readFiles.add(filePath);
      if (call.function.name === "write_file" || call.function.name === "edit_file" || call.function.name === "edit_files" || call.function.name === "delete_file" || call.function.name === "replace_by_line_range") modifiedFiles.add(filePath);
    }
  }
  for (const filePath of modifiedFiles) readFiles.delete(filePath);
  return { readFiles, modifiedFiles };
}

function formatFileOpsSection(readFiles: Set<string>, modifiedFiles: Set<string>): string | undefined {
  const maxFiles = 20;
  const entries: { path: string; label: string }[] = [];
  for (const filePath of readFiles) entries.push({ path: filePath, label: "Read" });
  for (const filePath of modifiedFiles) entries.push({ path: filePath, label: "Write" });
  if (!entries.length) return undefined;
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const grouped = new Map<string, { path: string; label: string }[]>();
  for (const entry of entries) {
    const dir = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : ".";
    const list = grouped.get(dir);
    if (list) list.push(entry);
    else grouped.set(dir, [entry]);
  }
  let lines: string[] = [];
  for (const [dir, files] of grouped) {
    lines.push(dir + "/");
    for (const file of files) {
      const base = file.path.slice(dir === "." ? 0 : dir.length + 1);
      lines.push(`  ${base} (${file.label})`);
    }
  }
  let elided = "";
  if (lines.length > maxFiles) {
    elided = `\n  ...${lines.length - maxFiles} files elided...`;
    lines = lines.slice(0, maxFiles);
  }
  return `<files>\n${lines.join("\n")}${elided}\n</files>`;
}
