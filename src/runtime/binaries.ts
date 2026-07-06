import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export async function resolveToolBinary(binary: string, startDirectory = moduleDirectory): Promise<string | undefined> {
  return await findLocalBinary(binary, startDirectory) ?? await findPathBinary(binary, process.env.PATH ?? "");
}

async function findLocalBinary(binary: string, startDirectory: string): Promise<string | undefined> {
  let current = startDirectory;
  const root = parse(current).root;
  while (true) {
    const candidate = join(current, "node_modules", ".bin", binary);
    if (await canExecute(candidate)) return candidate;
    if (current === root) return undefined;
    current = dirname(current);
  }
}

async function findPathBinary(binary: string, pathValue: string): Promise<string | undefined> {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, binary);
    if (await canExecute(candidate)) return candidate;
  }
  return undefined;
}

async function canExecute(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
