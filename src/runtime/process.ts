import { spawn } from "node:child_process";
import { disposeChildEnvironment, safeChildEnvironment } from "../security/environment.js";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export async function runShell(options: {
  command: string;
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<ProcessResult> {
  if (options.signal.aborted) throw options.signal.reason ?? new Error("command aborted");
  const started = performance.now();
  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
  const args = process.platform === "win32"
    ? ["-NoProfile", "-Command", options.command]
    : ["--noprofile", "--norc", "-c", options.command];
  const childEnv = safeChildEnvironment();
  const child = spawn(shell, args, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });

  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let truncated = false;
  let timedOut = false;

  const collect = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
    if (current.length >= options.maxOutputBytes) {
      truncated = true;
      return current;
    }
    const remaining = options.maxOutputBytes - current.length;
    if (chunk.length > remaining) truncated = true;
    return Buffer.concat([current, chunk.subarray(0, remaining)]);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdout = collect(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = collect(stderr, chunk);
  });

  const kill = () => {
    if (child.pid === undefined || child.killed) return;
    try {
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
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
      stdout: redact(stdout.toString("utf8")),
      stderr: redact(stderr.toString("utf8")),
      timedOut,
      truncated,
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", kill);
    disposeChildEnvironment(childEnv);
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
