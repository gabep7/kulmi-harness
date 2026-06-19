import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import { assertNotSensitivePath, resolveWorkspacePath } from "../security/paths.js";
import { defineTool, type AnyTool } from "./types.js";

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function fileTools(): AnyTool[] {
  return [readFileTool, globTool, grepTool, writeFileTool, editFileTool];
}

const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read a UTF-8 text file from the workspace with line numbers. Use offset and limit for large files.",
  schema: z.object({
    path: z.string().min(1),
    offset: z.number().int().positive().default(1),
    limit: z.number().int().positive().max(2_000).default(400),
  }),
  readOnly: true,
  async execute(context, input) {
    const path = await resolveWorkspacePath({
      workspaceRoot: context.workspaceRoot,
      cwd: context.cwd,
      input: input.path,
      mustExist: true,
    });
    assertNotSensitivePath(path);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`${input.path} is not a file`);
    if (info.size > 2_000_000) throw new Error(`${input.path} exceeds the 2 MB read limit`);
    const content = textDecoder.decode(await readFile(path));
    const lines = content.split("\n");
    const start = input.offset - 1;
    const selected = lines.slice(start, start + input.limit);
    const width = String(Math.min(lines.length, start + selected.length)).length;
    const rendered = selected
      .map((line, index) => `${String(start + index + 1).padStart(width)}\t${line}`)
      .join("\n");
    return {
      content: `${rendered}\n\n[${selected.length} of ${lines.length} lines, sha256:${sha256(content)}]`,
    };
  },
});

const globTool = defineTool({
  name: "glob",
  description: "Find workspace files by glob pattern. Results are sorted and symlinks are not followed.",
  schema: z.object({
    pattern: z.string().min(1),
    path: z.string().default("."),
    limit: z.number().int().positive().max(2_000).default(500),
  }),
  readOnly: true,
  async execute(context, input) {
    if (isAbsolute(input.pattern)) throw new Error("absolute glob patterns are blocked");
    const cwd = await resolveWorkspacePath({
      workspaceRoot: context.workspaceRoot,
      cwd: context.cwd,
      input: input.path,
      mustExist: true,
    });
    const matches = await fg(input.pattern, {
      cwd,
      dot: true,
      onlyFiles: false,
      followSymbolicLinks: false,
      ignore: ["**/.git/**", "**/node_modules/**", "**/dist/**", "**/target/**"],
    });
    const safeMatches: string[] = [];
    for (const match of matches) {
      try {
        const resolved = await resolveWorkspacePath({
          workspaceRoot: context.workspaceRoot,
          cwd,
          input: match,
          mustExist: true,
        });
        assertNotSensitivePath(resolved);
        safeMatches.push(match);
      } catch {
        continue;
      }
    }
    const sorted = safeMatches.sort().slice(0, input.limit);
    const suffix = matches.length > sorted.length ? `\n[truncated ${matches.length - sorted.length} results]` : "";
    return { content: sorted.length ? `${sorted.join("\n")}${suffix}` : "no matches" };
  },
});

const grepTool = defineTool({
  name: "grep",
  description: "Search text with ripgrep. The pattern is passed as an argument, not evaluated by a shell.",
  schema: z.object({
    pattern: z.string().min(1),
    path: z.string().default("."),
    glob: z.string().optional(),
    fixed_strings: z.boolean().default(false),
    limit: z.number().int().positive().max(2_000).default(500),
  }),
  readOnly: true,
  async execute(context, input) {
    const cwd = await resolveWorkspacePath({
      workspaceRoot: context.workspaceRoot,
      cwd: context.cwd,
      input: input.path,
      mustExist: true,
    });
    assertNotSensitivePath(cwd);
    const { spawn } = await import("node:child_process");
    const args = ["--line-number", "--color", "never", "--no-heading"];
    if (input.glob) args.push("--glob", input.glob);
    args.push(
      "--glob", "!**/.env", "--glob", "!**/.env.*", "--glob", "!**/*.pem",
      "--glob", "!**/*.key", "--glob", "!**/.npmrc", "--glob", "!**/.pypirc",
    );
    if (input.fixed_strings) args.push("--fixed-strings");
    args.push("--", input.pattern, ".");
    const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
    if (context.signal.aborted) throw context.signal.reason ?? new Error("grep aborted");
    if (code > 1) throw new Error(Buffer.concat(errors).toString("utf8") || `rg exited ${code}`);
    const lines = Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean);
    return { content: lines.slice(0, input.limit).join("\n") || "no matches" };
  },
});

const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Create or replace a UTF-8 text file inside the workspace. Parent directories are created. Use edit_file for small changes.",
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  readOnly: false,
  async execute(context, input) {
    if (context.autonomy === "read") throw new Error("write_file requires low autonomy or higher");
    const path = await resolveWorkspacePath({
      workspaceRoot: context.workspaceRoot,
      cwd: context.cwd,
      input: input.path,
    });
    assertNotSensitivePath(path);
    await context.checkpoint.capture(path);
    await writeAtomic(path, input.content);
    const rel = relative(context.workspaceRoot, path);
    context.state.modifiedFiles.add(rel);
    context.state.revision += 1;
    delete context.state.completion;
    return { content: JSON.stringify({ path: rel, bytes: Buffer.byteLength(input.content), sha256: sha256(input.content) }) };
  },
});

const editFileTool = defineTool({
  name: "edit_file",
  description:
    "Replace exact text in one UTF-8 workspace file. By default old_text must occur exactly once. Supply expected_sha256 to reject stale edits.",
  schema: z.object({
    path: z.string().min(1),
    old_text: z.string().min(1),
    new_text: z.string(),
    expected_sha256: z.string().optional(),
    replace_all: z.boolean().default(false),
  }),
  readOnly: false,
  async execute(context, input) {
    if (context.autonomy === "read") throw new Error("edit_file requires low autonomy or higher");
    const path = await resolveWorkspacePath({
      workspaceRoot: context.workspaceRoot,
      cwd: context.cwd,
      input: input.path,
      mustExist: true,
    });
    assertNotSensitivePath(path);
    const current = textDecoder.decode(await readFile(path));
    const fingerprint = sha256(current);
    if (input.expected_sha256 && input.expected_sha256 !== fingerprint) {
      throw new Error(`stale edit for ${input.path}: expected ${input.expected_sha256}, found ${fingerprint}`);
    }
    const occurrences = current.split(input.old_text).length - 1;
    if (occurrences === 0) throw new Error(`old_text not found in ${input.path}`);
    if (!input.replace_all && occurrences !== 1) {
      throw new Error(`old_text occurs ${occurrences} times in ${input.path}; provide more context or use replace_all`);
    }
    const next = input.replace_all
      ? current.replaceAll(input.old_text, input.new_text)
      : current.replace(input.old_text, input.new_text);
    await context.checkpoint.capture(path);
    await writeAtomic(path, next);
    const rel = relative(context.workspaceRoot, path);
    context.state.modifiedFiles.add(rel);
    context.state.revision += 1;
    delete context.state.completion;
    return { content: JSON.stringify({ path: rel, replacements: input.replace_all ? occurrences : 1, sha256: sha256(next) }) };
  },
});

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode;
  } catch {
    mode = undefined;
  }
  const temporary = `${path}.${process.pid}.kulmi-tmp`;
  await writeFile(temporary, content, "utf8");
  if (mode !== undefined) await chmod(temporary, mode);
  await rename(temporary, path);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
