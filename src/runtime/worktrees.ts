import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, rename, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { CheckpointStore } from "./checkpoints.js";
import { disposeChildEnvironment, safeChildEnvironment } from "../security/environment.js";
import { resolveWorkspacePath } from "../security/paths.js";

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
  baseCommit: string;
  parentHead?: string;
  parentUnborn?: boolean;
}

interface WorktreeChange {
  path: string;
  deleted: boolean;
}

interface IntegrationOperation {
  path: string;
  source?: string;
  sourceMode?: number;
  destination: string;
  deleted: boolean;
  staged?: string;
  backup?: string;
  installed: boolean;
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

  async recover(retained: Iterable<WorktreeInfo> = []): Promise<void> {
    return this.#exclusive(async () => {
      await mkdir(this.#worktreesRoot, { recursive: true, mode: 0o700 });
      const retainedWorktrees = [...retained];
      const retainedPaths = new Set(retainedWorktrees.map((info) => resolve(info.path)));
      const retainedBranches = new Set(retainedWorktrees.map((info) => info.branch));
      await this.#git(this.#root, ["worktree", "prune"]);

      const listing = parseWorktreeListing(
        await this.#git(this.#root, ["worktree", "list", "--porcelain", "-z"]),
      );
      for (const entry of listing) {
        const path = resolve(entry.path);
        if (!isManagedWorktreePath(this.#worktreesRoot, path) || retainedPaths.has(path)) continue;
        await this.#git(this.#root, ["worktree", "remove", "--force", path]);
      }

      for (const entry of await readdir(this.#worktreesRoot, { withFileTypes: true })) {
        const path = resolve(this.#worktreesRoot, entry.name);
        if (retainedPaths.has(path)) continue;
        if (entry.isDirectory() || entry.name.startsWith(".index-") || entry.name.startsWith(".integrate-")) {
          await rm(path, { recursive: true, force: true });
        }
      }

      const branches = (await this.#git(this.#root, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/kulmi/",
      ])).split("\n").filter(Boolean);
      for (const branch of branches) {
        if (retainedBranches.has(branch)) continue;
        await this.#git(this.#root, ["branch", "-D", branch]);
      }
      await this.#git(this.#root, ["worktree", "prune"]);
    });
  }

  async create(id: string): Promise<WorktreeInfo> {
    return this.#exclusive(async () => {
      assertSafeId(id);
      await mkdir(this.#worktreesRoot, { recursive: true });
      const parentHead = await this.#gitOptional(this.#root, ["rev-parse", "--verify", "HEAD"]);
      const baseCommit = await this.#snapshotCommit(id, parentHead);
      const path = join(this.#worktreesRoot, id);
      const branch = `kulmi/${id}`;
      try {
        await this.#git(this.#root, ["worktree", "add", "-b", branch, path, baseCommit]);
      } catch (error) {
        await this.#git(this.#root, ["worktree", "remove", "--force", path]).catch(() => undefined);
        await this.#git(this.#root, ["branch", "-D", branch]).catch(() => undefined);
        throw error;
      }
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
      const changed = await this.#changes(info);
      const token = `.kulmi-integrate-${info.id}-${randomUUID()}`;
      const operations: IntegrationOperation[] = [];
      for (const change of changed) {
        const { path } = change;
        if (isSensitiveSnapshotPath(path)) throw new Error(`refusing to integrate sensitive path ${path}`);
        const source = resolve(info.path, path);
        let sourceMode: number | undefined;
        if (!change.deleted) {
          await resolveWorkspacePath({
            workspaceRoot: info.path,
            cwd: info.path,
            input: path,
            mustExist: true,
          });
          const sourceInfo = await lstat(source);
          if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
            throw new Error(`worktree integration only supports regular files: ${path}`);
          }
          sourceMode = sourceInfo.mode & 0o7777;
        }
        const destination = await resolveWorkspacePath({
          workspaceRoot: this.#root,
          cwd: this.#root,
          input: path,
        });
        await this.#assertPathUnchanged(info, path, destination, change.deleted ? undefined : source);
        await checkpoint.capture(destination);
        operations.push({
          path,
          ...(change.deleted ? {} : { source, ...(sourceMode === undefined ? {} : { sourceMode }) }),
          destination,
          deleted: change.deleted,
          installed: false,
        });
      }

      try {
        for (const [index, operation] of operations.entries()) {
          if (operation.deleted) continue;
          await mkdir(dirname(operation.destination), { recursive: true });
          operation.staged = `${operation.destination}${token}-${index}.new`;
          await copyFile(operation.source!, operation.staged);
          await chmod(operation.staged, operation.sourceMode!);
        }

        const touched: IntegrationOperation[] = [];
        try {
          for (const [index, operation] of operations.entries()) {
            touched.push(operation);
            try {
              const destinationInfo = await lstat(operation.destination);
              if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink()) {
                throw new Error(`worktree integration only supports regular files: ${operation.path}`);
              }
              operation.backup = `${operation.destination}${token}-${index}.old`;
              await rename(operation.destination, operation.backup);
            } catch (error) {
              if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
            }
            if (!operation.deleted) {
              await rename(operation.staged!, operation.destination);
              delete operation.staged;
              operation.installed = true;
            }
          }
        } catch (error) {
          const rollbackErrors: string[] = [];
          for (const operation of touched.reverse()) {
            try {
              if (operation.installed) {
                await unlink(operation.destination).catch((unlinkError: unknown) => {
                  if (!(unlinkError && typeof unlinkError === "object" && "code" in unlinkError && unlinkError.code === "ENOENT")) {
                    throw unlinkError;
                  }
                });
                operation.installed = false;
              }
              if (operation.backup) {
                await rename(operation.backup, operation.destination);
                delete operation.backup;
              }
            } catch (rollbackError) {
              rollbackErrors.push(`${operation.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
            }
          }
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(rollbackErrors.length > 0
            ? `worktree integration failed: ${detail}; rollback failed for ${rollbackErrors.join(", ")}`
            : `worktree integration failed and was rolled back: ${detail}`);
        }
        return changed.map((change) => change.path);
      } finally {
        for (const operation of operations) {
          if (operation.staged) await unlink(operation.staged).catch(() => undefined);
          if (operation.backup) await unlink(operation.backup).catch(() => undefined);
        }
      }
    });
  }

  async dispose(info: WorktreeInfo): Promise<void> {
    return this.#exclusive(async () => {
      await this.#git(this.#root, ["worktree", "remove", "--force", info.path]).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!/not a working tree|No such file|does not exist/i.test(message)) throw error;
      });
      await this.#git(this.#root, ["branch", "-D", info.branch]).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!/not found|not a valid refname/i.test(message)) throw error;
      });
    });
  }

  async #assertPathUnchanged(
    info: WorktreeInfo,
    path: string,
    destination: string,
    source: string | undefined,
  ): Promise<void> {
    const baseEntry = await this.#git(this.#root, ["ls-tree", info.baseCommit, "--", path]);
    const baseHash = baseEntry.match(/^\d+\s+blob\s+([a-f0-9]+)\t/)?.[1] ?? "";
    const parentHash = await this.#hashFile(this.#root, destination);
    if (!source) {
      if (baseHash === parentHash || !parentHash) return;
      throw new Error(`integration conflict for ${path}; parent and worker both changed it. Worktree kept at ${info.path}`);
    }
    const sourceHash = await this.#hashFile(info.path, source);
    if (parentHash === sourceHash) return;
    if (baseHash === parentHash) return;
    if (!baseHash && !parentHash) return;
    throw new Error(`integration conflict for ${path}; parent and worker both changed it. Worktree kept at ${info.path}`);
  }

  async #hashFile(cwd: string, path: string): Promise<string> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`worktree integration only supports regular files: ${path}`);
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
      throw error;
    }
    return (await this.#git(cwd, ["hash-object", path])).trim();
  }

  async #changes(info: WorktreeInfo): Promise<WorktreeChange[]> {
    const tracked = await this.#git(info.path, ["diff", "--no-renames", "--name-status", "-z", info.baseCommit]);
    const tokens = tracked.split("\0");
    const changes = new Map<string, WorktreeChange>();
    for (let index = 0; index < tokens.length - 1;) {
      const status = tokens[index++] ?? "";
      if (!status) continue;
      if (/^[RCU]/.test(status)) {
        throw new Error(`worktree integration does not yet support ${status} changes; worktree kept at ${info.path}`);
      }
      const path = tokens[index++];
      if (path) changes.set(path, { path, deleted: status.startsWith("D") });
    }
    const untracked = await this.#git(info.path, ["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const path of untracked.split("\0")) {
      if (path) changes.set(path, { path, deleted: false });
    }
    return [...changes.values()].sort((left, right) => left.path.localeCompare(right.path));
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

function parseWorktreeListing(output: string): Array<{ path: string; branch?: string }> {
  const entries: Array<{ path: string; branch?: string }> = [];
  let current: { path: string; branch?: string } | undefined;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: field.slice("worktree ".length) };
    } else if (current && field.startsWith("branch refs/heads/")) {
      current.branch = field.slice("branch refs/heads/".length);
    }
  }
  if (current) entries.push(current);
  return entries;
}

function isManagedWorktreePath(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`unsafe worktree ID ${id}`);
}

function isSensitiveSnapshotPath(path: string): boolean {
  const normalized = path.toLowerCase();
  const name = normalized.split("/").at(-1) ?? normalized;
  return name === ".env" || name.startsWith(".env.") ||
    name === ".npmrc" || name === ".pypirc" || name === "credentials" ||
    name === "credentials.json" || name === "service-account.json" ||
    name === "id_rsa" || name === "id_ed25519" || /^secrets?\./.test(name) ||
    name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p12") ||
    normalized.includes("/.ssh/") || normalized.startsWith(".ssh/");
}
