import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { RunState } from "../src/core/types.js";
import type { ProviderMessage } from "../src/provider/types.js";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import { SessionStore } from "../src/runtime/session-store.js";
import { TEST_API_KEY_ENV, TEST_MODEL, TEST_MODEL_PROFILE, writeTestModelConfig } from "./helpers/test-config.js";

const exec = promisify(execFile);
const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("kulmi undo", () => {
  it("restores the latest durable turn from the headless CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-cli-undo-workspace-"));
    const data = await mkdtemp(join(tmpdir(), "kulmi-cli-undo-data-"));
    await exec("git", ["init", root]);
    await writeTestModelConfig(root);
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    process.env.XDG_DATA_HOME = data;
    const file = join(root, "file.txt");
    await writeFile(file, "before\n");
    const state: RunState = {
      agentId: "agent_cli_undo",
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
    const session = await SessionStore.create({
      cwd: root,
      model: TEST_MODEL,
      modelProfile: TEST_MODEL_PROFILE,
    });
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

    const result = await exec(process.execPath, [
      "--import",
      join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs"),
      join(process.cwd(), "src", "cli.ts"),
      "undo",
      session.id,
    ], {
      cwd: root,
      env: { ...process.env, XDG_DATA_HOME: data, [TEST_API_KEY_ENV]: "sk-123456789" },
    });
    expect(result.stdout).toContain("message history truncate");
    expect(await readFile(file, "utf8")).toBe("before\n");
    const persisted = (await SessionStore.open(session.id)).session;
    expect(persisted.messages).toEqual(before);
    expect(persisted.state).toMatchObject({ revision: 0, status: "idle" });
  }, 15_000);
});
