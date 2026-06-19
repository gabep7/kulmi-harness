import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import { WorktreeManager } from "../src/runtime/worktrees.js";

const exec = promisify(execFile);

describe("WorktreeManager", () => {
  it("snapshots an unborn dirty repository without mutating the parent index", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-repo-unborn-"));
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-worktrees-"));
    await exec("git", ["init", root]);
    await writeFile(join(root, "main.ts"), "export const value = 1;\n");
    await writeFile(join(root, ".env"), "MIMO_API_KEY=secret\n");

    const manager = new WorktreeManager(root);
    const worker = await manager.create("worker_unborn");
    expect(await readFile(join(worker.path, "main.ts"), "utf8")).toContain("value = 1");
    await expect(readFile(join(worker.path, ".env"), "utf8")).rejects.toThrow();
    expect((await exec("git", ["-C", root, "status", "--porcelain"])).stdout).toContain("?? main.ts");

    await writeFile(join(worker.path, "main.ts"), "export const value = 2;\n");
    const checkpoint = new CheckpointStore(join(process.env.XDG_DATA_HOME!, "session"), root);
    await checkpoint.beginTurn(1, "parent");
    expect(await manager.integrate(worker, checkpoint)).toEqual(["main.ts"]);
    expect(await readFile(join(root, "main.ts"), "utf8")).toContain("value = 2");
  });

  it("isolates and integrates writable worker files", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-repo-"));
    const data = await mkdtemp(join(tmpdir(), "kulmi-worktrees-"));
    process.env.XDG_DATA_HOME = data;
    await exec("git", ["init", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.test"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "main.ts"), "export const value = 1;\n");
    await exec("git", ["-C", root, "add", "main.ts"]);
    await exec("git", ["-C", root, "commit", "-m", "initial"]);

    const manager = new WorktreeManager(root);
    const worktree = await manager.create("worker_test");
    await writeFile(join(worktree.path, "main.ts"), "export const value = 2;\n");
    await writeFile(join(worktree.path, "extra.ts"), "export const extra = true;\n");
    expect(await readFile(join(root, "main.ts"), "utf8")).toContain("value = 1");

    const checkpoint = new CheckpointStore(join(data, "session"), root);
    await checkpoint.beginTurn(1, "parent");
    const changed = await manager.integrate(worktree, checkpoint);

    expect(changed).toEqual(["extra.ts", "main.ts"]);
    expect(await readFile(join(root, "main.ts"), "utf8")).toContain("value = 2");
    expect(await readFile(join(root, "extra.ts"), "utf8")).toContain("extra = true");
  });

  it("integrates non-overlapping workers and rejects overlapping edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-repo-"));
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-worktrees-"));
    await exec("git", ["init", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.test"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "a.ts"), "a1\n");
    await writeFile(join(root, "b.ts"), "b1\n");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-m", "initial"]);

    const manager = new WorktreeManager(root);
    const first = await manager.create("worker_one");
    const second = await manager.create("worker_two");
    const conflict = await manager.create("worker_conflict");
    await writeFile(join(first.path, "a.ts"), "a2\n");
    await writeFile(join(second.path, "b.ts"), "b2\n");
    await writeFile(join(conflict.path, "a.ts"), "a3\n");
    const checkpoint = new CheckpointStore(join(process.env.XDG_DATA_HOME, "session"), root);
    await checkpoint.beginTurn(1, "parent");

    await manager.integrate(first, checkpoint);
    await manager.integrate(second, checkpoint);
    await expect(manager.integrate(conflict, checkpoint)).rejects.toThrow("integration conflict for a.ts");
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("a2\n");
    expect(await readFile(join(root, "b.ts"), "utf8")).toBe("b2\n");
  });

  it("preflights every file before copying any worker change", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-repo-"));
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-worktrees-"));
    await exec("git", ["init", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.test"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "a.ts"), "a1\n");
    await writeFile(join(root, "z.ts"), "z1\n");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-m", "initial"]);
    const manager = new WorktreeManager(root);
    const worker = await manager.create("worker_atomic");
    await writeFile(join(worker.path, "a.ts"), "a-worker\n");
    await writeFile(join(worker.path, "z.ts"), "z-worker\n");
    await writeFile(join(root, "z.ts"), "z-parent\n");
    const checkpoint = new CheckpointStore(join(process.env.XDG_DATA_HOME!, "session"), root);
    await checkpoint.beginTurn(1, "parent");

    await expect(manager.integrate(worker, checkpoint)).rejects.toThrow("integration conflict for z.ts");
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("a1\n");
    expect(await readFile(join(root, "z.ts"), "utf8")).toBe("z-parent\n");
  });
});
