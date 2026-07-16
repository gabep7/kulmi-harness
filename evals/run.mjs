#!/usr/bin/env node
// Eval runner for SWE-style regression tasks.
// Usage: node evals/run.mjs [--task <name>] [--keep]
// Env: KULMI_EVAL_BIN replaces the harness executable (receives
// "exec --auto high <prompt>" as argv); KULMI_EVAL_MODEL appends
// "--model <name>"; KULMI_EVAL_TASKS_DIR overrides the tasks
// directory (used by tests).
import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const evalsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(evalsDir, "..");
const tasksDir = process.env.KULMI_EVAL_TASKS_DIR ?? join(evalsDir, "tasks");

function runCommand(command, args, { cwd, timeoutMs, capture = false }) {
  const { promise, resolve: resolveRun } = Promise.withResolvers();
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
    detached: true,
  });
  let output = "";
  if (capture) {
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
  }
  let timedOut = false;
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeoutMs)
    : undefined;
  child.on("error", () => {
    clearTimeout(timer);
    resolveRun({ code: 127, timedOut, output });
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    resolveRun({ code: code ?? (signal ? 1 : 0), timedOut, output });
  });
  return promise;
}

async function runTask(name, keep) {
  const taskDir = join(tasksDir, name);
  const config = JSON.parse(await readFile(join(taskDir, "task.json"), "utf8"));
  if (
    typeof config.prompt !== "string" ||
    typeof config.verify !== "string" ||
    typeof config.timeout_seconds !== "number"
  ) {
    throw new Error(`${name}/task.json must define prompt (string), verify (string), and timeout_seconds (number)`);
  }
  const timeoutMs = config.timeout_seconds * 1000;
  const temp = await mkdtemp(join(tmpdir(), `kulmi-eval-${name}-`));
  const started = Date.now();
  try {
    await cp(join(taskDir, "fixture"), temp, { recursive: true });
    const init = await runCommand(
      "sh",
      [
        "-c",
        "git init -q && git add -A && git -c user.name=kulmi-eval -c user.email=eval@kulmi.invalid -c commit.gpgsign=false commit -qm base",
      ],
      { cwd: temp, timeoutMs, capture: true },
    );
    if (init.code !== 0) throw new Error(`git setup failed for ${name}: ${init.output.trim()}`);
    if (typeof config.setup === "string") {
      const setup = await runCommand("sh", ["-c", config.setup], { cwd: temp, timeoutMs, capture: true });
      if (setup.code !== 0) throw new Error(`setup failed for ${name}: ${setup.output.trim()}`);
    }
    const evalBin = process.env.KULMI_EVAL_BIN;
    const command = evalBin ? (evalBin.includes("/") ? resolve(evalBin) : evalBin) : process.execPath;
    const modelArgs = process.env.KULMI_EVAL_MODEL ? ["--model", process.env.KULMI_EVAL_MODEL] : [];
    const args = evalBin
      ? ["exec", "--auto", "high", ...modelArgs, config.prompt]
      : [join(repoRoot, "dist", "cli.js"), "exec", "--auto", "high", ...modelArgs, config.prompt];
    const run = await runCommand(command, args, { cwd: temp, timeoutMs, capture: true });
    if (run.code === 127) {
      process.stderr.write(`${name}: harness command ${command} failed to start\n`);
    } else if (run.timedOut) {
      process.stderr.write(`${name}: harness run timed out after ${config.timeout_seconds}s and was killed\n`);
    } else if (run.code !== 0) {
      const tail = run.output.trim().split("\n").slice(-15).join("\n");
      process.stderr.write(`${name}: harness exited ${run.code}${tail ? `:\n${tail}` : ""}\n`);
    }
    const verify = await runCommand("sh", ["-c", config.verify], { cwd: temp, timeoutMs, capture: true });
    const passed = !verify.timedOut && verify.code === 0;
    if (verify.timedOut) {
      process.stderr.write(`${name}: verify command timed out after ${config.timeout_seconds}s and was killed\n`);
    } else if (!passed && verify.output.trim()) {
      process.stderr.write(`${name}: verify output:\n${verify.output.trim()}\n`);
    }
    return { passed, seconds: (Date.now() - started) / 1000 };
  } finally {
    if (keep) console.log(`kept ${temp}`);
    else await rm(temp, { recursive: true, force: true });
  }
}

const { values } = parseArgs({
  options: {
    task: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});

let names;
if (values.task) {
  const info = await stat(join(tasksDir, values.task)).catch(() => undefined);
  if (!info?.isDirectory()) {
    console.error(`unknown task: ${values.task}`);
    process.exit(1);
  }
  names = [values.task];
} else {
  const entries = await readdir(tasksDir, { withFileTypes: true });
  names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
if (names.length === 0) {
  console.error(`no tasks found in ${tasksDir}`);
  process.exit(1);
}

let passedCount = 0;
for (const name of names) {
  let result;
  try {
    result = await runTask(name, values.keep);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    result = { passed: false, seconds: 0 };
  }
  if (result.passed) passedCount += 1;
  console.log(`${name} ${result.passed ? "pass" : "fail"} ${result.seconds.toFixed(1)}s`);
}
console.log(`passed ${passedCount}/${names.length}`);
process.exit(passedCount === names.length ? 0 : 1);
