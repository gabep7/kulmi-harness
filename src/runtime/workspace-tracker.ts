import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createTextDiff } from "../core/diff.js";
import { disposeChildEnvironment, safeChildEnvironment } from "../security/environment.js";
import { assertWithin } from "../security/paths.js";
import type { CheckpointStore } from "./checkpoints.js";

const execFileAsync = promisify(execFile);

interface FileState {
  existed: boolean;
  hash: string;
  content?: Buffer;
  mode?: number;
}

export interface WorkspaceChange {
  path: string;
  diff?: string;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export class WorkspaceSnapshot {
  readonly #root: string;
  readonly #files: Map<string, FileState>;

  private constructor(root: string, files: Map<string, FileState>) {
    this.#root = root;
    this.#files = files;
  }

  static async capture(root: string): Promise<WorkspaceSnapshot> {
    // Require a git work tree, but not an existing commit. A freshly initialized
    // repo has no HEAD ("Needed a single revision"); tracking must still work there.
    const insideWorkTree = (await git(root, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (insideWorkTree !== "true") throw new Error("workspace tracking requires a git work tree");
    const files = await dirtyFileStates(root);
    return new WorkspaceSnapshot(root, files);
  }

  async reconcile(checkpoint: CheckpointStore): Promise<string[]> {
    return (await this.reconcileChanges(checkpoint)).map((change) => change.path);
  }

  async reconcileChanges(checkpoint: CheckpointStore): Promise<WorkspaceChange[]> {
    const after = await dirtyFileStates(this.#root);
    const paths = new Set([...this.#files.keys(), ...after.keys()]);
    const changed: WorkspaceChange[] = [];

    for (const path of paths) {
      const recordedBefore = this.#files.get(path);
      const recordedAfter = after.get(path);
      const base = recordedBefore ? undefined : await gitFile(this.#root, `HEAD:${path}`);
      const baseMode = recordedBefore || !base ? undefined : await gitMode(this.#root, path);
      const beforeState = recordedBefore ?? bufferState(base, baseMode);
      const afterState = recordedAfter ?? await currentFileState(this.#root, path);
      if (sameState(beforeState, afterState)) continue;
      const absolute = resolve(this.#root, path);
      assertWithin(this.#root, absolute);
      let beforeContent = beforeState?.existed ? beforeState.content : undefined;
      if (recordedBefore) {
        await checkpoint.captureSnapshot(absolute, recordedBefore);
      } else {
        beforeContent = base;
        await checkpoint.captureSnapshot(absolute, {
          existed: base !== undefined,
          ...(base ? { content: base } : {}),
          ...(baseMode !== undefined ? { mode: baseMode } : {}),
        });
      }
      const diff = textDiff(path, beforeContent, afterState?.existed ? afterState.content : undefined);
      changed.push({ path, ...(diff ? { diff } : {}) });
    }
    return changed.sort((left, right) => left.path.localeCompare(right.path));
  }
}

function bufferState(content: Buffer | undefined, mode?: number): FileState | undefined {
  if (!content) return undefined;
  return {
    existed: true,
    hash: createHash("sha256").update(content).digest("hex"),
    content,
    ...(mode !== undefined ? { mode } : {}),
  };
}

async function currentFileState(root: string, path: string): Promise<FileState | undefined> {
  const absolute = resolve(root, path);
  assertWithin(root, absolute);
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) return { existed: false, hash: "non-file" };
    const content = await readFile(absolute);
    return {
      existed: true,
      hash: createHash("sha256").update(content).digest("hex"),
      content,
      mode: info.mode & 0o7777,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function textDiff(path: string, before: Buffer | undefined, after: Buffer | undefined): string | undefined {
  try {
    return createTextDiff(
      path,
      before ? textDecoder.decode(before) : "",
      after ? textDecoder.decode(after) : "",
      80,
    )?.text;
  } catch {
    return undefined;
  }
}

async function dirtyFileStates(root: string): Promise<Map<string, FileState>> {
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const paths = parseStatusPaths(status);
  const states = new Map<string, FileState>();
  let totalBytes = 0;
  for (const path of paths) {
    const absolute = resolve(root, path);
    assertWithin(root, absolute);
    try {
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) {
        states.set(path, { existed: false, hash: "non-file" });
        continue;
      }
      if (info.size > 10_000_000 || totalBytes + info.size > 100_000_000) {
        throw new Error(`workspace tracking cannot safely snapshot large dirty file: ${path}`);
      }
      const content = await readFile(absolute);
      totalBytes += content.length;
      states.set(path, {
        existed: true,
        hash: createHash("sha256").update(content).digest("hex"),
        content,
        mode: info.mode & 0o7777,
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        states.set(path, { existed: false, hash: "missing" });
        continue;
      }
      throw error;
    }
  }
  return states;
}

function parseStatusPaths(status: string): string[] {
  const tokens = status.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index];
    if (!token || token.length < 4) continue;
    const code = token.slice(0, 2);
    const path = token.slice(3);
    if (path) paths.push(path);
    if (/[RC]/.test(code)) {
      const source = tokens[++index];
      if (source) paths.push(source);
    }
  }
  return [...new Set(paths)];
}

function sameState(left: FileState | undefined, right: FileState | undefined): boolean {
  if (!left && !right) return true;
  return left?.existed === right?.existed && left?.hash === right?.hash && left?.mode === right?.mode;
}

async function git(root: string, args: string[]): Promise<string> {
  const env = safeChildEnvironment();
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 20_000_000,
      env,
    });
    return stdout;
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : String(error);
    throw new Error(`workspace tracking requires git: ${stderr.trim()}`);
  } finally {
    disposeChildEnvironment(env);
  }
}

async function gitFile(root: string, spec: string): Promise<Buffer | undefined> {
  const env = safeChildEnvironment();
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "show", spec], {
      encoding: "buffer",
      maxBuffer: 20_000_000,
      env,
    });
    return Buffer.from(stdout);
  } catch {
    return undefined;
  } finally {
    disposeChildEnvironment(env);
  }
}

async function gitMode(root: string, path: string): Promise<number | undefined> {
  const env = safeChildEnvironment();
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "ls-tree", "HEAD", "--", path], {
      encoding: "utf8",
      maxBuffer: 1_000_000,
      env,
    });
    const raw = stdout.match(/^(\d{6})\s/)?.[1];
    return raw ? Number.parseInt(raw, 8) & 0o7777 : undefined;
  } catch {
    return undefined;
  } finally {
    disposeChildEnvironment(env);
  }
}
