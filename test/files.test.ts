import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/core/events.js";
import type { RunState } from "../src/core/types.js";
import { ArtifactStore } from "../src/runtime/artifacts.js";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import { fileTools } from "../src/tools/files.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createHash } from "node:crypto";

describe("file tools", () => {
  it("reports literal directory matches even when their contents are ignored", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kulmi-files-glob-")));
    const session = await realpath(await mkdtemp(join(tmpdir(), "kulmi-files-glob-session-")));
    await mkdir(join(root, "dist"));
    await mkdir(join(root, "dist", "cache"));
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, "node_modules", "package"));
    await mkdir(join(root, ".git"));
    const registry = new ToolRegistry(fileTools());
    const context = {
      workspaceRoot: root,
      cwd: root,
      autonomy: "read" as const,
      signal: new AbortController().signal,
      events: new EventBus(),
      state: {
        agentId: "agent",
        mode: "task" as const,
        status: "running" as const,
        plan: [],
        modifiedFiles: new Set<string>(),
        verifications: [],
        revision: 0,
      },
      checkpoint: new CheckpointStore(session, root),
      artifacts: new ArtifactStore(session),
      commandTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
    };

    await expect(registry.execute({
      name: "glob",
      argumentsJson: JSON.stringify({ pattern: "dist" }),
      callId: "glob-dist",
      context,
    })).resolves.toMatchObject({ content: "dist", isError: false });
    await expect(registry.execute({
      name: "glob",
      argumentsJson: JSON.stringify({ pattern: "node_modules" }),
      callId: "glob-node-modules",
      context,
    })).resolves.toMatchObject({ content: "node_modules", isError: false });
    await expect(registry.execute({
      name: "glob",
      argumentsJson: JSON.stringify({ pattern: ".git" }),
      callId: "glob-git",
      context,
    })).resolves.toMatchObject({ content: "no matches", isError: false });
    await expect(registry.execute({
      name: "glob",
      argumentsJson: JSON.stringify({ pattern: "dist/cache" }),
      callId: "glob-dist-child",
      context,
    })).resolves.toMatchObject({ content: "no matches", isError: false });
    await expect(registry.execute({
      name: "glob",
      argumentsJson: JSON.stringify({ pattern: "node_modules/package" }),
      callId: "glob-node-modules-child",
      context,
    })).resolves.toMatchObject({ content: "no matches", isError: false });
  });

  it("emits a bounded diff and does not count no-op edits as revisions", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kulmi-files-")));
    const session = await realpath(await mkdtemp(join(tmpdir(), "kulmi-files-session-")));
    await writeFile(join(root, "example.ts"), "const value = 1;\n");
    const events = new EventBus();
    const checkpoint = new CheckpointStore(session, root);
    await checkpoint.beginTurn(1, "agent");
    const state: RunState = {
      agentId: "agent",
      mode: "task",
      status: "running",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    const context = {
      workspaceRoot: root,
      cwd: root,
      autonomy: "medium" as const,
      signal: new AbortController().signal,
      events,
      state,
      checkpoint,
      artifacts: new ArtifactStore(session),
      commandTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
    };
    const finished: string[] = [];
    events.on((envelope) => {
      if (envelope.event.type === "tool.finished" && envelope.event.diff) {
        finished.push(envelope.event.diff);
      }
    });
    const registry = new ToolRegistry(fileTools());

    const edit = await registry.execute({
      name: "edit_file",
      argumentsJson: JSON.stringify({
        path: "example.ts",
        old_text: "const value = 1;",
        new_text: "const value = 2;",
        expected_sha256: digest("const value = 1;\n"),
      }),
      callId: "edit-1",
      context,
    });
    expect(edit.isError, edit.content).toBe(false);
    expect(JSON.parse(edit.content)).toMatchObject({
      path: "example.ts",
      replacements: 1,
      additions: 1,
      deletions: 1,
    });
    expect(finished[0]).toContain("--- a/example.ts");
    expect(finished[0]).toContain("-const value = 1;");
    expect(finished[0]).toContain("+const value = 2;");
    expect(await readFile(join(root, "example.ts"), "utf8")).toBe("const value = 2;\n");
    expect(state.revision).toBe(1);
    state.completion = { status: "completed", summary: "verified", evidence: ["check passed"] };

    const noOp = await registry.execute({
      name: "edit_file",
      argumentsJson: JSON.stringify({
        path: "example.ts",
        old_text: "const value = 2;",
        new_text: "const value = 2;",
        expected_sha256: digest("const value = 2;\n"),
      }),
      callId: "edit-2",
      context,
    });
    expect(JSON.parse(noOp.content)).toMatchObject({ path: "example.ts", unchanged: true });
    expect(state.revision).toBe(1);
    expect(state.completion).toMatchObject({ status: "completed", summary: "verified" });
    expect(finished).toHaveLength(1);

    const deletion = await registry.execute({
      name: "delete_file",
      argumentsJson: JSON.stringify({
        path: "example.ts",
        expected_sha256: JSON.parse(noOp.content).sha256,
      }),
      callId: "delete-1",
      context,
    });
    expect(JSON.parse(deletion.content)).toMatchObject({ path: "example.ts", deleted: true });
    await expect(access(join(root, "example.ts"))).rejects.toThrow();
    expect(state.revision).toBe(2);
    expect(state.completion).toBeUndefined();
    expect(finished[1]).toContain("-const value = 2;");
  });

  it("requires a current read hash before replacing a file", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kulmi-files-write-")));
    const session = await realpath(await mkdtemp(join(tmpdir(), "kulmi-files-write-session-")));
    await writeFile(join(root, "existing.txt"), "before\n");
    const checkpoint = new CheckpointStore(session, root);
    await checkpoint.beginTurn(1, "agent");
    const registry = new ToolRegistry(fileTools());
    const context = {
      workspaceRoot: root,
      cwd: root,
      autonomy: "medium" as const,
      signal: new AbortController().signal,
      events: new EventBus(),
      state: {
        agentId: "agent",
        mode: "task" as const,
        status: "running" as const,
        plan: [],
        modifiedFiles: new Set<string>(),
        verifications: [],
        revision: 0,
      },
      checkpoint,
      artifacts: new ArtifactStore(session),
      commandTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
    };

    const missing = await registry.execute({
      name: "write_file",
      argumentsJson: JSON.stringify({ path: "existing.txt", content: "after\n" }),
      callId: "write-missing",
      context,
    });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.content).toContain("requires expected_sha256");

    const stale = await registry.execute({
      name: "edit_file",
      argumentsJson: JSON.stringify({
        path: "existing.txt",
        old_text: "before",
        new_text: "after",
        expected_sha256: "0000000000000000",
      }),
      callId: "edit-stale",
      context,
    });
    expect(stale).toMatchObject({ isError: true });
    expect(stale.content).toContain("stale edit");
    expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("before\n");
  });

  it("preflights and applies multiple exact file edits as one revision", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "kulmi-files-batch-")));
    const session = await realpath(await mkdtemp(join(tmpdir(), "kulmi-files-batch-session-")));
    const first = "const one = 1;\nconst two = 2;\n";
    const second = "export const mode = 'old';\n";
    await writeFile(join(root, "first.ts"), first);
    await writeFile(join(root, "second.ts"), second);
    const events = new EventBus();
    const checkpoint = new CheckpointStore(session, root);
    await checkpoint.beginTurn(1, "agent");
    const state: RunState = {
      agentId: "agent",
      mode: "task",
      status: "running",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    const context = {
      workspaceRoot: root,
      cwd: root,
      autonomy: "medium" as const,
      signal: new AbortController().signal,
      events,
      state,
      checkpoint,
      artifacts: new ArtifactStore(session),
      commandTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
    };
    const diffs: string[] = [];
    events.on((envelope) => {
      if (envelope.event.type === "tool.finished" && envelope.event.diff) diffs.push(envelope.event.diff);
    });
    const registry = new ToolRegistry(fileTools());

    const stale = await registry.execute({
      name: "edit_files",
      argumentsJson: JSON.stringify({ files: [
        {
          path: "first.ts",
          expected_sha256: digest(first),
          edits: [{ old_text: "one = 1", new_text: "one = 10" }],
        },
        {
          path: "second.ts",
          expected_sha256: "0000000000000000",
          edits: [{ old_text: "'old'", new_text: "'new'" }],
        },
      ] }),
      callId: "batch-stale",
      context,
    });
    expect(stale.isError).toBe(true);
    expect(await readFile(join(root, "first.ts"), "utf8")).toBe(first);
    expect(await readFile(join(root, "second.ts"), "utf8")).toBe(second);
    expect(state.revision).toBe(0);

    const result = await registry.execute({
      name: "edit_files",
      argumentsJson: JSON.stringify({ files: [
        {
          path: "first.ts",
          expected_sha256: digest(first),
          edits: [
            { old_text: "one = 1", new_text: "one = 10" },
            { old_text: "two = 2", new_text: "two = 20" },
          ],
        },
        {
          path: "second.ts",
          expected_sha256: digest(second),
          edits: [{ old_text: "'old'", new_text: "'new'" }],
        },
      ] }),
      callId: "batch-ok",
      context,
    });
    expect(result.isError, result.content).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      changed_files: 2,
      files: [
        { path: "first.ts", replacements: 2 },
        { path: "second.ts", replacements: 1 },
      ],
    });
    expect(await readFile(join(root, "first.ts"), "utf8")).toBe("const one = 10;\nconst two = 20;\n");
    expect(await readFile(join(root, "second.ts"), "utf8")).toBe("export const mode = 'new';\n");
    expect(state.revision).toBe(1);
    expect([...state.modifiedFiles].sort()).toEqual(["first.ts", "second.ts"]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("--- a/first.ts");
    expect(diffs[0]).toContain("--- a/second.ts");
  });
});

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
