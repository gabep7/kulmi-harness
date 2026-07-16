import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { EventBus } from "../src/core/events.js";
import type { RunState } from "../src/core/types.js";
import { ArtifactStore } from "../src/runtime/artifacts.js";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import { fileTools } from "../src/tools/files.js";
import { ToolRegistry } from "../src/tools/registry.js";

const registry = new ToolRegistry(fileTools());

async function createContext() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kulmi-edit-robust-")));
  const session = await realpath(await mkdtemp(join(tmpdir(), "kulmi-edit-robust-session-")));
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
    events: new EventBus(),
    state,
    checkpoint,
    artifacts: new ArtifactStore(session),
    commandTimeoutMs: 10_000,
    maxOutputBytes: 100_000,
  };
  return { root, context };
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

describe("whitespace-tolerant edit fallback", () => {
  it("matches a uniquely indented block and re-indents new_text to the actual base", async () => {
    const { root, context } = await createContext();
    const content = "def outer():\n    if flag:\n        value = 1\n        print(value)\n    return value\n";
    await writeFile(join(root, "sample.py"), content);

    const result = await registry.execute({
      name: "edit_file",
      argumentsJson: JSON.stringify({
        path: "sample.py",
        old_text: "if flag:  \n    value = 1\n    print(value)",
        new_text: "if flag:\n    value = 2\n    print(value * 2)",
        expected_sha256: digest(content),
      }),
      callId: "fallback-1",
      context,
    });
    expect(result.isError, result.content).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed).toMatchObject({
      path: "sample.py",
      replacements: 1,
      matched: "whitespace-normalized",
    });
    expect(await readFile(join(root, "sample.py"), "utf8")).toBe(
      "def outer():\n    if flag:\n        value = 2\n        print(value * 2)\n    return value\n",
    );
  });

  it("strips new_text's own base indentation before applying the matched base", async () => {
    const { root, context } = await createContext();
    const content = "def outer():\n    if flag:\n        value = 1\n    return value\n";
    await writeFile(join(root, "reindent.py"), content);

    const result = await registry.execute({
      name: "edit_file",
      argumentsJson: JSON.stringify({
        path: "reindent.py",
        old_text: "if flag:\n    value = 1",
        new_text: "        if flag:\n            value = 2",
        expected_sha256: digest(content),
      }),
      callId: "fallback-reindent",
      context,
    });
    expect(result.isError, result.content).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ matched: "whitespace-normalized" });
    expect(await readFile(join(root, "reindent.py"), "utf8")).toBe(
      "def outer():\n    if flag:\n        value = 2\n    return value\n",
    );
  });

  it("rejects an ambiguous fallback match and reports the location count", async () => {
    const { root, context } = await createContext();
    const content = "def a():\n    item = 1\n    emit(item)\n\ndef b():\n        item = 1\n        emit(item)\n";
    await writeFile(join(root, "ambiguous.py"), content);

    const result = await registry.execute({
      name: "edit_file",
      argumentsJson: JSON.stringify({
        path: "ambiguous.py",
        old_text: "item = 1\nemit(item)",
        new_text: "item = 2\nemit(item)",
        expected_sha256: digest(content),
      }),
      callId: "fallback-ambiguous",
      context,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("2 locations");
    expect(result.content).toContain("context");
    expect(await readFile(join(root, "ambiguous.py"), "utf8")).toBe(content);
  });

  it("keeps the not-found error when neither exact nor fallback matches", async () => {
    const { root, context } = await createContext();
    const content = "value = 1\n";
    await writeFile(join(root, "missing.py"), content);

    const result = await registry.execute({
      name: "edit_file",
      argumentsJson: JSON.stringify({
        path: "missing.py",
        old_text: "missing_line()",
        new_text: "found_line()",
        expected_sha256: digest(content),
      }),
      callId: "fallback-missing",
      context,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("old_text not found in missing.py");
  });

  it("never uses the fallback for replace_all", async () => {
    const { root, context } = await createContext();
    const content = "def outer():\n    value = 1\n";
    await writeFile(join(root, "replace-all.py"), content);

    const result = await registry.execute({
      name: "edit_file",
      argumentsJson: JSON.stringify({
        path: "replace-all.py",
        old_text: "value = 1  ",
        new_text: "value = 2",
        replace_all: true,
        expected_sha256: digest(content),
      }),
      callId: "fallback-replace-all",
      context,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("old_text not found in replace-all.py");
    expect(await readFile(join(root, "replace-all.py"), "utf8")).toBe(content);
  });

  it("keeps exact-match semantics untouched", async () => {
    const { root, context } = await createContext();
    const content = "alpha = 1\nbeta = 1\nbeta = 1\n";
    await writeFile(join(root, "exact.py"), content);

    const exact = await registry.execute({
      name: "edit_file",
      argumentsJson: JSON.stringify({
        path: "exact.py",
        old_text: "alpha = 1",
        new_text: "alpha = 2",
        expected_sha256: digest(content),
      }),
      callId: "exact-1",
      context,
    });
    expect(exact.isError, exact.content).toBe(false);
    const parsed = JSON.parse(exact.content);
    expect(parsed).toMatchObject({ path: "exact.py", replacements: 1 });
    expect(parsed.matched).toBeUndefined();

    const updated = await readFile(join(root, "exact.py"), "utf8");
    const duplicate = await registry.execute({
      name: "edit_file",
      argumentsJson: JSON.stringify({
        path: "exact.py",
        old_text: "beta = 1",
        new_text: "beta = 2",
        expected_sha256: digest(updated),
      }),
      callId: "exact-2",
      context,
    });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content).toContain("occurs 2 times");
  });

  it("applies the fallback inside edit_files and flags the file as normalized", async () => {
    const { root, context } = await createContext();
    const content = "def run():\n    if ready:\n        start()\n";
    await writeFile(join(root, "batch.py"), content);

    const result = await registry.execute({
      name: "edit_files",
      argumentsJson: JSON.stringify({
        files: [{
          path: "batch.py",
          expected_sha256: digest(content),
          edits: [
            { old_text: "if ready:\n    start()", new_text: "if ready:\n    start_all()" },
            { old_text: "def run():", new_text: "def run_all():" },
          ],
        }],
      }),
      callId: "batch-1",
      context,
    });
    expect(result.isError, result.content).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.files[0]).toMatchObject({
      path: "batch.py",
      replacements: 2,
      matched: "whitespace-normalized",
    });
    expect(await readFile(join(root, "batch.py"), "utf8")).toBe(
      "def run_all():\n    if ready:\n        start_all()\n",
    );
  });

  it("rejects an ambiguous edit_files fallback with the edit index and count", async () => {
    const { root, context } = await createContext();
    const content = "    ping()\n        ping()\n";
    await writeFile(join(root, "batch-ambiguous.py"), content);

    const result = await registry.execute({
      name: "edit_files",
      argumentsJson: JSON.stringify({
        files: [{
          path: "batch-ambiguous.py",
          expected_sha256: digest(content),
          edits: [{ old_text: "ping()  ", new_text: "pong()" }],
        }],
      }),
      callId: "batch-2",
      context,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("edit 1");
    expect(result.content).toContain("2 locations");
    expect(await readFile(join(root, "batch-ambiguous.py"), "utf8")).toBe(content);
  });
});
