import type { EventBus, EventEnvelope } from "../core/events.js";
import type { AgentStatus, PlanStep, RunState, TokenUsage } from "../core/types.js";
import type { ProviderMessage } from "../provider/types.js";
import type { PermissionRequest } from "../tools/types.js";

export type FeedItem =
  | { id: string; kind: "user" | "assistant" | "notice" | "error"; text: string }
  | { id: string; kind: "tool"; title: string; detail: string; diff?: string; status: "running" | "done" | "error"; durationMs?: number }
  | { id: string; kind: "worker"; title: string; status: AgentStatus; activity?: string };

export interface PendingApproval {
  request: PermissionRequest;
  resolve: (approved: boolean) => void;
}

export interface TuiSnapshot {
  // Finalized history is append-only so Ink <Static> can render each row once
  // into the terminal's native scrollback without reshuffling a capped window.
  transcript: FeedItem[];
  // In-flight rows (running tools and workers) shown in the live bottom region
  // until they finalize and move into the transcript.
  live: FeedItem[];
  reasoning: string;
  streaming: string;
  plan: PlanStep[];
  usage: TokenUsage;
  status: AgentStatus;
  pendingApproval: PendingApproval | undefined;
  expandedThinking: boolean;
  completion: CompletionSummary | undefined;
}

export interface CompletionSummary {
  status: "completed" | "blocked";
  modifiedFiles: string[];
  verificationCommands: string[];
}

const emptyUsage: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
};

export class TuiStore {
  #snapshot: TuiSnapshot;
  readonly #listeners = new Set<() => void>();
  #scheduled = false;
  #detach: (() => void) | undefined;
  #rootAgentId: string | undefined;

