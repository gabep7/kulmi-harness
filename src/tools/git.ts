import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { resolveToolBinary } from "../runtime/binaries.js";
import { disposeChildEnvironment, safeChildEnvironment } from "../security/environment.js";
import { assertNotSensitivePath, resolveWorkspacePath } from "../security/paths.js";
import { writeAtomic } from "./files.js";
import { defineTool, type AnyTool, type ToolContext } from "./types.js";

const execFileAsync = promisify(execFile);

export function gitTools(): AnyTool[] {
  return [listConflictsTool, readConflictTool, resolveConflictTool, commitChangesTool, createPullRequestTool];
}

const listConflictsTool = defineTool({
  name: "list_conflicts",
  description: "List unresolved Git merge-conflict files in the workspace.",
  schema: z.object({}),
  readOnly: true,
  async execute(context) {
    const files = await conflictFiles(context.workspaceRoot);
    return { content: files.length ? JSON.stringify({ conflicts: files }, null, 2) : "no conflicts" };
  },
});

const readConflictTool = defineTool({
  name: "read_conflict",
  description: "Read one unresolved conflict file with conflict marker blocks and line numbers.",
  schema: z.object({ path: z.string().min(1) }),
  readOnly: true,
  async execute(context, input) {
    const path = await resolveWorkspacePath({ workspaceRoot: context.workspaceRoot, cwd: context.cwd, input: input.path, mustExist: true });
    assertNotSensitivePath(path);
    const rel = relativeConflictPath(context.workspaceRoot, path);
    const conflicts = await conflictFiles(context.workspaceRoot);
    if (!conflicts.includes(rel)) throw new Error(`${rel} is not an unresolved conflict`);
    const lines = (await readFile(path, "utf8")).split("\n");
    return { content: lines.map((line, index) => `${index + 1}:${line}`).join("\n") };
  },
});

const resolveConflictTool = defineTool({
  name: "resolve_conflict",
  description: "Resolve one Git conflict by writing final file content and staging the file. Use content only after reading the conflict.",
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  readOnly: false,
  async execute(context, input) {
    await requireGitMutationApproval(context, `resolve conflict ${input.path}`);
    const path = await resolveWorkspacePath({ workspaceRoot: context.workspaceRoot, cwd: context.cwd, input: input.path, mustExist: true });
    assertNotSensitivePath(path);
    const rel = relativeConflictPath(context.workspaceRoot, path);
    const conflicts = await conflictFiles(context.workspaceRoot);
    if (!conflicts.includes(rel)) throw new Error(`${rel} is not an unresolved conflict`);
    if (/^<<<<<<< |^=======\s*$|^>>>>>>> /m.test(input.content)) throw new Error("resolved content still contains conflict markers");
    await context.checkpoint.capture(path);
    await writeAtomic(path, input.content);
    context.state.modifiedFiles.add(rel);
    context.state.revision += 1;
    delete context.state.completion;
    await git(context.workspaceRoot, ["add", "--", rel]);
    return { content: `resolved and staged ${rel}`, mutated: true };
  },
});

const commitChangesTool = defineTool({
  name: "commit_changes",
  description: "Create a local Git commit from selected paths or all current changes. Never pushes. Requires trusted autonomy or approval.",
  schema: z.object({
    message: z.string().min(1).max(200),
    paths: z.array(z.string().min(1)).default([]),
  }),
  readOnly: false,
  async execute(context, input) {
    await requireGitMutationApproval(context, "create local git commit");
    if (/\n/.test(input.message)) throw new Error("commit message must be a single line");
    const statusBefore = await git(context.workspaceRoot, ["status", "--porcelain=v1"]);
    if (!statusBefore.trim()) throw new Error("nothing to commit");
    if (input.paths.length > 0) {
      const rels = [];
      for (const item of input.paths) {
        const path = await resolveWorkspacePath({ workspaceRoot: context.workspaceRoot, cwd: context.cwd, input: item, mustExist: false });
        assertNotSensitivePath(path);
        rels.push(relativeConflictPath(context.workspaceRoot, path));
      }
      await git(context.workspaceRoot, ["add", "--", ...rels]);
    } else {
      await git(context.workspaceRoot, ["add", "--all"]);
    }
    const staged = await git(context.workspaceRoot, ["diff", "--cached", "--name-only"]);
    if (!staged.trim()) throw new Error("nothing staged for commit");
    await git(context.workspaceRoot, ["commit", "-m", input.message]);
    const hash = (await git(context.workspaceRoot, ["rev-parse", "--short", "HEAD"])).trim();
    return { content: `created local commit ${hash}: ${input.message}`, mutated: false };
  },
});

