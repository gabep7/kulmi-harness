import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export interface RuleDefinition {
  name: string;
  description: string;
  globs?: string;
  alwaysApply: boolean;
  path: string;
  source: "project" | "user";
}

export const MAX_RULE_BYTES = 128_000;

export function discoverRules(workspaceRoot: string): RuleDefinition[] {
  const roots: Array<{ path: string; source: RuleDefinition["source"] }> = [
    { path: join(homedir(), ".config", "kulmi", "rules"), source: "user" },
    { path: join(workspaceRoot, ".kulmi", "rules"), source: "project" },
    { path: join(workspaceRoot, ".agents", "rules"), source: "project" },
  ];
  const rules = new Map<string, RuleDefinition>();
  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    for (const entry of readdirSync(root.path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      if (!entry.name.endsWith(".md")) continue;
      const path = join(root.path, entry.name);
      if (!isContainedFile(root.path, path)) continue;
      let rule: RuleDefinition | undefined;
      try {
        const content = readRuleFile(path);
        const metadata = parseRuleMetadata(content, basename(entry.name, ".md"));
        if (metadata) rule = { ...metadata, path, source: root.source };
      } catch {
        rule = undefined;
      }
      if (rule) rules.set(rule.name, rule);
    }
  }
  return [...rules.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function readRule(rule: RuleDefinition): string {
  return readRuleFile(rule.path);
}

export function rulesPromptInventory(rules: RuleDefinition[]): string {
  const onDemand = rules.filter((r) => !r.alwaysApply);
  if (onDemand.length === 0) return "No rulebook rules were found.";
  return onDemand.map((rule) => `- ${rule.name}: ${rule.description}`).join("\n");
}

export function loadStickyRules(workspaceRoot: string, cwd: string): { files: string[]; content: string } {
  const root = resolve(workspaceRoot);
  let cursor = resolve(cwd);
  const directories: string[] = [];

  while (cursor.startsWith(root)) {
    directories.unshift(cursor);
    if (cursor === root) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  const stickyNames = ["RULES.md"];
  const files: string[] = [];
  const sections: string[] = [];

  for (const directory of directories) {
    const selected = stickyNames.map((name) => join(directory, name)).find(existsSync);
    if (!selected) continue;
    files.push(selected);
    sections.push(`## Rules from ${selected}\n\n${readFileSync(selected, "utf8").trim()}`);
  }

  const userRulesMd = join(homedir(), ".config", "kulmi", "RULES.md");
  if (existsSync(userRulesMd) && !files.includes(userRulesMd)) {
    files.push(userRulesMd);
    sections.push(`## Rules from ${userRulesMd}\n\n${readFileSync(userRulesMd, "utf8").trim()}`);
  }

  return { files, content: sections.join("\n\n") };
}

export function parseRuleMetadata(content: string, fallbackName: string): Pick<RuleDefinition, "name" | "description" | "globs" | "alwaysApply"> {
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
  const description = fields.get("description") ?? paragraph?.replace(/\s+/g, " ").slice(0, 240) ?? "Project rule";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)) throw new Error(`invalid rule name ${name}`);

  const globsRaw = fields.get("globs");
  let globs: string | undefined;
  if (globsRaw) {
    globs = globsRaw
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean)
      .join(", ");
  }

  const alwaysApplyRaw = fields.get("alwaysapply");
  const alwaysApply = alwaysApplyRaw === "true" || alwaysApplyRaw === "yes" || alwaysApplyRaw === "1";

  const result: { name: string; description: string; globs?: string; alwaysApply: boolean } = { name, description, alwaysApply };
  if (globs) result.globs = globs;
  return result;
}

function readRuleFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid rule file ${path}`);
  if (stat.size > MAX_RULE_BYTES) throw new Error(`rule exceeds ${MAX_RULE_BYTES} bytes: ${path}`);
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

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
