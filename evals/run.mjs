#!/usr/bin/env node
// Eval runner for SWE-style regression tasks.
// Usage: node evals/run.mjs [--task <name>] [--keep] [--json]
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
  let stdout = "";
  let stderr = "";
  if (capture) {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
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
    resolveRun({ code: 127, timedOut, stdout, stderr });
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    resolveRun({ code: code ?? (signal ? 1 : 0), timedOut, stdout, stderr });
  });
  return promise;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

async function runTestList(commands, temp, timeoutMs) {
  const out = [];
  for (const cmd of commands ?? []) {
    const res = await runCommand("sh", ["-c", cmd], { cwd: temp, timeoutMs, capture: true });
    const passed = !res.timedOut && res.code === 0;
    if (res.timedOut) {
      process.stderr.write(`test command timed out: ${cmd}\n`);
    }
    out.push({ cmd, passed });
  }
  return out;
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
  const repoUrl = typeof config.repo_url === "string" ? config.repo_url : undefined;
  const baseCommit = typeof config.base_commit === "string" ? config.base_commit : undefined;
  if (repoUrl || baseCommit) {
    if (!repoUrl || !baseCommit) {
      throw new Error(`${name}/task.json must define both repo_url and base_commit, or neither`);
    }
  }
  if (config.fail_to_pass !== undefined && !isStringArray(config.fail_to_pass)) {
    throw new Error(`${name}/task.json fail_to_pass must be an array of strings`);
  }
  if (config.pass_to_pass !== undefined && !isStringArray(config.pass_to_pass)) {
    throw new Error(`${name}/task.json pass_to_pass must be an array of strings`);
  }
  const failToPass = isStringArray(config.fail_to_pass) ? config.fail_to_pass : [];
  const passToPass = isStringArray(config.pass_to_pass) ? config.pass_to_pass : [];
  const timeoutMs = config.timeout_seconds * 1000;
  const temp = await mkdtemp(join(tmpdir(), `kulmi-eval-${name}-`));
  const started = Date.now();
  try {
    if (repoUrl) {
      const cloneMs = Math.max(timeoutMs, 600_000);
      const clone = await runCommand(
        "git",
        ["clone", "--filter=blob:none", repoUrl, temp],
        { cwd: temp, timeoutMs: cloneMs, capture: true },
      );
      if (clone.code !== 0) throw new Error(`git clone failed for ${name}: ${clone.stderr.trim() || clone.stdout.trim()}`);
      const checkout = await runCommand("git", ["-C", temp, "checkout", baseCommit], { cwd: temp, timeoutMs: cloneMs, capture: true });
      if (checkout.code !== 0) throw new Error(`git checkout ${baseCommit} failed for ${name}: ${checkout.stderr.trim() || checkout.stdout.trim()}`);
      const marker = await runCommand(
        "git",
        ["-C", temp, "-c", "user.name=kulmi-eval", "-c", "user.email=eval@kulmi.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "base"],
        { cwd: temp, timeoutMs, capture: true },
      );
      if (marker.code !== 0) throw new Error(`git base marker failed for ${name}: ${marker.stderr.trim() || marker.stdout.trim()}`);
    } else {
      await cp(join(taskDir, "fixture"), temp, { recursive: true });
      const init = await runCommand(
        "sh",
        [
          "-c",
          "git init -q && git add -A && git -c user.name=kulmi-eval -c user.email=eval@kulmi.invalid -c commit.gpgsign=false commit -qm base",
        ],
        { cwd: temp, timeoutMs, capture: true },
      );
      if (init.code !== 0) throw new Error(`git setup failed for ${name}: ${init.stderr.trim() || init.stdout.trim()}`);
    }
    if (typeof config.setup === "string") {
      const setup = await runCommand("sh", ["-c", config.setup], { cwd: temp, timeoutMs, capture: true });
      if (setup.code !== 0) throw new Error(`setup failed for ${name}: ${setup.stderr.trim() || setup.stdout.trim()}`);
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
      const tail = run.stderr.trim() || run.stdout.trim();
      process.stderr.write(`${name}: harness exited ${run.code}${tail ? `:\n${tail.split("\n").slice(-15).join("\n")}` : ""}\n`);
    }
    // Capture the model's patch before verify runs.
    const patch = await runCommand("git", ["-C", temp, "diff"], { cwd: temp, timeoutMs, capture: true });
    const statOut = await runCommand("git", ["-C", temp, "diff", "--stat"], { cwd: temp, timeoutMs, capture: true });
    const namesOut = await runCommand("git", ["-C", temp, "diff", "--name-only"], { cwd: temp, timeoutMs, capture: true });
    const patchText = patch.stdout;
    const patchStat = statOut.stdout.trim();
    const changedFiles = namesOut.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    // Best-effort usage/cost capture: harness stderr may carry token usage lines.
    const usage = run.stderr.split("\n").filter((line) => /token|usage|cost/i.test(line)).join("\n");
    const verify = await runCommand("sh", ["-c", config.verify], { cwd: temp, timeoutMs, capture: true });
    const verifyPassed = !verify.timedOut && verify.code === 0;
    if (verify.timedOut) {
      process.stderr.write(`${name}: verify command timed out after ${config.timeout_seconds}s and was killed\n`);
    } else if (!verifyPassed && verify.stderr.trim()) {
      process.stderr.write(`${name}: verify stderr:\n${verify.stderr.trim()}\n`);
    } else if (!verifyPassed && verify.stdout.trim()) {
      process.stderr.write(`${name}: verify output:\n${verify.stdout.trim()}\n`);
    }
    const failToPassResults = await runTestList(failToPass, temp, timeoutMs);
    const passToPassResults = await runTestList(passToPass, temp, timeoutMs);
    const passed = verifyPassed &&
      failToPassResults.every((result) => result.passed) &&
      passToPassResults.every((result) => result.passed);
    return {
      passed,
      seconds: (Date.now() - started) / 1000,
      patch: patchText,
      patchStat,
      changedFiles,
      usage: usage || undefined,
      failToPass: failToPassResults,
      passToPass: passToPassResults,
      ...(repoUrl ? { repoUrl, baseCommit } : {}),
    };
  } finally {
    if (keep) console.log(`kept ${temp}`);
    else await rm(temp, { recursive: true, force: true });
  }
}

const { values } = parseArgs({
  options: {
    task: { type: "string" },
    keep: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
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

const results = [];
let passedCount = 0;
for (const name of names) {
  let result;
  try {
    result = await runTask(name, values.keep);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    result = {
      passed: false,
      seconds: 0,
      patch: "",
      patchStat: "",
      changedFiles: [],
      usage: undefined,
      failToPass: [],
      passToPass: [],
    };
  }
  if (result.passed) passedCount += 1;
  results.push({
    name,
    passed: result.passed,
    seconds: result.seconds,
    patch: result.patch,
    changedFiles: result.changedFiles,
    failToPass: result.failToPass,
    passToPass: result.passToPass,
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.repoUrl ? { repo_url: result.repoUrl, base_commit: result.baseCommit } : {}),
  });
  if (!values.json) {
    const statLine = result.patchStat ? ` | ${result.patchStat}` : "";
    console.log(`${name} ${result.passed ? "pass" : "fail"} ${result.seconds.toFixed(1)}s${statLine}`);
  }
}

if (values.json) {
  process.stdout.write(
    JSON.stringify({
      results,
      summary: { passed: passedCount, total: names.length },
    }) + "\n",
  );
} else {
  console.log(`passed ${passedCount}/${names.length}`);
}
process.exit(passedCount === names.length ? 0 : 1);