const createPullRequestTool = defineTool({
  name: "create_pull_request",
  description: "Push the current branch to origin and open a GitHub pull request via the gh CLI. Always requires explicit approval.",
  schema: z.object({
    title: z.string().min(1).max(120),
    body: z.string().max(20000).optional(),
    base: z.string().min(1).optional(),
    draft: z.boolean().optional(),
  }),
  readOnly: false,
  async execute(context, input) {
    const root = context.workspaceRoot;
    const gh = await resolveToolBinary("gh");
    if (!gh) throw new Error("gh CLI not found on PATH: install GitHub CLI (https://cli.github.com) and run `gh auth login`");
    const branch = (await git(root, ["branch", "--show-current"])).trim();
    if (!branch) throw new Error("HEAD is detached: check out a branch before creating a pull request");
    try {
      await git(root, ["remote", "get-url", "origin"]);
    } catch {
      throw new Error("no origin remote is configured: add one with `git remote add origin <url>`");
    }
    if (input.base === branch) throw new Error(`current branch ${branch} is the base branch: check out a feature branch first`);
    const baseRef = await resolveBaseRef(root, input.base);
    if (baseRef) {
      const ahead = (await git(root, ["rev-list", "--count", `${baseRef}..HEAD`])).trim();
      if (ahead === "0") throw new Error(`branch ${branch} has no commits ahead of ${baseRef}: commit changes before creating a pull request`);
    }
    const ghArgs = ["pr", "create", "--title", input.title, "--body", input.body ?? "", "--head", branch];
    if (input.base) ghArgs.push("--base", input.base);
    if (input.draft) ghArgs.push("--draft");
    if (!context.permissions) {
      throw new Error("create_pull_request publishes to a remote and always requires approval: no permission prompt is available in this session");
    }
    const approved = await context.permissions.request({
      tool: "git",
      risk: "high",
      reason: `push ${branch} to origin and create a pull request`,
      command: `gh ${ghArgs.join(" ")}`,
      input,
    });
    if (!approved) throw new Error("pull request creation was denied by the user");
    const env = safeChildEnvironment({
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR ?? (process.env.HOME ? join(process.env.HOME, ".config", "gh") : undefined),
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    });
    let output: string;
    try {
      try {
        await execFileAsync("git", ["-C", root, "push", "-u", "origin", "HEAD"], {
          env,
          cwd: root,
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024,
        });
      } catch (error) {
        throw new Error(`git push -u origin HEAD failed: ${childProcessFailure(error)}`);
      }
      try {
        const { stdout, stderr } = await execFileAsync(gh, ghArgs, {
          env,
          cwd: root,
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024,
        });
        output = `${stdout}\n${stderr}`;
      } catch (error) {
        throw new Error(`gh pr create failed: ${childProcessFailure(error)}`);
      }
    } finally {
      disposeChildEnvironment(env);
    }
    const url = output.match(/https:\/\/\S+/)?.[0];
    if (!url) throw new Error(`gh did not report a pull request URL: ${output.trim() || "empty output"}`);
    return { content: JSON.stringify({ branch, url }, null, 2), mutated: false };
  },
});

async function conflictFiles(root: string): Promise<string[]> {
  const output = await git(root, ["diff", "--name-only", "--diff-filter=U"]);
  return output.split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

async function requireGitMutationApproval(context: ToolContext, reason: string): Promise<void> {
  if (context.autonomy === "trusted") return;
  const approved = await context.permissions?.request({ tool: "git", risk: "high", reason, input: {} });
  if (!approved) throw new Error(`${reason} requires trusted autonomy or approval`);
}

async function resolveBaseRef(root: string, base: string | undefined): Promise<string | undefined> {
  const candidates = base
    ? [`refs/remotes/origin/${base}`, `refs/heads/${base}`]
    : ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"];
  for (const candidate of candidates) {
    try {
      await git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function childProcessFailure(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) {
    return error.stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function relativeConflictPath(root: string, path: string): string {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!path.startsWith(prefix)) throw new Error(`path is outside workspace: ${path}`);
  return path.slice(prefix.length);
}

async function git(root: string, args: string[]): Promise<string> {
  const env = safeChildEnvironment();
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      env,
      cwd: root,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } finally {
    disposeChildEnvironment(env);
  }
}
