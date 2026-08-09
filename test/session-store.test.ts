import { access, mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { pruneSessions, SessionStore } from "../src/runtime/session-store.js";
import { EventBus } from "../src/core/events.js";
import type { ProviderMessage } from "../src/provider/types.js";
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

  it("appends new messages to the log instead of rewriting the whole transcript, and replays on open", async () => {
    const store = await SessionStore.create({ cwd: process.cwd(), model: "test-model" });
    const msg = (m: Array<Record<string, string>>): ProviderMessage[] => m as ProviderMessage[];
    await store.saveMessages(msg([{ role: "user", content: "first" }]));
    await store.saveMessages(msg([{ role: "user", content: "first" }, { role: "assistant", content: "second" }]));
    await store.saveMessages(msg([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ]));
    await store.close("completed");

    // The base file keeps the initial empty snapshot; the appended messages go
    // to the append log (so we never re-serialize and rewrite the whole array).
    const base = JSON.parse(await readFile(join(store.path, "messages.json"), "utf8"));
    expect(base.messages).toEqual([]);
    const log = await readFile(join(store.path, "messages.jsonl"), "utf8");
    expect(log.split("\n").filter(Boolean)).toHaveLength(3);

    const loaded = await SessionStore.open(store.id);
    expect(loaded.session.messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ]);
  });

  it("replays the append log and survives a corrupt trailing line", async () => {
    const store = await SessionStore.create({ cwd: process.cwd(), model: "test-model" });
    const msg = (m: Array<Record<string, string>>): ProviderMessage[] => m as ProviderMessage[];
    await store.saveMessages(msg([{ role: "user", content: "a" }]));
    await store.saveMessages(msg([{ role: "user", content: "a" }, { role: "user", content: "b" }]));
    await store.close("completed");
    // Simulate a crash mid-append leaving a truncated final line.
    await writeFile(join(store.path, "messages.jsonl"), "{ truncated", { flag: "a" });

    const loaded = await SessionStore.open(store.id);
    expect(loaded.session.messages).toEqual([{ role: "user", content: "a" }, { role: "user", content: "b" }]);
  });

  it("rewrites the base and resets the append log when the message array is truncated", async () => {
    const store = await SessionStore.create({ cwd: process.cwd(), model: "test-model" });
    const full = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "user", content: "c" },
      { role: "user", content: "d" },
    ] as ProviderMessage[];
    const msg = (m: ProviderMessage[]): ProviderMessage[] => m;
    await store.saveMessages(full.slice(0, 2));
    await store.saveMessages(msg(full));
    // Undo-style truncation rewrites the base and clears the log.
    await store.saveMessages(full.slice(0, 2));
    await store.close("completed");

    const base = JSON.parse(await readFile(join(store.path, "messages.json"), "utf8"));
    expect(base.messages).toEqual([{ role: "user", content: "a" }, { role: "user", content: "b" }]);
    expect(await readFile(join(store.path, "messages.jsonl"), "utf8")).toBe("");

    const loaded = await SessionStore.open(store.id);
    expect(loaded.session.messages).toEqual([{ role: "user", content: "a" }, { role: "user", content: "b" }]);
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

  it("prunes sessions by max count and max age while keeping protected ids", async () => {
    const keep = await SessionStore.create({ cwd: process.cwd(), model: "keep-model" });
    const oldA = await SessionStore.create({ cwd: process.cwd(), model: "old-a" });
    const oldB = await SessionStore.create({ cwd: process.cwd(), model: "old-b" });
    const recent = await SessionStore.create({ cwd: process.cwd(), model: "recent" });

    const ancient = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000).toISOString();
    for (const store of [oldA, oldB]) {
      const meta = JSON.parse(await readFile(join(store.path, "session.json"), "utf8")) as Record<string, unknown>;
      meta.updatedAt = ancient;
      meta.createdAt = ancient;
      await writeFile(join(store.path, "session.json"), `${JSON.stringify(meta, null, 2)}\n`);
    }

    const removedByAge = await pruneSessions({
      maxCount: 100,
      maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
      keepIds: [keep.id],
    });
    expect(removedByAge.sort()).toEqual([oldA.id, oldB.id].sort());
    await expect(access(oldA.path)).rejects.toThrow();
    await expect(access(keep.path)).resolves.toBeUndefined();
    await expect(access(recent.path)).resolves.toBeUndefined();

    const extras = await Promise.all(
      Array.from({ length: 3 }, () => SessionStore.create({ cwd: process.cwd(), model: "extra" })),
    );
    const removedByCount = await pruneSessions({
      maxCount: 2,
      maxAgeMs: 365 * 24 * 60 * 60 * 1_000,
      keepIds: [keep.id],
    });
    expect(removedByCount.length).toBeGreaterThan(0);
    await expect(access(keep.path)).resolves.toBeUndefined();
    const survivors = [keep, recent, ...extras].filter((store) => !removedByCount.includes(store.id));
    expect(survivors.length).toBeGreaterThanOrEqual(2);
  });
});

  it("recovers from a corrupt append-log line without losing the next message", async () => {
    const store = await SessionStore.create({ cwd: process.cwd(), model: "test-model" });
    const message1: ProviderMessage = { role: "user", content: "first" };
    await store.saveMessages([message1]);

    // Simulate a crash that writes a partial (invalid JSON) line to the append log.
    const logPath = join(store.path, "messages.jsonl");
    const { readFile, writeFile, appendFile } = await import("node:fs/promises");
    // Write a partial JSON fragment that would corrupt the next appended message
    await appendFile(logPath, "{\"role\":\"user\":\"parti", { mode: 0o600 });

    // Reopen: the corrupt line should be detected and skipped
    const reopened = await SessionStore.open(store.id);
    // The valid message should still be present
    expect(reopened.session.messages.length).toBe(1);
    expect(reopened.session.messages[0]?.content).toBe("first");

    // Now save a new message — the dirty flag should force a full rewrite,
    // not an append after the corrupt line.
    const message2: ProviderMessage = { role: "assistant", content: "second" };
    const allMessages = [...reopened.session.messages, message2];
    await reopened.store.saveMessages(allMessages);

    // Reopen again and verify message2 was persisted correctly
    const final = await SessionStore.open(store.id);
    const contents = final.session.messages.map((m) => m.content);
    expect(contents).toContain("second");
    expect(final.session.messages.length).toBe(2);
  });
