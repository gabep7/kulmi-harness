#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { configTemplate, findWorkspaceRoot, loadConfig, type SearchMode } from "./config/config.js";
import { EventBus } from "./core/events.js";
import { VERSION } from "./core/version.js";
import type { AutonomyLevel, OutputFormat } from "./core/types.js";
import { SessionController } from "./runtime/controller.js";
import { forkSession, listSessions, SessionStore } from "./runtime/session-store.js";
import { estimateCost, formatCost } from "./provider/pricing.js";
import { attachRenderer } from "./cli/render.js";
import { runRpcServer } from "./rpc/server.js";
import type { PermissionRequest } from "./tools/types.js";
import { runTui } from "./tui/index.js";
import { acceptCredential, resolveExistingCredential, type CredentialKind } from "./auth/credentials.js";
import { CredentialSetupCancelledError, runCredentialOnboarding } from "./tui/onboarding.js";
import { sandboxAvailability } from "./runtime/process.js";
import { resolveToolBinary } from "./runtime/binaries.js";

type ApprovalMode = "never" | "on-request";

const program = new Command();
program
  .name("kulmi")
  .description("MiMo V2.5-native autonomous coding agent")
  // Program-level options (for the bare TUI) and subcommands like `exec` both
  // declare --auto/--model/etc. Without positional options the parent swallows
  // them, so `kulmi exec --auto medium` would silently run read-only.
  .enablePositionalOptions()
  .version(VERSION)
  .option("-m, --model <name>", "model profile")
  .option("--auto <level>", "autonomy: read, low, medium, high", "medium")
  .option("--web-search <mode>", "web search: off or free")
  .option("--approval-mode <mode>", "approvals: never or on-request", "on-request")
  .option("-s, --session-id <id>", "resume a session")
  .action(async (options: { model?: string; auto: string; webSearch?: string; approvalMode: string; sessionId?: string }) => {
    const credentialModel = await credentialModelFor(options.model, options.sessionId, process.cwd());
    const existing = await resolveExistingCredential({
      cwd: process.cwd(),
      ...(credentialModel ? { requestedModel: credentialModel } : {}),
    });
    let model = existing?.model;
    if (!existing) {
      const initial = credentialKindForModel(credentialModel, process.cwd());
      const choice = await runCredentialOnboarding(initial);
      const accepted = await acceptCredential({
        choice,
        cwd: process.cwd(),
        ...(credentialModel ? { requestedModel: credentialModel } : {}),
      });
      model = accepted.model;
      if (!accepted.stored) {
        process.stderr.write(`${pc.yellow("warning")} macOS Keychain was unavailable; the key is active only for this process\n`);
      }
    }
    await runTui({
      cwd: process.cwd(),
      autonomy: parseAutonomy(options.auto),
      approvalMode: parseApprovalMode(options.approvalMode),
      ...(model ? { model } : {}),
      ...(options.webSearch ? { webSearch: parseSearchMode(options.webSearch) } : {}),
      ...(options.sessionId ? { resumeSessionId: options.sessionId } : {}),
    });
  });

program
  .command("rpc")
  .description("run the newline-delimited JSON-RPC app bridge")
  .option("--cwd <path>", "default workspace", process.cwd())
  .action(async (options: { cwd: string }) => {
    await runRpcServer(options.cwd);
  });

program
  .command("exec")
  .description("run one headless task")
  .argument("[prompt...]", "task prompt")
  .option("-m, --model <name>", "model profile")
  .option("--auto <level>", "autonomy: read, low, medium, high", "read")
  .option("-o, --output-format <format>", "text, json, or stream-json", "text")
  .option("-s, --session-id <id>", "resume a session")
  .option("--web-search <mode>", "web search: off or free")
  .option("--approval-mode <mode>", "approvals: never or on-request", "never")
  .action(async (
    words: string[],
    options: { model?: string; auto: string; outputFormat: string; sessionId?: string; webSearch?: string; approvalMode: string },
  ) => {
    const prompt = words.join(" ").trim() || await readStdin();
    if (!prompt) throw new Error("a prompt is required");
    await execute({
      prompt,
      autonomy: parseAutonomy(options.auto),
      format: parseOutputFormat(options.outputFormat),
      ...(options.model ? { model: options.model } : {}),
      ...(options.sessionId ? { resumeSessionId: options.sessionId } : {}),
      ...(options.webSearch ? { webSearch: parseSearchMode(options.webSearch) } : {}),
      approvalMode: parseApprovalMode(options.approvalMode),
    });
  });

