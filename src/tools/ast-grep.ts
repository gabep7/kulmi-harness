import { spawn } from "node:child_process";
import { z } from "zod";
import { assertNotSensitivePath, resolveWorkspacePath } from "../security/paths.js";
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
    const args = ["--pattern", input.pattern, "--json"];
    if (input.lang) args.push("--lang", input.lang);
    args.push(cwd);
    const child = spawn("sg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (bytes >= context.maxOutputBytes) return;
      chunks.push(chunk.subarray(0, context.maxOutputBytes - bytes));
      bytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    const abort = () => child.kill("SIGTERM");
    context.signal.addEventListener("abort", abort, { once: true });
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (value) => resolve(value ?? 1));
    }).finally(() => context.signal.removeEventListener("abort", abort));
    if (context.signal.aborted) throw context.signal.reason ?? new Error("ast_grep aborted");
    if (code > 1) {
      const stderr = Buffer.concat(errors).toString("utf8").trim();
      throw new Error(
        stderr.includes("ENOENT") || stderr.includes("not found") || code === 127
          ? `sg (ast-grep) binary not found. Install it: npm i -g @ast-grep/cli or cargo install ast-grep`
          : stderr || `sg exited ${code}`,
      );
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw || raw === "[]") return { content: "no matches" };
    try {
      const matches: Array<{ file: string; range: { start: { line: number; column: number } }; text: string }> = JSON.parse(raw);
      if (matches.length === 0) return { content: "no matches" };
      const lines = matches.slice(0, input.limit).map((m) => {
        const rel = m.file.startsWith(cwd) ? m.file.slice(cwd.length).replace(/^\//, "") : m.file;
        const text = m.text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
        return `${rel}:${m.range.start.line}:${m.range.start.column} | ${text}`;
      });
      return { content: lines.join("\n") };
    } catch {
      return { content: raw.slice(0, context.maxOutputBytes) };
    }
  },
});
