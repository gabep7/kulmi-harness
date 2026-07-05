import { Agent, type AgentResult } from "../agent/agent.js";
import { buildSystemPrompt, subagentReportContract } from "../agent/prompt.js";
import { SubagentScheduler, type WorkerJob } from "../agent/scheduler.js";
import {
  assertGitWorkTree,
  findWorkspaceRoot,
  loadConfig,
  resolveModel,
  type SearchMode,
  type SandboxConfig,
  type UndoMessageHistory,
} from "../config/config.js";
import { loadInstructions } from "../config/instructions.js";
import { discoverRules, rulesPromptInventory, loadStickyRules } from "../config/rules.js";
import { discoverAgents, agentsPromptInventory } from "../config/agents.js";
import { discoverSkills, skillsPromptInventory } from "../config/skills.js";
import { EventBus } from "../core/events.js";
import { createId } from "../core/ids.js";
import type { AgentMode, AutonomyLevel, RunState } from "../core/types.js";
import { MiMoProvider } from "../provider/mimo.js";
import type { ModelProvider, ProviderMessage } from "../provider/types.js";
import { progressTools, workerProgressTools } from "../tools/progress.js";
import { fileTools } from "../tools/files.js";
import { ToolRegistry } from "../tools/registry.js";
import { shellTool } from "../tools/shell.js";
import { subagentTools } from "../tools/subagents.js";
import type { AnyTool, PermissionApi, PermissionRequest } from "../tools/types.js";
import { CheckpointStore } from "./checkpoints.js";
import { SessionStore } from "./session-store.js";
import { WorktreeManager } from "./worktrees.js";
import { ArtifactStore } from "./artifacts.js";
import { readArtifactTool } from "../tools/artifacts.js";
import { fetchUrlTool, freeWebSearchTool } from "../tools/web-search.js";
import { skillTools } from "../tools/skills.js";
import { ruleTools } from "../tools/rules.js";
import { astGrepTool } from "../tools/ast-grep.js";
import { lspTool } from "../tools/lsp.js";

export interface ControllerOptions {
  cwd: string;
  mode: AgentMode;
  model?: string;
  autonomy?: AutonomyLevel;
  prompt?: string;
  resumeSessionId?: string;
  events?: EventBus;
  webSearch?: SearchMode;
  requestPermission?: (request: PermissionRequest) => Promise<boolean>;
}

export interface UndoResult {
  checkpointId: string;
  files: string[];
  messageHistory: UndoMessageHistory;
  removedMessageCount: number;
  messages: readonly ProviderMessage[];
  state: RunState;
}

export class SessionController {
  readonly events: EventBus;
  readonly sessionId: string;
  readonly model: string;
  readonly modelProfile: string;
  readonly workspaceRoot: string;
  readonly autonomy: AutonomyLevel;
  readonly searchMode: SearchMode;
  readonly sandbox: SandboxConfig;
  readonly undoMessageHistory: UndoMessageHistory;
  readonly #provider: ModelProvider;
  readonly #session: SessionStore;
  readonly #checkpoint: CheckpointStore;
  readonly #state: RunState;
  readonly #agent: Agent;
  readonly #scheduler: SubagentScheduler;
  #running: Promise<AgentResult> | undefined;
  #runAbort: AbortController | undefined;
  #closed = false;

  private constructor(options: {
    events: EventBus;
    provider: ModelProvider;
    session: SessionStore;
    state: RunState;
    agent: Agent;
    workspaceRoot: string;
    autonomy: AutonomyLevel;
    scheduler: SubagentScheduler;
    searchMode: SearchMode;
    checkpoint: CheckpointStore;
    undoMessageHistory: UndoMessageHistory;
    sandbox: SandboxConfig;
  }) {
    this.events = options.events;
    this.#provider = options.provider;
    this.#session = options.session;
    this.#checkpoint = options.checkpoint;
    this.undoMessageHistory = options.undoMessageHistory;
    this.sandbox = { ...options.sandbox };
    this.#state = options.state;
    this.#agent = options.agent;
    this.#scheduler = options.scheduler;
    this.sessionId = options.session.id;
    this.model = options.provider.model;
    this.modelProfile = options.provider.name;
    this.workspaceRoot = options.workspaceRoot;
    this.autonomy = options.autonomy;
    this.searchMode = options.searchMode;
    this.events.on((envelope) => {
      if (envelope.event.type === "usage") {
        void this.#session.addUsage(envelope.event.usage).catch(() => undefined);
      }
    });
  }

  get messages(): readonly ProviderMessage[] {
    return this.#agent.messages;
  }

  get mode(): AgentMode {
    return this.#state.mode;
  }

