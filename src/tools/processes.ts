import { spawn, type ChildProcessByStdio } from "node:child_process";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { disposeChildEnvironment, safeChildEnvironment } from "../security/environment.js";
import { decideCommand } from "../security/policy.js";
import { defineTool, type AnyTool } from "./types.js";

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
}

export interface ProcessStatus {
  name: string;
  command: string;
  pid: number;
  startedAt: number;
  uptimeMs: number;
  running: boolean;
  exit?: ProcessExit;
}

export interface StartProcessOptions {
  name: string;
  command: string;
  cwd: string;
  readyPattern?: RegExp;
  readyTimeoutMs?: number;
  signal?: AbortSignal;
  maxLines?: number;
  maxBytes?: number;
}

export interface StartProcessResult {
  name: string;
  pid: number;
  ready: boolean;
  output: string[];
}

class LineBuffer {
  private readonly lines: string[] = [];
  private bytes = 0;
  private partial = "";

  constructor(private readonly maxLines: number, private readonly maxBytes: number) {}

  append(text: string): void {
    this.partial += text;
    let newline = this.partial.indexOf("\n");
    while (newline >= 0) {
      this.push(this.partial.slice(0, newline));
      this.partial = this.partial.slice(newline + 1);
      newline = this.partial.indexOf("\n");
    }
    if (this.partial.length > this.maxBytes) {
      this.push(this.partial);
      this.partial = "";
    }
  }

  flush(): void {
    if (this.partial) {
      this.push(this.partial);
      this.partial = "";
    }
  }

  snapshot(): string[] {
    return this.partial ? [...this.lines, this.partial] : [...this.lines];
  }

  text(): string {
    return this.snapshot().join("\n");
  }

  private push(line: string): void {
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line, "utf8") + 1;
    while (this.lines.length > this.maxLines || this.bytes > this.maxBytes) {
      const dropped = this.lines.shift();
      if (dropped === undefined) break;
      this.bytes -= Buffer.byteLength(dropped, "utf8") + 1;
    }
  }
}

interface ManagedProcess {
  name: string;
  command: string;
  pid: number;
  startedAt: number;
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  buffer: LineBuffer;
  exited: Promise<ProcessExit>;
  exit?: ProcessExit;
  stopping?: Promise<ProcessExit>;
}

export class ProcessManager {
  static readonly #active = new Set<ProcessManager>();
  static #lifecycleHandlersInstalled = false;
  static #shutdownSignal: NodeJS.Signals | undefined;
  static readonly #onExit = (): void => {
    for (const manager of ProcessManager.#active) manager.#disposeImmediately();
  };
  static readonly #onSigterm = (): void => ProcessManager.#handleSignal("SIGTERM");
  static readonly #onSighup = (): void => ProcessManager.#handleSignal("SIGHUP");

  readonly #processes = new Map<string, ManagedProcess>();
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(
    private readonly stopGraceMs = 3_000,
    private readonly maxExitedProcesses = 20,
  ) {
    if (!Number.isInteger(maxExitedProcesses) || maxExitedProcesses < 0) {
      throw new Error("max exited process count must be a non-negative integer");
    }
    ProcessManager.#active.add(this);
    ProcessManager.#installLifecycleHandlers();
  }

