import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SandboxConfig } from "../config/config.js";
import { disposeChildEnvironment, safeChildEnvironment } from "../security/environment.js";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  sandbox: SandboxInvocation["backend"];
}

export async function runShell(options: {
  command: string;
  cwd: string;
  workspaceRoot?: string;
  sandbox?: SandboxConfig;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<ProcessResult> {
  if (options.signal.aborted) throw options.signal.reason ?? new Error("command aborted");
  const started = performance.now();
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`Kulmi shell execution is supported only on macOS and Linux, not ${process.platform}`);
  }
  const shell = "/bin/bash";
  const args = ["--noprofile", "--norc", "-c", options.command];
  const childEnv = safeChildEnvironment();
  let sandboxBackend: SandboxInvocation["backend"] = "none";
  let child;
  try {
    const invocation = buildSandboxInvocation({
      platform: process.platform,
      shell,
      shellArgs: args,
      cwd: options.cwd,
      workspaceRoot: options.workspaceRoot ?? options.cwd,
      env: childEnv,
      sandbox: options.sandbox ?? { mode: "required", network: false },
    });
    sandboxBackend = invocation.backend;
    const spawnEnv = { ...childEnv };
    delete spawnEnv.KULMI_SANDBOX_ROOT;
    delete spawnEnv.KULMI_SANDBOX_HOME;
    delete spawnEnv.KULMI_SANDBOX_TMP;
    child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnv,
    });
  } catch (error) {
    disposeChildEnvironment(childEnv);
    throw error;
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let remainingBytes = options.maxOutputBytes;
  let truncated = false;
  let timedOut = false;
  let escalationTimer: NodeJS.Timeout | undefined;

  const collect = (target: Buffer[], chunk: Buffer): void => {
    if (remainingBytes <= 0) {
      truncated = true;
      return;
    }
    const retained = chunk.subarray(0, remainingBytes);
    target.push(retained);
    remainingBytes -= retained.length;
    if (chunk.length > retained.length) truncated = true;
  };

  child.stdout.on("data", (chunk: Buffer) => {
    collect(stdoutChunks, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    collect(stderrChunks, chunk);
  });

  const kill = () => {
    if (child.pid === undefined || child.killed) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    escalationTimer ??= setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, 1_500).unref();
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    kill();
  }, options.timeoutMs);
  timeout.unref();
  options.signal.addEventListener("abort", kill, { once: true });

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    if (options.signal.aborted) throw options.signal.reason ?? new Error("command aborted");
    return {
      exitCode,
      stdout: redact(Buffer.concat(stdoutChunks).toString("utf8")),
      stderr: redact(Buffer.concat(stderrChunks).toString("utf8")),
      timedOut,
      truncated,
      durationMs: Math.round(performance.now() - started),
      sandbox: sandboxBackend,
    };
  } finally {
    clearTimeout(timeout);
    if (escalationTimer) clearTimeout(escalationTimer);
    options.signal.removeEventListener("abort", kill);
    disposeChildEnvironment(childEnv);
  }
}

export interface SandboxInvocation {
  command: string;
  args: string[];
  backend: "none" | "seatbelt" | "bubblewrap";
}

