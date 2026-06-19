import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const names = ["AGENTS.md", "KULMI.md", "REASONIX.md"];

export interface LoadedInstructions {
  files: string[];
  content: string;
}

export function loadInstructions(workspaceRoot: string, cwd: string): LoadedInstructions {
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

  const files: string[] = [];
  const sections: string[] = [];
  for (const directory of directories) {
    const selected = names.map((name) => join(directory, name)).find(existsSync);
    if (!selected) continue;
    files.push(selected);
    sections.push(`## Instructions from ${selected}\n\n${readFileSync(selected, "utf8").trim()}`);
  }

  return { files, content: sections.join("\n\n") };
}