  constructor(messages: readonly ProviderMessage[] = []) {
    this.#snapshot = {
      transcript: historyFeed(messages),
      live: [],
      reasoning: "",
      streaming: "",
      plan: [],
      usage: emptyUsage,
      status: "idle",
      pendingApproval: undefined,
      expandedThinking: false,
      completion: undefined,
    };
  }

  attach(events: EventBus): void {
    this.#detach?.();
    this.#detach = events.on((event) => this.consume(event));
  }

  close(): void {
    this.#detach?.();
    this.#detach = undefined;
    this.#snapshot.pendingApproval?.resolve(false);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): TuiSnapshot => this.#snapshot;

  seedMessages(messages: readonly ProviderMessage[]): void {
    if (messages.length === 0) return;
    this.#update({ transcript: historyFeed(messages) }, true);
  }

  seedRunState(state: RunState): void {
    this.#update(statePatch(state), true);
  }

  replaceSession(messages: readonly ProviderMessage[], state?: RunState): void {
    this.#rootAgentId = undefined;
    this.#snapshot.pendingApproval?.resolve(false);
    this.#snapshot = {
      transcript: historyFeed(messages),
      live: [],
      reasoning: "",
      streaming: "",
      plan: state?.plan ?? [],
      usage: emptyUsage,
      status: state?.status ?? "idle",
      pendingApproval: undefined,
      expandedThinking: this.#snapshot.expandedThinking,
      completion: state ? statePatch(state).completion : undefined,
    };
    this.#notify();
  }

  toggleThinking(): void {
    this.#update({ expandedThinking: !this.#snapshot.expandedThinking }, true);
  }

  // Render the user's message the instant they submit, before the run round-trips
  // through the event bus. agent.started dedupes against this so it is not doubled.
  echoUserMessage(text: string): void {
    this.#commit({ id: `user-local-${Date.now()}`, kind: "user", text }, { status: "running", reasoning: "", streaming: "", completion: undefined }, true);
  }

  requestPermission(request: PermissionRequest): Promise<boolean> {
    this.#snapshot.pendingApproval?.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.#update({ pendingApproval: { request, resolve } }, true);
    });
  }

  resolvePermission(approved: boolean): void {
    const pending = this.#snapshot.pendingApproval;
    if (!pending) return;
    this.#update({ pendingApproval: undefined }, true);
    pending.resolve(approved);
  }

  addNotice(text: string, error = false): void {
    this.#commit({ id: `local-${Date.now()}`, kind: error ? "error" : "notice", text });
  }

  private consume(envelope: EventEnvelope): void {
    const event = envelope.event;
    switch (event.type) {
      case "agent.started":
        if (event.parentAgentId) {
          this.#startLive({
            id: event.agentId,
            kind: "worker",
            title: shortPrompt(event.prompt),
            status: "running",
            activity: "starting",
          });
        } else {
          this.#rootAgentId = event.agentId;
          const last = this.#snapshot.transcript.at(-1);
          if (last?.kind === "user" && last.text === event.prompt) {
            this.#update({ status: "running", reasoning: "", streaming: "", completion: undefined });
          } else {
            this.#commit({ id: `user-${envelope.sequence}`, kind: "user", text: event.prompt }, { status: "running", reasoning: "", streaming: "", completion: undefined });
          }
        }
        break;
      case "agent.finished":
        if (this.#snapshot.live.some((item) => item.id === event.agentId && item.kind === "worker")) {
          this.#finalizeLive(event.agentId, (item) => {
            if (item.kind !== "worker") return item;
            const { activity: _activity, ...rest } = item;
            return { ...rest, status: event.status };
          });
        } else if (this.#isRoot(event.agentId)) {
          this.#update({ status: event.status });
        }
        break;
      case "assistant.reasoning.delta":
        if (!this.#isRoot(event.agentId)) {
          this.#patchWorker(event.agentId, { activity: "thinking" });
          break;
        }
        this.#update({ reasoning: this.#snapshot.reasoning + event.text });
        break;
      case "assistant.text.delta":
        if (!this.#isRoot(event.agentId)) {
          this.#patchWorker(event.agentId, { activity: "writing" });
          break;
        }
        this.#update({ streaming: this.#snapshot.streaming + event.text });
        break;
      case "assistant.message": {
        if (!this.#isRoot(event.agentId)) {
          this.#patchWorker(event.agentId, { activity: "working" });
          break;
        }
        const text = event.text || this.#snapshot.streaming;
        if (text) this.#commit({ id: `assistant-${envelope.sequence}`, kind: "assistant", text }, { streaming: "", reasoning: "" });
        else this.#update({ streaming: "", reasoning: "" });
        break;
      }
      case "tool.started": {
        const detail = toolDetail(event.input);
        const activity = detail ? `${friendlyTool(event.tool)}  ${detail}` : friendlyTool(event.tool);
        if (!this.#isRoot(event.agentId)) {
          this.#patchWorker(event.agentId, { activity });
          break;
        }
        this.#startLive({
          id: event.callId,
          kind: "tool",
          title: friendlyTool(event.tool),
          detail,
          status: "running",
        });
        break;
      }
      case "tool.finished":
        if (event.tool === "complete_task" && !event.isError && this.#isRoot(event.agentId)) {
          const completion = parseCompletion(event.output);
          if (completion) this.#update({ completion });
        }
        if (!this.#isRoot(event.agentId)) {
          const label = friendlyTool(event.tool);
          this.#patchWorker(event.agentId, {
            activity: event.isError ? `failed  ${label}` : `done  ${label}`,
          });
          break;
        }
        if (this.#snapshot.live.some((item) => item.id === event.callId)) {
          this.#finalizeLive(event.callId, (item) => item.kind === "tool"
            ? {
                ...item,
                status: event.isError ? "error" : "done",
                durationMs: event.durationMs,
                detail: event.isError ? compactError(event.output) : item.detail,
                ...(event.diff ? { diff: event.diff } : {}),
              }
            : item);
        } else {
          this.#commit({
            id: event.callId,
            kind: "tool",
            title: friendlyTool(event.tool),
            detail: event.isError ? compactError(event.output) : "",
            ...(event.diff ? { diff: event.diff } : {}),
            status: event.isError ? "error" : "done",
            durationMs: event.durationMs,
          });
        }
        break;
      case "plan.updated":
        if (!this.#isRoot(event.agentId)) break;
        this.#update({ plan: event.steps });
        break;
      case "usage":
        this.#update({ usage: addUsage(this.#snapshot.usage, event.usage) });
        break;
      case "notice":
        this.#commit({ id: `notice-${envelope.sequence}`, kind: "notice", text: event.message });
        break;
      case "error":
        this.#commit({ id: `error-${envelope.sequence}`, kind: "error", text: event.message });
        break;
      default:
        break;
    }
  }

  #commit(item: FeedItem, patch: Partial<TuiSnapshot> = {}, immediate = false): void {
    this.#update({
      ...patch,
      transcript: [...this.#snapshot.transcript, item],
    }, immediate);
  }

  #patchWorker(agentId: string, patch: { activity?: string; status?: AgentStatus }): void {
    let changed = false;
    const live = this.#snapshot.live.map((item) => {
      if (item.kind !== "worker" || item.id !== agentId) return item;
      changed = true;
      return {
        ...item,
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.activity !== undefined ? { activity: patch.activity } : {}),
      };
    });
    if (changed) this.#update({ live });
  }

  #startLive(item: FeedItem): void {
    this.#update({ live: [...this.#snapshot.live, item] });
  }

  #finalizeLive(id: string, transform: (item: FeedItem) => FeedItem): void {
    const finalized = this.#snapshot.live.find((item) => item.id === id);
    const live = this.#snapshot.live.filter((item) => item.id !== id);
    if (!finalized) {
      this.#update({ live });
      return;
    }
    this.#update({
      live,
      transcript: [...this.#snapshot.transcript, transform(finalized)],
    });
  }

  #update(patch: Partial<TuiSnapshot>, immediate = false): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    if (immediate) this.#notify();
    else this.#schedule();
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    setTimeout(() => {
      this.#scheduled = false;
      this.#notify();
    }, 32).unref();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  #isRoot(agentId: string): boolean {
    return this.#rootAgentId === undefined || this.#rootAgentId === agentId;
  }
}