  get state(): RunState {
    return structuredClone(this.#state);
  }

  static async create(options: ControllerOptions): Promise<SessionController> {
    const loaded = options.resumeSessionId
      ? await SessionStore.open(options.resumeSessionId)
      : undefined;
    const cwd = loaded?.session.metadata.cwd ?? options.cwd;
    const workspaceRoot = findWorkspaceRoot(cwd);
    if (options.mode === "task") assertGitWorkTree(cwd);
    if (loaded) {
      const requestedRoot = findWorkspaceRoot(options.cwd);
      if (requestedRoot !== workspaceRoot) {
        throw new Error(`session ${loaded.session.metadata.id} belongs to ${workspaceRoot}, not ${requestedRoot}`);
      }
    }
    const config = loadConfig(cwd);
    const savedModelProfile = loaded
      ? loaded.session.metadata.modelProfile ??
        Object.entries(config.models).find(([, profile]) => profile.model === loaded.session.metadata.model)?.[0]
      : undefined;
    const resolved = resolveModel(config, options.model ?? savedModelProfile);
    if (loaded && resolved.model !== loaded.session.metadata.model) {
      throw new Error(
        `session ${loaded.session.metadata.id} uses ${loaded.session.metadata.model}, not ${resolved.model}`,
      );
    }
    const search = { ...config.search, mode: options.webSearch ?? config.search.mode };
    const provider = new MiMoProvider(resolved);
    const events = options.events ?? new EventBus();
    const permissions: PermissionApi = {
      request: async (request) => {
        const requestId = createId("permission");
        await events.emit({ type: "permission.requested", agentId: "runtime", requestId, request });
        let approved = false;
        try {
          approved = await options.requestPermission?.(request) ?? false;
          return approved;
        } finally {
          await events.emit({ type: "permission.resolved", agentId: "runtime", requestId, approved });
        }
      },
    };
    const session = loaded?.store ?? await SessionStore.create({
      cwd,
      model: resolved.model,
      modelProfile: resolved.name,
      ...(options.prompt ? { prompt: options.prompt } : {}),
    });
    session.attach(events);
    const autonomy = options.autonomy ?? config.defaultAutonomy;
    const instructions = await loadInstructions(workspaceRoot, cwd);
    const skills = discoverSkills(workspaceRoot);
    const skillsInventory = skillsPromptInventory(skills);
    const customAgents = discoverAgents(workspaceRoot);
    const agentsInventory = agentsPromptInventory(customAgents);
    const rules = discoverRules(workspaceRoot);
    const rulesInventory = rulesPromptInventory(rules);
    const stickyRules = await loadStickyRules(workspaceRoot, cwd);
    const state: RunState = loaded?.session.state ?? {
      agentId: createId("agent"),
      mode: options.mode,
      status: "idle",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    if (loaded?.session.state?.mode === "subagent") {
      throw new Error(`session ${loaded.session.metadata.id} is a child-agent transcript and cannot be resumed directly`);
    }
    const previousMode = state.mode;
    if (!loaded || options.mode === "task") state.mode = options.mode;
    if (state.mode === "task") assertGitWorkTree(cwd);

    const rootCheckpoint = new CheckpointStore(session.path, workspaceRoot);
    const rootArtifacts = new ArtifactStore(session.path);
    const worktrees = new WorktreeManager(workspaceRoot);
    const activeWorkers = new Map<string, Agent>();
    let scheduler: SubagentScheduler;
    const runWorker = async (job: WorkerJob, signal: AbortSignal): Promise<string> => {
      const worktree = job.mode === "implement" ? await worktrees.create(job.id) : undefined;
      if (worktree) {
        job.worktree = worktree;
        await scheduler.persist();
      }
      const workerCwd = worktree?.path ?? cwd;
      const childEvents = new EventBus();
      const childSession = await SessionStore.create({
        cwd: workerCwd,
        model: resolved.model,
        modelProfile: resolved.name,
        prompt: job.prompt,
      });
      childSession.attach(childEvents);
      job.childSessionId = childSession.id;
      await scheduler.persist();
      const detachBridge = childEvents.on((envelope) => events.emit(envelope.event).then(() => undefined));
      const childState: RunState = {
        agentId: job.id,
        parentAgentId: job.parentAgentId,
        mode: "subagent",
        status: "idle",
        plan: [],
        modifiedFiles: new Set(),
        verifications: [],
        revision: 0,
      };
      const readOnly = job.mode !== "implement";
      const searchTools = search.mode === "free" ? [freeWebSearchTool(search), fetchUrlTool()] : [];
      const childTools = readOnly
        ? new ToolRegistry([...fileTools().filter((tool) => tool.readOnly), readArtifactTool, shellTool, ...searchTools, ...skillTools(skills), ...ruleTools(rules), astGrepTool, lspTool, ...workerProgressTools()])
        : new ToolRegistry([...fileTools(), readArtifactTool, shellTool, ...searchTools, ...skillTools(skills), ...ruleTools(rules), astGrepTool, lspTool, ...workerProgressTools()]);
      const childAgent = new Agent({
        provider,
        tools: childTools,
        events: childEvents,
        session: childSession,
        checkpoint: new CheckpointStore(childSession.path, workerCwd),
        artifacts: new ArtifactStore(childSession.path),
        state: childState,
        systemPrompt: `${buildSystemPrompt({
          mode: "subagent",
          projectInstructions: instructions.content,
          readOnly,
          skillsInventory,
          rulesInventory,
          agentsInventory,
        })}\n${subagentReportContract}`,
        workspaceRoot: workerCwd,
        cwd: workerCwd,
        autonomy: readOnly ? "read" : autonomy,
        maxSteps: Math.max(10, Math.floor(config.maxSteps / 2)),
        commandTimeoutMs: config.commandTimeoutSeconds * 1_000,
        maxOutputBytes: config.maxOutputBytes,
        contextWindow: resolved.contextWindow,
        sandbox: config.sandbox,
        ...(!readOnly && permissions ? { permissions } : {}),
      });
      activeWorkers.set(job.id, childAgent);
      try {
        const result = await childAgent.run(job.prompt, signal);
        await childSession.close(result.status);
        return worktree
          ? `${result.text}\n\nWorktree ready for integration: ${worktree.path}`
          : result.text;
      } catch (error) {
        await childSession.close(signal.aborted ? "cancelled" : "failed");
        throw error;
      } finally {
        activeWorkers.delete(job.id);
        detachBridge();
      }
    };
    const integrateWorker = async (job: WorkerJob): Promise<string[]> => {
      const worktree = job.worktree;
      if (!worktree) throw new Error(`worker ${job.id} has no worktree`);
      const integrated = await worktrees.integrate(worktree, rootCheckpoint);
      for (const path of integrated) state.modifiedFiles.add(path);
      if (integrated.length > 0) {
        state.revision += 1;
        delete state.completion;
      }
      await session.saveRunState(state);
      return integrated;
    };
    scheduler = new SubagentScheduler(
      config.maxSubagents,
      runWorker,
      integrateWorker,
      (jobs) => session.saveWorkerJobs(jobs),
      loaded?.session.workers ?? [],
      (job, message) => {
        const worker = activeWorkers.get(job.id);
        if (!worker) throw new Error(`worker ${job.id} is not accepting steering`);
        worker.steer(message);
      },
      (job, result) => rootArtifacts.materialize("worker", job.id, result),
    );
    await scheduler.persist();

    const rootTools: AnyTool[] = [
      ...(autonomy === "read" ? fileTools().filter((tool) => tool.readOnly) : fileTools()),
      readArtifactTool,
      shellTool,
      ...(search.mode === "free" ? [freeWebSearchTool(search), fetchUrlTool()] : []),
      ...progressTools(),
      ...subagentTools(customAgents),
      ...skillTools(skills),
      ...ruleTools(rules),
      astGrepTool,
      lspTool,
    ];
    const agent = new Agent({
      provider,
      tools: new ToolRegistry(rootTools),
      events,
      session,
      checkpoint: rootCheckpoint,
      artifacts: rootArtifacts,
      state,
      systemPrompt: buildSystemPrompt({
        mode: state.mode,
        projectInstructions: instructions.content,
        readOnly: autonomy === "read",
        skillsInventory,
        rulesInventory,
        agentsInventory,
      }),
      workspaceRoot,
      cwd,
      autonomy,
      maxSteps: config.maxSteps,
      commandTimeoutMs: config.commandTimeoutSeconds * 1_000,
      maxOutputBytes: config.maxOutputBytes,
      contextWindow: resolved.contextWindow,
      sandbox: config.sandbox,
      ...(loaded?.session.messages ? { messages: loaded.session.messages as ProviderMessage[] } : {}),
      subagents: scheduler,
      permissions,
    });
    if (loaded && previousMode === "chat" && state.mode === "task") {
      await agent.appendRuntimeContext("Task mode is now active. Use the task tools directly; do not call start_task.");
    }
    if (stickyRules.content) {
      await agent.appendRuntimeContext(stickyRules.content);
      agent.setStickyContext(stickyRules.content);
    }
    await session.saveRunState(state);
    return new SessionController({
      events,
      provider,
      session,
      state,
      agent,
      scheduler,
      searchMode: search.mode,
      checkpoint: rootCheckpoint,
      undoMessageHistory: config.undo.messageHistory,
      sandbox: config.sandbox,
      workspaceRoot,
      autonomy,
    });
  }

  run(prompt: string, signal: AbortSignal): Promise<AgentResult> {
    if (this.#closed) throw new Error("session is closed");
    if (this.#running) throw new Error("session is already running");
    const abort = new AbortController();
    this.#runAbort = abort;
    const operation = this.#runOnce(prompt, AbortSignal.any([signal, abort.signal]));
    let tracked: Promise<AgentResult>;
    tracked = operation.finally(() => {
      if (this.#running === tracked) this.#running = undefined;
      if (this.#runAbort === abort) this.#runAbort = undefined;
    });
    this.#running = tracked;
    return tracked;
  }

  async #runOnce(prompt: string, signal: AbortSignal): Promise<AgentResult> {
    await this.#session.setStatus("running");
    await this.events.emit({
      type: "session.started",
      sessionId: this.sessionId,
      model: this.model,
      modelProfile: this.modelProfile,
      cwd: this.workspaceRoot,
    });
    try {
      const result = await this.#agent.run(prompt, signal);
      await this.#session.setStatus(result.status);
      return result;
    } catch (error) {
      await this.#scheduler.cancelAll("parent agent failed");
      await this.#session.setStatus(signal.aborted ? "cancelled" : "failed");
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#runAbort?.abort(new Error("session closed"));
    await this.#running?.catch(() => undefined);
    await this.#scheduler.cancelAll();
    await this.events.emit({
      type: "session.finished",
      sessionId: this.sessionId,
      status: this.#state.status,
    });
    await this.#session.close(this.#state.status);
  }

  workers(): WorkerJob[] {
    return this.#scheduler.jobs();
  }

  steerWorker(jobId: string, message: string): Promise<string> {
    return this.#scheduler.steer(jobId, message);
  }

  cancelWorker(jobId: string): Promise<string> {
    return this.#scheduler.cancel(jobId);
  }

  retryWorker(jobId: string, signal: AbortSignal): Promise<string> {
    return this.#scheduler.retry(jobId, signal);
  }

  async setMode(mode: AgentMode): Promise<void> {
    if (mode === "subagent") throw new Error("a root session cannot enter child-agent mode");
    if (mode === "task") assertGitWorkTree(this.workspaceRoot);
    const previous = this.#state.mode;
    this.#state.mode = mode;
    try {
      if (previous === "chat" && mode === "task") {
        await this.#agent.appendRuntimeContext("Task mode is now active. Use the task tools directly; do not call start_task.");
      }
      await this.#session.saveRunState(this.#state);
    } catch (error) {
      this.#state.mode = previous;
      throw error;
    }
  }

  async undo(): Promise<UndoResult> {
    if (this.#closed) throw new Error("session is closed");
    if (this.#running) throw new Error("cannot undo while the session is running");
    const pendingWorkers = this.#scheduler.pending();
    if (pendingWorkers.length > 0) {
      throw new Error(`cannot undo while child-agent work is pending: ${pendingWorkers.join(", ")}`);
    }
    const prepared = await this.#checkpoint.prepareUndo(this.#state.agentId, this.#agent.messages.length);
    const messageHistory = prepared.messageHistory ?? this.undoMessageHistory;
    const originalStatus = this.#state.status;
    let agentTransaction: Awaited<ReturnType<Agent["applyUndo"]>> | undefined;
    let began = false;
    try {
      await prepared.begin(messageHistory);
      began = true;
      await prepared.apply();
      agentTransaction = await this.#agent.applyUndo({
        messageCount: prepared.messageCount,
        state: prepared.state,
        history: messageHistory,
        checkpointId: prepared.checkpointId,
      });
      await this.#session.setStatus(this.#state.status);
      await prepared.commit();
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (agentTransaction) {
        try {
          await agentTransaction.rollback();
          await this.#session.setStatus(originalStatus);
        } catch (rollbackError) {
          rollbackErrors.push(`session: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      try {
        await prepared.rollback();
      } catch (rollbackError) {
        rollbackErrors.push(`files: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      if (began && rollbackErrors.length === 0) {
        try {
          await prepared.cancel();
        } catch (rollbackError) {
          rollbackErrors.push(`journal: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(rollbackErrors.length
        ? `undo failed: ${detail}; rollback failed for ${rollbackErrors.join("; ")}`
        : `undo failed: ${detail}`);
    }
    await this.events.emit({
      type: "session.undone",
      sessionId: this.sessionId,
      checkpointId: prepared.checkpointId,
      files: prepared.files,
      messageHistory,
    }).catch(() => undefined);
    return {
      checkpointId: prepared.checkpointId,
      files: prepared.files,
      messageHistory,
      removedMessageCount: agentTransaction.removedMessages.length,
      messages: this.#agent.messages,
      state: this.state,
    };
  }

  integrateWorker(jobId: string): Promise<string> {
    return this.#scheduler.integrate(jobId);
  }
}
