import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const runner = join(repoRoot, "evals", "run.mjs");
const fakeBin = join(repoRoot, "test", "fixtures", "fake-eval-bin.mjs");

interface EvalResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runEvals(args: string[], env: Record<string, string>): Promise<EvalResult> {
  const { promise, resolve } = Promise.withResolvers<EvalResult>();
  execFile(process.execPath, [runner, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
    const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
    resolve({ code: exitCode, stdout, stderr });
  });
  return promise;
}

describe("evals runner", () => {
  beforeAll(async () => {
    await chmod(fakeBin, 0o755);
  });

  it("reports pass and exits zero for a task the fake bin solves", async () => {
    const result = await runEvals(["--task", "fix-failing-test"], {
      KULMI_EVAL_BIN: fakeBin,
      KULMI_FAKE_SOLVE: "fix-failing-test",
    });
    expect(result.stdout).toContain("fix-failing-test pass");
    expect(result.stdout).toContain("passed 1/1");
    expect(result.code).toBe(0);
  }, 30_000);

  it("solves the remaining starter tasks through the fake bin", async () => {
    for (const task of ["implement-function", "refactor-rename"]) {
      const result = await runEvals(["--task", task], {
        KULMI_EVAL_BIN: fakeBin,
        KULMI_FAKE_SOLVE: task,
      });
      expect(result.stdout).toContain(`${task} pass`);
      expect(result.stdout).toContain("passed 1/1");
      expect(result.code).toBe(0);
    }
  }, 60_000);

  it("reports fail and exits nonzero for a task the fake bin leaves broken", async () => {
    const result = await runEvals(["--task", "implement-function"], {
      KULMI_EVAL_BIN: fakeBin,
      KULMI_FAKE_SOLVE: "",
    });
    expect(result.stdout).toContain("implement-function fail");
    expect(result.stdout).toContain("passed 0/1");
    expect(result.code).not.toBe(0);
  }, 30_000);

  it("kills a hanging verify command when timeout_seconds expires", async () => {
    const tasksDir = await mkdtemp(join(tmpdir(), "kulmi-eval-tasks-"));
    try {
      const taskDir = join(tasksDir, "hang-verify");
      await mkdir(join(taskDir, "fixture"), { recursive: true });
      await writeFile(join(taskDir, "fixture", "placeholder.txt"), "fixture\n");
      await writeFile(
        join(taskDir, "task.json"),
        JSON.stringify({ prompt: "do nothing", timeout_seconds: 1, verify: "sleep 30" }),
      );
      const started = Date.now();
      const result = await runEvals(["--task", "hang-verify"], {
        KULMI_EVAL_BIN: fakeBin,
        KULMI_FAKE_SOLVE: "",
        KULMI_EVAL_TASKS_DIR: tasksDir,
      });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(result.stdout).toContain("hang-verify fail");
      expect(result.stdout).toContain("passed 0/1");
      expect(result.stderr).toContain("timed out");
      expect(result.code).not.toBe(0);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  }, 30_000);
});
