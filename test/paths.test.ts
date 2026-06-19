import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNotSensitivePath, resolveWorkspacePath } from "../src/security/paths.js";

describe("workspace path guard", () => {
  it("rejects traversal and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-path-root-"));
    const outside = await mkdtemp(join(tmpdir(), "kulmi-path-outside-"));
    await mkdir(join(root, "src"));
    await writeFile(join(outside, "secret"), "nope");
    await symlink(outside, join(root, "escape"));

    await expect(resolveWorkspacePath({
      workspaceRoot: root,
      cwd: root,
      input: "../outside",
    })).rejects.toThrow("outside workspace");
    await expect(resolveWorkspacePath({
      workspaceRoot: root,
      cwd: root,
      input: "escape/secret",
      mustExist: true,
    })).rejects.toThrow("outside workspace");
    await expect(resolveWorkspacePath({
      workspaceRoot: root,
      cwd: root,
      input: "src/new.ts",
    })).resolves.toBe(join(root, "src", "new.ts"));
  });

  it("blocks common credential files but permits templates", () => {
    expect(() => assertNotSensitivePath("/repo/.env")).toThrow("sensitive file access");
    expect(() => assertNotSensitivePath("/repo/server.pem")).toThrow("sensitive file access");
    expect(() => assertNotSensitivePath("/repo/.env.example")).not.toThrow();
  });
});
