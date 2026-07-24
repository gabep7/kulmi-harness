import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { EventBus } from "../src/core/events.js";
import { TuiApp } from "../src/tui/app.js";
import { TuiStore } from "../src/tui/store.js";

afterEach(cleanup);

describe("Kulmi TUI", () => {
  it("renders a focused working view with plan and tools", async () => {
    const bus = new EventBus();
    const store = new TuiStore();
    store.attach(bus);
    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        onSubmit={async () => undefined}
        onCommand={async () => undefined}
        onCancel={() => undefined}
        onExit={() => undefined}
      />,
    );
    await bus.emit({ type: "agent.started", agentId: "agent_1", prompt: "Improve the cache layer" });
    await bus.emit({
      type: "plan.updated",
      agentId: "agent_1",
      steps: [{ id: "one", title: "Audit cache behavior", status: "in_progress", dependsOn: [], acceptanceCriteria: [] }],
    });
    await bus.emit({ type: "tool.started", agentId: "agent_1", callId: "call_1", tool: "read_file", input: { path: "src/cache.ts" } });
    await bus.emit({
      type: "usage",
      agentId: "agent_1",
      usage: { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100, cacheHitTokens: 800, cacheMissTokens: 200 },
    });
    await bus.emit({ type: "assistant.message", agentId: "agent_1", text: "## Result\n\n- **Cache path** verified with `hit`\n1. Keep it stable\n> Evidence attached\n\n```ts\nconst hit = true;\n```" });
    await bus.emit({ type: "tool.started", agentId: "agent_1", callId: "call_complete", tool: "complete_task", input: {} });
    await bus.emit({
      type: "tool.finished",
      agentId: "agent_1",
      callId: "call_complete",
      tool: "complete_task",
      output: JSON.stringify({
        status: "completed",
        modified_files: ["src/cache.ts"],
        verifications: [{ command: "npm test" }],
        verification_command: "npm test",
      }),
      isError: false,
      durationMs: 2,
    });
    await pause();
    const frame = view.frames.join("\n");
    expect(frame).toContain("test-model");
    expect(frame).toContain("Improve the cache layer");
    expect(frame).toContain("Read file");
    expect(frame).toContain("Audit cache behavior");
    expect(frame).toContain("chat");
    expect(frame).not.toContain("processed");
    expect(frame).not.toContain("fresh");
    expect(frame).not.toContain("cached");
    expect(frame).toContain("1 changed file");
    expect(frame).toContain("src/cache.ts");
    expect(frame).toContain("npm test");
    expect(frame).toContain("Cache path verified");
    expect(frame).toContain("const hit = true;");
    expect(frame).toContain("1. Keep it stable");
    expect(frame).toContain("│ Evidence attached");
    expect(frame).not.toContain("**Cache path**");
    expect(frame).toContain("What should we build?");
  });

  it("turns a permission request into a keyboard approval prompt", async () => {
    const store = new TuiStore();
    const pending = store.requestPermission({ tool: "shell", risk: "high", reason: "removes a file", command: "rm old.txt", input: {} });
    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        onSubmit={async () => undefined}
        onCommand={async () => undefined}
        onCancel={() => undefined}
        onExit={() => undefined}
      />,
    );
    expect(view.lastFrame()).toContain("approval required");
    expect(view.lastFrame()).toContain("rm old.txt");
    view.stdin.write("y");
    await expect(pending).resolves.toBe(true);
  });

  it("denies a permission request when enter is pressed", async () => {
    const store = new TuiStore();
    const pending = store.requestPermission({ tool: "shell", risk: "high", reason: "removes a file", command: "rm old.txt", input: {} });
    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        onSubmit={async () => undefined}
        onCommand={async () => undefined}
        onCancel={() => undefined}
        onExit={() => undefined}
      />,
    );
    view.stdin.write("\r");
    await expect(pending).resolves.toBe(false);
  });

  it("cancels the active run with escape", async () => {
    const store = new TuiStore();
    const cancel = vi.fn();
    let finishRun: (() => void) | undefined;
    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        onSubmit={() => new Promise<void>((resolve) => { finishRun = resolve; })}
        onCommand={async () => undefined}
        onCancel={cancel}
        onExit={() => undefined}
      />,
    );
    view.stdin.write("inspect this repo");
    await pause();
    view.stdin.write("\r");
    await pause();
    const workingFrame = view.lastFrame() ?? "";
    expect(workingFrame).toContain("Kulmi is working. Enter to steer, Esc to stop.");
    expect(workingFrame).toContain("⠋");
    expect(workingFrame).toContain("thinking");
    expect(workingFrame.indexOf("thinking")).toBeLessThan(workingFrame.indexOf("Kulmi is working. Enter to steer, Esc to stop."));
    const composerLine = workingFrame.split("\n").find((line) => line.includes("Kulmi is working. Enter to steer, Esc to stop."));
    expect(composerLine).not.toContain("thinking");
    view.stdin.write("\u001b");
    await pause();
    expect(cancel).toHaveBeenCalledOnce();
    finishRun?.();
  });

  it("queues composer text as steering while a run is active", async () => {
    const store = new TuiStore();
    const steer = vi.fn();
    let finishRun: (() => void) | undefined;
    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        onSubmit={() => new Promise<void>((resolve) => { finishRun = resolve; })}
        onCommand={async () => undefined}
        onSteer={steer}
        onCancel={() => undefined}
        onExit={() => undefined}
      />,
    );
    view.stdin.write("first prompt");
    await pause();
    view.stdin.write("\r");
    await pause();
    view.stdin.write("focus on the cache layer");
    await pause();
    view.stdin.write("\r");
    await pause();
    expect(steer).toHaveBeenCalledExactlyOnceWith("focus on the cache layer");
    const frame = view.frames.join("\n");
    expect(frame).toContain("steered: focus on the cache layer");
    const composerLine = (view.lastFrame() ?? "").split("\n").find((line) => line.includes("Kulmi is working"));
    expect(composerLine).toBeDefined();
    expect(composerLine).not.toContain("focus");
    finishRun?.();
  });

  it("offers allow always for non-high risk and persists the choice", async () => {
    const store = new TuiStore();
    const always = vi.fn();
    const request = { tool: "shell", risk: "medium" as const, reason: "runs tests", command: "npm test --watch", input: {} };
    const pending = store.requestPermission(request);
    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        onSubmit={async () => undefined}
        onCommand={async () => undefined}
        onAlwaysAllow={always}
        onCancel={() => undefined}
        onExit={() => undefined}
      />,
    );
    expect(view.lastFrame()).toContain("allow always");
    view.stdin.write("a");
    await expect(pending).resolves.toBe(true);
    expect(always).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("never offers allow always for high risk requests", async () => {
    const store = new TuiStore();
    const always = vi.fn();
    const pending = store.requestPermission({ tool: "shell", risk: "high", reason: "removes a file", command: "rm -rf build", input: {} });
    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        onSubmit={async () => undefined}
        onCommand={async () => undefined}
        onAlwaysAllow={always}
        onCancel={() => undefined}
        onExit={() => undefined}
      />,
    );
    expect(view.lastFrame()).not.toContain("allow always");
    view.stdin.write("a");
    await pause();
    expect(always).not.toHaveBeenCalled();
    view.stdin.write("y");
    await expect(pending).resolves.toBe(true);
  });

  it("lists discovered custom commands in help", async () => {
    const store = new TuiStore();
    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        customCommands={[{ name: "/deploy", description: "Deploy the app" }, { name: "/help", description: "shadowed" }]}
        onSubmit={async () => undefined}
        onCommand={async () => undefined}
        onCancel={() => undefined}
        onExit={() => undefined}
      />,
    );
    view.stdin.write("?");
    await pause();
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("custom commands");
    expect(frame).toContain("/deploy");
    expect(frame).toContain("Deploy the app");
    expect(frame).not.toContain("shadowed");
  });

  it("opens a compact command palette without covering the composer", async () => {
    const store = new TuiStore();
    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        onSubmit={async () => undefined}
        onCommand={async () => undefined}
        onCancel={() => undefined}
        onExit={() => undefined}
      />,
    );
    view.stdin.write("/");
    await pause();
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("/help");
    expect(frame).toContain("/sessions");
    expect(frame).toContain("/undo");
    expect(frame).toContain("/steer");
    expect(frame).toContain("/integrate");
    expect(frame).toContain("› /");
  });

  it("opens and switches sessions from the keyboard picker", async () => {
    const store = new TuiStore();
    const switchSession = vi.fn(async () => ({
      model: "test-model",
      sessionId: "session_fedcba0987654321",
      cwd: "/workspace/kulmi",
      autonomy: "medium" as const,
      mode: "task" as const,
    }));
    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        onSubmit={async () => undefined}
        onCommand={async (command) => command === "/sessions" ? {
          sessions: [
            { id: "session_1234567890abcdef", status: "idle", model: "test-model", title: "Current work", current: true },
            { id: "session_fedcba0987654321", status: "completed", model: "test-model", title: "Previous work", current: false },
          ],
        } : undefined}
        onSwitchSession={switchSession}
        onCancel={() => undefined}
        onExit={() => undefined}
      />,
    );
    view.stdin.write("/sessions");
    await pause();
    view.stdin.write("\r");
    await pause(100);
    expect(view.lastFrame()).toContain("Previous work");
    view.stdin.write("\u001b[B");
    await pause(100);
    view.stdin.write("\r");
    await pause(100);
    expect(switchSession).toHaveBeenCalledWith("session_fedcba0987654321");
    expect(view.lastFrame()).toContain("test-model");
    expect(view.lastFrame()).toContain("goal");
  });

  it("runs an inline goal and exposes goal mode in the footer", async () => {
    const store = new TuiStore();
    const submit = vi.fn(async () => undefined);
    const command = vi.fn(async (_name: string, args: string) => ({ submit: args, mode: "task" as const }));
    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        onSubmit={submit}
        onCommand={command}
        onCancel={() => undefined}
        onExit={() => undefined}
      />,
    );
    view.stdin.write("/goal fix the cache");
    await pause();
    view.stdin.write("\r");
    await pause(100);
    expect(command).toHaveBeenCalledWith("/goal", "fix the cache");
    expect(submit).toHaveBeenCalledWith("fix the cache");
    expect(view.lastFrame()).toContain("goal");
  });

  it("coalesces high-frequency streamed deltas", async () => {
    const bus = new EventBus();
    const store = new TuiStore();
    store.attach(bus);
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });
    for (let index = 0; index < 100; index += 1) {
      await bus.emit({ type: "assistant.text.delta", agentId: "agent", text: "x" });
    }
    expect(notifications).toBe(0);
    await pause();
    expect(notifications).toBe(1);
    expect(store.getSnapshot().streaming).toHaveLength(100);
  });

  it("keeps worker reasoning and plans out of the parent transcript", async () => {
    const bus = new EventBus();
    const store = new TuiStore();
    store.attach(bus);
    await bus.emit({ type: "agent.started", agentId: "root", prompt: "parent" });
    await bus.emit({ type: "agent.started", agentId: "worker", parentAgentId: "root", prompt: "child" });
    await bus.emit({ type: "assistant.text.delta", agentId: "worker", text: "private worker stream" });
    await bus.emit({
      type: "plan.updated",
      agentId: "worker",
      steps: [{ id: "child", title: "Child plan", status: "in_progress", dependsOn: [], acceptanceCriteria: [] }],
    });
    await pause();
    expect(store.getSnapshot().streaming).toBe("");
    expect(store.getSnapshot().plan).toEqual([]);
    expect(store.getSnapshot().live.some((item) => item.kind === "worker")).toBe(true);
  });

  it("surfaces worker activity instead of flooding the parent tool feed", async () => {
    const bus = new EventBus();
    const store = new TuiStore();
    store.attach(bus);
    await bus.emit({ type: "agent.started", agentId: "root", prompt: "parent" });
    await bus.emit({
      type: "agent.started",
      agentId: "worker_1",
      parentAgentId: "root",
      prompt: "Worker preset: security.\n- Inspect scope.\n\nAudit auth.ts",
    });
    await bus.emit({
      type: "tool.started",
      agentId: "worker_1",
      callId: "call_w1",
      tool: "read_file",
      input: { path: "src/auth.ts" },
    });
    await pause();
    const live = store.getSnapshot().live;
    expect(live.some((item) => item.kind === "tool")).toBe(false);
    const worker = live.find((item) => item.kind === "worker" && item.id === "worker_1");
    expect(worker?.kind).toBe("worker");
    if (worker?.kind !== "worker") throw new Error("expected worker");
    expect(worker.title).toContain("Audit auth.ts");
    expect(worker.activity).toContain("Read file");
    expect(worker.activity).toContain("src/auth.ts");

    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        onSubmit={async () => undefined}
        onCommand={async () => undefined}
        onCancel={() => undefined}
        onExit={() => undefined}
      />,
    );
    await pause();
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("agents");
    expect(frame).toContain("1/1 running");
    expect(frame).toContain("agent");
    expect(frame).toContain("Read file");
    expect(frame).toContain("1 agent");
  });

  it("renders a long assistant message in full without truncating", async () => {
    const bus = new EventBus();
    const store = new TuiStore();
    store.attach(bus);
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
    await bus.emit({ type: "agent.started", agentId: "root", prompt: "summarize" });
    await bus.emit({ type: "assistant.message", agentId: "root", text: lines.join("\n") });
    await pause();
    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        onSubmit={async () => undefined}
        onCommand={async () => undefined}
        onCancel={() => undefined}
        onExit={() => undefined}
      />,
    );
    const frame = view.frames.join("\n");
    expect(frame).toContain("line 1");
    expect(frame).toContain("line 40");
    expect(frame).not.toContain("…");
  });

  it("echoes the submitted message instantly and does not duplicate it on agent.started", async () => {
    const bus = new EventBus();
    const store = new TuiStore();
    store.attach(bus);

    store.echoUserMessage("hello");
    const echoed = store.getSnapshot().transcript;
    expect(echoed.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(echoed.at(-1)).toMatchObject({ kind: "user", text: "hello" });

    await bus.emit({ type: "agent.started", agentId: "root", prompt: "hello" });
    await bus.emit({ type: "tool.started", agentId: "root", callId: "call_1", tool: "read_file", input: { path: "a.ts" } });
    await pause();

    const snapshot = store.getSnapshot();
    expect(snapshot.transcript.filter((item) => item.kind === "user")).toHaveLength(1);
    expect(snapshot.transcript.some((item) => item.kind === "tool")).toBe(false);
    expect(snapshot.live.some((item) => item.id === "call_1" && item.kind === "tool")).toBe(true);
  });

  it("replaces transient state when switching sessions", async () => {
    const bus = new EventBus();
    const store = new TuiStore();
    store.attach(bus);
    await bus.emit({ type: "agent.started", agentId: "root", prompt: "old task" });
    await bus.emit({ type: "assistant.text.delta", agentId: "root", text: "old stream" });
    store.replaceSession([
      { role: "user", content: "new task" },
      { role: "assistant", content: "new answer" },
    ]);
    expect(store.getSnapshot()).toMatchObject({
      live: [],
      reasoning: "",
      streaming: "",
      plan: [],
      status: "idle",
    });
    expect(store.getSnapshot().transcript.map((item) => item.kind === "user" || item.kind === "assistant" ? item.text : ""))
      .toEqual(["new task", "new answer"]);
  });

  it("pins the active request while many tool calls run and shows compact errors", async () => {
    const bus = new EventBus();
    const store = new TuiStore();
    store.attach(bus);
    await bus.emit({ type: "agent.started", agentId: "root", prompt: "Keep this request visible" });
    for (let index = 0; index < 12; index += 1) {
      await bus.emit({ type: "tool.started", agentId: "root", callId: `call-${index}`, tool: "read_file", input: { path: `src/${index}.ts` } });
      await bus.emit({
        type: "tool.finished",
        agentId: "root",
        callId: `call-${index}`,
        tool: "read_file",
        output: index === 11 ? "ENOENT\nmissing final file" : "ok",
        ...(index === 10 ? { diff: "--- a/src/10.ts\n+++ b/src/10.ts\n@@ -1,1 +1,1 @@\n-old\n+new" } : {}),
        isError: index === 11,
        durationMs: 2,
      });
    }
    await pause();
    const snapshot = store.getSnapshot();
    expect(snapshot.transcript.at(-1)).toMatchObject({ title: "Read file", status: "error", detail: "src/11.ts", summary: "ENOENT missing final file" });
    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        onSubmit={async () => undefined}
        onCommand={async () => undefined}
        onCancel={() => undefined}
        onExit={() => undefined}
      />,
    );
    const frame = view.frames.join("\n");
    expect(frame).toContain("Keep this request visible");
    expect(frame).toContain("ENOENT missing final file");
    expect(frame).toContain("--- a/src/10.ts");
    expect(frame).toContain("+new");
  });

  it("shows what a finished tool call actually did on its row", async () => {
    const bus = new EventBus();
    const store = new TuiStore();
    store.attach(bus);
    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        onSubmit={async () => undefined}
        onCommand={async () => undefined}
        onCancel={() => undefined}
        onExit={() => undefined}
      />,
    );
    await bus.emit({ type: "agent.started", agentId: "root", prompt: "Find the leak" });
    await bus.emit({ type: "tool.started", agentId: "root", callId: "call_grep", tool: "grep", input: { pattern: "leak", path: "src" } });
    await bus.emit({
      type: "tool.finished",
      agentId: "root",
      callId: "call_grep",
      tool: "grep",
      output: "./src/a.ts:1:leak\n./src/a.ts:9:leak\n./src/b.ts:3:leak",
      isError: false,
      durationMs: 8,
    });
    await bus.emit({ type: "tool.started", agentId: "root", callId: "call_plan", tool: "update_plan", input: { steps: [{ id: "1", title: "fix", status: "completed" }, { id: "2", title: "verify", status: "pending" }] } });
    await bus.emit({
      type: "tool.finished",
      agentId: "root",
      callId: "call_plan",
      tool: "update_plan",
      output: JSON.stringify({ accepted: true, step_count: 2, completed: 1 }),
      isError: false,
      durationMs: 1,
    });
    await pause();
    const frame = view.frames.join("\n");
    expect(frame).toContain("Search code");
    expect(frame).toContain("3 matches in 2 files");
    expect(frame).toContain("Update plan");
    expect(frame).toContain("2 steps, 1 done");
    expect(frame).not.toContain("{\"steps\"");
  });

  it("keeps the transcript append-only past the former static cap", async () => {
    const bus = new EventBus();
    const store = new TuiStore();
    store.attach(bus);
    for (let index = 0; index < 1_005; index += 1) {
      await bus.emit({ type: "notice", message: `notice-${index}` });
    }
    await pause();
    const transcript = store.getSnapshot().transcript;
    expect(transcript).toHaveLength(1_005);
    expect(transcript[0]).toMatchObject({ kind: "notice", text: "notice-0" });
    expect(transcript.at(-1)).toMatchObject({ kind: "notice", text: "notice-1004" });
  });

  it("closes help with escape without cancelling a busy run", async () => {
    const store = new TuiStore();
    const cancel = vi.fn();
    let finishRun: (() => void) | undefined;
    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        onSubmit={() => new Promise<void>((resolve) => { finishRun = resolve; })}
        onCommand={async () => undefined}
        onCancel={cancel}
        onExit={() => undefined}
      />,
    );
    view.stdin.write("inspect this repo");
    await pause();
    view.stdin.write("\r");
    await pause();
    view.stdin.write("?");
    await pause();
    expect(view.lastFrame() ?? "").toContain("commands");
    view.stdin.write("\u001b");
    await pause();
    expect(cancel).not.toHaveBeenCalled();
    expect(view.lastFrame() ?? "").not.toContain("commands");
    finishRun?.();
  });

  it("does not leak help or thinking hotkeys into the composer", async () => {
    const store = new TuiStore();
    const view = render(
      <TuiApp
        store={store}
        model="test-model"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        onSubmit={async () => undefined}
        onCommand={async () => undefined}
        onCancel={() => undefined}
        onExit={() => undefined}
      />,
    );
    view.stdin.write("?");
    await pause();
    expect(view.lastFrame() ?? "").toContain("commands");
    view.stdin.write("?");
    await pause();
    expect(view.lastFrame() ?? "").toContain("What should we build?");
    expect(view.lastFrame() ?? "").not.toMatch(/› \?/);
    view.stdin.write("\u000f");
    await pause();
    expect(store.getSnapshot().expandedThinking).toBe(true);
    expect(view.lastFrame() ?? "").toContain("What should we build?");
    expect(view.lastFrame() ?? "").not.toMatch(/› o/);
  });
});

function pause(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
