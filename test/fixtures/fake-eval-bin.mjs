#!/usr/bin/env node
// Fake harness binary for eval runner tests. It receives the same argv as
// the real CLI (exec --auto high <prompt>) and solves the starter task named
// by KULMI_FAKE_SOLVE by editing files in the current working directory.
// Any other value leaves the fixture untouched so the verify step fails.
import { readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
if (args[0] !== "exec" || args[1] !== "--auto" || args[2] !== "high" || typeof args[3] !== "string") {
  console.error(`fake-eval-bin: unexpected argv ${JSON.stringify(args)}`);
  process.exit(2);
}

const solve = process.env.KULMI_FAKE_SOLVE ?? "";
if (solve === "fix-failing-test") {
  await writeFile(
    "lib.mjs",
    [
      "export function sumRange(start, end) {",
      "  let total = 0;",
      "  for (let i = start; i <= end; i += 1) total += i;",
      "  return total;",
      "}",
      "",
    ].join("\n"),
  );
} else if (solve === "implement-function") {
  await writeFile(
    "slugify.mjs",
    [
      "export function slugify(input) {",
      "  return input",
      "    .toLowerCase()",
      "    .replace(/[^a-z0-9]+/g, \"-\")",
      "    .replace(/^-+|-+$/g, \"\");",
      "}",
      "",
    ].join("\n"),
  );
} else if (solve === "refactor-rename") {
  for (const file of ["math.mjs", "report.mjs", "invoice.mjs", "smoke.mjs"]) {
    const source = await readFile(file, "utf8");
    await writeFile(file, source.replaceAll("computeTotal", "sumItems"));
  }
}
