import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/runtime/session-store.js";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import type { RunState } from "../src/core/types.js";
import type { ProviderMessage } from "../src/provider/types.js";

const exec = promisify(execFile);

describe("JSON-RPC bridge", () => {
  it("opens and closes a durable MiMo session with runtime state", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-rpc-workspace-"));
    const data = await mkdtemp(join(tmpdir(), "kulmi-rpc-data-"));
    await exec("git", ["init", root]);
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "rpc", "--cwd", root], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        XDG_DATA_HOME: data,
        MIMO_API_KEY: "sk-123456789",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    const responses: Array<Record<string, unknown>> = [];
    lines.on("line", (line) => responses.push(JSON.parse(line) as Record<string, unknown>));

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session.open",
      params: { cwd: root, mode: "task" },
    })}\n`);
    const opened = await waitForResponse(responses, 2);
    await expect(waitForResponse(responses, 1)).resolves.toMatchObject({
      result: { capabilities: { undo: true } },
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
      model: "mimo-v2.5-pro",
      modelProfile: "mimo-v2.5-pro",
      mode: "task",
      state: { mode: "task", status: "idle", modifiedFiles: [] },
    });

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session.close",
      params: { sessionId: result.sessionId },
    })}\n`);
    await expect(waitForResponse(responses, 3)).resolves.toMatchObject({ result: { closed: true } });
    child.stdin.end();
    await expect(new Promise<number | null>((resolve) => child.once("exit", resolve))).resolves.toBe(0);
    lines.close();
  }, 15_000);

  it("restores a durable turn through session.undo", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-rpc-undo-workspace-"));
    const data = await mkdtemp(join(tmpdir(), "kulmi-rpc-undo-data-"));
    await exec("git", ["init", root]);
    process.env.XDG_DATA_HOME = data;
    const file = join(root, "file.txt");
    await writeFile(file, "before\n");
    const session = await SessionStore.create({
      cwd: root,
      model: "mimo-v2.5-pro",
      modelProfile: "mimo-v2.5-pro",
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
      env: { ...process.env, XDG_DATA_HOME: data, MIMO_API_KEY: "sk-123456789" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    const responses: Array<Record<string, unknown>> = [];
    lines.on("line", (line) => responses.push(JSON.parse(line) as Record<string, unknown>));
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session.open",
      params: { cwd: root, sessionId: session.id },
    })}\n`);
    await waitForResponse(responses, 1);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session.undo",
      params: { sessionId: session.id },
    })}\n`);
    await expect(waitForResponse(responses, 2)).resolves.toMatchObject({
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
    await waitForResponse(responses, 3);
    child.stdin.end();
    await expect(new Promise<number | null>((resolve) => child.once("exit", resolve))).resolves.toBe(0);
    lines.close();
  }, 15_000);
});

async function waitForResponse(
  responses: Array<Record<string, unknown>>,
  id: number,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = responses.find((candidate) => candidate.id === id);
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for RPC response ${id}: ${JSON.stringify(responses)}`);
}
