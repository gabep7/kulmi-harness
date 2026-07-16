import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/runtime/session-store.js";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import type { RunState } from "../src/core/types.js";
import type { ProviderMessage } from "../src/provider/types.js";
import { TEST_API_KEY_ENV, TEST_MODEL, TEST_MODEL_PROFILE, writeTestModelConfig } from "./helpers/test-config.js";

const exec = promisify(execFile);
const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("JSON-RPC bridge", () => {
  it("opens and closes a durable session with runtime state", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-rpc-workspace-"));
    const data = await mkdtemp(join(tmpdir(), "kulmi-rpc-data-"));
    await exec("git", ["init", root]);
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    await writeTestModelConfig(root);
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "rpc", "--cwd", root], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        XDG_DATA_HOME: data,
        KULMI_TEST_API_KEY: "sk-123456789",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stream = collectResponses(child.stdout);

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session.open",
      params: { cwd: root, mode: "task" },
    })}\n`);
    const opened = await waitForResponse(stream.responses, 2);
    await expect(waitForResponse(stream.responses, 1)).resolves.toMatchObject({
      result: { capabilities: { undo: true, workers: true, permissions: true } },
    });
    const result = opened.result as {
      sessionId: string;
      model: string;
      modelProfile: string;
      mode: string;
      state: { mode: string; status: string; modifiedFiles: string[] };
    };
    expect(result).toMatchObject({
      sessionId: expect.stringMatching(/^session_[a-f0-9]{16}$/),
      model: TEST_MODEL,
      modelProfile: TEST_MODEL_PROFILE,
      mode: "task",
      state: { mode: "task", status: "idle", modifiedFiles: [] },
    });

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "workers.list",
      params: { sessionId: result.sessionId },
    })}\n`);
    await expect(waitForResponse(stream.responses, 3)).resolves.toMatchObject({ result: [] });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "permission.respond",
      params: { sessionId: result.sessionId, requestId: "permission_missing", approved: true },
    })}\n`);
    await expect(waitForResponse(stream.responses, 4)).resolves.toMatchObject({
      error: { code: -32005, message: "unknown permission permission_missing" },
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "session.close",
      params: { sessionId: result.sessionId },
    })}\n`);
    await expect(waitForResponse(stream.responses, 5)).resolves.toMatchObject({ result: { closed: true } });
    child.stdin.end();
    await expect(new Promise<number | null>((resolve) => child.once("exit", resolve))).resolves.toBe(0);
    stream.close();
  }, 15_000);

  it("rejects a sequential duplicate open without losing the original session", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-rpc-duplicate-workspace-"));
    const data = await mkdtemp(join(tmpdir(), "kulmi-rpc-duplicate-data-"));
    await exec("git", ["init", root]);
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    await writeTestModelConfig(root);
    const rpc = startRpc(root, data);

    rpc.request(1, "session.open", { cwd: root, mode: "task" });
    const sessionId = responseSessionId(await waitForResponse(rpc.responses, 1));
    rpc.request(2, "session.close", { sessionId });
    await expect(waitForResponse(rpc.responses, 2)).resolves.toMatchObject({ result: { closed: true } });

    rpc.request(3, "session.open", { cwd: root, sessionId });
    await expect(waitForResponse(rpc.responses, 3)).resolves.toMatchObject({ result: { sessionId } });
    rpc.request(4, "session.open", { cwd: root, sessionId });
    await expect(waitForResponse(rpc.responses, 4)).resolves.toMatchObject({
      error: { code: -32006, message: `session ${sessionId} is already open or opening` },
    });
    rpc.request(5, "workers.list", { sessionId });
    await expect(waitForResponse(rpc.responses, 5)).resolves.toMatchObject({ result: [] });

    rpc.request(6, "session.close", { sessionId });
    await waitForResponse(rpc.responses, 6);
    await rpc.stop();
  }, 15_000);

  it("allows only one concurrent open of a persisted session and keeps the winner addressable", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-rpc-concurrent-workspace-"));
    const data = await mkdtemp(join(tmpdir(), "kulmi-rpc-concurrent-data-"));
    await exec("git", ["init", root]);
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    await writeTestModelConfig(root);
    const rpc = startRpc(root, data);

    rpc.request(1, "session.open", { cwd: root, mode: "task" });
    const sessionId = responseSessionId(await waitForResponse(rpc.responses, 1));
    rpc.request(2, "session.close", { sessionId });
    await waitForResponse(rpc.responses, 2);

    rpc.request(3, "session.open", { cwd: root, sessionId });
    rpc.request(4, "session.open", { cwd: root, sessionId });
    const attempts = await Promise.all([
      waitForResponse(rpc.responses, 3),
      waitForResponse(rpc.responses, 4),
    ]);
    expect(attempts.filter((response) => "result" in response)).toHaveLength(1);
    expect(attempts.filter((response) => "error" in response)).toEqual([
      expect.objectContaining({
        error: { code: -32006, message: `session ${sessionId} is already open or opening` },
      }),
    ]);
    rpc.request(5, "workers.list", { sessionId });
    await expect(waitForResponse(rpc.responses, 5)).resolves.toMatchObject({ result: [] });

    rpc.request(6, "session.close", { sessionId });
    await waitForResponse(rpc.responses, 6);
    await rpc.stop();
  }, 15_000);

  it("exposes session.steer and rejects steering an idle session", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-rpc-steer-workspace-"));
    const data = await mkdtemp(join(tmpdir(), "kulmi-rpc-steer-data-"));
    await exec("git", ["init", root]);
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    await writeTestModelConfig(root);
    const rpc = startRpc(root, data);

    rpc.request(1, "session.steer", { sessionId: "session_0000000000000000", message: "focus" });
    await expect(waitForResponse(rpc.responses, 1)).resolves.toMatchObject({
      error: { code: -32001, message: "session session_0000000000000000 is not open" },
    });

    rpc.request(2, "session.open", { cwd: root, mode: "task" });
    const sessionId = responseSessionId(await waitForResponse(rpc.responses, 2));
    rpc.request(3, "session.steer", { sessionId, message: "focus on the cache layer" });
    await expect(waitForResponse(rpc.responses, 3)).resolves.toMatchObject({
      error: { code: -32002, message: "no active run to steer" },
    });
    rpc.request(4, "session.steer", { sessionId, message: "" });
    await expect(waitForResponse(rpc.responses, 4)).resolves.toMatchObject({
      error: { code: -32602, message: "invalid params" },
    });

    rpc.request(5, "session.close", { sessionId });
    await waitForResponse(rpc.responses, 5);
    await rpc.stop();
  }, 15_000);

  it("releases a persisted session reservation when opening it fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-rpc-failed-open-workspace-"));
    const data = await mkdtemp(join(tmpdir(), "kulmi-rpc-failed-open-data-"));
    await exec("git", ["init", root]);
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    await writeTestModelConfig(root);
    const rpc = startRpc(root, data);

    rpc.request(1, "session.open", { cwd: root, mode: "task" });
    const sessionId = responseSessionId(await waitForResponse(rpc.responses, 1));
    rpc.request(2, "session.close", { sessionId });
    await waitForResponse(rpc.responses, 2);

    rpc.request(3, "session.open", { cwd: root, sessionId, model: "missing-profile" });
    await expect(waitForResponse(rpc.responses, 3)).resolves.toMatchObject({
      error: { code: -32603, message: "unknown model missing-profile" },
    });
    rpc.request(4, "session.open", { cwd: root, sessionId });
    await expect(waitForResponse(rpc.responses, 4)).resolves.toMatchObject({ result: { sessionId } });
    rpc.request(5, "workers.list", { sessionId });
    await expect(waitForResponse(rpc.responses, 5)).resolves.toMatchObject({ result: [] });

    rpc.request(6, "session.close", { sessionId });
    await waitForResponse(rpc.responses, 6);
    await rpc.stop();
  }, 15_000);

  it("restores a durable turn through session.undo", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-rpc-undo-workspace-"));
    const data = await mkdtemp(join(tmpdir(), "kulmi-rpc-undo-data-"));
    await exec("git", ["init", root]);
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    await writeTestModelConfig(root);
    process.env.XDG_DATA_HOME = data;
    const file = join(root, "file.txt");
    await writeFile(file, "before\n");
    const session = await SessionStore.create({
      cwd: root,
      model: TEST_MODEL,
      modelProfile: TEST_MODEL_PROFILE,
    });
    const state: RunState = {
      agentId: "agent_rpc_undo",
      mode: "task",
      status: "idle",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    const before: ProviderMessage[] = [{ role: "system", content: "stable" }];
    const after: ProviderMessage[] = [
      ...before,
      { role: "user", content: "change" },
      { role: "assistant", content: "done" },
    ];
    await session.saveMessages(before);
    await session.saveRunState(state);
    const checkpoint = new CheckpointStore(session.path, root);
    await checkpoint.beginTurn(before.length, state.agentId, state);
    await checkpoint.capture(file);
    await writeFile(file, "after\n");
    await checkpoint.finalizeTurn();
    await session.saveMessages(after);
    await session.saveRunState({
      ...state,
      status: "completed",
      modifiedFiles: new Set(["file.txt"]),
      revision: 1,
    });
    await session.close("completed");

    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "rpc", "--cwd", root], {
      cwd: process.cwd(),
      env: { ...process.env, XDG_DATA_HOME: data, KULMI_TEST_API_KEY: "sk-123456789" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stream = collectResponses(child.stdout);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.open",
      params: { cwd: root, sessionId: session.id },
    })}\n`);
    await waitForResponse(stream.responses, 1);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session.undo",
      params: { sessionId: session.id },
    })}\n`);
    await expect(waitForResponse(stream.responses, 2)).resolves.toMatchObject({
      result: {
        files: ["file.txt"],
        messageHistory: "truncate",
        removedMessageCount: 2,
        state: { revision: 0, modifiedFiles: [] },
      },
    });
    expect(await readFile(file, "utf8")).toBe("before\n");
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session.close",
      params: { sessionId: session.id },
    })}\n`);
    await waitForResponse(stream.responses, 3);
    child.stdin.end();
    await expect(new Promise<number | null>((resolve) => child.once("exit", resolve))).resolves.toBe(0);
    stream.close();
  }, 15_000);
});

interface RpcStream {
  responses: Array<Record<string, unknown>>;
  close(): void;
}

const responseSignals = new WeakMap<Array<Record<string, unknown>>, Set<() => void>>();

function collectResponses(stdout: Readable): RpcStream {
  const lines = createInterface({ input: stdout });
  const responses: Array<Record<string, unknown>> = [];
  const signals = new Set<() => void>();
  responseSignals.set(responses, signals);
  lines.on("line", (line) => {
    responses.push(parseRpcResponse(line));
    for (const notify of [...signals]) notify();
  });
  return { responses, close: () => lines.close() };
}

async function waitForResponse(
  responses: Array<Record<string, unknown>>,
  id: number,
): Promise<Record<string, unknown>> {
  // This awaits stdio from a real child process, so fake timers cannot drive it;
  // the deadline only converts a genuine hang into a diagnosable failure.
  const deadline = Date.now() + 30_000;
  const signals = responseSignals.get(responses);
  if (!signals) throw new Error("responses array was not created by collectResponses");
  for (;;) {
    const response = responses.find((candidate) => candidate.id === id);
    if (response) return response;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for RPC response ${id}: ${JSON.stringify(responses)}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    signals.add(resolve);
    const timer = setTimeout(resolve, remaining);
    try {
      await promise;
    } finally {
      clearTimeout(timer);
      signals.delete(resolve);
    }
  }
}

function startRpc(root: string, data: string) {
  // HOME already isolated by callers so user config is ignored

  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "rpc", "--cwd", root], {
    cwd: process.cwd(),
    env: { ...process.env, XDG_DATA_HOME: data, KULMI_TEST_API_KEY: "sk-123456789" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stream = collectResponses(child.stdout);
  return {
    responses: stream.responses,
    request(id: number, method: string, params: Record<string, unknown>) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    },
    async stop() {
      child.stdin.end();
      await expect(new Promise<number | null>((resolve) => child.once("exit", resolve))).resolves.toBe(0);
      stream.close();
    },
  };
}

function responseSessionId(response: Record<string, unknown>): string {
  const result = response.result;
  if (!result || typeof result !== "object" || !("sessionId" in result) || typeof result.sessionId !== "string") {
    throw new Error(`RPC response did not contain a session id: ${JSON.stringify(response)}`);
  }
  return result.sessionId;
}

function parseRpcResponse(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (!isRecord(parsed)) throw new Error(`RPC emitted a non-object response: ${line}`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
