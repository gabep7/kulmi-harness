import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import { WorkspaceSnapshot } from "../src/runtime/workspace-tracker.js";

const exec = promisify(execFile);

describe("WorkspaceSnapshot", () => {
  it("detects shell-created changes and checkpoints pre-command content", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-tracker-"));
    const session = await mkdtemp(join(tmpdir(), "kulmi-tracker-session-"));
    await exec("git", ["init", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.test"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "a.ts"), "before\n");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-m", "initial"]);
    const checkpoint = new CheckpointStore(session, root);
    await checkpoint.beginTurn(1, "agent");
    const snapshot = await WorkspaceSnapshot.capture(root);

    await writeFile(join(root, "a.ts"), "after\n");
    await writeFile(join(root, "new.ts"), "new\n");
    expect(await snapshot.reconcile(checkpoint)).toEqual(["a.ts", "new.ts"]);
    expect(await readFile(join(session, "checkpoints", "0001-agent", "files", "a.ts"), "utf8"))
      .toBe("before\n");
  });

  it("tracks changes in a repo with no commits yet", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-tracker-empty-"));
    const session = await mkdtemp(join(tmpdir(), "kulmi-tracker-empty-session-"));
    await exec("git", ["init", root]);
    const checkpoint = new CheckpointStore(session, root);
    await checkpoint.beginTurn(1, "agent");
    const snapshot = await WorkspaceSnapshot.capture(root);

    await writeFile(join(root, "new.ts"), "new\n");
    expect(await snapshot.reconcile(checkpoint)).toEqual(["new.ts"]);
  });
});
