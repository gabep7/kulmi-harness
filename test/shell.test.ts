import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/core/events.js";
import type { RunState } from "../src/core/types.js";
import { ArtifactStore } from "../src/runtime/artifacts.js";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import { shellTool } from "../src/tools/shell.js";

const exec = promisify(execFile);

describe("shell tool", () => {
  it("tracks shell writes and binds verification to the resulting revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-shell-"));
    const session = await mkdtemp(join(tmpdir(), "kulmi-shell-session-"));
    await exec("git", ["init", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.test"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "source.txt"), "new\n");
    await writeFile(join(root, "target.txt"), "old\n");
    await writeFile(join(root, "package.json"), '{"scripts":{"test":"true"}}\n');
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-m", "initial"]);
    const checkpoint = new CheckpointStore(session, root);
    await checkpoint.beginTurn(1, "agent");
    const state: RunState = {
      agentId: "agent",
      mode: "task",
      status: "running",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    const context = {
      workspaceRoot: root,
      cwd: root,
      autonomy: "medium" as const,
      signal: new AbortController().signal,
      events: new EventBus(),
      state,
      checkpoint,
      artifacts: new ArtifactStore(session),
      commandTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
    };

    expect((await shellTool.execute(context, { command: "cp source.txt target.txt" })).isError).toBeFalsy();
    expect(state.modifiedFiles).toContain("target.txt");
    expect(state.revision).toBe(1);
    expect((await shellTool.execute(context, { command: "npm test" })).isError).toBeFalsy();
    expect(state.verifications.at(-1)).toMatchObject({
      command: "npm test",
      exitCode: 0,
      revision: 1,
      timedOut: false,
      truncated: false,
      changedFiles: ["target.txt"],
    });

    let requested = false;
    const deletion = await shellTool.execute({
      ...context,
      permissions: {
        request: async (request) => {
          requested = true;
          expect(request).toMatchObject({ tool: "shell", risk: "high", command: "rm target.txt" });
          return true;
        },
      },
    }, { command: "rm target.txt" });
    expect(requested).toBe(true);
    expect(deletion.isError).toBeFalsy();
    await expect(access(join(root, "target.txt"))).rejects.toThrow();
    expect(state.modifiedFiles).toContain("target.txt");
    expect(state.revision).toBe(2);
    expect(state.verifications).not.toContainEqual(expect.objectContaining({ revision: 2 }));

    let readOnlyRequested = false;
    const readOnlyWrite = await shellTool.execute({
      ...context,
      autonomy: "read",
      permissions: {
        request: async () => {
          readOnlyRequested = true;
          return true;
        },
      },
    }, { command: "cp source.txt target.txt" });
    expect(readOnlyWrite.isError).toBe(true);
    expect(readOnlyRequested).toBe(false);
    await expect(readFile(join(root, "target.txt"), "utf8")).rejects.toThrow();
  });
});
