import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative } from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import { combineDiffs, createTextDiff } from "../core/diff.js";
import { assertNotSensitivePath, resolveWorkspacePath } from "../security/paths.js";
import { resolveToolBinary } from "../runtime/binaries.js";
import { defineTool, type AnyTool } from "./types.js";

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const summarizableSourceExtensions: Record<string, true> = {
  ".cjs": true,
  ".cts": true,
  ".js": true,
  ".jsx": true,
  ".mjs": true,
  ".mts": true,
  ".ts": true,
  ".tsx": true,
};

export function fileTools(): AnyTool[] {
  return [readFileTool, globTool, grepTool, writeFileTool, editFileTool, editFilesTool, deleteFileTool, replaceByLineRangeTool];
}

const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read UTF-8 file; mode='lines' for exact ranges.",
  schema: z.object({
    path: z.string().min(1),
    offset: z.number().int().positive().default(1),
    limit: z.number().int().positive().max(2_000).default(400),
    mode: z.enum(["summary", "lines"]).default("summary"),
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
    if (input.mode === "summary") {
      const summary = summarizeSource(input.path, content, lines, input.limit);
      if (summary) return { content: summary };
    }
    return {
      content: renderNumberedLines(content, lines, input.offset, input.limit),
    };
  },
});

function renderNumberedLines(content: string, lines: string[], offset: number, limit: number): string {
  const start = offset - 1;
  const selected = lines.slice(start, start + limit);
  const width = String(Math.min(lines.length, start + selected.length)).length;
  const rendered = selected
    .map((line, index) => `${String(start + index + 1).padStart(width)}\t${line}`)
    .join("\n");
  return `${rendered}\n\n[${selected.length} of ${lines.length} lines, sha256:${sha256(content)}]`;
}

function summarizeSource(path: string, content: string, lines: string[], limit: number): string | undefined {
  if (!summarizableSourceExtensions[extname(path)] || lines.length <= Math.min(limit, 160)) return undefined;
  const selected = selectStructuralLines(lines, limit);
  if (selected.length < 4) return undefined;
  const selectedSet = new Set(selected);
  const width = String(lines.length).length;
  const rendered: string[] = [];
  let previous = 0;
  for (const lineNumber of selected) {
    if (previous > 0 && lineNumber > previous + 1) rendered.push("…");
    rendered.push(`${String(lineNumber).padStart(width)}\t${lines[lineNumber - 1]}`);
    previous = lineNumber;
  }
  const ranges = elidedRanges(lines.length, selectedSet).slice(0, 8).join(", ");
  const truncated = selected.length >= limit ? "; summary truncated" : "";
  return `${rendered.join("\n")}\n\n[structural summary${truncated}; ${selected.length} of ${lines.length} lines shown; re-read exact ranges with mode='lines' and offset/limit; elided ranges: ${ranges}; sha256:${sha256(content)}]`;
}

