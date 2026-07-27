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

  it("captures a non-empty patch when the fake bin edits a tracked file", async () => {
    const result = await runEvals(["--task", "fix-failing-test", "--json"], {
      KULMI_EVAL_BIN: fakeBin,
      KULMI_FAKE_SOLVE: "fix-failing-test",
    });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.results).toHaveLength(1);
    const entry = parsed.results[0];
    expect(entry.name).toBe("fix-failing-test");
    expect(entry.passed).toBe(true);
    expect(typeof entry.patch).toBe("string");
    expect(entry.patch.length).toBeGreaterThan(0);
    expect(entry.patch).toContain("lib.mjs");
    expect(entry.changedFiles).toContain("lib.mjs");
  }, 30_000);

  it("emits structured JSON with results and summary under --json", async () => {
    const result = await runEvals(["--task", "fix-failing-test", "--json"], {
      KULMI_EVAL_BIN: fakeBin,
      KULMI_FAKE_SOLVE: "fix-failing-test",
    });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBeGreaterThanOrEqual(1);
    expect(parsed.summary).toEqual({ passed: parsed.results.filter((r: { passed: boolean }) => r.passed).length, total: parsed.results.length });
    for (const entry of parsed.results) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.passed).toBe("boolean");
      expect(typeof entry.seconds).toBe("number");
      expect(Array.isArray(entry.changedFiles)).toBe(true);
      expect(Array.isArray(entry.failToPass)).toBe(true);
      expect(Array.isArray(entry.passToPass)).toBe(true);
    }
  }, 60_000);

  it("runs fail_to_pass and pass_to_pass commands and records each outcome", async () => {
    const tasksDir = await mkdtemp(join(tmpdir(), "kulmi-eval-tasks-"));
    try {
      const taskDir = join(tasksDir, "split-task");
      await mkdir(join(taskDir, "fixture"), { recursive: true });
      await writeFile(join(taskDir, "fixture", "counter.mjs"), "export let n = 0;\n");
      await writeFile(
        join(taskDir, "task.json"),
        JSON.stringify({
          prompt: "increment counter",
          timeout_seconds: 5,
          verify: "node -e \"require('fs').readFileSync('counter.mjs','utf8')\"",
          fail_to_pass: ["test -f counter.mjs"],
          pass_to_pass: ["node -e \"0\""],
        }),
      );
      const result = await runEvals(["--task", "split-task", "--json"], {
        KULMI_EVAL_BIN: fakeBin,
        KULMI_FAKE_SOLVE: "",
        KULMI_EVAL_TASKS_DIR: tasksDir,
      });
      const parsed = JSON.parse(result.stdout);
      const entry = parsed.results[0];
      expect(entry.failToPass).toEqual([{ cmd: "test -f counter.mjs", passed: true }]);
      expect(entry.passToPass).toEqual([{ cmd: "node -e \"0\"", passed: true }]);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports fail and exits nonzero for a task the fake bin leaves broken", async () => {
    const result = await runEvals(["--task", "implement-function"], {
      KULMI_EVAL_BIN: fakeBin,
      KULMI_FAKE_SOLVE: "",
    });
    expect(result.stdout).toContain("implement-function fail");
    expect(result.stdout).toContain("passed 0/1");
    expect(result.code).not.toBe(0);
  }, 30_000);
});