export function sandboxAvailability(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { available: boolean; backend: string; detail: string } {
  if (platform === "darwin") {
    const path = "/usr/bin/sandbox-exec";
    return executable(path)
      ? { available: true, backend: "seatbelt", detail: path }
      : { available: false, backend: "seatbelt", detail: `${path} is unavailable` };
  }
  if (platform === "linux") {
    const path = findExecutable("bwrap", env.PATH);
    if (!path) {
      return { available: false, backend: "bubblewrap", detail: "install the bubblewrap package to provide bwrap" };
    }
    const probe = spawnSync(path, [
      "--die-with-parent",
      "--unshare-all",
      "--ro-bind",
      "/",
      "/",
      "--",
      "/bin/true",
    ], {
      encoding: "utf8",
      env,
      timeout: 5_000,
    });
    if (probe.status === 0) return { available: true, backend: "bubblewrap", detail: path };
    const reason = (probe.stderr || probe.error?.message || `exit ${probe.status ?? "unknown"}`).trim();
    return {
      available: false,
      backend: "bubblewrap",
      detail: `${path} cannot create the required namespaces: ${reason}. Check Ubuntu AppArmor user-namespace policy`,
    };
  }
  return { available: false, backend: "unsupported", detail: `unsupported platform ${platform}` };
}

export function buildSandboxInvocation(options: {
  platform: NodeJS.Platform;
  shell: string;
  shellArgs: string[];
  cwd: string;
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
  sandbox: SandboxConfig;
  sandboxExecutable?: string;
}): SandboxInvocation {
  if (options.platform !== "darwin" && options.platform !== "linux") {
    throw new Error(`Kulmi shell execution is supported only on macOS and Linux, not ${options.platform}`);
  }
  if (options.sandbox.mode === "off") {
    return { command: options.shell, args: options.shellArgs, backend: "none" };
  }

  const workspaceRoot = canonicalDirectory(options.workspaceRoot, "workspace root");
  const cwd = canonicalDirectory(options.cwd, "working directory");
  assertInside(workspaceRoot, cwd);
  const sandboxRoot = canonicalDirectory(requiredEnvPath(options.env, "KULMI_SANDBOX_ROOT"), "sandbox root");
  const gitPaths = gitMetadataPaths(workspaceRoot);
  const readRoots = readableRoots(workspaceRoot, sandboxRoot, options.env, options.shell, options.platform);

  if (options.platform === "darwin") {
    const executablePath = options.sandboxExecutable ?? "/usr/bin/sandbox-exec";
    if (!executable(executablePath)) {
      throw new Error("required macOS sandbox is unavailable: /usr/bin/sandbox-exec was not found; set sandbox.mode=off only if you accept unsandboxed commands");
    }
    const profile = macSandboxProfile({
      readRoots: minimizeRoots([...readRoots, ...gitPaths]),
      writeRoots: [workspaceRoot, sandboxRoot],
      gitPaths,
      network: options.sandbox.network,
    });
    return {
      command: executablePath,
      args: ["-p", profile, options.shell, ...options.shellArgs],
      backend: "seatbelt",
    };
  }

  const executablePath = options.sandboxExecutable ?? findExecutable("bwrap", options.env.PATH);
  if (!executablePath || !executable(executablePath)) {
    throw new Error("required Linux sandbox is unavailable: install the bubblewrap package to provide bwrap, or set sandbox.mode=off only if you accept unsandboxed commands");
  }
  const args = ["--die-with-parent", "--new-session", "--unshare-all"];
  if (options.sandbox.network) args.push("--share-net");
  for (const root of readRoots) {
    if (root === workspaceRoot || root === sandboxRoot || isInside(workspaceRoot, root) || isInside(sandboxRoot, root)) continue;
    args.push("--ro-bind", root, root);
  }
  for (const [target, path] of linuxFilesystemAliases()) {
    args.push("--symlink", target, path);
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  args.push("--bind", workspaceRoot, workspaceRoot);
  args.push("--bind", sandboxRoot, sandboxRoot);
  for (const gitPath of gitPaths) {
    args.push("--ro-bind", gitPath, gitPath);
  }
  args.push("--chdir", cwd, "--", options.shell, ...options.shellArgs);
  return { command: executablePath, args, backend: "bubblewrap" };
}

function linuxFilesystemAliases(): Array<[target: string, path: string]> {
  const aliases: Array<[target: string, path: string]> = [];
  for (const path of ["/bin", "/sbin", "/lib", "/lib64"]) {
    try {
      if (lstatSync(path).isSymbolicLink()) aliases.push([readlinkSync(path), path]);
    } catch {
      // Missing compatibility aliases are valid on non-merged layouts.
    }
  }
  return aliases;
}

function macSandboxProfile(options: {
  readRoots: string[];
  writeRoots: string[];
  gitPaths: string[];
  network: boolean;
}): string {
  const reads = options.readRoots.map(sandboxPathFilter).join(" ");
  const writes = options.writeRoots.map(sandboxPathFilter).join(" ");
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process*)",
    "(allow file-ioctl file-fsctl)",
    "(allow ipc-posix-shm)",
    "(allow signal (target self))",
    "(allow system-sched)",
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    `(allow file-read* ${reads})`,
    `(allow file-map-executable ${reads})`,
    `(allow file-write* ${writes} (literal \"/dev/null\"))`,
    ...options.gitPaths.map((path) => `(deny file-write* ${sandboxPathFilter(path)})`),
    ...(options.network ? ["(allow network*)"] : []),
  ].join("\n");
}

