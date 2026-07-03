import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { RunState } from "../core/types.js";
import { resolveWorkspacePath } from "../security/paths.js";
import { decodeState, encodeState } from "./session-schema.js";

const snapshotSchema = z.object({
  existed: z.boolean(),
  snapshot: z.string().optional(),
  mode: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

const checkpointSchema = z.object({
  schemaVersion: z.literal(1),
  agentId: z.string().min(1),
  messageCount: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  finalizedAt: z.string().min(1).optional(),
  undoneAt: z.string().min(1).optional(),
  undoStartedAt: z.string().min(1).optional(),
  undoMessageHistory: z.enum(["truncate", "keep"]).optional(),
  state: z.unknown().optional(),
  entries: z.array(z.object({
    path: z.string().min(1),
    before: snapshotSchema,
    after: snapshotSchema.optional(),
  }).strict()),
}).strict();

type FileSnapshot = z.infer<typeof snapshotSchema>;
type CheckpointManifest = z.infer<typeof checkpointSchema>;

export interface PreparedUndo {
  checkpointId: string;
  messageCount: number;
  state: RunState;
  files: string[];
  messageHistory?: "truncate" | "keep";
  begin(history: "truncate" | "keep"): Promise<void>;
  apply(): Promise<void>;
  rollback(): Promise<void>;
  cancel(): Promise<void>;
  commit(): Promise<void>;
}

export class CheckpointStore {
  readonly #sessionPath: string;
  readonly #workspaceRoot: string;
  #turnPath?: string;
  #manifest?: CheckpointManifest;

  constructor(sessionPath: string, workspaceRoot: string) {
    this.#sessionPath = sessionPath;
    this.#workspaceRoot = resolve(workspaceRoot);
  }

  async beginTurn(messageCount: number, agentId: string, state?: RunState): Promise<void> {
    const base = join(
      this.#sessionPath,
      "checkpoints",
      `${String(messageCount).padStart(4, "0")}-${agentId}`,
    );
    this.#turnPath = base;
    for (let suffix = 2; existsSync(this.#turnPath); suffix += 1) {
      this.#turnPath = `${base}-${suffix}`;
    }
    this.#manifest = {
      schemaVersion: 1,
      agentId,
      messageCount,
      createdAt: new Date().toISOString(),
      ...(state ? { state: encodeState(state) } : {}),
      entries: [],
    };
    await mkdir(join(this.#turnPath, "files"), { recursive: true, mode: 0o700 });
    await this.#persist();
  }

  async capture(absolutePath: string): Promise<void> {
    const { manifest, turnPath } = this.#active();
    const path = this.#relativeWorkspacePath(absolutePath);
    if (manifest.entries.some((entry) => entry.path === path)) return;
    manifest.entries.push({
      path,
      before: await captureFileSnapshot(absolutePath, turnPath, join("files", path)),
    });
    await this.#persist();
  }

  async captureSnapshot(
    absolutePath: string,
    snapshot: { existed: boolean; content?: Buffer; mode?: number },
  ): Promise<void> {
    const { manifest, turnPath } = this.#active();
    const path = this.#relativeWorkspacePath(absolutePath);
    if (manifest.entries.some((entry) => entry.path === path)) return;
    const before: FileSnapshot = { existed: snapshot.existed };
    if (snapshot.existed) {
      if (!snapshot.content) throw new Error(`missing snapshot content for ${path}`);
      const snapshotPath = join("files", path);
      await writeSnapshot(turnPath, snapshotPath, snapshot.content);
      before.snapshot = snapshotPath;
      before.sha256 = digest(snapshot.content);
      before.mode = snapshot.mode ?? 0o644;
    }
    manifest.entries.push({ path, before });
    await this.#persist();
  }

  async finalizeTurn(): Promise<void> {
    if (!this.#manifest || !this.#turnPath || this.#manifest.finalizedAt) return;
    for (const entry of this.#manifest.entries) {
      const target = this.#absoluteWorkspacePath(entry.path);
      entry.after = await captureFileSnapshot(target, this.#turnPath, join("after-files", entry.path));
    }
    this.#manifest.finalizedAt = new Date().toISOString();
    await this.#persist();
  }

  async prepareUndo(agentId: string, currentMessageCount: number): Promise<PreparedUndo> {
    const candidate = await this.#latestUndoable(agentId, currentMessageCount);
    if (!candidate) throw new Error("there is no completed turn available to undo");
    const { manifest, turnPath, checkpointId } = candidate;
    if (manifest.state === undefined) throw new Error(`checkpoint ${checkpointId} has no restorable run state`);
    const state = decodeState(manifest.state).value;
    if (state.agentId !== agentId) throw new Error(`checkpoint ${checkpointId} run-state agent does not match ${agentId}`);
    if (new Set(manifest.entries.map((entry) => entry.path)).size !== manifest.entries.length) {
      throw new Error(`checkpoint ${checkpointId} contains duplicate file entries`);
    }
    for (const entry of manifest.entries) {
      if (!entry.after) throw new Error(`checkpoint ${checkpointId} is missing its finalized state for ${entry.path}`);
    }

    let applied = false;
    if (manifest.undoStartedAt) {
      const matchesBefore = await snapshotsMatch(
        manifest.entries,
        "before",
        (path) => this.#safeWorkspacePath(path),
      );
      const matchesAfter = await snapshotsMatch(
        manifest.entries,
        "after",
        (path) => this.#safeWorkspacePath(path),
      );
      if (matchesBefore && !matchesAfter) applied = true;
      else if (!matchesAfter && !matchesBefore) {
        throw new Error(`unfinished undo ${checkpointId} has mixed or externally changed file state`);
      }
    } else {
      for (const entry of manifest.entries) {
        await assertCurrentSnapshot(
          await this.#safeWorkspacePath(entry.path),
          entry.after!,
        );
      }
    }
    return {
      checkpointId,
      messageCount: manifest.messageCount,
      state,
      files: manifest.entries.map((entry) => entry.path),
      ...(manifest.undoMessageHistory ? { messageHistory: manifest.undoMessageHistory } : {}),
      begin: async (history) => {
        if (manifest.undoStartedAt) {
          if (manifest.undoMessageHistory !== history) {
            throw new Error(`unfinished undo ${checkpointId} uses message history mode ${manifest.undoMessageHistory}`);
          }
          return;
        }
        manifest.undoStartedAt = new Date().toISOString();
        manifest.undoMessageHistory = history;
        await writeManifest(turnPath, manifest);
      },
      apply: async () => {
        if (!manifest.undoStartedAt) throw new Error("undo journal has not been started");
        if (applied) return;
        const restored: typeof manifest.entries = [];
        try {
          for (const entry of manifest.entries) {
            await restoreSnapshot(
              await this.#safeWorkspacePath(entry.path),
              entry.before,
              turnPath,
            );
            restored.push(entry);
          }
          applied = true;
        } catch (error) {
          const rollbackErrors = await restoreEntries(
            restored.reverse(),
            "after",
            turnPath,
            (path) => this.#safeWorkspacePath(path),
          );
          if (rollbackErrors.length > 0) applied = true;
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(rollbackErrors.length
            ? `undo failed: ${detail}; file rollback also failed: ${rollbackErrors.join(", ")}`
            : `undo failed before all files were restored: ${detail}`);
        }
      },
      rollback: async () => {
        if (!applied) return;
        const errors = await restoreEntries(
          [...manifest.entries].reverse(),
          "after",
          turnPath,
          (path) => this.#safeWorkspacePath(path),
        );
        if (errors.length) throw new Error(`could not roll back failed undo: ${errors.join(", ")}`);
        applied = false;
      },
      cancel: async () => {
        if (applied) throw new Error("cannot cancel an undo while restored files are still applied");
        delete manifest.undoStartedAt;
        delete manifest.undoMessageHistory;
        await writeManifest(turnPath, manifest);
      },
      commit: async () => {
        if (!applied) throw new Error("cannot commit an undo before restoring its files");
        const undoStartedAt = manifest.undoStartedAt;
        const undoMessageHistory = manifest.undoMessageHistory;
        manifest.undoneAt = new Date().toISOString();
        delete manifest.undoStartedAt;
        delete manifest.undoMessageHistory;
        try {
          await writeManifest(turnPath, manifest);
        } catch (error) {
          delete manifest.undoneAt;
          if (undoStartedAt) manifest.undoStartedAt = undoStartedAt;
          if (undoMessageHistory) manifest.undoMessageHistory = undoMessageHistory;
          throw error;
        }
      },
    };
  }

  #active(): { manifest: CheckpointManifest; turnPath: string } {
    if (!this.#manifest || !this.#turnPath) throw new Error("checkpoint turn has not started");
    return { manifest: this.#manifest, turnPath: this.#turnPath };
  }

  async #latestUndoable(
    agentId: string,
    currentMessageCount: number,
  ): Promise<{ manifest: CheckpointManifest; turnPath: string; checkpointId: string } | undefined> {
    const root = join(this.#sessionPath, "checkpoints");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return undefined;
      throw error;
    }
    const directories: Array<{ turnPath: string; checkpointId: string; modified: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const turnPath = join(root, entry.name);
      try {
        directories.push({
          turnPath,
          checkpointId: entry.name,
          modified: (await stat(join(turnPath, "checkpoint.json"))).mtimeMs,
        });
      } catch {
        continue;
      }
    }
    directories.sort((left, right) => right.modified - left.modified || right.checkpointId.localeCompare(left.checkpointId));
    for (const directory of directories) {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(join(directory.turnPath, "checkpoint.json"), "utf8"));
      } catch (error) {
        if (directory.checkpointId.includes(`-${agentId}`)) {
          throw new Error(`latest checkpoint ${directory.checkpointId} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      const parsed = checkpointSchema.safeParse(raw);
      if (!parsed.success) {
        if (directory.checkpointId.includes(`-${agentId}`)) {
          throw new Error(`latest checkpoint ${directory.checkpointId} predates undo support or is invalid`);
        }
        continue;
      }
      const manifest = parsed.data;
      if (manifest.agentId !== agentId) continue;
      if (manifest.undoneAt) continue;
      if (manifest.messageCount > currentMessageCount) {
        throw new Error(`latest checkpoint ${directory.checkpointId} is ahead of the active message history`);
      }
      if (!manifest.finalizedAt) {
        throw new Error(`latest checkpoint ${directory.checkpointId} was not finalized and cannot be safely undone`);
      }
      if (manifest.state === undefined) {
        throw new Error(`latest checkpoint ${directory.checkpointId} has no restorable run state`);
      }
      return { manifest, turnPath: directory.turnPath, checkpointId: directory.checkpointId };
    }
    return undefined;
  }

  #relativeWorkspacePath(absolutePath: string): string {
    const path = relative(this.#workspaceRoot, resolve(absolutePath));
    validateRelativePath(path);
    return path;
  }

  #absoluteWorkspacePath(path: string): string {
    validateRelativePath(path);
    return resolve(this.#workspaceRoot, path);
  }

  async #safeWorkspacePath(path: string): Promise<string> {
    validateRelativePath(path);
    return resolveWorkspacePath({
      workspaceRoot: this.#workspaceRoot,
      cwd: this.#workspaceRoot,
      input: path,
    });
  }

  #persist(): Promise<void> {
    const { manifest, turnPath } = this.#active();
    return writeManifest(turnPath, manifest);
  }
}

async function captureFileSnapshot(absolutePath: string, turnPath: string, snapshotPath: string): Promise<FileSnapshot> {
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return { existed: false };
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`cannot checkpoint non-regular file ${absolutePath}`);
  const content = await readFile(absolutePath);
  await writeSnapshot(turnPath, snapshotPath, content);
  return {
    existed: true,
    snapshot: snapshotPath,
    mode: info.mode & 0o7777,
    sha256: digest(content),
  };
}

async function assertCurrentSnapshot(path: string, expected: FileSnapshot): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isErrorCode(error, "ENOENT") && !expected.existed) return;
    if (isErrorCode(error, "ENOENT")) throw new Error(`cannot undo because ${path} was deleted after the turn`);
    throw error;
  }
  if (!expected.existed) throw new Error(`cannot undo because ${path} was created or replaced after the turn`);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`cannot undo because ${path} is no longer a regular file`);
  const content = await readFile(path);
  if (digest(content) !== expected.sha256 || (info.mode & 0o7777) !== expected.mode) {
    throw new Error(`cannot undo because ${path} changed after the turn completed`);
  }
}

async function snapshotsMatch(
  entries: Array<CheckpointManifest["entries"][number]>,
  side: "before" | "after",
  resolvePath: (path: string) => Promise<string>,
): Promise<boolean> {
  for (const entry of entries) {
    const snapshot = entry[side];
    if (!snapshot || !await snapshotMatches(await resolvePath(entry.path), snapshot)) return false;
  }
  return true;
}

async function snapshotMatches(path: string, expected: FileSnapshot): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!expected.existed || !info.isFile() || info.isSymbolicLink()) return false;
    const content = await readFile(path);
    return digest(content) === expected.sha256 && (info.mode & 0o7777) === expected.mode;
  } catch (error) {
    return isErrorCode(error, "ENOENT") && !expected.existed;
  }
}

async function restoreEntries(
  entries: Array<CheckpointManifest["entries"][number]>,
  side: "before" | "after",
  turnPath: string,
  resolvePath: (path: string) => Promise<string>,
): Promise<string[]> {
  const errors: string[] = [];
  for (const entry of entries) {
    const snapshot = entry[side];
    if (!snapshot) {
      errors.push(`${entry.path}: missing ${side} snapshot`);
      continue;
    }
    try {
      await restoreSnapshot(await resolvePath(entry.path), snapshot, turnPath);
    } catch (error) {
      errors.push(`${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

async function restoreSnapshot(target: string, snapshot: FileSnapshot, turnPath: string): Promise<void> {
  if (!snapshot.existed) {
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("refusing to delete a non-regular file");
      await unlink(target);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
    return;
  }
  if (!snapshot.snapshot || snapshot.mode === undefined || !snapshot.sha256) {
    throw new Error(`incomplete checkpoint snapshot for ${target}`);
  }
  const source = safeSnapshotPath(turnPath, snapshot.snapshot);
  const content = await readFile(source);
  if (digest(content) !== snapshot.sha256) throw new Error(`checkpoint snapshot checksum mismatch for ${target}`);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.kulmi-undo`;
  try {
    await writeFile(temporary, content, { mode: snapshot.mode });
    await chmod(temporary, snapshot.mode);
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeSnapshot(turnPath: string, snapshotPath: string, content: Buffer): Promise<void> {
  const destination = safeSnapshotPath(turnPath, snapshotPath);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, content, { mode: 0o600 });
}

async function writeManifest(turnPath: string, manifest: CheckpointManifest): Promise<void> {
  const path = join(turnPath, "checkpoint.json");
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function safeSnapshotPath(turnPath: string, snapshotPath: string): string {
  validateRelativePath(snapshotPath);
  const path = resolve(turnPath, snapshotPath);
  const rel = relative(turnPath, path);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`invalid checkpoint snapshot path ${snapshotPath}`);
  }
  return path;
}

function validateRelativePath(path: string): void {
  if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error(`invalid checkpoint path ${path}`);
  }
  const parts = path.split(/[\\/]/);
  if (parts.includes("") || parts.includes(".") || parts.includes("..") || parts[0] === ".git") {
    throw new Error(`invalid checkpoint path ${path}`);
  }
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
