import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const names = ["AGENTS.md", "KULMI.md"];

const MAX_IMPORT_DEPTH = 3;
const MAX_IMPORT_BYTES = 32_768;

export interface LoadedInstructions {
  files: string[];
  content: string;
}

function findImportToken(line: string): string | undefined {
  const m = /^(?:[ \t]|^)@([~./][^\s`'"<>|;{}()[\]]+)/m.exec(line);
  return m?.[1];
}

async function expandImports(
  content: string,
  sourcePath: string,
  depth: number,
  budget: number,
  visited: ReadonlySet<string>,
): Promise<{ text: string; bytesUsed: number }> {
  if (depth <= 0 || budget <= 0) return { text: content, bytesUsed: 0 };

  const dir = dirname(sourcePath);
  const lines = content.split("\n");
  let inFence = false;
  let totalBytes = 0;
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
    }

    if (inFence) {
      const lb = Buffer.byteLength(line, "utf8") + 1;
      totalBytes += lb;
      if (totalBytes > budget) {
        result.push(line);
        for (let j = i + 1; j < lines.length; j++) result.push(lines[j]!);
        return { text: result.join("\n"), bytesUsed: totalBytes };
      }
      result.push(line);
      continue;
    }

    const token = findImportToken(line);
    if (!token) {
      const lb = Buffer.byteLength(line, "utf8") + 1;
      totalBytes += lb;
      if (totalBytes > budget) {
        result.push(line);
        for (let j = i + 1; j < lines.length; j++) result.push(lines[j]!);
        return { text: result.join("\n"), bytesUsed: totalBytes };
      }
      result.push(line);
      continue;
    }

    // Resolve path
    const resolved = token.startsWith("~")
      ? resolve(join(homedir(), token.slice(1)))
      : resolve(join(dir, token));

    // Cycle detection
    if (visited.has(resolved)) {
      const lb = Buffer.byteLength(line, "utf8") + 1;
      totalBytes += lb;
      result.push(line);
      continue;
    }

    // Missing file — leave as-is
    if (!existsSync(resolved)) {
      const lb = Buffer.byteLength(line, "utf8") + 1;
      totalBytes += lb;
      result.push(line);
      continue;
    }

    // Read and expand
    try {
      const fileContent = (await readFile(resolved, "utf8")).trimEnd();
      const fileBytes = Buffer.byteLength(fileContent, "utf8");
      const remaining = budget - totalBytes;

      // If the file alone exceeds remaining budget, skip expansion
      if (fileBytes > remaining) {
        const lb = Buffer.byteLength(line, "utf8") + 1;
        totalBytes += lb;
        result.push(line);
        continue;
      }

      const newVisited = new Set(visited);
      newVisited.add(resolved);
      const { text: expandedText, bytesUsed } = await expandImports(
        fileContent,
        resolved,
        depth - 1,
        remaining - fileBytes,
        newVisited,
      );

      const consumed = fileBytes + bytesUsed;
      if (consumed > remaining) {
        // Expanded content exceeds budget — leave unexpanded
        const lb = Buffer.byteLength(line, "utf8") + 1;
        totalBytes += lb;
        result.push(line);
      } else {
        totalBytes += consumed;
        result.push(expandedText);
      }
    } catch {
      const lb = Buffer.byteLength(line, "utf8") + 1;
      totalBytes += lb;
      result.push(line);
    }
  }

  return { text: result.join("\n"), bytesUsed: totalBytes };
}

export async function loadInstructions(workspaceRoot: string, cwd: string): Promise<LoadedInstructions> {
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
    const raw = (await readFile(selected, "utf8")).trim();
    const { text } = await expandImports(raw, selected, MAX_IMPORT_DEPTH, MAX_IMPORT_BYTES, new Set([selected]));
    sections.push(`## Instructions from ${selected}\n\n${text}`);
  }

  return { files, content: sections.join("\n\n") };
}
