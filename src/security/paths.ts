import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export async function resolveWorkspacePath(options: {
  workspaceRoot: string;
  cwd: string;
  input: string;
  mustExist?: boolean;
}): Promise<string> {
  const lexicalRoot = resolve(options.workspaceRoot);
  const root = await realpath(lexicalRoot);
  const candidate = resolve(options.cwd, options.input);
  assertWithin(lexicalRoot, candidate);

  if (options.mustExist) {
    const resolved = await realpath(candidate);
    assertWithin(root, resolved);
    return resolved;
  }

  let existing = candidate;
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) throw new Error(`cannot resolve parent for ${options.input}`);
      existing = parent;
    }
  }
  const resolvedParent = await realpath(existing);
  assertWithin(root, resolvedParent);
  return candidate;
}

export function assertWithin(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error(`path is outside workspace: ${path}`);
}

export function assertNotSensitivePath(path: string): void {
  const name = basename(path).toLowerCase();
  const allowedExample = name.endsWith(".example") || name.endsWith(".sample") || name.endsWith(".template");
  if (allowedExample) return;
  if (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".npmrc" ||
    name === ".pypirc" ||
    name === "credentials.json" ||
    name === "service-account.json" ||
    name === "id_rsa" ||
    name === "id_ed25519" ||
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    /^secrets?\./.test(name)
  ) {
    throw new Error(`sensitive file access is blocked without an approval flow: ${path}`);
  }
}