function statePatch(state: RunState): Pick<TuiSnapshot, "plan" | "status" | "completion"> {
  return {
    plan: structuredClone(state.plan),
    status: state.status,
    completion: state.completion ? {
      status: state.completion.status,
      modifiedFiles: [...state.modifiedFiles].sort(),
      verificationCommands: state.verifications
        .filter((verification) =>
          verification.exitCode === 0 &&
          !verification.timedOut &&
          !verification.truncated &&
          verification.revision === state.revision
        )
        .map((verification) => verification.command),
    } : undefined,
  };
}

function historyFeed(messages: readonly ProviderMessage[]): FeedItem[] {
  return messages.flatMap((message, index): FeedItem[] => {
    if (message.role === "user" && typeof message.content === "string") {
      return [{ id: `history-user-${index}`, kind: "user", text: message.content }];
    }
    if (message.role === "assistant" && message.content) {
      return [{ id: `history-assistant-${index}`, kind: "assistant", text: message.content }];
    }
    return [];
  }).slice(-100);
}

function addUsage(total: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    promptTokens: total.promptTokens + next.promptTokens,
    completionTokens: total.completionTokens + next.completionTokens,
    totalTokens: total.totalTokens + next.totalTokens,
    cacheHitTokens: total.cacheHitTokens + next.cacheHitTokens,
    cacheMissTokens: total.cacheMissTokens + next.cacheMissTokens,
    reasoningTokens: (total.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
    webSearchCalls: (total.webSearchCalls ?? 0) + (next.webSearchCalls ?? 0),
    webSearchPages: (total.webSearchPages ?? 0) + (next.webSearchPages ?? 0),
  };
}

function friendlyTool(name: string): string {
  const labels: Record<string, string> = {
    read_file: "Read file",
    glob: "Find files",
    grep: "Search code",
    write_file: "Write file",
    edit_file: "Edit file",
    edit_files: "Edit files",
    delete_file: "Delete file",
    shell: "Run command",
    web_search: "Search web",
    fetch_url: "Fetch page",
    browser_qa: "Browser QA",
    attach_image: "Attach image",
    list_conflicts: "List conflicts",
    read_conflict: "Read conflict",
    resolve_conflict: "Resolve conflict",
    commit_changes: "Commit changes",
    spawn_agent: "Start worker",
    wait_agents: "Wait for workers",
    inspect_agent: "Inspect worker",
    steer_agent: "Steer worker",
    integrate_agent: "Integrate worker",
    cancel_agent: "Cancel worker",
    retry_agent: "Retry worker",
    update_plan: "Update plan",
    inspect_plan: "Inspect plan",
    complete_task: "Complete task",
    report_worker: "Report worker",
    start_task: "Start task",
    read_skill: "Read skill",
    read_artifact: "Read artifact",
  };
  if (labels[name]) return labels[name];
  return name.replaceAll("_", " ");
}

function toolDetail(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const object = input as Record<string, unknown>;
  const candidate = object.command ?? object.path ?? object.pattern ?? object.query ?? object.job_id;
  if (typeof candidate === "string") return candidate.replace(/\s+/g, " ").slice(0, 100);
  const rendered = JSON.stringify(input);
  return rendered === "{}" ? "" : rendered.slice(0, 100);
}

function shortPrompt(value: string): string {
  const cleaned = value
    .replace(/^Worker preset:\s*\w+\.[\s\S]*?(?=\n\n|\n[A-Z]|$)/, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || value.replace(/\s+/g, " ").trim()).slice(0, 72);
}

function compactError(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 120);
}

function parseCompletion(value: string): CompletionSummary | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.status !== "completed" && parsed.status !== "blocked") return undefined;
    const modifiedFiles = Array.isArray(parsed.modified_files)
      ? parsed.modified_files.filter((item): item is string => typeof item === "string")
      : [];
    const verificationCommands = typeof parsed.verification_command === "string"
      ? [parsed.verification_command]
      : [];
    return { status: parsed.status, modifiedFiles, verificationCommands };
  } catch {
    return undefined;
  }
}