program
  .command("init")
  .description("create a Kulmi config")
  .option("--global", "write ~/.config/kulmi/config.toml")
  .action(async (options: { global?: boolean }) => {
    const path = options.global
      ? join(homedir(), ".config", "kulmi", "config.toml")
      : join(process.cwd(), ".kulmi", "config.toml");
    if (existsSync(path)) {
      process.stdout.write(`config already exists at ${path}\n`);
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, configTemplate(), { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`created ${path}\n`);
  });

program
  .command("sessions")
  .description("list recent sessions")
  .option("-n, --limit <count>", "number of sessions", "20")
  .action(async (options: { limit: string }) => {
    const sessions = await listSessions(Number.parseInt(options.limit, 10));
    for (const session of sessions) {
      process.stdout.write(
        `${session.id}\t${session.status}\t${session.model}\t${session.updatedAt}\t${session.prompt ?? ""}\n`,
      );
    }
  });

program
  .command("usage")
  .description("show cumulative token usage and estimated cost")
  .option("-n, --limit <count>", "number of sessions", "100")
  .action(async (options: { limit: string }) => {
    const sessions = await listSessions(Number.parseInt(options.limit, 10));
    const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
    const perModel: Record<string, { tokens: number; cost: number }> = {};
    let count = 0;

    for (const session of sessions) {
      if (!session.usage) continue;
      count++;
      const u = session.usage;
      totals.promptTokens += u.promptTokens;
      totals.completionTokens += u.completionTokens;
      totals.totalTokens += u.totalTokens;
      totals.cacheHitTokens += u.cacheHitTokens;
      totals.cacheMissTokens += u.cacheMissTokens;

      const model = session.model;
      const entry = perModel[model] ??= { tokens: 0, cost: 0 };
      entry.tokens += u.totalTokens;
      entry.cost += estimateCost(model, u);
    }

    const totalCost = Object.values(perModel).reduce((sum, e) => sum + e.cost, 0);
    const hitRate = totals.promptTokens > 0
      ? (totals.cacheHitTokens / totals.promptTokens * 100)
      : 0;

    process.stdout.write(`Token usage (last ${sessions.length} sessions, ${count} with data):\n`);
    process.stdout.write(`  Input (cache hit):   ${totals.cacheHitTokens.toLocaleString()} tokens\n`);
    process.stdout.write(`  Input (cache miss):  ${totals.cacheMissTokens.toLocaleString()} tokens\n`);
    process.stdout.write(`  Output:              ${totals.completionTokens.toLocaleString()} tokens\n`);
    process.stdout.write(`  Total:               ${totals.totalTokens.toLocaleString()} tokens\n`);
    process.stdout.write(`  Cache hit rate:      ${hitRate.toFixed(1)}%\n`);
    process.stdout.write(`\n`);
    process.stdout.write(`Estimated cost (pay-as-you-go rates):\n`);
    process.stdout.write(`  ${formatCost(totalCost)} USD\n`);

    const modelNames = Object.keys(perModel);
    if (modelNames.length > 0) {
      process.stdout.write(`\n`);
      process.stdout.write(`Per-model breakdown:\n`);
      const maxNameLen = Math.max(...modelNames.map(n => n.length));
      for (const model of modelNames) {
        const entry = perModel[model]!;
        const padded = model.padEnd(maxNameLen);
        process.stdout.write(`  ${pc.bold(padded)}  ${entry.tokens.toLocaleString()} tokens  ${pc.cyan(formatCost(entry.cost))}\n`);
      }
    }
  });

program
  .command("fork")
  .description("fork a durable session into a new independent session")
  .argument("<session-id>")
  .action(async (sessionId: string) => {
    const session = await forkSession(sessionId);
    process.stdout.write(`${session.id}\t${session.cwd}\t${session.model}\n`);
  });

program
  .command("undo")
  .description("revert the latest completed turn in a durable session")
  .argument("<session-id>")
  .action(async (sessionId: string) => {
    const requestedModel = await credentialModelFor(undefined, sessionId, process.cwd());
    await resolveExistingCredential({
      cwd: process.cwd(),
      ...(requestedModel ? { requestedModel } : {}),
    });
    const controller = await SessionController.create({
      cwd: process.cwd(),
      mode: "chat",
      resumeSessionId: sessionId,
    });
    try {
      const undone = await controller.undo();
      process.stdout.write(
        `${undone.checkpointId}\t${undone.files.length} files\tmessage history ${undone.messageHistory}\n`,
      );
    } finally {
      await controller.close();
    }
  });

program
  .command("doctor")
  .description("check local harness prerequisites and configuration")
  .action(async () => {
    const credential = await resolveExistingCredential({ cwd: process.cwd() });
    const config = loadConfig(process.cwd());
    const root = findWorkspaceRoot(process.cwd());
    const gitVersion = commandOutput("git", ["--version"]);
    const gitWorkspace = commandOutput("git", ["-C", process.cwd(), "rev-parse", "--show-toplevel"]);
    const profile = credential?.model ?? config.defaultModel;
    const selected = config.models[profile];
    const selectedKey = selected ? process.env[selected.apiKeyEnv] : undefined;
    const sandbox = sandboxAvailability();
    const astGrepBinary = await resolveToolBinary("sg");
    const lspBinary = await resolveToolBinary("typescript-language-server");
    const ripgrepBinary = await resolveToolBinary("rg");
    const checks = [
      ["node", Number.parseInt(process.versions.node, 10) >= 22, process.versions.node],
      ["git", Boolean(gitVersion), gitVersion || "missing"],
      ["workspace", Boolean(gitWorkspace), gitWorkspace || `${root} is not a git worktree`],
      ["model", Boolean(selected), profile],
      ["credential", Boolean(selectedKey), selected ? `${selected.apiKeyEnv} ${selectedKey ? "set" : "missing"}` : "unknown profile"],
      ["sandbox", config.sandbox.mode === "off" || sandbox.available, config.sandbox.mode === "off" ? "disabled by configuration" : `${sandbox.backend} ${sandbox.detail}`],
      ["ast-grep", Boolean(astGrepBinary), astGrepBinary ?? "sg missing; run npm install or add sg to PATH"],
      ["lsp", Boolean(lspBinary), lspBinary ?? "typescript-language-server missing; run npm install or add it to PATH"],
      ["ripgrep", Boolean(ripgrepBinary), ripgrepBinary ?? "rg missing; run npm install or add rg to PATH"],
      ["search", true, config.search.mode === "free" ? config.search.provider : "off"],
    ] as const;
    for (const [name, ok, detail] of checks) {
      process.stdout.write(`${ok ? "ok" : "warn"}\t${name}\t${detail}\n`);
    }
    if (checks.slice(0, 9).some(([, ok]) => !ok)) process.exitCode = 1;
  });

program
  .command("auth")
  .description("change the MiMo API or Token Plan credential")
  .option("--token-plan", "select Token Plan initially")
  .action(async (options: { tokenPlan?: boolean }) => {
    const choice = await runCredentialOnboarding(options.tokenPlan ? "token-plan" : "api");
    const accepted = await acceptCredential({ choice, cwd: process.cwd() });
    process.stdout.write(
      accepted.stored
        ? `saved ${accepted.kind} credential in macOS Keychain\n`
        : `credential accepted for this process; macOS Keychain was unavailable\n`,
    );
  });

program.parseAsync().catch((error: unknown) => {
  if (error instanceof CredentialSetupCancelledError) {
    process.exitCode = 130;
    return;
  }
  process.stderr.write(`${pc.red("error")} ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function execute(options: {
  prompt: string;
  model?: string;
  autonomy: AutonomyLevel;
  format: OutputFormat;
  resumeSessionId?: string;
  webSearch?: SearchMode;
  approvalMode: ApprovalMode;
}): Promise<void> {
  const credentialModel = await credentialModelFor(options.model, options.resumeSessionId, process.cwd());
  const credential = await resolveExistingCredential({
    cwd: process.cwd(),
    ...(credentialModel ? { requestedModel: credentialModel } : {}),
  });
  const events = new EventBus();
  const detach = attachRenderer(events, options.format, credential?.model ?? options.model);
  const approvalReadline = options.approvalMode === "on-request" && process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stderr })
    : undefined;
  const controller = await SessionController.create({
    cwd: process.cwd(),
    mode: "task",
    autonomy: options.autonomy,
    prompt: options.prompt,
    events,
    ...(credential?.model || options.model ? { model: credential?.model ?? options.model! } : {}),
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
    ...(options.webSearch ? { webSearch: options.webSearch } : {}),
    ...(approvalReadline ? { requestPermission: (request: PermissionRequest) => askPermission(approvalReadline, request) } : {}),
  });
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("interrupted"));
  process.once("SIGINT", interrupt);
  try {
    const result = await controller.run(options.prompt, abort.signal);
    if (options.format === "json") {
      process.stdout.write(`${JSON.stringify({
        type: "result",
        session_id: controller.sessionId,
        status: result.status,
        result: result.text,
      })}\n`);
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    detach();
    approvalReadline?.close();
    await controller.close();
  }
}

function parseAutonomy(value: string): AutonomyLevel {
  if (["read", "low", "medium", "high"].includes(value)) return value as AutonomyLevel;
  throw new Error(`invalid autonomy ${value}`);
}

function parseOutputFormat(value: string): OutputFormat {
  if (["text", "json", "stream-json"].includes(value)) return value as OutputFormat;
  throw new Error(`invalid output format ${value}`);
}

function parseSearchMode(value: string): SearchMode {
  if (["off", "free"].includes(value)) return value as SearchMode;
  throw new Error(`invalid web search mode ${value}`);
}

function parseApprovalMode(value: string): ApprovalMode {
  if (value === "never" || value === "on-request") return value;
  throw new Error(`invalid approval mode ${value}`);
}

function credentialKindForModel(model: string | undefined, cwd: string): CredentialKind {
  const profile = model ? loadConfig(cwd).models[model] : undefined;
  return profile?.billing === "token-plan" ? "token-plan" : "api";
}

async function credentialModelFor(
  model: string | undefined,
  sessionId: string | undefined,
  cwd: string,
): Promise<string | undefined> {
  if (model || !sessionId) return model;
  const { session } = await SessionStore.open(sessionId);
  if (session.metadata.modelProfile) return session.metadata.modelProfile;
  return Object.entries(loadConfig(cwd).models)
    .find(([, profile]) => profile.model === session.metadata.model)?.[0];
}

async function askPermission(
  readline: ReturnType<typeof createInterface>,
  request: PermissionRequest,
): Promise<boolean> {
  process.stderr.write(`\n${pc.yellow(pc.bold("approval required"))} ${pc.dim(`[${request.risk}]`)}\n`);
  process.stderr.write(`${request.reason}\n`);
  if (request.command) process.stderr.write(`${pc.cyan("command")} ${request.command}\n`);
  const answer = (await readline.question("Allow once? [y/N] ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let content = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) content += chunk;
  return content;
}

function commandOutput(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}
