import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { CheckpointStore } from "./checkpoints.js";
import { disposeChildEnvironment, safeChildEnvironment } from "../security/environment.js";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
  baseCommit: string;
  parentHead?: string;
  parentUnborn?: boolean;
}

export class WorktreeManager {
  readonly #root: string;
  readonly #worktreesRoot: string;
  #operationQueue = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.#root = resolve(workspaceRoot);
    const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
    const repositoryId = createHash("sha256").update(this.#root).digest("hex").slice(0, 16);
    this.#worktreesRoot = join(data, "kulmi", "worktrees", repositoryId);
  }

  async create(id: string): Promise<WorktreeInfo> {
    return this.#exclusive(async () => {
      assertSafeId(id);
      await mkdir(this.#worktreesRoot, { recursive: true });
      const parentHead = await this.#gitOptional(this.#root, ["rev-parse", "--verify", "HEAD"]);
      const baseCommit = await this.#snapshotCommit(id, parentHead);
      const path = join(this.#worktreesRoot, id);
      const branch = `kulmi/${id}`;
      await this.#git(this.#root, ["worktree", "add", "-b", branch, path, baseCommit]);
      return {
        id,
        path,
        branch,
        baseCommit,
        ...(parentHead ? { parentHead } : { parentUnborn: true }),
      };
    });
  }

  async integrate(info: WorktreeInfo, checkpoint: CheckpointStore): Promise<string[]> {
    return this.#exclusive(async () => {
      const parentHead = await this.#gitOptional(this.#root, ["rev-parse", "--verify", "HEAD"]);
      const expectedParentHead = info.parentUnborn ? "" : info.parentHead ?? info.baseCommit;
      if (parentHead !== expectedParentHead) {
        throw new Error(`parent HEAD changed while ${info.id} was running; worktree kept at ${info.path}`);
      }
      const changed = await this.#changedFiles(info);
      const copies: Array<{ source: string; destination: string }> = [];
      for (const path of changed) {
        if (isSensitiveSnapshotPath(path)) throw new Error(`refusing to integrate sensitive path ${path}`);
        const source = resolve(info.path, path);
        const destination = resolve(this.#root, path);
        if (
          relative(info.path, source).startsWith("..") ||
          relative(this.#root, destination).startsWith("..")
        ) {
          throw new Error(`unsafe worktree path ${path}`);
        }
        const sourceInfo = await lstat(source);
        if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
          throw new Error(`worktree integration only supports regular files: ${path}`);
        }
        await this.#assertPathUnchanged(info, path, destination, source);
        await checkpoint.capture(destination);
        copies.push({ source, destination });
      }
      for (const { source, destination } of copies) {
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(source, destination);
      }
      return changed;
    });
  }

  async #assertPathUnchanged(
    info: WorktreeInfo,
    path: string,
    destination: string,
    source: string,
  ): Promise<void> {
    const baseHash = await this.#gitOptional(this.#root, ["rev-parse", `${info.baseCommit}:${path}`]);
    const parentHash = await this.#gitOptional(this.#root, ["hash-object", destination]);
    const sourceHash = await this.#gitOptional(info.path, ["hash-object", source]);
    if (parentHash === sourceHash) return;
    if (baseHash === parentHash) return;
    if (!baseHash && !parentHash) return;
    throw new Error(`integration conflict for ${path}; parent and worker both changed it. Worktree kept at ${info.path}`);
  }

  async #changedFiles(info: WorktreeInfo): Promise<string[]> {
    const tracked = await this.#git(info.path, ["diff", "--name-status", "-z", info.baseCommit]);
    const tokens = tracked.split("\0");
    const paths = new Set<string>();
    for (let index = 0; index < tokens.length - 1;) {
      const status = tokens[index++] ?? "";
      if (!status) continue;
      if (/^[DRCU]/.test(status)) {
        throw new Error(`worktree integration does not yet support ${status} changes; worktree kept at ${info.path}`);
      }
      const path = tokens[index++];
      if (path) paths.add(path);
    }
    const untracked = await this.#git(info.path, ["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const path of untracked.split("\0")) {
      if (path) paths.add(path);
    }
    return [...paths].sort();
  }

  async #snapshotCommit(id: string, parentHead: string): Promise<string> {
    const index = join(this.#worktreesRoot, `.index-${id}`);
    const env: NodeJS.ProcessEnv = {
      GIT_INDEX_FILE: index,
      GIT_AUTHOR_NAME: "Kulmi",
      GIT_AUTHOR_EMAIL: "kulmi@localhost",
      GIT_COMMITTER_NAME: "Kulmi",
      GIT_COMMITTER_EMAIL: "kulmi@localhost",
    };
    try {
      if (parentHead) await this.#git(this.#root, ["read-tree", parentHead], env);
      await this.#git(this.#root, ["add", "-u"], env);
      const untracked = (await this.#git(this.#root, ["ls-files", "--others", "--exclude-standard", "-z"], env))
        .split("\0")
        .filter((path) => path && !isSensitiveSnapshotPath(path));
      for (let offset = 0; offset < untracked.length; offset += 100) {
        await this.#git(this.#root, ["add", "--", ...untracked.slice(offset, offset + 100)], env);
      }
      const tree = (await this.#git(this.#root, ["write-tree"], env)).trim();
      const args = ["commit-tree", tree, "-m", `kulmi worker snapshot ${id}`];
      if (parentHead) args.push("-p", parentHead);
      return (await this.#git(this.#root, args, env)).trim();
    } finally {
      await unlink(index).catch(() => undefined);
    }
  }

  async #git(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
    const env = safeChildEnvironment(extraEnv);
    try {
      const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        maxBuffer: 10_000_000,
        env,
      });
      return stdout;
    } catch (error) {
      const detail = error && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim()
        : String(error);
      throw new Error(`git ${args.join(" ")} failed: ${detail}`);
    } finally {
      disposeChildEnvironment(env);
    }
  }

  async #gitOptional(cwd: string, args: string[]): Promise<string> {
    try {
      return (await this.#git(cwd, args)).trim();
    } catch {
      return "";
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationQueue.then(operation, operation);
    this.#operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`unsafe worktree ID ${id}`);
}

function isSensitiveSnapshotPath(path: string): boolean {
  const normalized = path.toLowerCase();
  const name = normalized.split("/").at(-1) ?? normalized;
  return name === ".env" || name.startsWith(".env.") ||
    name === ".npmrc" || name === ".pypirc" || name === "credentials" ||
    name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p12") ||
    normalized.includes("/.ssh/") || normalized.startsWith(".ssh/");
}
