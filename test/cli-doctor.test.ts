import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const tsxLoader = resolve("node_modules/tsx/dist/loader.mjs");

describe("kulmi doctor", () => {
  it("reports bundled code-intelligence tool readiness", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "kulmi-doctor-"));
    await exec("git", ["init", root]);
    await mkdir(resolve(root, ".kulmi"));
    await writeFile(resolve(root, ".kulmi", "config.toml"), "[sandbox]\nmode = \"off\"\n", "utf8");

    const { stdout } = await exec(process.execPath, ["--import", tsxLoader, resolve("src/cli.ts"), "doctor"], {
      cwd: root,
      env: { ...process.env, MIMO_API_KEY: "sk-1234567" },
    });

    expect(stdout).toContain("ok\tast-grep\t");
    expect(stdout).toContain("ok\tlsp\t");
    expect(stdout).toContain("ok\tripgrep\t");
  }, 15_000);
});
