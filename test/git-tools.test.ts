import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
import type { PermissionApi, PermissionRequest, ToolContext } from "../src/tools/types.js";

const exec = promisify(execFile);
const ConflictList = z.object({ conflicts: z.array(z.string()) });

describe("git workflow tools", () => {
  it("lists, reads, resolves, and commits a local merge conflict under trusted autonomy", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kulmi-git-tools-")));
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-git-data-"));
    await exec("git", ["init", "--initial-branch", "master", root]);
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

describe("create_pull_request tool", () => {
  it("errors when the gh CLI is missing from PATH", async () => {
    const { root } = await pullRequestRepo();
    const registry = new ToolRegistry(gitTools());
    const context = await toolContext(root, { request: async () => true });
    const emptyBin = await realpath(await mkdtemp(join(tmpdir(), "kulmi-empty-bin-")));
    const originalPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      const result = await registry.execute({
        name: "create_pull_request",
        argumentsJson: JSON.stringify({ title: "Add feature" }),
        callId: "pr_missing_gh",
        context,
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("gh CLI not found");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("refuses without a permission prompt and never pushes when permission is denied", async () => {
    const { root, origin } = await pullRequestRepo();
    const shim = await fakeGhShim("https://github.com/example/repo/pull/1");
    const registry = new ToolRegistry(gitTools());
    const originalPath = process.env.PATH;
    process.env.PATH = `${shim.binDir}${delimiter}${originalPath}`;
    try {
      const missing = await registry.execute({
        name: "create_pull_request",
        argumentsJson: JSON.stringify({ title: "Add feature", base: "master" }),
        callId: "pr_no_permissions",
        context: await toolContext(root),
      });
      expect(missing.isError).toBe(true);
      expect(missing.content).toContain("requires approval");

      const requests: PermissionRequest[] = [];
      const deny: PermissionApi = {
        request: async (request) => {
          requests.push(request);
          return false;
        },
      };
      const denied = await registry.execute({
        name: "create_pull_request",
        argumentsJson: JSON.stringify({ title: "Add feature", base: "master" }),
        callId: "pr_denied",
        context: await toolContext(root, deny),
      });
      expect(denied.isError).toBe(true);
      expect(denied.content).toContain("denied");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.risk).toBe("high");
      expect(requests[0]?.command).toContain("gh pr create");
      await expect(exec("git", ["-C", origin, "rev-parse", "--verify", "refs/heads/feature"])).rejects.toThrow();
      await expect(readFile(shim.argvLog, "utf8")).rejects.toThrow();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("pushes the branch to origin and returns the pull request URL when approved", async () => {
    const { root, origin } = await pullRequestRepo();
    const shim = await fakeGhShim("https://github.com/example/repo/pull/42");
    const registry = new ToolRegistry(gitTools());
    const allow: PermissionApi = { request: async () => true };
    const context = await toolContext(root, allow);
    const originalPath = process.env.PATH;
    process.env.PATH = `${shim.binDir}${delimiter}${originalPath}`;
    try {
      const created = await registry.execute({
        name: "create_pull_request",
        argumentsJson: JSON.stringify({ title: "Add feature", body: "Details", base: "master", draft: true }),
        callId: "pr_create",
        context,
      });
      expect(created.isError).toBe(false);
      const parsed = z.object({ branch: z.string(), url: z.string() }).parse(JSON.parse(created.content));
      expect(parsed).toEqual({ branch: "feature", url: "https://github.com/example/repo/pull/42" });
      const { stdout: remoteHead } = await exec("git", ["-C", origin, "rev-parse", "refs/heads/feature"]);
      const { stdout: localHead } = await exec("git", ["-C", root, "rev-parse", "HEAD"]);
      expect(remoteHead.trim()).toBe(localHead.trim());
      const argv = (await readFile(shim.argvLog, "utf8")).trim().split("\n");
      expect(argv).toEqual([
        "pr",
        "create",
        "--title",
        "Add feature",
        "--body",
        "Details",
        "--head",
        "feature",
        "--base",
        "master",
        "--draft",
      ]);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

async function pullRequestRepo(): Promise<{ root: string; origin: string }> {
  process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-git-data-"));
  const root = await realpath(await mkdtemp(join(tmpdir(), "kulmi-git-pr-")));
  const origin = await realpath(await mkdtemp(join(tmpdir(), "kulmi-git-origin-")));
  await exec("git", ["init", "--bare", origin]);
  await exec("git", ["init", "--initial-branch", "master", root]);
  await exec("git", ["-C", root, "config", "user.email", "kulmi@example.invalid"]);
  await exec("git", ["-C", root, "config", "user.name", "Kulmi Test"]);
  await exec("git", ["-C", root, "remote", "add", "origin", origin]);
  await writeFile(join(root, "readme.txt"), "base\n");
  await exec("git", ["-C", root, "add", "readme.txt"]);
  await exec("git", ["-C", root, "commit", "-m", "base"]);
  await exec("git", ["-C", root, "checkout", "-b", "feature"]);
  await writeFile(join(root, "readme.txt"), "feature\n");
  await exec("git", ["-C", root, "commit", "-am", "feature change"]);
  return { root, origin };
}

async function fakeGhShim(url: string): Promise<{ binDir: string; argvLog: string }> {
  const binDir = await realpath(await mkdtemp(join(tmpdir(), "kulmi-gh-bin-")));
  const argvLog = join(binDir, "gh-argv.log");
  const script = `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvLog}"\necho "${url}"\n`;
  await writeFile(join(binDir, "gh"), script, { mode: 0o755 });
  return { binDir, argvLog };
}

async function toolContext(root: string, permissions?: PermissionApi): Promise<ToolContext> {
  const session = await SessionStore.create({ cwd: root, model: "test-model" });
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
    ...(permissions ? { permissions } : {}),
  };
}
