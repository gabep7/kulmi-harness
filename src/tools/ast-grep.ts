import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { z } from "zod";
import { combineDiffs } from "../core/diff.js";
import { decodeUtf8Slice } from "../core/utf8.js";
import { WorkspaceSnapshot, type WorkspaceChange } from "../runtime/workspace-tracker.js";
import { assertNotSensitivePath, resolveWorkspacePath } from "../security/paths.js";
import { disposeChildEnvironment, safeChildEnvironment } from "../security/environment.js";
import { resolveToolBinary } from "../runtime/binaries.js";
import { defineTool, type ToolContext } from "./types.js";

export const astGrepTool = defineTool({
  name: "ast_grep",
  description:
    "Structural code search using AST patterns. Finds code by syntax shape rather than text. Use for: function calls, declarations, imports, type definitions, method signatures, JSX elements. Example patterns: \"console.log($$$)\" \"function $NAME($$$) {$$$}\" \"import { $$$ } from $SOURCE\"",
  schema: z.object({
    pattern: z.string().min(1),
    path: z.string().default("."),
    lang: z.string().optional(),
    limit: z.number().int().positive().max(200).default(50),
  }),
  readOnly: true,
  isParallelSafe: () => true,
  async execute(context, input) {
    const cwd = await resolveWorkspacePath({
      workspaceRoot: context.workspaceRoot,
      cwd: context.cwd,
      input: input.path,
      mustExist: true,
    });
    assertNotSensitivePath(cwd);
    const args = ["run", "--pattern", input.pattern, "--json=stream"];
    if (input.lang) args.push("--lang", input.lang);
    args.push(cwd);
    const binary = await resolveToolBinary("sg");
    if (!binary) {
      throw new Error("sg (ast-grep) binary not found. Install dependencies with pnpm install or add sg to PATH.");
    }
    const env = safeChildEnvironment();
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      disposeChildEnvironment(env);
      throw error;
    }
    const errors: Buffer[] = [];
    const lines: string[] = [];
    let carry = "";
    let retainedBytes = 0;
    let truncated = false;
    const pushMatch = (rawLine: string) => {
      if (!rawLine.trim() || truncated) return;
      try {
        const match = JSON.parse(rawLine) as { file: string; range: { start: { line: number; column: number } }; text: string };
        const rel = match.file.startsWith(cwd) ? match.file.slice(cwd.length).replace(/^\//, "") : match.file;
        const text = match.text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
        const formatted = `${rel}:${match.range.start.line}:${match.range.start.column} | ${text}`;
        const bytes = Buffer.byteLength(formatted, "utf8") + 1;
        if (lines.length >= input.limit || retainedBytes + bytes > context.maxOutputBytes) {
          truncated = true;
          child.kill("SIGTERM");
          return;
        }
        lines.push(formatted);
        retainedBytes += bytes;
        if (lines.length >= input.limit) {
          truncated = true;
          child.kill("SIGTERM");
        }
      } catch {
        truncated = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      carry += chunk.toString("utf8");
      while (true) {
        const newline = carry.indexOf("\n");
        if (newline === -1) break;
        const rawLine = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        pushMatch(rawLine);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    const abort = () => child.kill("SIGTERM");
    context.signal.addEventListener("abort", abort, { once: true });
    const { code } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }).finally(() => {
      context.signal.removeEventListener("abort", abort);
      disposeChildEnvironment(env);
    });
    if (context.signal.aborted) throw context.signal.reason ?? new Error("ast_grep aborted");
    if (carry.trim() && !truncated) pushMatch(carry);
    if (!truncated && (code ?? 1) > 1) {
      const stderr = Buffer.concat(errors).toString("utf8").trim();
      throw new Error(
        stderr.includes("ENOENT") || stderr.includes("not found") || code === 127
          ? `sg (ast-grep) binary not found. Install dependencies with pnpm install or add sg to PATH.`
          : stderr || `sg exited ${code}`,
      );
    }
    if (lines.length === 0) return { content: "no matches" };
    return { content: `${lines.join("\n")}${truncated ? "\n[truncated]" : ""}` };
  },
});

export const astGrepReplaceTool = defineTool({
  name: "ast_grep_replace",
  description:
    "Structural code rewrite using AST patterns. Replaces every matching syntax node and reports files verified as changed. Use for codemods where text replacement is unsafe.",
  schema: z.object({
    pattern: z.string().min(1),
    replacement: z.string(),
    path: z.string().default("."),
    lang: z.string().optional(),
  }),
  readOnly: false,
  isParallelSafe: () => false,
  async execute(context, input) {
    if (context.autonomy === "read") throw new Error("ast_grep_replace requires low autonomy or higher");
    const cwd = await resolveWorkspacePath({
      workspaceRoot: context.workspaceRoot,
      cwd: context.cwd,
      input: input.path,
      mustExist: true,
    });
    assertNotSensitivePath(cwd);
    const binary = await resolveToolBinary("sg");
    if (!binary) {
      throw new Error("sg (ast-grep) binary not found. Install dependencies with pnpm install or add sg to PATH.");
    }
    // Pre-flight: enumerate the files that would be rewritten and refuse any
    // sensitive one (`.env`, `.pem`, `.key`, `secrets.*`, ...). The rewrite
    // tool otherwise applies --update-all across the whole directory with no
    // per-file guard, unlike write_file/edit_file.
    const sensitiveTargets = await collectSensitiveTargets(context, binary, input.pattern, input.lang, cwd);
    if (sensitiveTargets.length > 0) {
      throw new Error(
        `ast_grep_replace would modify sensitive file${sensitiveTargets.length === 1 ? "" : "s"}: ${sensitiveTargets.join(", ")}`,
      );
    }
    const snapshot = await WorkspaceSnapshot.capture(context.workspaceRoot);
    const args = ["run", "--pattern", input.pattern, "--rewrite", input.replacement, "--update-all"];
    if (input.lang) args.push("--lang", input.lang);
    args.push(cwd);

    const env = safeChildEnvironment();
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      disposeChildEnvironment(env);
      throw error;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = Math.max(0, context.maxOutputBytes - stdoutBytes);
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        stdoutChunks.push(retained);
        stdoutBytes += retained.length;
      }
      if (chunk.length > remaining) truncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = Math.max(0, context.maxOutputBytes - stderrBytes);
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        stderrChunks.push(retained);
        stderrBytes += retained.length;
      }
      if (chunk.length > remaining) truncated = true;
    });
    const abort = () => child.kill("SIGTERM");
    context.signal.addEventListener("abort", abort, { once: true });
    let outcome: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let processError: unknown;
    const changes: WorkspaceChange[] = [];
    try {
      outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
    } catch (error) {
      processError = error;
    } finally {
      context.signal.removeEventListener("abort", abort);
      disposeChildEnvironment(env);
      changes.push(...await snapshot.reconcileChanges(context.checkpoint));
      if (changes.length > 0) {
        for (const change of changes) context.state.modifiedFiles.add(change.path);
        context.state.revision += 1;
        delete context.state.completion;
      }
    }
    if (processError) throw processError;
    if (context.signal.aborted) throw context.signal.reason ?? new Error("ast_grep_replace aborted");

    const stdoutBuffer = Buffer.concat(stdoutChunks);
    const stderrBuffer = Buffer.concat(stderrChunks);
    const stdout = decodeUtf8Slice(stdoutBuffer).trim();
    const stderr = decodeUtf8Slice(stderrBuffer).trim();
    if ((outcome?.code ?? 1) > 1) {
      throw new Error(
        stderr.includes("ENOENT") || stderr.includes("not found") || outcome?.code === 127
          ? "sg (ast-grep) binary not found. Install dependencies with pnpm install or add sg to PATH."
          : stderr || `sg exited ${outcome?.code}`,
      );
    }
    const changedFiles = changes.map((change) => change.path);
    const diff = combineDiffs(changes.flatMap((change) => change.diff ? [change.diff] : []));
    return {
      content: JSON.stringify({
        changed_files: changedFiles,
        ...(stdout ? { stdout } : {}),
        ...(stderr ? { stderr } : {}),
        truncated,
      }),
      mutated: changedFiles.length > 0,
      ...(diff ? { diff } : {}),
    };
  },
});


