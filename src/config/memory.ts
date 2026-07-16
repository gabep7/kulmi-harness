import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

export interface MemoryDefinition {
  name: string;
  preview: string;
  tags: string[];
  importance: MemoryImportance;
  path: string;
  source: "project" | "user";
}

export type MemoryImportance = "low" | "normal" | "high";

export const MEMORY_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
export const MAX_MEMORY_BYTES = 128_000;
const MAX_INVENTORY_ENTRIES = 40;
const importanceRank: Record<MemoryImportance, number> = { high: 0, normal: 1, low: 2 };

export function projectMemoryDirectory(workspaceRoot: string): string {
  return join(workspaceRoot, ".kulmi", "memory");
}

export function discoverMemory(workspaceRoot: string): MemoryDefinition[] {
  const roots: Array<{ path: string; source: MemoryDefinition["source"] }> = [
    { path: join(homedir(), ".config", "kulmi", "memory"), source: "user" },
    { path: join(workspaceRoot, ".agents", "memory"), source: "project" },
    { path: projectMemoryDirectory(workspaceRoot), source: "project" },
  ];
  const memories = new Map<string, MemoryDefinition>();
  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    for (const entry of readdirSync(root.path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      const path = join(root.path, entry.name);
      if (!isContainedFile(root.path, path)) continue;
      let memory: MemoryDefinition | undefined;
      try {
        const content = readMemoryFile(path);
        const metadata = parseMemoryMetadata(content, basename(entry.name, ".md"));
        if (metadata) memory = { ...metadata, path, source: root.source };
      } catch {
        memory = undefined;
      }
      if (memory) memories.set(memory.name, memory);
    }
  }
  return [...memories.values()].sort((a, b) => {
    const rankDiff = importanceRank[a.importance] - importanceRank[b.importance];
    if (rankDiff !== 0) return rankDiff;
    return a.name.localeCompare(b.name);
  });
}

export function readMemory(memory: MemoryDefinition): string {
  return readMemoryFile(memory.path);
}

export function formatMemoryLine(memory: MemoryDefinition): string {
  const tagSuffix = memory.tags.length > 0 ? ` [${memory.tags.join(", ")}]` : "";
  const importanceTag = memory.importance === "high" ? "★ " : memory.importance === "low" ? "↓ " : "";
  return `${importanceTag}${memory.name}${tagSuffix}: ${memory.preview}`;
}

export function memoryPromptInventory(memories: MemoryDefinition[]): string {
  if (memories.length === 0) return "No memory files were found.";
  const shown = memories.slice(0, MAX_INVENTORY_ENTRIES);
  const lines = shown.map((memory) => `- ${formatMemoryLine(memory)}`);
  if (memories.length > shown.length) {
    lines.push(`…and ${memories.length - shown.length} more; use list_memory to see all.`);
  }
  return lines.join("\n");
}

function readMemoryFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid memory file ${path}`);
  if (stat.size > MAX_MEMORY_BYTES) throw new Error(`memory exceeds ${MAX_MEMORY_BYTES} bytes: ${path}`);
  return readFileSync(path, "utf8");
}

function isContainedFile(root: string, path: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const realPath = realpathSync(path);
    const rel = relative(realRoot, realPath);
    return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !resolve(realPath).includes(`${sep}.git${sep}`);
  } catch {
    return false;
  }
}

function parseMemoryMetadata(content: string, fallbackName: string): Omit<MemoryDefinition, "path" | "source"> | undefined {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  const fields = new Map<string, string>();
  for (const line of frontmatter?.[1]?.split("\n") ?? []) {
    const match = line.match(/^([a-zA-Z_][\w-]*):\s*(.+?)\s*$/);
    if (match) fields.set(match[1]!.toLowerCase(), unquote(match[2]!));
  }
  const body = frontmatter ? content.slice(frontmatter[0].length) : content;
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const paragraph = body
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#+\s+.*$/gm, "").trim())
    .find(Boolean);
  const name = normalizeName(fields.get("name")) ?? normalizeName(heading) ?? normalizeName(fallbackName);
  if (!name) return undefined;
  const preview = fields.get("preview") ?? paragraph?.replace(/\s+/g, " ").slice(0, 200) ?? "Memory entry";
  const tags = parseTags(fields.get("tags"));
  const importance = parseImportance(fields.get("importance"));
  return { name, preview, tags, importance };
}

function normalizeName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = value
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .replace(/^[._-]+/, "")
    .slice(0, 80);
  return MEMORY_NAME_PATTERN.test(candidate) ? candidate : undefined;
}

function parseTags(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0)
    .slice(0, 10);
}

function parseImportance(value: string | undefined): MemoryImportance {
  if (value === "high" || value === "low") return value;
  return "normal";
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
