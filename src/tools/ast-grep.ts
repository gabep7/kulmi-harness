import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { z } from "zod";
import { assertNotSensitivePath, resolveWorkspacePath } from "../security/paths.js";
import { disposeChildEnvironment, safeChildEnvironment } from "../security/environment.js";
import { resolveToolBinary } from "../runtime/binaries.js";
import { defineTool } from "./types.js";

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
      throw new Error("sg (ast-grep) binary not found. Install dependencies with npm install or add sg to PATH.");
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
          ? `sg (ast-grep) binary not found. Install dependencies with npm install or add sg to PATH.`
          : stderr || `sg exited ${code}`,
      );
    }
    if (lines.length === 0) return { content: "no matches" };
    return { content: `${lines.join("\n")}${truncated ? "\n[truncated]" : ""}` };
  },
});
