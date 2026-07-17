import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

export interface SkillDefinition {
  name: string;
  description: string;
  path: string;
  source: "project" | "user";
}

const MAX_SKILL_BYTES = 256_000;

export function discoverSkills(workspaceRoot: string): SkillDefinition[] {
  const roots: Array<{ path: string; source: SkillDefinition["source"] }> = [
    { path: join(homedir(), ".config", "kulmi", "skills"), source: "user" },
    { path: join(workspaceRoot, ".agents", "skills"), source: "project" },
    { path: join(workspaceRoot, ".kulmi", "skills"), source: "project" },
  ];
  const skills = new Map<string, SkillDefinition>();
  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    for (const entry of readdirSync(root.path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = join(root.path, entry.name, "SKILL.md");
      if (!isContainedFile(root.path, path)) continue;
      let skill: SkillDefinition | undefined;
      try {
        const content = readSkillFile(path);
        const metadata = parseMetadata(content, entry.name);
        if (metadata) skill = { ...metadata, path, source: root.source };
      } catch {
        skill = undefined;
      }
      if (skill) skills.set(skill.name, skill);
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(skill: SkillDefinition): string {
  return readSkillFile(skill.path);
}

export function skillsPromptInventory(skills: SkillDefinition[]): string {
  if (skills.length === 0) return "No local skills were found.";
  return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
}

function readSkillFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid skill file ${path}`);
  if (stat.size > MAX_SKILL_BYTES) throw new Error(`skill exceeds ${MAX_SKILL_BYTES} bytes: ${path}`);
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

function parseMetadata(content: string, fallbackName: string): Pick<SkillDefinition, "name" | "description"> {
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
  const name = fields.get("name") ?? heading ?? basename(fallbackName);
  const description = fields.get("description") ?? paragraph?.replace(/\s+/g, " ").slice(0, 240) ?? "Local workflow instructions";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)) throw new Error(`invalid skill name ${name}`);
  return { name, description };
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