function selectStructuralLines(lines: string[], limit: number): number[] {
  const selected = new Set<number>();
  for (let index = 0; index < lines.length && selected.size < limit; index++) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    if (!trimmed) continue;
    if (
      /^import\s/.test(trimmed) ||
      /^export\s+(?:type\s+)?\{/.test(trimmed) ||
      /^export\s+\*\s+from\s+/.test(trimmed)
    ) {
      if (selected.size < limit) selected.add(index + 1);
      continue;
    }
    if (indent === 0 && /^(?:export\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\b/.test(trimmed)) {
      if (selected.size < limit) selected.add(index + 1);
      continue;
    }
    if (indent === 0 && /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*/.test(trimmed)) {
      if (selected.size < limit) selected.add(index + 1);
      continue;
    }
    if (indent > 0 && indent <= 4 && /^(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*(?:[A-Za-z_$][\w$]*|#\w+)\s*[(:=]/.test(trimmed)) {
      if (selected.size < limit) selected.add(index + 1);
    }
  }
  return [...selected].sort((left, right) => left - right);
}

function elidedRanges(totalLines: number, selected: Set<number>): string[] {
  const ranges: string[] = [];
  let start: number | undefined;
  for (let line = 1; line <= totalLines; line++) {
    if (selected.has(line)) {
      if (start !== undefined) {
        ranges.push(start === line - 1 ? String(start) : `${start}-${line - 1}`);
        start = undefined;
      }
    } else {
      start ??= line;
    }
  }
  if (start !== undefined) ranges.push(start === totalLines ? String(start) : `${start}-${totalLines}`);
  return ranges;
}

const globTool = defineTool({
  name: "glob",
  description: "Find workspace files or directories by glob pattern. Results are sorted and symlinks are not followed.",
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
    if (!hasGlobMagic(input.pattern)) {
      try {
        const resolved = await resolveWorkspacePath({
          workspaceRoot: context.workspaceRoot,
          cwd,
          input: input.pattern,
          mustExist: true,
        });
        await lstat(resolved);
        assertNotSensitivePath(resolved);
        const workspaceRelative = relative(context.workspaceRoot, resolved);
        if (isIgnoredLiteralMatch(workspaceRelative)) return { content: "no matches" };
        return { content: relative(cwd, resolved) || "." };
      } catch {
        return { content: "no matches" };
      }
    }
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

function hasGlobMagic(pattern: string): boolean {
  return /[*?\[\]{}()!+@]/.test(pattern);
}

function isIgnoredLiteralMatch(path: string): boolean {
  if (path === ".git" || path.startsWith(".git/")) return true;
  return ["node_modules", "dist", "target"].some((directory) => path.startsWith(`${directory}/`));
}

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
    const binary = await resolveToolBinary("rg");
    if (!binary) {
      throw new Error("rg (ripgrep) binary not found. Install dependencies with npm install or add rg to PATH.");
    }
    const args = ["--line-number", "--color", "never", "--no-heading", "--max-count", String(input.limit)];
    if (input.glob) args.push("--glob", input.glob);
    args.push(
      "--glob", "!**/.env", "--glob", "!**/.env.*", "--glob", "!**/*.pem",
      "--glob", "!**/*.key", "--glob", "!**/.npmrc", "--glob", "!**/.pypirc",
    );
    if (input.fixed_strings) args.push("--fixed-strings");
    args.push("--", input.pattern, ".");
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let retainedBytes = 0;
    let truncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (retainedBytes >= context.maxOutputBytes) {
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      const remaining = context.maxOutputBytes - retainedBytes;
      const retained = chunk.subarray(0, remaining);
      chunks.push(retained);
      retainedBytes += retained.length;
      if (chunk.length > remaining) {
        truncated = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    const abort = () => child.kill("SIGTERM");
    context.signal.addEventListener("abort", abort, { once: true });
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }).finally(() => context.signal.removeEventListener("abort", abort));
    if (context.signal.aborted) throw context.signal.reason ?? new Error("grep aborted");
    if (!truncated && (code ?? 1) > 1) throw new Error(Buffer.concat(errors).toString("utf8") || `rg exited ${code}`);
    const lines = Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean);
    const limited = lines.slice(0, input.limit);
    const clipped = truncated || lines.length >= input.limit || signal === "SIGTERM";
    return { content: limited.length ? `${limited.join("\n")}${clipped ? "\n[truncated]" : ""}` : "no matches" };
  },
});

const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Create a UTF-8 text file, or replace one after read_file confirmation. Replacing requires its expected_sha256. Parent directories are created. Use edit_file for small changes.",
  schema: z.object({
    path: z.string().min(1),
    content: z.string(),
    expected_sha256: z.string().regex(/^[a-f0-9]{16}$/).optional(),
  }),
  readOnly: false,
  async execute(context, input) {
    if (context.autonomy === "read") throw new Error("write_file requires low autonomy or higher");
    const path = await resolveWorkspacePath({
      workspaceRoot: context.workspaceRoot,
      cwd: context.cwd,
      input: input.path,
    });
    assertNotSensitivePath(path);
    const previous = await readExistingText(path);
    if (previous.exists) {
      const fingerprint = sha256(previous.content);
      if (!input.expected_sha256) {
        throw new Error(`replacing ${input.path} requires expected_sha256 from read_file`);
      }
      if (input.expected_sha256 !== fingerprint) {
        throw new Error(`stale write for ${input.path}: expected ${input.expected_sha256}, found ${fingerprint}`);
      }
    }
    const rel = relative(context.workspaceRoot, path);
    if (previous.exists && previous.content === input.content) {
      return {
        content: JSON.stringify({ path: rel, unchanged: true, sha256: sha256(input.content) }),
        mutated: false,
      };
    }
    await context.checkpoint.capture(path);
    await writeAtomic(path, input.content);
    const diff = createTextDiff(rel, previous.content, input.content);
    context.state.modifiedFiles.add(rel);
    context.state.revision += 1;
    delete context.state.completion;
    return {
      content: JSON.stringify({
        path: rel,
        bytes: Buffer.byteLength(input.content),
        additions: diff?.additions ?? 0,
        deletions: diff?.deletions ?? 0,
        sha256: sha256(input.content),
      }),
      ...(diff ? { diff: diff.text } : {}),
    };
  },
});

