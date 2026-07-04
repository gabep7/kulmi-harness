import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { buildSandboxInvocation, runShell, sandboxAvailability } from "../src/runtime/process.js";
import { disposeChildEnvironment, safeChildEnvironment } from "../src/security/environment.js";

const exec = promisify(execFile);

describe("command sandbox", () => {
  it("reports an installed but unusable Linux sandbox backend", async () => {
    const binaries = await mkdtemp(join(tmpdir(), "kulmi-bwrap-probe-"));
    await symlink("/usr/bin/false", join(binaries, "bwrap"));

    expect(sandboxAvailability("linux", { PATH: binaries })).toMatchObject({
      available: false,
      backend: "bubblewrap",
    });
    expect(sandboxAvailability("linux", { PATH: binaries }).detail).toContain("cannot create the required namespaces");
  });

  it("builds deny-by-default macOS and isolated Linux invocations", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-sandbox-plan-"));
    await mkdir(join(workspace, ".git"));
    const env = safeChildEnvironment();
    try {
      const mac = buildSandboxInvocation({
        platform: "darwin",
        shell: "/bin/bash",
        shellArgs: ["-c", "true"],
        cwd: workspace,
        workspaceRoot: workspace,
        env,
        sandbox: { mode: "required", network: false },
        sandboxExecutable: "/usr/bin/true",
      });
      expect(mac).toMatchObject({ backend: "seatbelt", command: "/usr/bin/true" });
      expect(mac.args[1]).toContain("(deny default)");
      expect(mac.args[1]).toContain("(deny file-write*");
      expect(mac.args[1]).not.toContain('(subpath "/")');
      expect(mac.args[1]).not.toContain("(allow network*)");

      const linux = buildSandboxInvocation({
        platform: "linux",
        shell: "/bin/bash",
        shellArgs: ["-c", "true"],
        cwd: workspace,
        workspaceRoot: workspace,
        env,
        sandbox: { mode: "required", network: false },
        sandboxExecutable: "/bin/echo",
      });
      expect(linux).toMatchObject({ backend: "bubblewrap", command: "/bin/echo" });
      expect(linux.args).toContain("--unshare-all");
      expect(linux.args).not.toContain("--share-net");
      expect(linux.args).toContain("--bind");
      expect(linux.args).toContain("--ro-bind");
      expect(JSON.stringify(linux.args)).not.toContain('["--ro-bind","/","/"]');

      const networked = buildSandboxInvocation({
        platform: "linux",
        shell: "/bin/bash",
        shellArgs: ["-c", "true"],
        cwd: workspace,
        workspaceRoot: workspace,
        env,
        sandbox: { mode: "required", network: true },
        sandboxExecutable: "/bin/echo",
      });
      expect(networked.args).toContain("--share-net");

      const off = buildSandboxInvocation({
        platform: "linux",
        shell: "/bin/bash",
        shellArgs: ["-c", "true"],
        cwd: workspace,
        workspaceRoot: workspace,
        env,
        sandbox: { mode: "off", network: false },
      });
      expect(off).toEqual({ command: "/bin/bash", args: ["-c", "true"], backend: "none" });
      expect(() => buildSandboxInvocation({
        platform: "win32",
        shell: "powershell.exe",
        shellArgs: [],
        cwd: workspace,
        workspaceRoot: workspace,
        env,
        sandbox: { mode: "off", network: false },
      })).toThrow("only on macOS and Linux");
    } finally {
      disposeChildEnvironment(env);
    }
  });

  it.runIf(sandboxAvailability().available)("allows workspace writes but blocks host reads, host writes, Git metadata, and network", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-sandbox-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "kulmi-sandbox-outside-"));
    await mkdir(join(workspace, ".git"));
    await writeFile(join(outside, "secret.txt"), "host secret\n");
    await writeFile(join(workspace, "escape.cjs"), [
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(join(outside, "escaped.txt"))}, 'escaped');`,
    ].join("\n"));
    await writeFile(join(workspace, "read-host.cjs"), [
      "const { readFileSync, writeFileSync } = require('node:fs');",
      `const secret = readFileSync(${JSON.stringify(join(outside, "secret.txt"))}, 'utf8');`,
      "writeFileSync('stolen.txt', secret);",
    ].join("\n"));
    const options = {
      cwd: workspace,
      workspaceRoot: workspace,
      sandbox: { mode: "required" as const, network: false },
      signal: new AbortController().signal,
      timeoutMs: 10_000,
      maxOutputBytes: 20_000,
    };

    const allowed = await runShell({ ...options, command: "touch allowed.txt" });
    expect(allowed.exitCode, allowed.stderr).toBe(0);
    await expect(access(join(workspace, "allowed.txt"))).resolves.toBeUndefined();

    const escaped = await runShell({ ...options, command: "node escape.cjs" });
    expect(escaped.exitCode).not.toBe(0);
    await expect(access(join(outside, "escaped.txt"))).rejects.toThrow();

    const hostRead = await runShell({ ...options, command: "node read-host.cjs" });
    expect(hostRead.exitCode).not.toBe(0);
    await expect(access(join(workspace, "stolen.txt"))).rejects.toThrow();

    const gitWrite = await runShell({ ...options, command: "touch .git/escaped" });
    expect(gitWrite.exitCode).not.toBe(0);
    await expect(access(join(workspace, ".git", "escaped"))).rejects.toThrow();

    const server = createServer((socket) => socket.end("reachable"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
    await writeFile(join(workspace, "network.cjs"), [
      "const net = require('node:net');",
      `const socket = net.connect(${address.port}, '127.0.0.1', () => process.exit(0));`,
      "socket.on('error', () => process.exit(7));",
      "setTimeout(() => process.exit(8), 1000);",
    ].join("\n"));
    try {
      const network = await runShell({ ...options, command: "node network.cjs" });
      expect(network.exitCode).not.toBe(0);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it.runIf(sandboxAvailability().available)("allows read-only Git access in linked worktrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-sandbox-git-root-"));
    const worktrees = await mkdtemp(join(tmpdir(), "kulmi-sandbox-git-worktrees-"));
    const worktree = join(worktrees, "worker");
    await exec("git", ["init", root]);
    await exec("git", ["-C", root, "config", "user.email", "test@example.test"]);
    await exec("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "tracked.txt"), "tracked\n");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-m", "initial"]);
    await exec("git", ["-C", root, "worktree", "add", worktree, "HEAD"]);

    const result = await runShell({
      command: "git status --short",
      cwd: worktree,
      workspaceRoot: worktree,
      sandbox: { mode: "required", network: false },
      signal: new AbortController().signal,
      timeoutMs: 10_000,
      maxOutputBytes: 20_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("cancels delayed force-kill escalation after the child exits", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-process-cancel-"));
    const abort = new AbortController();
    const kill = vi.spyOn(process, "kill");
    try {
      const operation = runShell({
        command: "trap 'exit 0' TERM; while :; do :; done",
        cwd: workspace,
        workspaceRoot: workspace,
        sandbox: { mode: "off", network: false },
        signal: abort.signal,
        timeoutMs: 10_000,
        maxOutputBytes: 20_000,
      });
      setTimeout(() => abort.abort(new Error("test cancellation")), 50);
      await expect(operation).rejects.toThrow("test cancellation");
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      expect(kill.mock.calls.some((call) => call[1] === "SIGKILL")).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });
});
