import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  workspaceRoot: string,
  depth: number,
  budget: number,
  visited: ReadonlySet<string>,
): Promise<{ text: string; bytesUsed: number }> {
  if (depth <= 0 || budget <= 0) {
    return { text: content, bytesUsed: Buffer.byteLength(content, "utf8") };
  }

  const dir = dirname(sourcePath);
  const lines = content.split("\n");
  let inFence = false;
  let totalBytes = 0;
  const result: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineBytes = Buffer.byteLength(line, "utf8") + (index < lines.length - 1 ? 1 : 0);
    if (/^\s*```/.test(line)) inFence = !inFence;
    const token = inFence ? undefined : findImportToken(line);
    if (!token) {
      totalBytes += lineBytes;
      result.push(line);
      continue;
    }

    const resolved = token.startsWith("~")
      ? resolve(join(homedir(), token.slice(1)))
      : resolve(dir, token);
    if (visited.has(resolved) || !existsSync(resolved) || !await isWorkspaceFile(workspaceRoot, resolved)) {
      totalBytes += lineBytes;
      result.push(line);
      continue;
    }

    try {
      const fileContent = (await readFile(resolved, "utf8")).trimEnd();
      const remaining = budget - totalBytes;
      if (remaining <= 0 || Buffer.byteLength(fileContent, "utf8") > remaining) {
        totalBytes += lineBytes;
        result.push(line);
        continue;
      }
      const newVisited = new Set(visited);
      newVisited.add(resolved);
      const expanded = await expandImports(
        fileContent,
        resolved,
        workspaceRoot,
        depth - 1,
        remaining,
        newVisited,
      );
      if (expanded.bytesUsed > remaining) {
        totalBytes += lineBytes;
        result.push(line);
      } else {
        totalBytes += expanded.bytesUsed;
        result.push(expanded.text);
      }
    } catch {
      totalBytes += lineBytes;
      result.push(line);
    }
  }

  return { text: result.join("\n"), bytesUsed: totalBytes };
}

async function isWorkspaceFile(workspaceRoot: string, path: string): Promise<boolean> {
  try {
    const [realRoot, realPath] = await Promise.all([realpath(workspaceRoot), realpath(path)]);
    const rel = relative(realRoot, realPath);
    return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.split(sep).includes(".git");
  } catch {
    return false;
  }
}

function isContainedPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export async function loadInstructions(workspaceRoot: string, cwd: string): Promise<LoadedInstructions> {
  const root = await realpath(resolve(workspaceRoot));
  let cursor = resolve(cwd);
  const directories: string[] = [];

  while (isContainedPath(root, cursor)) {
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
    if (!selected || !await isWorkspaceFile(root, selected)) continue;
    files.push(selected);
    const raw = (await readFile(selected, "utf8")).trim();
    const { text } = await expandImports(
      raw,
      selected,
      root,
      MAX_IMPORT_DEPTH,
      MAX_IMPORT_BYTES,
      new Set([selected]),
    );
    sections.push(`## Instructions from ${selected}\n\n${text}`);
  }

  return { files, content: sections.join("\n\n") };
}