// Run sg in read-only match mode over the rewrite target and return the paths
// of any matching file that assertNotSensitivePath considers sensitive. This
// lets ast_grep_replace refuse to touch secrets it would otherwise rewrite.
async function collectSensitiveTargets(
  context: ToolContext,
  binary: string,
  pattern: string,
  lang: string | undefined,
  cwd: string,
): Promise<string[]> {
  const args = ["run", "--pattern", pattern, "--json=stream"];
  if (lang) args.push("--lang", lang);
  args.push(cwd);
  const env = safeChildEnvironment();
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    disposeChildEnvironment(env);
    throw error;
  }
  const errors: Buffer[] = [];
  const sensitive = new Set<string>();
  let carry = "";
  let limitReached = false;
  const onMatch = (rawLine: string) => {
    if (limitReached || !rawLine.trim()) return;
    try {
      const match = JSON.parse(rawLine) as { file?: string };
      if (match.file && match.file !== cwd) {
        try {
          assertNotSensitivePath(match.file);
        } catch {
          sensitive.add(match.file);
        }
      }
    } catch {
      limitReached = true;
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    carry += chunk.toString("utf8");
    while (true) {
      const newline = carry.indexOf("\n");
      if (newline === -1) break;
      const rawLine = carry.slice(0, newline);
      carry = carry.slice(newline + 1);
      onMatch(rawLine);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const abort = () => child.kill("SIGTERM");
  context.signal.addEventListener("abort", abort, { once: true });
  const { code } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    context.signal.removeEventListener("abort", abort);
    disposeChildEnvironment(env);
  });
  if (context.signal.aborted) throw context.signal.reason ?? new Error("ast_grep_replace aborted");
  if (!limitReached && carry.trim()) onMatch(carry);
  if ((code ?? 1) > 1) {
    const stderr = Buffer.concat(errors).toString("utf8").trim();
    if (stderr.includes("ENOENT") || stderr.includes("not found") || code === 127) {
      throw new Error("sg (ast-grep) binary not found. Install dependencies with pnpm install or add sg to PATH.");
    }
  }
  return [...sensitive];
}
