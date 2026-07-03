import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import type { RunState } from "../src/core/types.js";

describe("CheckpointStore", () => {
  it("never overwrites an earlier turn when compacted histories reuse a message count", async () => {
    const session = await mkdtemp(join(tmpdir(), "kulmi-checkpoints-"));
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-checkpoint-workspace-"));
    const file = join(workspace, "file.txt");
    await writeFile(file, "first\n");
    const store = new CheckpointStore(session, workspace);

    await store.beginTurn(12, "agent");
    await store.capture(file);
    await store.beginTurn(12, "agent");
    await store.capture(file);

    expect((await readdir(join(session, "checkpoints"))).sort()).toEqual([
      "0012-agent",
      "0012-agent-2",
    ]);
  });

  it("restores changed and created files, including permissions, then commits one undo", async () => {
    const session = await mkdtemp(join(tmpdir(), "kulmi-checkpoints-"));
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-checkpoint-workspace-"));
    const changed = join(workspace, "changed.txt");
    const created = join(workspace, "created.txt");
    await writeFile(changed, "before\n", { mode: 0o640 });
    const store = new CheckpointStore(session, workspace);
    const state = runState();

    await store.beginTurn(1, state.agentId, state);
    await store.capture(changed);
    await store.capture(created);
    await writeFile(changed, "after\n");
    await chmod(changed, 0o600);
    await writeFile(created, "new\n");
    await store.finalizeTurn();

    const undo = await store.prepareUndo(state.agentId, 4);
    expect(undo.messageCount).toBe(1);
    expect(undo.files.sort()).toEqual(["changed.txt", "created.txt"]);
    await undo.begin("truncate");
    await undo.apply();
    expect(await readFile(changed, "utf8")).toBe("before\n");
    expect((await stat(changed)).mode & 0o777).toBe(0o640);
    await expect(access(created)).rejects.toThrow();

    await undo.rollback();
    expect(await readFile(changed, "utf8")).toBe("after\n");
    expect((await stat(changed)).mode & 0o777).toBe(0o600);
    expect(await readFile(created, "utf8")).toBe("new\n");

    await undo.apply();
    await undo.commit();
    await expect(store.prepareUndo(state.agentId, 4)).rejects.toThrow("no completed turn");
  });

  it("refuses to overwrite external changes made after a turn", async () => {
    const session = await mkdtemp(join(tmpdir(), "kulmi-checkpoints-"));
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-checkpoint-workspace-"));
    const file = join(workspace, "file.txt");
    await writeFile(file, "before\n");
    const store = new CheckpointStore(session, workspace);
    const state = runState();
    await store.beginTurn(1, state.agentId, state);
    await store.capture(file);
    await writeFile(file, "after\n");
    await store.finalizeTurn();
    await writeFile(file, "external\n");

    await expect(store.prepareUndo(state.agentId, 4)).rejects.toThrow("changed after the turn");
    expect(await readFile(file, "utf8")).toBe("external\n");
  });

  it("refuses to restore through a parent symlink introduced after the turn", async () => {
    const session = await mkdtemp(join(tmpdir(), "kulmi-checkpoints-"));
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-checkpoint-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "kulmi-checkpoint-outside-"));
    const directory = join(workspace, "nested");
    const file = join(directory, "file.txt");
    await mkdir(directory);
    await writeFile(file, "before\n");
    const store = new CheckpointStore(session, workspace);
    const state = runState();
    await store.beginTurn(1, state.agentId, state);
    await store.capture(file);
    await unlink(file);
    await store.finalizeTurn();
    await rename(directory, join(workspace, "nested-original"));
    await symlink(outside, directory);

    await expect(store.prepareUndo(state.agentId, 4)).rejects.toThrow("outside workspace");
    await expect(access(join(outside, "file.txt"))).rejects.toThrow();
  });

  it("does not skip an unfinished latest turn to undo an older one", async () => {
    const session = await mkdtemp(join(tmpdir(), "kulmi-checkpoints-"));
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-checkpoint-workspace-"));
    const store = new CheckpointStore(session, workspace);
    const state = runState();
    await store.beginTurn(1, state.agentId, state);
    await store.finalizeTurn();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.beginTurn(3, state.agentId, state);

    await expect(store.prepareUndo(state.agentId, 5)).rejects.toThrow("was not finalized");
  });

  it("resumes an undo journal after files were restored but before commit", async () => {
    const session = await mkdtemp(join(tmpdir(), "kulmi-checkpoints-"));
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-checkpoint-workspace-"));
    const file = join(workspace, "file.txt");
    await writeFile(file, "before\n");
    const state = runState();
    const store = new CheckpointStore(session, workspace);
    await store.beginTurn(1, state.agentId, state);
    await store.capture(file);
    await writeFile(file, "after\n");
    await store.finalizeTurn();
    const interrupted = await store.prepareUndo(state.agentId, 3);
    await interrupted.begin("truncate");
    await interrupted.apply();
    expect(await readFile(file, "utf8")).toBe("before\n");

    const reopened = new CheckpointStore(session, workspace);
    const resumed = await reopened.prepareUndo(state.agentId, 3);
    expect(resumed.messageHistory).toBe("truncate");
    await resumed.begin("truncate");
    await resumed.apply();
    await resumed.commit();
    expect(await readFile(file, "utf8")).toBe("before\n");
    await expect(reopened.prepareUndo(state.agentId, 3)).rejects.toThrow("no completed turn");
  });
});

function runState(): RunState {
  return {
    agentId: "agent",
    mode: "task",
    status: "idle",
    plan: [],
    modifiedFiles: new Set(),
    verifications: [],
    revision: 0,
  };
}
