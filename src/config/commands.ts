import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

export interface CommandDefinition {
  name: string;
  preview: string;
  template: string;
  path: string;
  source: "project" | "user";
}

export const COMMAND_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;
export const MAX_COMMAND_BYTES = 64_000;

export function projectCommandsDirectory(workspaceRoot: string): string {
  return join(workspaceRoot, ".kulmi", "commands");
}

export function discoverCommands(workspaceRoot: string): CommandDefinition[] {
  const roots: Array<{ path: string; source: CommandDefinition["source"] }> = [
    { path: join(homedir(), ".config", "kulmi", "commands"), source: "user" },
    { path: projectCommandsDirectory(workspaceRoot), source: "project" },
  ];
  const commands = new Map<string, CommandDefinition>();
  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    for (const entry of readdirSync(root.path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      const name = basename(entry.name, ".md");
      if (!COMMAND_NAME_PATTERN.test(name)) continue;
      const path = join(root.path, entry.name);
      if (!isContainedFile(root.path, path)) continue;
      let command: CommandDefinition | undefined;
      try {
        const template = readCommandFile(path);
        const preview = template
          .split("\n")
          .map((line) => line.replace(/^#+\s*/, "").trim())
          .find(Boolean)
          ?.slice(0, 60) ?? "custom command";
        command = { name, preview, template, path, source: root.source };
      } catch {
        command = undefined;
      }
      if (command) commands.set(command.name, command);
    }
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandCommand(template: string, argumentsText: string): string {
  return template.split("$ARGUMENTS").join(argumentsText);
}

function readCommandFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid command file ${path}`);
  if (stat.size > MAX_COMMAND_BYTES) throw new Error(`command exceeds ${MAX_COMMAND_BYTES} bytes: ${path}`);
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