const editFileTool = defineTool({
  name: "edit_file",
  description:
    "Replace exact text in one UTF-8 workspace file after read_file confirmation. By default old_text must occur exactly once.",
  schema: z.object({
    path: z.string().min(1),
    old_text: z.string().min(1),
    new_text: z.string(),
    expected_sha256: z.string().regex(/^[a-f0-9]{16}$/),
    replace_all: z.boolean().default(false),
    allow_stale_sha256: z.boolean().default(false),
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
    let staleRecoveryWarning: string | undefined;
    if (input.expected_sha256 !== fingerprint) {
      if (input.allow_stale_sha256 && current.includes(input.old_text)) {
        staleRecoveryWarning = `Warning: expected sha256 ${input.expected_sha256} is stale (found ${fingerprint}), but old_text was located in the current file content. Proceeding with edit.`;
      } else {
        throw new Error(`stale edit for ${input.path}: expected ${input.expected_sha256}, found ${fingerprint}`);
      }
    }
    const occurrences = current.split(input.old_text).length - 1;
    if (occurrences === 0) throw new Error(`old_text not found in ${input.path}`);
    if (!input.replace_all && occurrences !== 1) {
      throw new Error(`old_text occurs ${occurrences} times in ${input.path}; provide more context or use replace_all`);
    }
    const next = input.replace_all
      ? current.replaceAll(input.old_text, input.new_text)
      : current.replace(input.old_text, input.new_text);
    const rel = relative(context.workspaceRoot, path);
    if (next === current) {
      return {
        content: JSON.stringify({ path: rel, unchanged: true, sha256: fingerprint }),
        mutated: false,
      };
    }
    await context.checkpoint.capture(path);
    await writeAtomic(path, next);
    const actualContent = textDecoder.decode(await readFile(path));
    if (next !== actualContent) {
      throw new Error(`post-edit verification failed for ${input.path}: file content does not match expected state after write. This may indicate a concurrent modification.`);
    }
    const diff = createTextDiff(rel, current, next);
    context.state.modifiedFiles.add(rel);
    context.state.revision += 1;
    delete context.state.completion;
    const resultContent: Record<string, unknown> = {
      path: rel,
      replacements: input.replace_all ? occurrences : 1,
      additions: diff?.additions ?? 0,
      deletions: diff?.deletions ?? 0,
      sha256: sha256(actualContent),
    };
    if (staleRecoveryWarning) resultContent.warning = staleRecoveryWarning;
    return {
      content: JSON.stringify(resultContent),
      ...(diff ? { diff: diff.text } : {}),
    };
  },
});

const editFilesTool = defineTool({
  name: "edit_files",
  description:
    "Apply multiple exact replacements to one or more already-read UTF-8 files in one preflighted call. Each file requires its current read_file sha256. Use this instead of repeated edit_file calls.",
  schema: z.object({
    files: z.array(z.object({
      path: z.string().min(1),
      expected_sha256: z.string().regex(/^[a-f0-9]{16}$/),
      edits: z.array(z.object({
        old_text: z.string().min(1),
        new_text: z.string(),
        replace_all: z.boolean().default(false),
      })).min(1).max(20),
    })).min(1).max(20),
  }),
  readOnly: false,
  async execute(context, input) {
    if (context.autonomy === "read") throw new Error("edit_files requires low autonomy or higher");
    const paths = new Set<string>();
    const prepared: Array<{
      path: string;
      rel: string;
      current: string;
      next: string;
      replacements: number;
      diff: ReturnType<typeof createTextDiff>;
    }> = [];

    for (const file of input.files) {
      const path = await resolveWorkspacePath({
        workspaceRoot: context.workspaceRoot,
        cwd: context.cwd,
        input: file.path,
        mustExist: true,
      });
      assertNotSensitivePath(path);
      const rel = relative(context.workspaceRoot, path);
      if (paths.has(rel)) throw new Error(`duplicate edit_files path ${file.path}`);
      paths.add(rel);
      const current = textDecoder.decode(await readFile(path));
      const fingerprint = sha256(current);
      if (file.expected_sha256 !== fingerprint) {
        throw new Error(`stale edit for ${file.path}: expected ${file.expected_sha256}, found ${fingerprint}`);
      }
      const applied = applyReplacements(current, file.path, file.edits);
      prepared.push({
        path,
        rel,
        current,
        next: applied.content,
        replacements: applied.replacements,
        diff: createTextDiff(rel, current, applied.content),
      });
    }

    const changed = prepared.filter((file) => file.next !== file.current);
    if (changed.length === 0) {
      return {
        content: JSON.stringify({
          files: prepared.map((file) => ({ path: file.rel, unchanged: true, sha256: sha256(file.current) })),
          unchanged: true,
        }),
        mutated: false,
      };
    }

    for (const file of changed) await context.checkpoint.capture(file.path);
    const written: typeof changed = [];
    try {
      for (const file of changed) {
        await writeAtomic(file.path, file.next);
        written.push(file);
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const file of written.reverse()) {
        try {
          await writeAtomic(file.path, file.current);
        } catch (rollbackError) {
          rollbackErrors.push(`${file.rel}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(rollbackErrors.length > 0
        ? `edit_files failed: ${detail}; rollback failed for ${rollbackErrors.join(", ")}`
        : `edit_files failed before all writes completed: ${detail}`);
    }

    for (const file of changed) context.state.modifiedFiles.add(file.rel);
    context.state.revision += 1;
    delete context.state.completion;
    const diffs = changed.flatMap((file) => file.diff ? [file.diff.text] : []);
    const combinedDiff = combineDiffs(diffs);
    return {
      content: JSON.stringify({
        files: prepared.map((file) => ({
          path: file.rel,
          unchanged: file.next === file.current,
          replacements: file.replacements,
          additions: file.diff?.additions ?? 0,
          deletions: file.diff?.deletions ?? 0,
          sha256: sha256(file.next),
        })),
        changed_files: changed.length,
      }),
      ...(combinedDiff ? { diff: combinedDiff } : {}),
    };
  },
});

const replaceByLineRangeTool = defineTool({
  name: "replace_by_line_range",
  description:
    "Replace a line range in a file. Use with line numbers from read_file output. start_line and end_line are inclusive and 1-indexed.",
  schema: z.object({
    path: z.string().min(1),
    start_line: z.number().int().min(1),
    end_line: z.number().int().min(1),
    new_text: z.string(),
    expected_sha256: z.string().regex(/^[a-f0-9]{16}$/),
    allow_stale_sha256: z.boolean().default(false),
  }),
  readOnly: false,
  async execute(context, input) {
    if (context.autonomy === "read") throw new Error("replace_by_line_range requires low autonomy or higher");
    const path = await resolveWorkspacePath({
      workspaceRoot: context.workspaceRoot,
      cwd: context.cwd,
      input: input.path,
      mustExist: true,
    });
    assertNotSensitivePath(path);
    const current = textDecoder.decode(await readFile(path));
    const fingerprint = sha256(current);
    let staleRecoveryWarning: string | undefined;
    if (input.expected_sha256 !== fingerprint) {
      if (input.allow_stale_sha256) {
        staleRecoveryWarning = `Warning: expected sha256 ${input.expected_sha256} is stale (found ${fingerprint}). Proceeding with replace_by_line_range despite stale hash.`;
      } else {
        throw new Error(`stale edit for ${input.path}: expected ${input.expected_sha256}, found ${fingerprint}`);
      }
    }
    const lines = current.split("\n");
    if (input.start_line < 1) throw new Error(`start_line must be >= 1`);
    if (input.end_line > lines.length) throw new Error(`end_line ${input.end_line} exceeds file length ${lines.length}`);
    if (input.start_line > input.end_line) throw new Error(`start_line ${input.start_line} > end_line ${input.end_line}`);
    const replacement = input.new_text.split("\n");
    const before = lines.slice(0, input.start_line - 1);
    const after = lines.slice(input.end_line);
    const next = [...before, ...replacement, ...after].join("\n");
    const rel = relative(context.workspaceRoot, path);
    if (next === current) {
      return {
        content: JSON.stringify({ path: rel, unchanged: true, sha256: fingerprint }),
        mutated: false,
      };
    }
    await context.checkpoint.capture(path);
    await writeAtomic(path, next);
    const actualContent = textDecoder.decode(await readFile(path));
    if (next !== actualContent) {
      throw new Error(`post-edit verification failed for ${input.path}: file content does not match expected state after write. This may indicate a concurrent modification.`);
    }
    const diff = createTextDiff(rel, current, next);
    context.state.modifiedFiles.add(rel);
    context.state.revision += 1;
    delete context.state.completion;
    const resultContent: Record<string, unknown> = {
      path: rel,
      replacements: 1,
      additions: diff?.additions ?? 0,
      deletions: diff?.deletions ?? 0,
      sha256: sha256(actualContent),
    };
    if (staleRecoveryWarning) resultContent.warning = staleRecoveryWarning;
    return {
      content: JSON.stringify(resultContent),
      ...(diff ? { diff: diff.text } : {}),
    };
  },
});

const deleteFileTool = defineTool({
  name: "delete_file",
  description:
    "Delete one regular workspace file after read_file confirmation. expected_sha256 is required to reject stale deletion. Shell deletion remains blocked.",
  schema: z.object({
    path: z.string().min(1),
    expected_sha256: z.string().regex(/^[a-f0-9]{16}$/),
  }),
  readOnly: false,
  async execute(context, input) {
    if (context.autonomy === "read") throw new Error("delete_file requires low autonomy or higher");
    const path = await resolveWorkspacePath({
      workspaceRoot: context.workspaceRoot,
      cwd: context.cwd,
      input: input.path,
    });
    assertNotSensitivePath(path);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${input.path} is not a regular file`);
    const content = await readFile(path);
    const fingerprint = sha256(content);
    if (input.expected_sha256 !== fingerprint) {
      throw new Error(`stale deletion for ${input.path}: expected ${input.expected_sha256}, found ${fingerprint}`);
    }
    await context.checkpoint.capture(path);
    await unlink(path);
    const rel = relative(context.workspaceRoot, path);
    let diff;
    try {
      diff = createTextDiff(rel, textDecoder.decode(content), "");
    } catch {
      diff = undefined;
    }
    context.state.modifiedFiles.add(rel);
    context.state.revision += 1;
    delete context.state.completion;
    return {
      content: JSON.stringify({ path: rel, deleted: true, sha256: fingerprint }),
      ...(diff ? { diff: diff.text } : {}),
    };
  },
});

async function readExistingText(path: string): Promise<{ exists: boolean; content: string }> {
  try {
    return { exists: true, content: textDecoder.decode(await readFile(path)) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { exists: false, content: "" };
    }
    throw error;
  }
}

function applyReplacements(
  initial: string,
  path: string,
  edits: Array<{ old_text: string; new_text: string; replace_all: boolean }>,
): { content: string; replacements: number } {
  let content = initial;
  let replacements = 0;
  for (const [index, edit] of edits.entries()) {
    const occurrences = content.split(edit.old_text).length - 1;
    if (occurrences === 0) throw new Error(`edit ${index + 1} old_text not found in ${path}`);
    if (!edit.replace_all && occurrences !== 1) {
      throw new Error(`edit ${index + 1} old_text occurs ${occurrences} times in ${path}; provide more context or use replace_all`);
    }
    content = edit.replace_all
      ? content.replaceAll(edit.old_text, edit.new_text)
      : content.replace(edit.old_text, edit.new_text);
    replacements += edit.replace_all ? occurrences : 1;
  }
  return { content, replacements };
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode;
  } catch {
    mode = undefined;
  }
  const temporary = `${path}.${process.pid}.kulmi-tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