function gitMetadataPaths(workspaceRoot: string): string[] {
  const dotGit = join(workspaceRoot, ".git");
  if (!existsSync(dotGit)) return [];
  const paths = [canonicalPath(dotGit)];
  if (!statSync(dotGit).isFile()) return paths;

  const match = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/im);
  if (!match?.[1]) throw new Error(`invalid linked-worktree metadata file ${dotGit}`);
  const gitDir = canonicalDirectory(resolve(dirname(dotGit), match[1]), "linked-worktree git directory");
  paths.push(gitDir);
  const commonDirFile = join(gitDir, "commondir");
  if (existsSync(commonDirFile)) {
    const commonDir = readFileSync(commonDirFile, "utf8").trim();
    if (!commonDir) throw new Error(`empty linked-worktree common directory file ${commonDirFile}`);
    paths.push(canonicalDirectory(resolve(gitDir, commonDir), "linked-worktree common git directory"));
  }
  return minimizeRoots(paths);
}

function readableRoots(
  workspaceRoot: string,
  sandboxRoot: string,
  env: NodeJS.ProcessEnv,
  shell: string,
  platform: NodeJS.Platform,
): string[] {
  const candidates = platform === "darwin"
    ? ["/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/opt", "/nix/store", "/private/etc", "/private/var/db", "/dev"]
    : ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt", "/nix/store"];
  candidates.push(workspaceRoot, sandboxRoot, toolRoot(shell), toolRoot(process.execPath));
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!entry || !isAbsolute(entry) || !existsSync(entry)) continue;
    const directory = toolRoot(entry);
    candidates.push(directory);
    if (executable(join(directory, "node"))) candidates.push(dirname(directory));
  }
  return minimizeRoots(candidates.filter((path) => existsSync(path)).map(canonicalPath));
}

function toolRoot(path: string): string {
  const resolved = canonicalPath(path);
  let info;
  try {
    info = statSync(resolved);
  } catch {
    return dirname(resolved);
  }
  return info.isDirectory() ? resolved : dirname(resolved);
}

function minimizeRoots(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort((left, right) => left.length - right.length || left.localeCompare(right));
  return sorted.filter((candidate, index) => !sorted.slice(0, index).some((root) => isInside(root, candidate)));
}

function sandboxPathFilter(path: string): string {
  const escaped = path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return statSync(path).isDirectory() ? `(subpath \"${escaped}\")` : `(literal \"${escaped}\")`;
}

function canonicalDirectory(path: string, label: string): string {
  const value = canonicalPath(path);
  if (!statSync(value).isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  return value;
}

function canonicalPath(path: string): string {
  return realpathSync(resolve(path));
}

function requiredEnvPath(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing internal sandbox path ${name}`);
  return value;
}

function assertInside(root: string, path: string): void {
  if (!isInside(root, path)) throw new Error(`working directory is outside workspace: ${path}`);
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function findExecutable(name: string, pathValue: string | undefined): string | undefined {
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function redact(value: string): string {
  let redacted = value;
  for (const [name, secret] of Object.entries(process.env)) {
    if (!secret || secret.length < 8 || !/(?:KEY|SECRET|TOKEN|PASSWORD)/i.test(name)) continue;
    redacted = redacted.replaceAll(secret, `[redacted:${name}]`);
  }
  return redacted;
}
