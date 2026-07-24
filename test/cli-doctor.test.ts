import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_API_KEY_ENV, writeTestModelConfig } from "./helpers/test-config.js";

const exec = promisify(execFile);
const tsxLoader = resolve("node_modules/tsx/dist/loader.mjs");

describe("kulmi doctor", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it("reports bundled code-intelligence tool readiness", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "kulmi-doctor-"));
    const home = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    process.env.HOME = home;
    await exec("git", ["init", root]);
    await writeTestModelConfig(root);

    const { stdout } = await exec(process.execPath, ["--import", tsxLoader, resolve("src/cli.ts"), "doctor"], {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        [TEST_API_KEY_ENV]: "sk-1234567",
      },
    });

    expect(stdout).toContain("ok\tast-grep\t");
    expect(stdout).toContain("ok\tlsp\t");
    expect(stdout).toContain("ok\tripgrep\t");
  }, 15_000);
});
