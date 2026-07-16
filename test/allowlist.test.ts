import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowlistEntryFor,
  loadAllowlist,
  matchesAllowlist,
  saveAllowlistEntry,
} from "../src/security/allowlist.js";
import type { PermissionRequest } from "../src/tools/types.js";

describe("permission allowlist", () => {
  it("derives entries from commands, short commands, and non-command tools", () => {
    expect(allowlistEntryFor("/repo", request({ command: "git push origin main" }))).toEqual({
      workspaceRoot: "/repo",
      tool: "shell",
      commandPrefix: "git push",
    });
    expect(allowlistEntryFor("/repo", request({ command: "ls" }))).toEqual({
      workspaceRoot: "/repo",
      tool: "shell",
      commandPrefix: "ls",
    });
    expect(allowlistEntryFor("/repo", request({ tool: "write_file" }))).toEqual({
      workspaceRoot: "/repo",
      tool: "write_file",
    });
  });

  it("never derives or matches entries for high risk requests", async () => {
    expect(allowlistEntryFor("/repo", request({ command: "git push", risk: "high" }))).toBeUndefined();
    const path = await allowlistFile();
    await saveAllowlistEntry({ workspaceRoot: "/repo", tool: "shell", commandPrefix: "git push" }, path);
    const entries = await loadAllowlist(path);
    expect(matchesAllowlist(entries, "/repo", request({ command: "git push origin main", risk: "high" }))).toBe(false);
    expect(matchesAllowlist(entries, "/repo", request({ command: "git push origin main" }))).toBe(true);
  });

  it("matches by two-word command prefix within the recorded workspace only", async () => {
    const path = await allowlistFile();
    await saveAllowlistEntry({ workspaceRoot: "/repo", tool: "shell", commandPrefix: "npm test" }, path);
    const entries = await loadAllowlist(path);
    expect(matchesAllowlist(entries, "/repo", request({ command: "npm test --watch" }))).toBe(true);
    expect(matchesAllowlist(entries, "/repo", request({ command: "npm  test" }))).toBe(true);
    expect(matchesAllowlist(entries, "/repo", request({ command: "npm install" }))).toBe(false);
    expect(matchesAllowlist(entries, "/other", request({ command: "npm test --watch" }))).toBe(false);
    expect(matchesAllowlist(entries, "/repo", request({ tool: "shell" }))).toBe(false);
  });

  it("matches non-command tools by name and workspace", async () => {
    const path = await allowlistFile();
    await saveAllowlistEntry({ workspaceRoot: "/repo", tool: "write_file" }, path);
    const entries = await loadAllowlist(path);
    expect(matchesAllowlist(entries, "/repo", request({ tool: "write_file" }))).toBe(true);
    expect(matchesAllowlist(entries, "/repo", request({ tool: "edit_file" }))).toBe(false);
    expect(matchesAllowlist(entries, "/other", request({ tool: "write_file" }))).toBe(false);
  });

  it("persists entries once and tolerates corrupt files", async () => {
    const path = await allowlistFile();
    await saveAllowlistEntry({ workspaceRoot: "/repo", tool: "shell", commandPrefix: "git status" }, path);
    await saveAllowlistEntry({ workspaceRoot: "/repo", tool: "shell", commandPrefix: "git status" }, path);
    const stored: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(stored).toEqual([{ workspaceRoot: "/repo", tool: "shell", commandPrefix: "git status" }]);

    await writeFile(path, "not json", "utf8");
    await expect(loadAllowlist(path)).resolves.toEqual([]);
    await writeFile(path, JSON.stringify([{ workspaceRoot: "/repo" }, { workspaceRoot: "/repo", tool: "shell" }]), "utf8");
    await expect(loadAllowlist(path)).resolves.toEqual([{ workspaceRoot: "/repo", tool: "shell" }]);
    await expect(loadAllowlist(join(tmpdir(), "kulmi-allowlist-missing", "allowlist.json"))).resolves.toEqual([]);
  });
});

function request(overrides: Partial<PermissionRequest>): PermissionRequest {
  return { tool: "shell", risk: "medium", reason: "test", input: {}, ...overrides };
}

async function allowlistFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kulmi-allowlist-"));
  return join(root, "data", "allowlist.json");
}
