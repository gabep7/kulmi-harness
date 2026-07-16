import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/core/events.js";
import type { RunState } from "../src/core/types.js";
import { ArtifactStore } from "../src/runtime/artifacts.js";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import { ProcessManager, processTools } from "../src/tools/processes.js";
import type { AnyTool, ToolContext } from "../src/tools/types.js";

function makeState(): RunState {
  return {
    agentId: "agent",
    mode: "task",
    status: "running",
    plan: [],
    modifiedFiles: new Set(),
    verifications: [],
    revision: 0,
  };
}

function makeContext(root: string, session: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: root,
    cwd: root,
    autonomy: "trusted",
    signal: new AbortController().signal,
    events: new EventBus(),
    state: makeState(),
    checkpoint: new CheckpointStore(session, root),
    artifacts: new ArtifactStore(session),
    commandTimeoutMs: 10_000,
    maxOutputBytes: 100_000,
    ...overrides,
  };
}

// Integration tests against real spawned OS processes: fake timers cannot drive
// a child's stdout, so readiness is polled against the real clock.
async function until(check: () => Promise<boolean> | boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

interface LogsPayload {
  name: string;
  status: "running" | "exited";
  exit_code?: number | null;
  exit_signal?: string | null;
  lines: string[];
}

describe("process tools", () => {
  let root: string;
  let session: string;
  let manager: ProcessManager;
  let context: ToolContext;
  let tool: Record<string, AnyTool>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kulmi-processes-"));
    session = await mkdtemp(join(tmpdir(), "kulmi-processes-session-"));
    manager = new ProcessManager();
    context = makeContext(root, session);
    tool = Object.fromEntries(processTools(manager).map((entry) => [entry.name, entry]));
  });

  afterEach(() => {
    manager.disposeAll();
  });

  async function readLogs(input: { name: string; lines?: number; grep?: string }): Promise<LogsPayload> {
    const result = await tool.process_logs!.execute(context, input);
    return JSON.parse(result.content) as LogsPayload;
  }

  it("starts a process with a ready pattern, reads and greps logs, and stops with an exit report", async () => {
    const start = await tool.start_process!.execute(context, {
      name: "ticker",
      command: `node -e 'console.log("READY"); let i = 0; setInterval(() => { console.log("tick " + i); i += 1; }, 25);'`,
      ready_pattern: "READY",
      ready_timeout_seconds: 15,
    });
    const started = JSON.parse(start.content) as { name: string; pid: number; ready: boolean; output: string[] };
    expect(started.name).toBe("ticker");
    expect(started.pid).toBeGreaterThan(0);
    expect(started.ready).toBe(true);
    expect(started.output).toContain("READY");

    await until(async () => (await readLogs({ name: "ticker" })).lines.some((line) => line.startsWith("tick"))); 
    const logs = await readLogs({ name: "ticker", lines: 1000 });
    expect(logs.status).toBe("running");
    expect(logs.lines).toContain("READY");

    const grepped = await readLogs({ name: "ticker", grep: "^tick [0-9]+$" });
    expect(grepped.lines.length).toBeGreaterThan(0);
    expect(grepped.lines.every((line) => /^tick \d+$/.test(line))).toBe(true);

    const listed = JSON.parse((await tool.list_processes!.execute(context, {})).content) as Array<{
      name: string;
      pid: number;
      status: string;
      uptime_seconds: number;
    }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "ticker", pid: started.pid, status: "running" });

    const stop = await tool.stop_process!.execute(context, { name: "ticker" });
    const stopped = JSON.parse(stop.content) as {
      stopped: boolean;
      was_running: boolean;
      exit_code: number | null;
      exit_signal: string | null;
    };
    expect(stopped.stopped).toBe(true);
    expect(stopped.was_running).toBe(true);
    expect(stopped.exit_code !== null || stopped.exit_signal !== null).toBe(true);
    expect(JSON.parse((await tool.list_processes!.execute(context, {})).content)).toEqual([]);

    const again = JSON.parse((await tool.stop_process!.execute(context, { name: "ticker" })).content) as { stopped: boolean };
    expect(again.stopped).toBe(false);
  });

  it("echoes stdin input back through the log buffer and honors signals", async () => {
    await tool.start_process!.execute(context, {
      name: "echoer",
      command: `node -e 'process.stdin.on("data", (d) => console.log("echo:" + d.toString().trim())); console.log("READY");'`,
      ready_pattern: "READY",
      ready_timeout_seconds: 15,
    });

    await tool.send_process_input!.execute(context, { name: "echoer", text: "hello world" });
    await until(async () => (await readLogs({ name: "echoer" })).lines.includes("echo:hello world"));

    await tool.send_process_input!.execute(context, { name: "echoer", signal: "SIGKILL" });
    await until(async () => (await readLogs({ name: "echoer" })).status === "exited");
    const logs = await readLogs({ name: "echoer" });
    expect(logs.exit_signal).toBe("SIGKILL");
  });

  it("rejects a second start under a live name", async () => {
    await tool.start_process!.execute(context, {
      name: "dupe",
      command: `node -e 'setInterval(() => {}, 1000);'`,
    });
    await expect(
      tool.start_process!.execute(context, {
        name: "dupe",
        command: `node -e 'setInterval(() => {}, 1000);'`,
      }),
    ).rejects.toThrow(/already running/);
  });

  it("kills the process and errors when the ready pattern never matches", async () => {
    await expect(
      tool.start_process!.execute(context, {
        name: "silent",
        command: `node -e 'setInterval(() => {}, 1000);'`,
        ready_pattern: "NEVER_GOING_TO_MATCH",
        ready_timeout_seconds: 1,
      }),
    ).rejects.toThrow(/did not match ready pattern/);
    const listed = JSON.parse((await tool.list_processes!.execute(context, {})).content) as Array<{ name: string; status: string }>;
    expect(listed).toEqual([expect.objectContaining({ name: "silent", status: "exited" })]);
  });

  it("requires approval and fails when the permission request is denied", async () => {
    const requests: Array<{ tool: string; risk: string; command?: string }> = [];
    const denying = makeContext(root, session, {
      autonomy: "medium",
      permissions: {
        async request(input) {
          requests.push({ tool: input.tool, risk: input.risk, ...(input.command !== undefined ? { command: input.command } : {}) });
          return false;
        },
      },
    });
    await expect(
      tool.start_process!.execute(denying, { name: "denied", command: "sleep 60" }),
    ).rejects.toThrow(/permission denied/);
    expect(requests).toEqual([{ tool: "start_process", risk: "high", command: "sleep 60" }]);
    expect(JSON.parse((await tool.list_processes!.execute(context, {})).content)).toEqual([]);
  });

  it("fails without a permission api unless autonomy is trusted", async () => {
    const untrusted = makeContext(root, session, { autonomy: "medium" });
    await expect(
      tool.start_process!.execute(untrusted, { name: "nope", command: "sleep 60" }),
    ).rejects.toThrow(/permission grant or trusted autonomy/);
  });

  it("keeps hard-blocked commands blocked even with an approving permission api", async () => {
    let asked = false;
    const approving = makeContext(root, session, {
      autonomy: "medium",
      permissions: {
        async request() {
          asked = true;
          return true;
        },
      },
    });
    await expect(
      tool.start_process!.execute(approving, { name: "subst", command: "echo $(whoami)" }),
    ).rejects.toThrow(/blocked/);
    expect(asked).toBe(false);
  });

  it("disposes every process group and is safe to call twice", async () => {
    await tool.start_process!.execute(context, {
      name: "one",
      command: `node -e 'console.log("up1"); setInterval(() => {}, 1000);'`,
      ready_pattern: "up1",
      ready_timeout_seconds: 15,
    });
    await tool.start_process!.execute(context, {
      name: "two",
      command: `node -e 'console.log("up2"); setInterval(() => {}, 1000);'`,
      ready_pattern: "up2",
      ready_timeout_seconds: 15,
    });
    expect(manager.list()).toHaveLength(2);
    manager.disposeAll();
    expect(manager.list()).toEqual([]);
    manager.disposeAll();
    expect(manager.list()).toEqual([]);
  });
});
