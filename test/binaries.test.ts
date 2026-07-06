import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveToolBinary } from "../src/runtime/binaries.js";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("resolveToolBinary", () => {
  it("finds package-local binaries from nested runtime modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-binary-local-"));
    const nested = join(root, "dist", "tools");
    const binDir = join(root, "node_modules", ".bin");
    await mkdir(nested, { recursive: true });
    await mkdir(binDir, { recursive: true });
    const binary = join(binDir, "kulmi-local-tool");
    await writeFile(binary, "#!/bin/sh\n", "utf8");
    await chmod(binary, 0o755);

    await expect(resolveToolBinary("kulmi-local-tool", nested)).resolves.toBe(binary);
  });

  it("falls back to PATH when no package-local binary exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-binary-root-"));
    const pathDir = await mkdtemp(join(tmpdir(), "kulmi-binary-path-"));
    const binary = join(pathDir, "kulmi-path-tool");
    await writeFile(binary, "#!/bin/sh\n", "utf8");
    await chmod(binary, 0o755);
    process.env.PATH = pathDir;

    await expect(resolveToolBinary("kulmi-path-tool", root)).resolves.toBe(binary);
  });
});