  async start(options: StartProcessOptions): Promise<StartProcessResult> {
    if (this.#disposed) throw new Error("process manager is disposed");
    const existing = this.#processes.get(options.name);
    if (existing && !existing.exit) {
      throw new Error(
        `process "${options.name}" is already running (pid ${existing.pid}); stop_process it first or pick another name`,
      );
    }
    if (existing) this.#processes.delete(options.name);
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("start_process aborted");

    const childEnv = safeChildEnvironment();
    const spawnEnv = { ...childEnv };
    delete spawnEnv.KULMI_SANDBOX_ROOT;
    delete spawnEnv.KULMI_SANDBOX_HOME;
    delete spawnEnv.KULMI_SANDBOX_TMP;
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", options.command], {
      cwd: options.cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
    });
    const spawned = Promise.withResolvers<void>();
    child.once("spawn", () => spawned.resolve());
    child.once("error", (error) => spawned.reject(error));
    try {
      await spawned.promise;
    } catch (error) {
      disposeChildEnvironment(childEnv);
      throw error instanceof Error ? error : new Error(String(error));
    }
    const pid = child.pid;
    if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 1) {
      disposeChildEnvironment(childEnv);
      child.kill("SIGKILL");
      throw new Error(`spawned process "${options.name}" has an invalid pid`);
    }

    const buffer = new LineBuffer(options.maxLines ?? 2_000, options.maxBytes ?? 1_048_576);
    const exitGate = Promise.withResolvers<ProcessExit>();
    const entry: ManagedProcess = {
      name: options.name,
      command: options.command,
      pid,
      startedAt: Date.now(),
      child,
      buffer,
      exited: exitGate.promise,
    };
    let notify: (() => void) | undefined;
    const consume = (chunk: Buffer): void => {
      buffer.append(chunk.toString("utf8"));
      notify?.();
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.stdin.on("error", () => {});
    child.once("close", (code, signal) => {
      buffer.flush();
      entry.exit = { code, signal, at: Date.now() };
      disposeChildEnvironment(childEnv);
      exitGate.resolve(entry.exit);
      notify?.();
      this.#pruneExitedProcesses();
    });
    this.#processes.set(options.name, entry);

    if (!options.readyPattern) {
      return { name: options.name, pid: entry.pid, ready: true, output: buffer.snapshot().slice(-40) };
    }

    const pattern = options.readyPattern;
    const readiness = Promise.withResolvers<"ready" | "exit" | "timeout" | "abort">();
    notify = () => {
      if (entry.exit) readiness.resolve("exit");
      else {
        pattern.lastIndex = 0;
        if (pattern.test(buffer.text())) readiness.resolve("ready");
      }
    };
    notify();
    const timeoutMs = options.readyTimeoutMs ?? 30_000;
    const timer = setTimeout(() => readiness.resolve("timeout"), timeoutMs);
    const onAbort = (): void => readiness.resolve("abort");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let outcome: "ready" | "exit" | "timeout" | "abort";
    try {
      outcome = await readiness.promise;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      notify = undefined;
    }
    if (outcome === "ready") {
      return { name: options.name, pid: entry.pid, ready: true, output: buffer.snapshot().slice(-40) };
    }
    const tail = buffer.snapshot().slice(-40).join("\n");
    if (outcome === "exit") {
      throw new Error(
        `process "${options.name}" exited (code ${entry.exit?.code ?? "unknown"}) before ready pattern matched; last output:\n${tail}`,
      );
    }
    this.#killGroup(entry, "SIGKILL");
    await entry.exited;
    if (outcome === "abort") throw options.signal?.reason ?? new Error("start_process aborted");
    throw new Error(
      `process "${options.name}" did not match ready pattern within ${timeoutMs / 1_000}s and was killed; last output:\n${tail}`,
    );
  }

  logs(name: string): { running: boolean; exit?: ProcessExit; lines: string[] } {
    const entry = this.#require(name);
    return {
      running: !entry.exit,
      ...(entry.exit ? { exit: entry.exit } : {}),
      lines: entry.buffer.snapshot(),
    };
  }

  send(name: string, message: { text?: string; signal?: NodeJS.Signals }): void {
    const entry = this.#require(name);
    if (entry.exit) {
      throw new Error(
        `process "${name}" already exited (code ${entry.exit.code ?? "null"}, signal ${entry.exit.signal ?? "null"}); its logs remain readable via process_logs`,
      );
    }
    if (message.text !== undefined) {
      if (!entry.child.stdin.writable) throw new Error(`stdin of process "${name}" is no longer writable`);
      entry.child.stdin.write(`${message.text}\n`);
    }
    if (message.signal) this.#killGroup(entry, message.signal);
  }

  async stop(name: string): Promise<{ found: boolean; wasRunning: boolean; exit?: ProcessExit }> {
    const entry = this.#processes.get(name);
    if (!entry) return { found: false, wasRunning: false };
    if (entry.exit) return { found: true, wasRunning: false, exit: entry.exit };
    const exit = await this.#terminate(entry);
    return { found: true, wasRunning: true, exit };
  }

  list(): ProcessStatus[] {
    return [...this.#processes.values()].map((entry) => ({
      name: entry.name,
      command: entry.command,
      pid: entry.pid,
      startedAt: entry.startedAt,
      uptimeMs: (entry.exit?.at ?? Date.now()) - entry.startedAt,
      running: !entry.exit,
      ...(entry.exit ? { exit: entry.exit } : {}),
    }));
  }

  disposeAll(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    ProcessManager.#unregister(this);
    const entries = [...this.#processes.values()];
    this.#disposePromise = Promise.allSettled(entries.map((entry) => this.#terminate(entry)))
      .then(() => {
        this.#processes.clear();
      });
    return this.#disposePromise;
  }

  #disposeImmediately(): void {
    this.#disposed = true;
    ProcessManager.#unregister(this);
    for (const entry of this.#processes.values()) {
      if (!entry.exit) this.#killGroup(entry, "SIGKILL");
    }
    this.#processes.clear();
  }

  #terminate(entry: ManagedProcess): Promise<ProcessExit> {
    if (entry.exit) return Promise.resolve(entry.exit);
    if (entry.stopping) return entry.stopping;
    entry.stopping = (async () => {
      this.#killGroup(entry, "SIGTERM");
      const grace = Promise.withResolvers<"exit" | "grace">();
      const timer = setTimeout(() => grace.resolve("grace"), this.stopGraceMs);
      void entry.exited.then(() => grace.resolve("exit"));
      const first = await grace.promise;
      clearTimeout(timer);
      if (first === "grace" && !entry.exit) this.#killGroup(entry, "SIGKILL");
      return entry.exited;
    })();
    return entry.stopping;
  }

  #pruneExitedProcesses(): void {
    const exited = [...this.#processes.values()]
      .filter((entry) => entry.exit)
      .sort((left, right) => (left.exit?.at ?? 0) - (right.exit?.at ?? 0));
    for (const entry of exited.slice(0, Math.max(0, exited.length - this.maxExitedProcesses))) {
      this.#processes.delete(entry.name);
    }
  }

  #require(name: string): ManagedProcess {
    const entry = this.#processes.get(name);
    if (!entry) {
      const known = [...this.#processes.keys()].sort().join(", ");
      throw new Error(`no process named "${name}"; known processes: ${known || "none"}`);
    }
    return entry;
  }

  #killGroup(entry: ManagedProcess, signal: NodeJS.Signals): void {
    signalProcessGroup(entry.pid, signal, () => entry.child.kill(signal));
  }

  static #installLifecycleHandlers(): void {
    if (ProcessManager.#lifecycleHandlersInstalled) return;
    ProcessManager.#lifecycleHandlersInstalled = true;
    process.once("exit", ProcessManager.#onExit);
    process.on("SIGTERM", ProcessManager.#onSigterm);
    process.on("SIGHUP", ProcessManager.#onSighup);
  }

  static #unregister(manager: ProcessManager): void {
    ProcessManager.#active.delete(manager);
    if (ProcessManager.#active.size > 0 || ProcessManager.#shutdownSignal) return;
    ProcessManager.#removeLifecycleHandlers();
  }

  static #removeLifecycleHandlers(): void {
    if (!ProcessManager.#lifecycleHandlersInstalled) return;
    ProcessManager.#lifecycleHandlersInstalled = false;
    process.off("exit", ProcessManager.#onExit);
    process.off("SIGTERM", ProcessManager.#onSigterm);
    process.off("SIGHUP", ProcessManager.#onSighup);
  }

  static #handleSignal(signal: NodeJS.Signals): void {
    if (ProcessManager.#shutdownSignal) return;
    ProcessManager.#shutdownSignal = signal;
    const managers = [...ProcessManager.#active];
    void Promise.allSettled(managers.map((manager) => manager.disposeAll())).finally(() => {
      ProcessManager.#removeLifecycleHandlers();
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(signal === "SIGHUP" ? 129 : 143);
      }
    });
  }
}

export function processTools(manager: ProcessManager): AnyTool[] {
  const startProcessTool = defineTool({
    name: "start_process",
    description:
      "Start a persistent background process (dev server, watcher) that survives across turns. Runs outside the one-shot sandbox, so it requires approval. Use process_logs to read output, send_process_input for stdin or signals, stop_process to end it.",
    schema: z.object({
      name: z
        .string()
        .min(1)
        .max(32)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "name must start with an alphanumeric and contain only alphanumerics, underscores, and hyphens"),
      command: z.string().min(1),
      cwd: z.string().optional(),
      ready_pattern: z.string().optional(),
      ready_timeout_seconds: z.number().int().positive().max(300).optional(),
    }),
    readOnly: false,
    async execute(context, input) {
      const root = resolve(context.workspaceRoot);
      const cwd = resolve(root, input.cwd ?? ".");
      if (cwd !== root && !cwd.startsWith(`${root}/`)) {
        throw new Error(`cwd resolves outside the workspace: ${input.cwd}`);
      }
      const decision = decideCommand(input.command, context.autonomy, context.workspaceRoot);
      if (!decision.allowed && isHardBlockedDenial(decision.reason)) {
        throw new Error(`command is blocked and cannot be approved: ${decision.reason}`);
      }
      if (context.permissions) {
        const approved = await context.permissions.request({
          tool: "start_process",
          risk: "high",
          reason: `run "${input.command}" as persistent background process "${input.name}" outside the sandbox`,
          command: input.command,
          input,
        });
        if (!approved) {
          throw new Error(`permission denied: start_process "${input.name}" was not approved; the process would run outside the sandbox`);
        }
      } else if (context.autonomy !== "trusted") {
        throw new Error("start_process runs outside the sandbox; it requires an interactive permission grant or trusted autonomy");
      } else if (!decision.allowed) {
        throw new Error(`command is blocked: ${decision.reason}`);
      }
      let readyPattern: RegExp | undefined;
      if (input.ready_pattern !== undefined) {
        try {
          readyPattern = new RegExp(input.ready_pattern);
        } catch (error) {
          throw new Error(`invalid ready_pattern: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const result = await manager.start({
        name: input.name,
        command: input.command,
        cwd,
        ...(readyPattern ? { readyPattern } : {}),
        readyTimeoutMs: (input.ready_timeout_seconds ?? 30) * 1_000,
        signal: context.signal,
      });
      return { content: JSON.stringify(result), mutated: false };
    },
  });

  const processLogsTool = defineTool({
    name: "process_logs",
    description:
      "Read buffered stdout and stderr from a process started with start_process. Returns the tail of the merged output plus running or exited status.",
    schema: z.object({
      name: z.string().min(1),
      lines: z.number().int().positive().max(1_000).optional(),
      grep: z.string().optional(),
    }),
    readOnly: true,
    async execute(_context, input) {
      const info = manager.logs(input.name);
      let lines = info.lines;
      if (input.grep !== undefined) {
        let pattern: RegExp;
        try {
          pattern = new RegExp(input.grep);
        } catch (error) {
          throw new Error(`invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`);
        }
        lines = lines.filter((line) => pattern.test(line));
      }
      const tail = lines.slice(-(input.lines ?? 100));
      return {
        content: JSON.stringify({
          name: input.name,
          status: info.running ? "running" : "exited",
          ...(info.exit ? { exit_code: info.exit.code, exit_signal: info.exit.signal } : {}),
          lines: tail,
        }),
      };
    },
  });

  const sendProcessInputTool = defineTool({
    name: "send_process_input",
    description:
      "Send a line of text to the stdin of a running background process, or deliver a signal (SIGINT, SIGTERM, SIGKILL) to its process group.",
    schema: z.object({
      name: z.string().min(1),
      text: z.string().optional(),
      signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL"]).optional(),
    }),
    readOnly: false,
    async execute(_context, input) {
      if (input.text === undefined && input.signal === undefined) {
        throw new Error("provide text, signal, or both");
      }
      manager.send(input.name, {
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return {
        content: JSON.stringify({
          name: input.name,
          ...(input.text !== undefined ? { wrote: `${input.text}\n` } : {}),
          ...(input.signal ? { signaled: input.signal } : {}),
        }),
        mutated: false,
      };
    },
  });

  const stopProcessTool = defineTool({
    name: "stop_process",
    description:
      "Stop a background process: SIGTERM to its process group, 3 seconds of grace, then SIGKILL. Also removes exited entries; stopping an unknown name is a no-op.",
    schema: z.object({
      name: z.string().min(1),
    }),
    readOnly: false,
    async execute(_context, input) {
      const result = await manager.stop(input.name);
      if (!result.found) {
        return { content: JSON.stringify({ name: input.name, stopped: false, reason: "no such process; nothing to stop" }), mutated: false };
      }
      return {
        content: JSON.stringify({
          name: input.name,
          stopped: true,
          was_running: result.wasRunning,
          exit_code: result.exit?.code ?? null,
          exit_signal: result.exit?.signal ?? null,
        }),
        mutated: false,
      };
    },
  });

  const listProcessesTool = defineTool({
    name: "list_processes",
    description: "List background processes started with start_process: names, pids, uptime, and running or exited status.",
    schema: z.object({}),
    readOnly: true,
    async execute() {
      const items = manager.list().map((status) => ({
        name: status.name,
        pid: status.pid,
        command: status.command,
        uptime_seconds: Math.round(status.uptimeMs / 1_000),
        status: status.running ? "running" : "exited",
        ...(status.exit ? { exit_code: status.exit.code, exit_signal: status.exit.signal } : {}),
      }));
      return { content: JSON.stringify(items) };
    },
  });

  return [startProcessTool, processLogsTool, sendProcessInputTool, stopProcessTool, listProcessesTool];
}

export function signalProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: () => unknown,
): void {
  if (pid !== undefined && Number.isSafeInteger(pid) && pid > 1) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group no longer exists.
    }
  }
  try {
    fallback();
  } catch {}
}

function isHardBlockedDenial(reason: string): boolean {
  return /(?:cannot safely parse|command substitution|nested shell|environment assignment|operator .* blocked|missing program|empty command|home-directory|parent-directory|sensitive file|outside workspace)/i.test(reason);
}
