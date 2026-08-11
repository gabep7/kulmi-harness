#!/usr/bin/env node
// Cross-harness comparison. Runs the same eval tasks against several agent
// CLIs and prints pass rate, time, and patch size side by side.
//
// Usage:
//   node evals/compare.mjs --harness kulmi,pi [--task X] [--runs 2] [--json]
//
// Each harness is a shim in evals/harnesses/<name>.sh receiving
// "exec --auto high <prompt>" with the prompt last. Configure models with the
// env vars each shim reads (KULMI_COMPARE_MODEL, PI_MODEL, OPENCODE_MODEL,
// CLAUDE_MODEL). Comparing harnesses is only meaningful on the same model.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const evalsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(evalsDir, "..");
const tasksDir = join(evalsDir, "tasks");
const harnessDir = join(evalsDir, "harnesses");

const { values } = parseArgs({
  options: {
    harness: { type: "string" },
    task: { type: "string" },
    runs: { type: "string", default: "1" },
    json: { type: "boolean", default: false },
  },
});

const harnesses = (values.harness ?? "kulmi").split(",").map((name) => name.trim()).filter(Boolean);
const runs = Number.parseInt(values.runs ?? "1", 10);
if (!Number.isInteger(runs) || runs < 1) {
  console.error("--runs must be a positive integer");
  process.exit(1);
}

for (const name of harnesses) {
  if (!existsSync(join(harnessDir, `${name}.sh`))) {
    console.error(`no adapter for harness "${name}": expected evals/harnesses/${name}.sh`);
    process.exit(1);
  }
}

let tasks;
if (values.task) {
  const info = await stat(join(tasksDir, values.task)).catch(() => undefined);
  if (!info?.isDirectory()) {
    console.error(`unknown task: ${values.task}`);
    process.exit(1);
  }
  tasks = [values.task];
} else {
  const entries = await readdir(tasksDir, { withFileTypes: true });
  tasks = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function runOne(harness, task) {
  const { promise, resolve: done } = Promise.withResolvers();
  const started = Date.now();
  const child = spawn(process.execPath, [join(evalsDir, "run.mjs"), "--task", task, "--json"], {
    cwd: repoRoot,
    env: { ...process.env, KULMI_EVAL_BIN: join(harnessDir, `${harness}.sh`), KULMI_COMPARE_CLI: join(repoRoot, "dist", "cli.js") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", () => {
    let parsed;
    try {
      parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
    } catch {
      parsed = undefined;
    }
    const result = parsed?.results?.[0];
    done({
      passed: Boolean(result?.passed),
      seconds: result?.seconds ?? (Date.now() - started) / 1000,
      patchLines: (result?.patch ?? "").split("\n").filter((line) => /^[+-][^+-]/.test(line)).length,
      changedFiles: result?.changedFiles?.length ?? 0,
      // Keep the diff for failures: without it a failed run cannot be
      // diagnosed after the fact, and the scratch worktree is already gone.
      ...(result && !result.passed ? { patch: result.patch ?? "" } : {}),
      error: parsed ? undefined : (stderr.trim().split("\n").at(-1) ?? "no json output"),
    });
  });
  return promise;
}

const table = [];
for (const harness of harnesses) {
  for (const task of tasks) {
    for (let attempt = 1; attempt <= runs; attempt += 1) {
      const result = await runOne(harness, task);
      table.push({ harness, task, attempt, ...result });
      if (!values.json) {
        const flag = result.passed ? "pass" : "fail";
        const note = result.error ? `  (${result.error.slice(0, 60)})` : "";
        console.log(`${harness.padEnd(10)} ${task.padEnd(20)} ${flag} ${result.seconds.toFixed(1).padStart(6)}s  ${String(result.patchLines).padStart(4)} patch lines${note}`);
      }
    }
  }
}

const summary = harnesses.map((harness) => {
  const rows = table.filter((row) => row.harness === harness);
  const passed = rows.filter((row) => row.passed).length;
  const totalSeconds = rows.reduce((sum, row) => sum + row.seconds, 0);
  const patchLines = rows.reduce((sum, row) => sum + row.patchLines, 0);
  return {
    harness,
    passed,
    total: rows.length,
    passRate: rows.length > 0 ? passed / rows.length : 0,
    totalSeconds,
    medianSeconds: median(rows.map((row) => row.seconds)),
    patchLines,
  };
});

if (values.json) {
  process.stdout.write(`${JSON.stringify({ results: table, summary }, null, 2)}\n`);
} else {
  console.log(`\n${"harness".padEnd(10)} ${"pass".padEnd(9)} ${"rate".padEnd(6)} ${"total s".padEnd(9)} median s  patch lines`);
  for (const row of summary) {
    console.log(
      `${row.harness.padEnd(10)} ${`${row.passed}/${row.total}`.padEnd(9)} ${`${Math.round(row.passRate * 100)}%`.padEnd(6)} ${row.totalSeconds.toFixed(1).padEnd(9)} ${row.medianSeconds.toFixed(1).padStart(8)}  ${String(row.patchLines).padStart(11)}`,
    );
  }
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
