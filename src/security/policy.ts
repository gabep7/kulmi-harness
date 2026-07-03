import { resolve } from "node:path";
import { parse, type ParseEntry } from "shell-quote";
import type { AutonomyLevel } from "../core/types.js";

export type CommandRisk = "read" | "low" | "medium" | "high" | "blocked";

export interface CommandDecision {
  allowed: boolean;
  risk: CommandRisk;
  reason: string;
  verification: boolean;
}

interface ParsedCommand {
  argv: string[];
  writesRedirect: boolean;
}

const rank: Record<AutonomyLevel, number> = { read: 0, low: 1, medium: 2, high: 3 };
const readPrograms = new Set([
  "cat", "cut", "diff", "du", "find", "git", "grep", "head", "ls", "pwd", "rg",
  "sed", "stat", "tail", "tree", "type", "uname", "wc", "which",
]);
const lowPrograms = new Set(["biome", "cp", "eslint", "mkdir", "mv", "prettier", "touch"]);
const blockedPrograms = new Set([
  "curl", "wget", "nc", "netcat", "ssh", "scp", "sftp", "rsync", "xargs", "sudo",
  "eval", "source", "rm", "rmdir", "mkfs", "fdisk", "shutdown", "reboot", "halt",
  "awk", "perl", "ruby", "npx", "cd", "pushd", "popd", "ln",
  "gh", "aws", "gcloud", "az", "twine",
  "builtin", "command", "exec", "nohup", "nice", "timeout", "time",
  "case", "if", "then", "else", "while", "until", "for", "do", "done",
  ".", "busybox",
]);

