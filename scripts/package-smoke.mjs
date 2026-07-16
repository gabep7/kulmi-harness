#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const temp = await mkdtemp(join(tmpdir(), "kulmi-package-smoke-"));

try {
  const packDir = join(temp, "pack");
  const appDir = join(temp, "app");
  await mkdir(packDir);
  await mkdir(appDir);
  await execFileAsync("npm", ["run", "build"], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  const { stdout } = await execFileAsync("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  const tarball = stdout.trim().split("\n").at(-1);
  if (!tarball) throw new Error("npm pack did not report a tarball");
  await execFileAsync("npm", ["install", "--prefix", appDir, "--ignore-scripts", join(packDir, tarball)], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  const bin = join(appDir, "node_modules", ".bin", "kulmi");
  const version = await execFileAsync(bin, ["--version"], { cwd: root, maxBuffer: 1024 * 1024 });
  if (!version.stdout.trim()) throw new Error("kulmi --version returned empty output");
  const doctor = await execFileAsync(bin, ["doctor"], {
    cwd: root,
    env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "sk-package-smoke-00000000" },
    maxBuffer: 1024 * 1024,
  });
  if (!doctor.stdout.includes("ok\tnode") || !doctor.stdout.includes("ok\tgit")) {
    throw new Error(`doctor output missing required checks:\n${doctor.stdout}`);
  }
  process.stdout.write(`ok package ${tarball}\n`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
