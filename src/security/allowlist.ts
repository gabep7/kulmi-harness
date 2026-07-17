import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "shell-quote";
import type { PermissionRequest } from "../tools/types.js";

export interface AllowlistEntry {
  workspaceRoot: string;
  tool: string;
  commandPrefix?: string;
}

export function allowlistPath(): string {
  const dataRoot = process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, "kulmi")
    : join(homedir(), ".local", "share", "kulmi");
  return join(dataRoot, "allowlist.json");
}

export function allowlistEntryFor(workspaceRoot: string, request: PermissionRequest): AllowlistEntry | undefined {
  if (request.risk === "high") return undefined;
  const command = request.command?.trim();
  if (!command) return { workspaceRoot, tool: request.tool };
  const commandPrefix = commandPrefixFor(command);
  if (commandPrefix === undefined) return undefined;
  return { workspaceRoot, tool: request.tool, commandPrefix };
}

export async function loadAllowlist(path = allowlistPath()): Promise<AllowlistEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAllowlistEntry).map((entry) => ({
      workspaceRoot: entry.workspaceRoot,
      tool: entry.tool,
      ...(entry.commandPrefix === undefined ? {} : { commandPrefix: entry.commandPrefix }),
    }));
  } catch {
    return [];
  }
}

export async function saveAllowlistEntry(entry: AllowlistEntry, path = allowlistPath()): Promise<void> {
  const entries = await loadAllowlist(path);
  if (entries.some((existing) =>
    existing.workspaceRoot === entry.workspaceRoot &&
    existing.tool === entry.tool &&
    existing.commandPrefix === entry.commandPrefix
  )) return;
  entries.push(entry);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

export function matchesAllowlist(
  entries: readonly AllowlistEntry[],
  workspaceRoot: string,
  request: PermissionRequest,
): boolean {
  const candidate = allowlistEntryFor(workspaceRoot, request);
  if (!candidate) return false;
  return entries.some((entry) =>
    entry.workspaceRoot === candidate.workspaceRoot &&
    entry.tool === candidate.tool &&
    entry.commandPrefix === candidate.commandPrefix
  );
}

/** First ≤2 argv words of the sole parsed shell command; undefined if multi-command or unparseable. */
function commandPrefixFor(command: string): string | undefined {
  let entries;
  try {
    entries = parse(command, (key) => `$${key}`);
  } catch {
    return undefined;
  }

  const argv: string[] = [];
  let skipNext = false;
  for (const entry of entries) {
    if (typeof entry === "string") {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      argv.push(entry);
      continue;
    }
    if ("comment" in entry) break;
    if (entry.op === "glob") {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      argv.push(entry.pattern);
      continue;
    }
    if ([">", ">>", ">&", "<"].includes(entry.op)) {
      skipNext = true;
      continue;
    }
    // Any control operator (&&, ||, |, ;, …) means a compound/chained command.
    return undefined;
  }
  if (argv.length === 0) return undefined;
  return argv.slice(0, 2).join(" ");
}

function isAllowlistEntry(value: unknown): value is AllowlistEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.workspaceRoot === "string" &&
    typeof record.tool === "string" &&
    (record.commandPrefix === undefined || typeof record.commandPrefix === "string");
}