export function decideCommand(
  command: string,
  autonomy: AutonomyLevel,
  workspaceRoot?: string,
): CommandDecision {
  const trimmed = command.trim();
  if (!trimmed) return blocked("empty command");
  if (/[`]|\$\(/.test(trimmed)) return blocked("shell command substitution is blocked");
  if (/\$(?:\{HOME\}|HOME)|(?:^|\s)~(?:\/|\s|$)/.test(trimmed)) return blocked("home-directory shell paths are blocked");
  if (/(?:^|[\s/])\.\.(?:\/|$)/.test(trimmed)) return blocked("parent-directory shell paths are blocked");
  if (sensitivePathInCommand(trimmed)) return blocked("sensitive file access requires an approval flow");

  for (const path of absoluteShellPaths(trimmed)) {
    if (path === "/dev/null") continue;
    if (path.startsWith("~/")) return blocked("home-directory shell paths are blocked");
    const resolvedPath = resolve(path);
    const resolvedRoot = workspaceRoot ? resolve(workspaceRoot) : "";
    if (!workspaceRoot || (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}/`))) {
      return blocked(`shell path is outside workspace: ${path}`);
    }
  }

  let commands: ParsedCommand[];
  try {
    commands = parseCommands(trimmed);
  } catch (error) {
    return blocked(`cannot safely parse shell command: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (commands.length === 0) return blocked("empty command");

  let highest = 0;
  let verification = false;
  for (const parsed of commands) {
    const analysis = analyzeArgv(parsed.argv);
    if (analysis.blocked) return blocked(analysis.blocked);
    highest = Math.max(highest, parsed.writesRedirect ? 1 : riskNumber(analysis.risk));
    verification ||= analysis.verification;
  }

  const risk: Exclude<CommandRisk, "blocked"> = highest === 0
    ? "read"
    : highest === 1
      ? "low"
      : highest === 2
        ? "medium"
        : "high";
  if (rank[autonomy] < highest) {
    return {
      allowed: false,
      risk,
      reason: `${risk}-risk command exceeds ${autonomy} autonomy`,
      verification,
    };
  }
  return { allowed: true, risk, reason: `allowed at ${autonomy} autonomy`, verification };
}

function parseCommands(command: string): ParsedCommand[] {
  const entries = parse(command, (key) => `$${key}`);
  const commands: ParsedCommand[] = [];
  let argv: string[] = [];
  let writesRedirect = false;
  let nextIsRedirectPath = false;

  const flush = () => {
    if (argv.length > 0) commands.push({ argv, writesRedirect });
    argv = [];
    writesRedirect = false;
    nextIsRedirectPath = false;
  };

  for (const entry of entries) {
    if (typeof entry === "string") {
      if (nextIsRedirectPath) {
        nextIsRedirectPath = false;
        continue;
      }
      argv.push(entry);
      continue;
    }
    if ("comment" in entry) break;
    if (entry.op === "glob") {
      argv.push(entry.pattern);
      continue;
    }
    if (["(", ")", "<("].includes(entry.op)) throw new Error(`operator ${entry.op} is blocked`);
    if ([">", ">>", ">&"].includes(entry.op)) {
      writesRedirect = true;
      nextIsRedirectPath = true;
      continue;
    }
    if (entry.op === "<") {
      nextIsRedirectPath = true;
      continue;
    }
    flush();
  }
  flush();
  return commands;
}

function analyzeArgv(input: string[]): {
  risk: Exclude<CommandRisk, "blocked">;
  blocked?: string;
  verification: boolean;
} {
  if (input.some((arg) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg))) {
    return { risk: "read", blocked: "shell environment assignments are blocked", verification: false };
  }
  const argv = unwrapEnvironment(input);
  const program = basename(argv[0] ?? "");
  if (!program) return { risk: "read", blocked: "missing program", verification: false };
  if (blockedPrograms.has(program)) {
    return { risk: "read", blocked: `${program} is blocked without an approval flow`, verification: false };
  }
  if (["bash", "sh", "zsh"].includes(program) && argv.slice(1).some((arg) => arg === "-c" || arg === "--command")) {
    return { risk: "read", blocked: "nested shells are blocked", verification: false };
  }
  if (["deno", "bun"].includes(program)) {
    return { risk: "read", blocked: `direct ${program} execution is blocked; use a declared project script`, verification: false };
  }
  if (program === "node") {
    if (argv.slice(1).some((arg) => ["-e", "--eval", "-p", "--print"].includes(arg))) {
      return { risk: "read", blocked: "direct node -e/--eval execution is blocked; use a declared project script", verification: false };
    }
    const firstPositional = argv.slice(1).find((arg) => !arg.startsWith("-"));
    if (firstPositional) return { risk: "medium", verification: false };
    return { risk: "read", blocked: "direct node execution is blocked; use a declared project script", verification: false };
  }
  if (["python", "python3"].includes(program)) {
    if (argv[1] === "-m" && argv[2] === "pytest") return { risk: "medium", verification: true };
    if (argv.slice(1).some((arg) => arg === "-c" || arg === "-m")) {
      return { risk: "read", blocked: `direct ${program} execution is blocked; use a declared project script`, verification: false };
    }
    const firstPositional = argv.slice(1).find((arg) => !arg.startsWith("-"));
    if (firstPositional) return { risk: "medium", verification: false };
    return { risk: "read", blocked: `direct ${program} execution is blocked; use a declared project script`, verification: false };
  }
  if (program === "find" && argv.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg))) {
    return { risk: "read", blocked: "mutating find actions are blocked", verification: false };
  }
  if (program === "sed" && argv.some((arg) => /^-[^-]*i/.test(arg) || arg === "--in-place" || arg.startsWith("--in-place="))) {
    return { risk: "read", blocked: "in-place sed edits are blocked; use edit_file", verification: false };
  }
  if (program === "git") return analyzeGit(argv);
  if (["npm", "pnpm", "yarn"].includes(program) && ["exec", "dlx"].includes(argv[1] ?? "")) {
    return { risk: "read", blocked: `${program} ${argv[1]} is blocked`, verification: false };
  }
  if (
    (["npm", "pnpm", "yarn"].includes(program) &&
      ["publish", "unpublish", "login", "logout", "owner", "access", "deprecate", "dist-tag", "token"].includes(argv[1] ?? "")) ||
    (program === "cargo" && argv[1] === "publish") ||
    (["npm", "pnpm", "yarn"].includes(program) && argv[1] === "run" && /^(?:deploy|release|publish)(?::|$)/.test(argv[2] ?? ""))
  ) {
    return { risk: "read", blocked: "publication and deployment commands are blocked", verification: false };
  }
  if ((program === "go" || program === "cargo") && argv[1] === "run") {
    return { risk: "read", blocked: `${program} run is blocked`, verification: false };
  }
  if (["docker", "podman", "kubectl", "terraform", "pulumi", "vercel", "flyctl"].includes(program)) {
    return { risk: "high", blocked: `${program} is blocked because it can control external or privileged infrastructure`, verification: false };
  }

  const verification = isValidator(argv);
  if (readPrograms.has(program)) return { risk: "read", verification };
  if (lowPrograms.has(program)) return { risk: "low", verification };
  if (isPackageMutation(argv)) return { risk: "medium", verification };
  return { risk: "medium", verification };
}

function analyzeGit(argv: string[]): {
  risk: Exclude<CommandRisk, "blocked">;
  blocked?: string;
  verification: boolean;
} {
  let index = 1;
  while (index < argv.length) {
    const arg = argv[index] ?? "";
    if (arg === "-c") {
      return { risk: "read", blocked: "git -c configuration overrides are blocked", verification: false };
    }
    if (["-C", "--git-dir", "--work-tree", "--namespace"].includes(arg)) {
      index += 2;
      continue;
    }
    if (/^--(?:git-dir|work-tree|namespace)=/.test(arg) || arg.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  const subcommand = argv[index] ?? "";
  const args = argv.slice(index + 1);
  if (["push", "clean"].includes(subcommand)) {
    return { risk: "read", blocked: `git ${subcommand} is blocked`, verification: false };
  }
  if (["config", "alias"].includes(subcommand)) {
    return { risk: "read", blocked: `git ${subcommand} is blocked`, verification: false };
  }
  if ([
    "add", "commit", "merge", "rebase", "cherry-pick", "checkout", "restore", "switch",
    "stash", "tag", "worktree", "apply", "am", "mv", "rm", "pull", "fetch",
  ].includes(subcommand)) {
    return { risk: "read", blocked: `git ${subcommand} is blocked without an approval flow`, verification: false };
  }
  if (subcommand === "reset" && args.includes("--hard")) {
    return { risk: "read", blocked: "git reset --hard is blocked", verification: false };
  }
  if (["checkout", "restore"].includes(subcommand) && args.includes("--")) {
    return { risk: "read", blocked: `destructive git ${subcommand} is blocked`, verification: false };
  }
  if (subcommand === "branch" && args.some((arg) => arg === "-D" || arg === "--delete")) {
    return { risk: "read", blocked: "git branch deletion is blocked", verification: false };
  }
  if (["status", "diff", "log", "show", "rev-parse", "ls-files", "grep", "blame"].includes(subcommand)) {
    return { risk: "read", verification: false };
  }
  if (subcommand === "branch") {
    const readFlags = new Set(["--show-current", "--list", "-a", "--all", "-r", "--remotes", "-v", "-vv"]);
    if (args.length === 0 || args.every((arg) => readFlags.has(arg))) {
      return { risk: "read", verification: false };
    }
    return { risk: "read", blocked: "git branch mutation is blocked", verification: false };
  }
  return {
    risk: "read",
    blocked: `git ${subcommand || "operation"} is not in the read-only allowlist`,
    verification: false,
  };
}

function unwrapEnvironment(input: string[]): string[] {
  let argv = input.slice();
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] ?? "")) argv.shift();
  if (basename(argv[0] ?? "") !== "env") return argv;
  argv.shift();
  while (argv.length > 0 && ((argv[0] ?? "").startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] ?? ""))) {
    argv.shift();
  }
  return argv;
}

function isPackageMutation(argv: string[]): boolean {
  const program = basename(argv[0] ?? "");
  const command = argv[1] ?? "";
  return (
    (["npm", "pnpm", "yarn"].includes(program) && ["install", "add", "remove", "update", "ci"].includes(command)) ||
    (["pip", "pip3", "pipx", "uv", "cargo", "go"].includes(program) && ["install", "add", "get", "update"].includes(command))
  );
}

function isValidator(argv: string[]): boolean {
  const program = basename(argv[0] ?? "");
  const args = argv.slice(1);
  if (["pytest", "vitest", "jest", "tsc"].includes(program)) return true;
  if (["eslint", "biome"].includes(program)) return !args.includes("--fix") && !args.includes("--write");
  if (["npm", "pnpm", "yarn"].includes(program)) {
    const script = args[0] === "run" ? args[1] : args[0];
    return Boolean(script && /^(?:test|check|typecheck|lint|build)(?::|$)/.test(script));
  }
  if (program === "cargo") return ["test", "check", "clippy", "build"].includes(args[0] ?? "");
  if (program === "go") return args[0] === "test";
  if (program === "make") return args.some((arg) => /^(?:test|check|lint|build)$/.test(arg));
  return false;
}

function riskNumber(risk: Exclude<CommandRisk, "blocked">): number {
  return risk === "read" ? 0 : risk === "low" ? 1 : risk === "medium" ? 2 : 3;
}

function blocked(reason: string): CommandDecision {
  return { allowed: false, risk: "blocked", reason, verification: false };
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function sensitivePathInCommand(command: string): boolean {
  return (
    /(?:^|[\s/])\.env(?!\.(?:example|sample|template))(?:\.[^\s/]*)?(?:$|[\s])/i.test(command) ||
    /(?:^|[\s/])(?:id_rsa|id_ed25519|\.npmrc|\.pypirc|credentials\.json|[^\s/]+\.(?:pem|key))(?:$|[\s])/i.test(command)
  );
}

function absoluteShellPaths(command: string): string[] {
  const paths: string[] = [];
  const pattern = /(?:^|[\s"'=<>])((?:~\/|\/)[^\s"'|;&]+)/g;
  for (const match of command.matchAll(pattern)) {
    const path = match[1]?.replace(/[),]+$/, "");
    if (path) paths.push(path);
  }
  return paths;
}
