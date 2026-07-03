import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("does not report unchanged working files when a commit only cleans git status", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-tracker-commit-"));
    const session = await mkdtemp(join(tmpdir(), "kulmi-tracker-session-"));
    await exec("git", ["init", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.test"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "a.ts"), "before\n");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-m", "initial"]);
    await writeFile(join(root, "a.ts"), "after\n");
    const checkpoint = new CheckpointStore(session, root);
    await checkpoint.beginTurn(1, "agent");
    const snapshot = await WorkspaceSnapshot.capture(root);

    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-m", "change"]);
    expect(await snapshot.reconcile(checkpoint)).toEqual([]);
  });

  it("tracks permission-only changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-tracker-mode-"));
    const session = await mkdtemp(join(tmpdir(), "kulmi-tracker-mode-session-"));
    await exec("git", ["init", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.test"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "script.sh"), "echo ok\n", { mode: 0o644 });
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-m", "initial"]);
    const checkpoint = new CheckpointStore(session, root);
    await checkpoint.beginTurn(1, "agent");
    const snapshot = await WorkspaceSnapshot.capture(root);

    await chmod(join(root, "script.sh"), 0o755);
    expect(await snapshot.reconcile(checkpoint)).toEqual(["script.sh"]);
    const manifest = JSON.parse(await readFile(
      join(session, "checkpoints", "0001-agent", "checkpoint.json"),
      "utf8",
    )) as { entries: Array<{ path: string; before: { mode?: number } }> };
    expect(manifest.entries).toContainEqual(expect.objectContaining({
      path: "script.sh",
      before: expect.objectContaining({ mode: 0o644 }),
    }));
  });
});
