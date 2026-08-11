import { resolve } from "node:path";
import { parse, type ParseEntry } from "shell-quote";
import type { AutonomyLevel } from "../core/types.js";
import { assertNotSensitivePath } from "./paths.js";

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
  redirectPaths: string[];
}

const rank: Record<AutonomyLevel, number> = { read: 0, low: 1, medium: 2, high: 3, trusted: 4 };
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
  "watch", "parallel", "setsid", "chroot", "nsenter", "unshare", "su", "runuser", "doas", "pkexec",
  "stdbuf", "script", "taskset", "strace", "dtrace", "ionice",
  "case", "if", "then", "else", "while", "until", "for", "do", "done",
  ".", "busybox",
]);
const shellInterpreters: Record<string, true> = {
  ash: true,
  bash: true,
  csh: true,
  dash: true,
  elvish: true,
  fish: true,
  ksh: true,
  ksh93: true,
  mksh: true,
  powershell: true,
  pwsh: true,
  sh: true,
  tcsh: true,
  yash: true,
  zsh: true,
};
const allowedShellInterpreters: Record<string, true> = { bash: true, sh: true, zsh: true };
const trustedStillBlockedPrograms = new Set([
  "sudo", "eval", "source", "rm", "rmdir", "mkfs", "fdisk", "shutdown", "reboot", "halt",
  "gh", "aws", "gcloud", "az", "twine", "builtin", "command", "exec", ".", "busybox",
  "nohup", "nice", "timeout", "time", "watch", "parallel", "setsid", "chroot", "nsenter", "unshare",
  "su", "runuser", "doas", "pkexec", "stdbuf", "script", "taskset", "strace", "dtrace", "ionice",
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
  if (commands.some((parsed) => [...parsed.argv, ...parsed.redirectPaths].some(isSensitiveToken))) {
    return blocked("sensitive file access requires an approval flow");
  }

  let highest = 0;
  let verification = false;
  for (const parsed of commands) {
    const analysis = analyzeArgv(parsed.argv, autonomy === "trusted");
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
  const commands: ParsedCommand[] = [];
  for (const line of splitShellLines(command)) {
    if (line.trim()) collectLineCommands(line, commands);
  }
  return commands;
}

// shell-quote treats a newline as ordinary whitespace, but bash treats it as a
// command separator. Splitting here first keeps the policy's view of the command
// list identical to what `/bin/bash -c` actually executes; without it a second
// line is absorbed as arguments of the first command and never classified.
function splitShellLines(command: string): string[] {
  const lines: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote === "'") {
      current += char;
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      const next = command[index + 1] ?? "";
      if (next === "\n" || next === "\r") {
        // Line continuation: bash removes the backslash and the newline entirely
        // and joins the surrounding text, so it is not a command separator.
        index += next === "\r" && command[index + 2] === "\n" ? 2 : 1;
        continue;
      }
      // Any other backslash escapes exactly one following character.
      current += char + next;
      index += 1;
      continue;
    }
    if (quote === "\"") {
      current += char;
      if (char === "\"") quote = undefined;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\n" || char === "\r") {
      lines.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("unbalanced quote");
  lines.push(current);
  return lines;
}

function collectLineCommands(line: string, commands: ParsedCommand[]): void {
  const entries = collapseAmpersandRedirects(parse(line, (key) => `$${key}`));
  let argv: string[] = [];
  let writesRedirect = false;
  let redirectPaths: string[] = [];
  let nextIsRedirectPath = false;
  let previousWasInput = false;

  const flush = () => {
    // A redirect with no program of its own still writes its target, so it must
    // not be silently dropped. Attribute it to the preceding command when
    // there is one, otherwise keep an empty argv that analyzeArgv rejects.
    if (argv.length === 0) {
      if (writesRedirect) {
        const previous = commands.at(-1);
        if (previous) {
          previous.writesRedirect = true;
          previous.redirectPaths.push(...redirectPaths);
        } else {
          commands.push({ argv, writesRedirect, redirectPaths });
        }
      }
    } else {
      commands.push({ argv, writesRedirect, redirectPaths });
    }
    argv = [];
    writesRedirect = false;
    redirectPaths = [];
    nextIsRedirectPath = false;
  };

  for (const entry of entries) {
    const afterInputRedirect = previousWasInput;
    previousWasInput = false;
    if (typeof entry === "string") {
      if (nextIsRedirectPath) {
        redirectPaths.push(entry);
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
    // A heredoc body is data, not commands, but splitting on newlines would
    // classify each body line as its own command: harmless prose mentioning a
    // blocked program would be rejected, and the delimiter would parse as a
    // program. Teaching this parser the heredoc grammar is exactly the surface
    // that produced the bypasses above, so reject them the way subshells and
    // command substitution already are.
    // shell-quote emits `<<<` at runtime even though its ControlOperator union
    // omits it, so widen before comparing rather than asserting a shape.
    const operator: string = entry.op;
    if (operator === "<<<") throw new Error("herestrings are blocked");
    if (entry.op === "<") {
      if (afterInputRedirect) throw new Error("heredocs are blocked");
      previousWasInput = true;
      nextIsRedirectPath = true;
      continue;
    }
    flush();
  }
  flush();
}

// bash parses `&>` and `&>>` as a single redirect of both stdout and stderr, but
// shell-quote reports them as a `&` separator followed by a `>` redirect. Left
// alone that flushes the real command and strands the redirect on an empty argv,
// so the write disappears from the risk assessment.
function collapseAmpersandRedirects(entries: ParseEntry[]): ParseEntry[] {
  const collapsed: ParseEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const next = entries[index + 1];
    if (
      typeof entry === "object" && entry !== null && "op" in entry && entry.op === "&" &&
      typeof next === "object" && next !== null && "op" in next && (next.op === ">" || next.op === ">>")
    ) {
      collapsed.push(next);
      index += 1;
      continue;
    }
    if (entry === undefined) continue;
    collapsed.push(entry);
  }
  return collapsed;
}

function analyzeArgv(input: string[], trusted: boolean): {
  risk: Exclude<CommandRisk, "blocked">;
  blocked?: string;
  verification: boolean;
} {
  const unwrapped = unwrapEnvironment(input);
  if (unwrapped.blocked) return { risk: "read", blocked: unwrapped.blocked, verification: false };
  const argv = unwrapped.argv;
  const program = basename(argv[0] ?? "");
  if (!program || program.startsWith("-")) return { risk: "read", blocked: "missing program", verification: false };
  if (blockedPrograms.has(program) && (!trusted || trustedStillBlockedPrograms.has(program))) {
    return { risk: "read", blocked: `${program} is blocked without an approval flow`, verification: false };
  }
  if (shellInterpreters[program]) {
    if (!allowedShellInterpreters[program]) {
      return { risk: "read", blocked: `${program} is not an allowed shell interpreter`, verification: false };
    }
    if (argv.slice(1).some((arg) => arg === "--command" || arg.startsWith("--command=") || /^-[^-]*c/.test(arg))) {
      return { risk: "read", blocked: "nested shells are blocked", verification: false };
    }
    const script = shellScriptPath(argv.slice(1));
    if (!script) {
      return { risk: "read", blocked: "direct shell execution is blocked; invoke a workspace script", verification: false };
    }
    return { risk: "medium", verification: isValidator([program, script]) };
  }
  if (["deno", "bun"].includes(program)) {
    return { risk: "read", blocked: `direct ${program} execution is blocked; use a declared project script`, verification: false };
  }
  if (program === "node") {
    if (!trusted && argv.slice(1).some((arg) => ["-e", "--eval", "-p", "--print"].includes(arg))) {
      return { risk: "read", blocked: "direct node -e/--eval execution is blocked; use a declared project script", verification: false };
    }
    const firstPositional = argv.slice(1).find((arg) => !arg.startsWith("-"));
    if (firstPositional || trusted) return { risk: "medium", verification: isValidator(argv) };
    return { risk: "read", blocked: "direct node execution is blocked; use a declared project script", verification: false };
  }
  if (["python", "python3"].includes(program)) {
    if (argv[1] === "-m" && argv[2] === "pytest") return { risk: "medium", verification: true };
    if (!trusted && argv.slice(1).some((arg) => arg === "-c" || arg === "-m")) {
      return { risk: "read", blocked: `direct ${program} execution is blocked; use a declared project script`, verification: false };
    }
    const firstPositional = argv.slice(1).find((arg) => !arg.startsWith("-"));
    if (firstPositional || trusted) return { risk: "medium", verification: isValidator(argv) };
    return { risk: "read", blocked: `direct ${program} execution is blocked; use a declared project script`, verification: false };
  }
  if (program === "find" && argv.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg))) {
    return { risk: "read", blocked: "mutating find actions are blocked", verification: false };
  }
  if (program === "sed" && argv.some((arg) => /^-[^-]*i/.test(arg) || arg === "--in-place" || arg.startsWith("--in-place="))) {
    return { risk: "read", blocked: "in-place sed edits are blocked; use edit_file", verification: false };
  }
  if (program === "git") return analyzeGit(argv, trusted);
  if (!trusted && ["npm", "pnpm", "yarn"].includes(program) && ["exec", "dlx"].includes(argv[1] ?? "")) {
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

function analyzeGit(argv: string[], trusted: boolean): {
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
  if (trusted && ["add", "commit", "mv"].includes(subcommand)) {
    return { risk: "high", verification: false };
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

interface UnwrappedEnvironment {
  argv: string[];
  blocked?: string;
}

function unwrapEnvironment(input: string[]): UnwrappedEnvironment {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(input[index] ?? "")) index += 1;
  if (basename(input[index] ?? "") !== "env") return { argv: input.slice(index) };
  index += 1;
  while (index < input.length) {
    const arg = input[index] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      index += 1;
      continue;
    }
    if (arg === "--") {
      index += 1;
      break;
    }
    if (arg === "-S" || arg === "--split-string" || arg.startsWith("--split-string=") || /^-[^-]*S/.test(arg)) {
      return { argv: [], blocked: "env -S/--split-string is blocked" };
    }
    if (["-i", "--ignore-environment", "-0", "--null"].includes(arg)) {
      index += 1;
      continue;
    }
    if (["-u", "--unset", "-C", "--chdir", "-P", "--path"].includes(arg)) {
      const value = input[index + 1] ?? "";
      if (!value || value.startsWith("-")) {
        return { argv: [], blocked: `${arg} requires an option value` };
      }
      index += 2;
      continue;
    }
    if (/^--(?:unset|chdir|path)=/.test(arg)) {
      if (arg.endsWith("=")) return { argv: [], blocked: `${arg.slice(0, -1)} requires an option value` };
      index += 1;
      continue;
    }
    if (/^-u.+/.test(arg) || /^-[CP].+/.test(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) return { argv: [], blocked: `env option ${arg} is blocked` };
    break;
  }
  return { argv: input.slice(index) };
}

function isPackageMutation(argv: string[]): boolean {
  const program = basename(argv[0] ?? "");
  const command = argv[1] ?? "";
  return (
    (["npm", "pnpm", "yarn"].includes(program) && ["install", "add", "remove", "update", "ci"].includes(command)) ||
    (["pip", "pip3", "pipx", "uv", "cargo", "go"].includes(program) && ["install", "add", "get", "update"].includes(command))
  );
}

// Names that identify a script as a verification step. A passing check that is
// not recognized here is worse than cosmetic: completion is gated on a recorded
// verification, so the agent is pushed into writing a throwaway wrapper script
// just to get its real check acknowledged.
const validatorScriptPattern = /(?:^|[._-])(?:tests?|spec|verify|verification|check|checks|smoke|sanity|validate|validation|e2e|lint|typecheck)(?:$|[._-])/i;

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
  if (["node", "python", "python3"].includes(program)) {
    if (program === "node" && args.includes("--test")) return true;
    const script = args.find((arg) => !arg.startsWith("-"));
    return Boolean(script && validatorScriptPattern.test(basename(script)));
  }
  return validatorScriptPattern.test(program);
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

function shellScriptPath(args: string[]): string | undefined {
  let consumeNext = false;
  for (const arg of args) {
    if (consumeNext) {
      consumeNext = false;
      continue;
    }
    if (["-o", "+o", "-O", "+O", "--rcfile", "--init-file"].includes(arg)) {
      consumeNext = true;
      continue;
    }
    if (arg === "--") continue;
    if (!arg.startsWith("-") && !arg.startsWith("+")) return arg;
  }
  return undefined;
}

function isSensitiveToken(token: string): boolean {
  const candidates = new Set<string>([token]);
  for (const part of token.split("=")) candidates.add(part);
  for (const candidate of candidates) {
    const value = candidate.replace(/^[([{]+/, "").replace(/[),;]+$/, "");
    if (!value || value.startsWith("-")) continue;
    try {
      assertNotSensitivePath(value);
    } catch {
      return true;
    }
  }
  return false;
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
