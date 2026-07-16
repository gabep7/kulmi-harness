import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { EventBus } from "../src/core/events.js";
import type { RunState } from "../src/core/types.js";
import { ArtifactStore } from "../src/runtime/artifacts.js";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import { resolveToolBinary } from "../src/runtime/binaries.js";
import { fileTools } from "../src/tools/files.js";
import { probeDiagnostics } from "../src/tools/lsp.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/types.js";

const registry = new ToolRegistry(fileTools());
const lspBinary = await resolveToolBinary("typescript-language-server");

const root = await realpath(await mkdtemp(join(tmpdir(), "kulmi-edit-diag-")));
const session = await realpath(await mkdtemp(join(tmpdir(), "kulmi-edit-diag-session-")));
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
const context: ToolContext = {
  workspaceRoot: root,
  cwd: root,
  autonomy: "medium",
  signal: new AbortController().signal,
  events: new EventBus(),
  state,
  checkpoint,
  artifacts: new ArtifactStore(session),
  commandTimeoutMs: 10_000,
  maxOutputBytes: 100_000,
};

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

describe.skipIf(!lspBinary)("post-edit diagnostics", () => {
  beforeAll(async () => {
    // Warm the shared language server so per-edit probes are not racing a cold tsserver start.
    await writeFile(join(root, "warmup.ts"), "export const warm = 1;\n");
    await probeDiagnostics(context, join(root, "warmup.ts"), 25_000);
  }, 30_000);

  it("appends error diagnostics after writing a TypeScript file with a type error", { timeout: 30_000 }, async () => {
    const result = await registry.execute({
      name: "write_file",
      argumentsJson: JSON.stringify({
        path: "bad.ts",
        content: 'const wrong: number = "oops";\nexport const value = wrong;\n',
      }),
      callId: "diag-write-bad",
      context,
    });
    expect(result.isError, result.content).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.diagnostics).toBeDefined();
    expect(parsed.diagnostics).toContain("bad.ts:1");
    expect(parsed.diagnostics).toContain("not assignable");
  });

  it("omits diagnostics for a clean edit", { timeout: 30_000 }, async () => {
    const clean = "export const value = 1;\n";
    const write = await registry.execute({
      name: "write_file",
      argumentsJson: JSON.stringify({ path: "clean.ts", content: clean }),
      callId: "diag-write-clean",
      context,
    });
    expect(write.isError, write.content).toBe(false);
    expect(JSON.parse(write.content).diagnostics).toBeUndefined();

    const edit = await registry.execute({
      name: "edit_file",
      argumentsJson: JSON.stringify({
        path: "clean.ts",
        old_text: "value = 1",
        new_text: "value = 2",
        expected_sha256: digest(clean),
      }),
      callId: "diag-edit-clean",
      context,
    });
    expect(edit.isError, edit.content).toBe(false);
    expect(JSON.parse(edit.content).diagnostics).toBeUndefined();
  });

  it("reports diagnostics from replace_by_line_range and recovers after a fix", { timeout: 30_000 }, async () => {
    const original = "export const flag: boolean = true;\n";
    await writeFile(join(root, "range.ts"), original);
    const broken = await registry.execute({
      name: "replace_by_line_range",
      argumentsJson: JSON.stringify({
        path: "range.ts",
        start_line: 1,
        end_line: 1,
        new_text: "export const flag: boolean = 42;",
        expected_sha256: digest(original),
      }),
      callId: "diag-range-break",
      context,
    });
    expect(broken.isError, broken.content).toBe(false);
    const brokenParsed = JSON.parse(broken.content);
    expect(brokenParsed.diagnostics).toBeDefined();
    expect(brokenParsed.diagnostics).toContain("range.ts:1");

    const fixed = await registry.execute({
      name: "edit_files",
      argumentsJson: JSON.stringify({
        files: [{
          path: "range.ts",
          expected_sha256: brokenParsed.sha256,
          edits: [{ old_text: "= 42;", new_text: "= false;" }],
        }],
      }),
      callId: "diag-range-fix",
      context,
    });
    expect(fixed.isError, fixed.content).toBe(false);
    expect(JSON.parse(fixed.content).files[0].diagnostics).toBeUndefined();
  });

  it("caps the summary at five errors", { timeout: 30_000 }, async () => {
    const lines = Array.from({ length: 7 }, (_, index) => `const bad${index}: number = "x${index}";`);
    const result = await registry.execute({
      name: "write_file",
      argumentsJson: JSON.stringify({ path: "many.ts", content: `${lines.join("\n")}\nexport {};\n` }),
      callId: "diag-write-many",
      context,
    });
    expect(result.isError, result.content).toBe(false);
    const { diagnostics } = JSON.parse(result.content);
    expect(diagnostics).toBeDefined();
    const reported = diagnostics.split("\n");
    expect(reported).toHaveLength(6);
    expect(reported[5]).toBe("plus 2 more errors");
  });

  it("skips files the lsp tool does not recognize", async () => {
    const result = await registry.execute({
      name: "write_file",
      argumentsJson: JSON.stringify({ path: "notes.txt", content: "const wrong: number = 'oops';\n" }),
      callId: "diag-write-txt",
      context,
    });
    expect(result.isError, result.content).toBe(false);
    expect(JSON.parse(result.content).diagnostics).toBeUndefined();
  });

  it("returns undefined instead of throwing when the budget is exhausted", async () => {
    await writeFile(join(root, "tiny.ts"), 'const wrong: number = "oops";\n');
    await expect(probeDiagnostics(context, join(root, "tiny.ts"), 1)).resolves.toBeUndefined();
  });
});
