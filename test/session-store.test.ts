import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/runtime/session-store.js";
import { EventBus } from "../src/core/events.js";

describe("SessionStore", () => {
  beforeEach(async () => {
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-session-data-"));
  });

  it("rejects path traversal in session IDs", async () => {
    const outside = join(process.env.XDG_DATA_HOME!, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "session.json"), "{}");
    await expect(SessionStore.open("../../outside")).rejects.toThrow("invalid session ID");
  });

  it("persists the billing-specific model profile", async () => {
    const store = await SessionStore.create({
      cwd: process.cwd(),
      model: "test-model",
      modelProfile: "test-model",
    });
    const loaded = await SessionStore.open(store.id);
    expect(loaded.session.metadata.modelProfile).toBe("test-model");
  });

  it("persists durable events without serializing streaming deltas", async () => {
    const store = await SessionStore.create({ cwd: process.cwd(), model: "test-model" });
    const events = new EventBus();
    store.attach(events);
    await events.emit({ type: "assistant.reasoning.delta", agentId: "agent", text: "private stream" });
    await events.emit({ type: "assistant.text.delta", agentId: "agent", text: "visible stream" });
    await events.emit({ type: "assistant.message", agentId: "agent", text: "final text" });
    await store.close("completed");

    const log = await readFile(join(store.path, "events.jsonl"), "utf8");
    expect(log).toContain("final text");
    expect(log).not.toContain("private stream");
    expect(log).not.toContain("visible stream");
  });

  it("writes versioned session files", async () => {
    const store = await SessionStore.create({ cwd: process.cwd(), model: "test-model" });
    await store.saveRunState({
      agentId: "agent_test",
      mode: "task",
      status: "idle",
      plan: [],
      modifiedFiles: new Set(["src/a.ts"]),
      verifications: [],
      revision: 1,
    });
    const metadata = JSON.parse(await readFile(join(store.path, "session.json"), "utf8"));
    const messages = JSON.parse(await readFile(join(store.path, "messages.json"), "utf8"));
    const state = JSON.parse(await readFile(join(store.path, "state.json"), "utf8"));
    expect(metadata.schemaVersion).toBe(1);
    expect(messages).toMatchObject({ schemaVersion: 1, messages: [] });
    expect(state).toMatchObject({ schemaVersion: 1, state: { modifiedFiles: ["src/a.ts"] } });
    if (process.platform !== "win32") {
      expect((await stat(store.path)).mode & 0o777).toBe(0o700);
      expect((await stat(join(store.path, "messages.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("migrates valid unversioned sessions on open", async () => {
    const id = "session_0123456789abcdef";
    const path = join(process.env.XDG_DATA_HOME!, "kulmi", "sessions", id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "session.json"), JSON.stringify({
      id,
      cwd: process.cwd(),
      model: "test-model",
      status: "idle",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    await writeFile(join(path, "messages.json"), JSON.stringify([{ role: "user", content: "hello" }]));
    await writeFile(join(path, "state.json"), JSON.stringify({
      agentId: "agent_old",
      mode: "task",
      status: "idle",
      plan: [{ id: "one", title: "One", status: "pending" }],
      modifiedFiles: [],
      verifications: [],
    }));
    const loaded = await SessionStore.open(id);
    expect(loaded.session.state?.plan[0]).toMatchObject({ dependsOn: [], acceptanceCriteria: [] });
    expect(JSON.parse(await readFile(join(path, "session.json"), "utf8"))).toMatchObject({ schemaVersion: 1, id });
    expect(JSON.parse(await readFile(join(path, "messages.json"), "utf8"))).toMatchObject({ schemaVersion: 1 });
    expect(JSON.parse(await readFile(join(path, "state.json"), "utf8"))).toMatchObject({ schemaVersion: 1 });
  });

  it("rejects malformed required and optional session files", async () => {
    const metadataStore = await SessionStore.create({ cwd: process.cwd(), model: "test-model" });
    const metadata = JSON.parse(await readFile(join(metadataStore.path, "session.json"), "utf8"));
    await writeFile(join(metadataStore.path, "session.json"), JSON.stringify({ ...metadata, status: "mystery" }));
    await expect(SessionStore.open(metadataStore.id)).rejects.toThrow("invalid session metadata");

    const messageStore = await SessionStore.create({ cwd: process.cwd(), model: "test-model" });
    await writeFile(join(messageStore.path, "messages.json"), JSON.stringify([{
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call", type: "function", function: { arguments: "{}" } }],
    }]));
    await expect(SessionStore.open(messageStore.id)).rejects.toThrow("invalid session messages");

    const second = await SessionStore.create({ cwd: process.cwd(), model: "test-model" });
    await writeFile(join(second.path, "state.json"), JSON.stringify({ broken: true }));
    await expect(SessionStore.open(second.id)).rejects.toThrow("invalid run state");

    const workerStore = await SessionStore.create({ cwd: process.cwd(), model: "test-model" });
    await writeFile(join(workerStore.path, "workers.json"), JSON.stringify([{ id: "worker_bad" }]));
    await expect(SessionStore.open(workerStore.id)).rejects.toThrow("invalid worker state");
  });
});
