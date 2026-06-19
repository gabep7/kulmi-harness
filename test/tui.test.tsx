import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { EventBus } from "../src/core/events.js";
import { TuiApp } from "../src/tui/app.js";
import { TuiStore } from "../src/tui/store.js";

afterEach(cleanup);

describe("Kulmi TUI", () => {
  it("renders a focused working view with plan, tools, and telemetry", async () => {
    const bus = new EventBus();
    const store = new TuiStore();
    store.attach(bus);
    const view = render(
      <TuiApp
        store={store}
        model="mimo-v2.5-pro"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        search="free"
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
    await pause();
    const frame = view.frames.join("\n");
    expect(frame).toContain("◆ kulmi");
    expect(frame).toContain("Improve the cache layer");
    expect(frame).toContain("Read file");
    expect(frame).toContain("Audit cache behavior");
    expect(frame).toContain("80% cache");
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
        model="mimo-v2.5-pro"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        search="off"
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

  it("opens a compact command palette without covering the composer", async () => {
    const store = new TuiStore();
    const view = render(
      <TuiApp
        store={store}
        model="mimo-v2.5-pro"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        search="free"
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
    expect(frame).toContain("/steer");
    expect(frame).toContain("/integrate");
    expect(frame).toContain("› /");
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
        model="mimo-v2.5-pro"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        search="free"
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
        isError: index === 11,
        durationMs: 2,
      });
    }
    await pause();
    const snapshot = store.getSnapshot();
    expect(snapshot.transcript.at(-1)).toMatchObject({ title: "Read file", status: "error", detail: "ENOENT missing final file" });
    const view = render(
      <TuiApp
        store={store}
        model="mimo-v2.5-pro"
        sessionId="session_1234567890abcdef"
        cwd="/workspace/kulmi"
        autonomy="medium"
        search="free"
        onSubmit={async () => undefined}
        onCommand={async () => undefined}
        onCancel={() => undefined}
        onExit={() => undefined}
      />,
    );
    const frame = view.frames.join("\n");
    expect(frame).toContain("Keep this request visible");
    expect(frame).toContain("ENOENT missing final file");
  });
});

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}
