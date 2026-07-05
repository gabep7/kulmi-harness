import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

export interface AgentDefinition {
  name: string;
  description: string;
  mode: "explore" | "review" | "implement";
  path: string;
  source: "project" | "user";
}

const MAX_AGENT_BYTES = 128_000;

export function discoverAgents(workspaceRoot: string): AgentDefinition[] {
  const roots: Array<{ path: string; source: AgentDefinition["source"] }> = [
    { path: join(homedir(), ".config", "kulmi", "agents"), source: "user" },
    { path: join(workspaceRoot, ".kulmi", "agents"), source: "project" },
    { path: join(workspaceRoot, ".agents", "agents"), source: "project" },
  ];
  const agents = new Map<string, AgentDefinition>();
  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    for (const entry of readdirSync(root.path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      if (!entry.name.endsWith(".md")) continue;
      const path = join(root.path, entry.name);
      if (!isContainedFile(root.path, path)) continue;
      const content = readAgentFile(path);
      const metadata = parseAgentMetadata(content, basename(entry.name, ".md"));
      agents.set(metadata.name, { ...metadata, path, source: root.source });
    }
  }
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function readAgentPrompt(agent: AgentDefinition): string {
  return readAgentFile(agent.path);
}

export function agentsPromptInventory(agents: AgentDefinition[]): string {
  if (agents.length === 0) return "No custom agents available.";
  return agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n");
}

function readAgentFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid agent file ${path}`);
  if (stat.size > MAX_AGENT_BYTES) throw new Error(`agent exceeds ${MAX_AGENT_BYTES} bytes: ${path}`);
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

function parseAgentMetadata(content: string, fallbackName: string): Omit<AgentDefinition, "path" | "source"> {
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
  const name = fields.get("name") ?? heading ?? fallbackName;
  const description = fields.get("description") ?? paragraph?.replace(/\s+/g, " ").slice(0, 240) ?? "Custom agent";
  const rawMode = fields.get("mode");
  const mode: AgentDefinition["mode"] = rawMode === "explore" || rawMode === "review" || rawMode === "implement" ? rawMode : "explore";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)) throw new Error(`invalid agent name ${name}`);
  return { name, description, mode };
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
