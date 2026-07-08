import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EventBus } from "../src/core/events.js";
import type { RunState } from "../src/core/types.js";
import { ArtifactStore } from "../src/runtime/artifacts.js";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import { SessionStore } from "../src/runtime/session-store.js";
import { gitTools } from "../src/tools/git.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/types.js";

const exec = promisify(execFile);
const ConflictList = z.object({ conflicts: z.array(z.string()) });

describe("git workflow tools", () => {
  it("lists, reads, resolves, and commits a local merge conflict under trusted autonomy", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kulmi-git-tools-")));
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-git-data-"));
    await exec("git", ["init", root]);
    await exec("git", ["-C", root, "config", "user.email", "kulmi@example.invalid"]);
    await exec("git", ["-C", root, "config", "user.name", "Kulmi Test"]);
    await writeFile(join(root, "conflict.txt"), "base\n");
    await exec("git", ["-C", root, "add", "conflict.txt"]);
    await exec("git", ["-C", root, "commit", "-m", "base"]);
    await exec("git", ["-C", root, "checkout", "-b", "other"]);
    await writeFile(join(root, "conflict.txt"), "theirs\n");
    await exec("git", ["-C", root, "commit", "-am", "other change"]);
    await exec("git", ["-C", root, "checkout", "master"]);
    await writeFile(join(root, "conflict.txt"), "ours\n");
    await exec("git", ["-C", root, "commit", "-am", "main change"]);

    let mergeConflicted = false;
    try {
      await exec("git", ["-C", root, "merge", "other"]);
    } catch {
      mergeConflicted = true;
    }
    expect(mergeConflicted).toBe(true);

    const registry = new ToolRegistry(gitTools());
    const context = await toolContext(root);
    const listed = await registry.execute({
      name: "list_conflicts",
      argumentsJson: "{}",
      callId: "list_conflicts",
      context,
    });
    expect(ConflictList.parse(JSON.parse(listed.content)).conflicts).toEqual(["conflict.txt"]);

    const conflict = await registry.execute({
      name: "read_conflict",
      argumentsJson: JSON.stringify({ path: "conflict.txt" }),
      callId: "read_conflict",
      context,
    });
    expect(conflict.content).toContain("<<<<<<< HEAD");
    expect(conflict.content).toContain("ours");
    expect(conflict.content).toContain("=======");
    expect(conflict.content).toContain("theirs");
    expect(conflict.content).toContain(">>>>>>> other");

    const resolved = await registry.execute({
      name: "resolve_conflict",
      argumentsJson: JSON.stringify({ path: "conflict.txt", content: "resolved\n" }),
      callId: "resolve_conflict",
      context,
    });
    expect(resolved).toEqual({ content: "resolved and staged conflict.txt", isError: false });

    const empty = await registry.execute({
      name: "list_conflicts",
      argumentsJson: "{}",
      callId: "list_conflicts_after",
      context,
    });
    expect(empty).toEqual({ content: "no conflicts", isError: false });

    const committed = await registry.execute({
      name: "commit_changes",
      argumentsJson: JSON.stringify({ message: "resolve conflict", paths: ["conflict.txt"] }),
      callId: "commit_changes",
      context,
    });
    expect(committed.content).toMatch(/^created local commit [a-f0-9]+: resolve conflict$/);
    expect(committed.isError).toBe(false);
    expect(await readFile(join(root, "conflict.txt"), "utf8")).toBe("resolved\n");
    const { stdout } = await exec("git", ["-C", root, "log", "-1", "--pretty=%s"]);
    expect(stdout.trim()).toBe("resolve conflict");
  });
});

async function toolContext(root: string): Promise<ToolContext> {
  const session = await SessionStore.create({ cwd: root, model: "mimo-v2.5-pro" });
  const state: RunState = {
    agentId: "agent_git_tools",
    mode: "task",
    status: "running",
    plan: [],
    modifiedFiles: new Set(),
    verifications: [],
    revision: 0,
  };
  return {
    workspaceRoot: root,
    cwd: root,
    autonomy: "trusted",
    signal: new AbortController().signal,
    events: new EventBus(),
    state,
    checkpoint: new CheckpointStore(session.path, root),
    artifacts: new ArtifactStore(session.path),
    commandTimeoutMs: 10_000,
    maxOutputBytes: 100_000,
  };
}
