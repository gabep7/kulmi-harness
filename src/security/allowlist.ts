import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  const words = request.command?.trim().split(/\s+/).filter(Boolean) ?? [];
  return words.length > 0
    ? { workspaceRoot, tool: request.tool, commandPrefix: words.slice(0, 2).join(" ") }
    : { workspaceRoot, tool: request.tool };
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

function isAllowlistEntry(value: unknown): value is AllowlistEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.workspaceRoot === "string" &&
    typeof record.tool === "string" &&
    (record.commandPrefix === undefined || typeof record.commandPrefix === "string");
}
