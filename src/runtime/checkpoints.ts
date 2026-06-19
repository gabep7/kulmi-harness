import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";

interface CheckpointEntry {
  path: string;
  existed: boolean;
  snapshot?: string;
}

export class CheckpointStore {
  readonly #sessionPath: string;
  readonly #workspaceRoot: string;
  #turnPath?: string;
  #entries = new Map<string, CheckpointEntry>();

  constructor(sessionPath: string, workspaceRoot: string) {
    this.#sessionPath = sessionPath;
    this.#workspaceRoot = workspaceRoot;
  }

  async beginTurn(turn: number, agentId: string): Promise<void> {
    this.#turnPath = join(
      this.#sessionPath,
      "checkpoints",
      `${String(turn).padStart(4, "0")}-${agentId}`,
    );
    this.#entries.clear();
    await mkdir(join(this.#turnPath, "files"), { recursive: true });
    await this.#persist();
  }

  async capture(absolutePath: string): Promise<void> {
    if (!this.#turnPath) throw new Error("checkpoint turn has not started");
    const path = relative(this.#workspaceRoot, absolutePath);
    if (this.#entries.has(path)) return;

    const existed = existsSync(absolutePath);
    const entry: CheckpointEntry = { path, existed };
    if (existed) {
      const info = await stat(absolutePath);
      if (!info.isFile()) throw new Error(`cannot checkpoint non-file ${path}`);
      const snapshot = join("files", path);
      const destination = join(this.#turnPath, snapshot);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(absolutePath, destination);
      entry.snapshot = snapshot;
    }
    this.#entries.set(path, entry);
    await this.#persist();
  }

  async captureSnapshot(
    absolutePath: string,
    snapshot: { existed: boolean; content?: Buffer },
  ): Promise<void> {
    if (!this.#turnPath) throw new Error("checkpoint turn has not started");
    const path = relative(this.#workspaceRoot, absolutePath);
    if (this.#entries.has(path)) return;
    const entry: CheckpointEntry = { path, existed: snapshot.existed };
    if (snapshot.existed) {
      if (!snapshot.content) throw new Error(`missing snapshot content for ${path}`);
      const snapshotPath = join("files", path);
      const destination = join(this.#turnPath, snapshotPath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, snapshot.content);
      entry.snapshot = snapshotPath;
    }
    this.#entries.set(path, entry);
    await this.#persist();
  }

  async #persist(): Promise<void> {
    if (!this.#turnPath) return;
    await writeFile(
      join(this.#turnPath, "checkpoint.json"),
      `${JSON.stringify({ entries: [...this.#entries.values()] }, null, 2)}\n`,
      "utf8",
    );
  }
}
