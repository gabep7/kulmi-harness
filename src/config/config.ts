import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import type { AutonomyLevel } from "../core/types.js";
import { registerSecretEnvNames } from "../core/redact.js";

export type SearchMode = "off" | "free";
export type FreeSearchProvider = "auto" | "searxng" | "bing-rss";
export type SandboxMode = "required" | "off";
export type UndoMessageHistory = "truncate" | "keep";

export type ModelProtocol = "openai" | "anthropic";

export interface ModelConfig {
  model: string;
  provider?: string;
  protocol?: ModelProtocol;
  baseUrl: string;
  apiKeyEnv: string;
  thinking: boolean;
  reasoningEffort?: string;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SearchConfig {
  mode: SearchMode;
  resultLimit: number;
  provider: FreeSearchProvider;
  searxngUrl: string;
}

export interface SandboxConfig {
  mode: SandboxMode;
  network: boolean;
}

export interface UndoConfig {
  messageHistory: UndoMessageHistory;
}

export interface HookScriptConfig {
  tool?: string;
  command: string;
  timeoutSeconds: number;
}

export interface HooksConfig {
  toolPre: HookScriptConfig[];
  toolPost: HookScriptConfig[];
}

export interface KulmiConfig {
  defaultModel: string;
  defaultAutonomy: AutonomyLevel;
  maxSteps: number;
  maxSubagents: number;
  commandTimeoutSeconds: number;
  maxOutputBytes: number;
  models: Record<string, ModelConfig>;
  search: SearchConfig;
  sandbox: SandboxConfig;
  undo: UndoConfig;
  hooks: HooksConfig;
  mcpServers: McpServerConfig[];
}

export interface ResolvedModel extends ModelConfig {
  name: string;
  apiKey: string;
}

const modelDefaults: ModelConfig = {
  model: "",
  baseUrl: "",
  apiKeyEnv: "API_KEY",
  thinking: false,
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
};

const defaults: KulmiConfig = {
  defaultModel: "",
  defaultAutonomy: "medium",
  maxSteps: 80,
  maxSubagents: 3,
  commandTimeoutSeconds: 120,
  maxOutputBytes: 200_000,
  models: {},
  search: {
    mode: "free",
    resultLimit: 5,
    provider: "auto",
    searxngUrl: "",
  },
  sandbox: {
    mode: "required",
    network: false,
  },
  undo: {
    messageHistory: "truncate",
  },
  hooks: {
    toolPre: [],
    toolPost: [],
  },
  mcpServers: [],
};

const httpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "must use http or https");
const positiveInt = z.number().int().positive();
const mcpServerFileSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
}).strict();
const modelFileSchema = z.object({
  provider: z.string().min(1).optional(),
  protocol: z.enum(["openai", "anthropic"]).optional(),
  model: z.string().min(1).optional(),
  base_url: httpUrlSchema.optional(),
  baseUrl: httpUrlSchema.optional(),
  api_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  thinking: z.boolean().optional(),
  reasoning_effort: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  context_window: positiveInt.optional(),
  contextWindow: positiveInt.optional(),
  max_output_tokens: positiveInt.optional(),
  maxOutputTokens: positiveInt.optional(),
}).strict();
const searchFileSchema = z.object({
  mode: z.enum(["off", "free"]).optional(),
  result_limit: z.number().int().min(1).max(10).optional(),
  resultLimit: z.number().int().min(1).max(10).optional(),
  provider: z.enum(["auto", "searxng", "bing-rss"]).optional(),
  searxng_url: z.union([z.literal(""), httpUrlSchema]).optional(),
  searxngUrl: z.union([z.literal(""), httpUrlSchema]).optional(),
}).strict();
const sandboxFileSchema = z.object({
  mode: z.enum(["required", "off"]).optional(),
  network: z.boolean().optional(),
}).strict();
const undoFileSchema = z.object({
  message_history: z.enum(["truncate", "keep"]).optional(),
  messageHistory: z.enum(["truncate", "keep"]).optional(),
}).strict();
const defaultFileSchema = z.object({
  default_model: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  default_autonomy: z.enum(["read", "low", "medium", "high", "trusted"]).optional(),
  defaultAutonomy: z.enum(["read", "low", "medium", "high", "trusted"]).optional(),
}).strict();
const hookScriptFileSchema = z.union([
  z.string().min(1),
  z.object({
    command: z.string().min(1),
    tool: z.string().min(1).optional(),
    timeout_seconds: z.number().int().min(1).max(1_800).optional(),
    timeoutSeconds: z.number().int().min(1).max(1_800).optional(),
  }).strict(),
]);
const hooksFileSchema = z.object({
  tool_pre: z.array(hookScriptFileSchema).optional(),
  toolPre: z.array(hookScriptFileSchema).optional(),
  tool_post: z.array(hookScriptFileSchema).optional(),
  toolPost: z.array(hookScriptFileSchema).optional(),
}).strict();
const fileConfigSchema = z.object({
  default_model: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  default_autonomy: z.enum(["read", "low", "medium", "high", "trusted"]).optional(),
  defaultAutonomy: z.enum(["read", "low", "medium", "high", "trusted"]).optional(),
  max_steps: z.number().int().min(1).max(10_000).optional(),
  max_subagents: z.number().int().min(1).max(64).optional(),
  command_timeout_seconds: z.number().int().min(1).max(1_800).optional(),
  max_output_bytes: z.number().int().min(1_024).max(100_000_000).optional(),
  api_keys: z.record(z.string(), z.unknown()).optional(),
  apiKeys: z.record(z.string(), z.unknown()).optional(),
  default: defaultFileSchema.optional(),
  search: searchFileSchema.optional(),
  sandbox: sandboxFileSchema.optional(),
  undo: undoFileSchema.optional(),
  hooks: hooksFileSchema.optional(),
  mcp: z.object({
    servers: z.record(z.string().min(1).max(32).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/), mcpServerFileSchema).optional(),
  }).strict().optional(),
  models: z.record(z.string().min(1), modelFileSchema).optional(),
}).strict();
type FileConfig = z.infer<typeof fileConfigSchema>;

export function findWorkspaceRoot(cwd: string): string {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return resolve(cwd);
  }
}

export function isGitWorkTree(cwd: string): boolean {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() === "true";
  } catch {
    return false;
  }
}

export function assertGitWorkTree(cwd: string): void {
  if (isGitWorkTree(cwd)) return;
  throw new Error(
    "Kulmi task mode requires a git worktree for workspace tracking. " +
      "Run `git init` in this workspace, or start Kulmi from an existing git repository.",
  );
}

export type ConfigTrustLevel = "user" | "project";

// Settings that change containment, autonomy, or code-execution surface.
// Only hard defaults + user config (~/.config/kulmi/config.toml) may set them.
// Project .kulmi/config.toml values for these keys are stripped so a cloned
// repo cannot weaken the sandbox, raise autonomy, or inject MCP/hooks.
// Privileged keys: sandbox, hooks, mcp, default_autonomy (and default.default_autonomy).

export function loadConfig(cwd: string): KulmiConfig {
  const root = findWorkspaceRoot(cwd);
  let config = structuredClone(defaults);
  const userPath = join(homedir(), ".config", "kulmi", "config.toml");
  const projectPath = join(root, ".kulmi", "config.toml");
  if (existsSync(userPath)) {
    config = mergeConfig(config, parseFileConfig(parse(readFileSync(userPath, "utf8")), userPath, "user"));
  }
  if (existsSync(projectPath)) {
    config = mergeConfig(config, parseFileConfig(parse(readFileSync(projectPath, "utf8")), projectPath, "project"));
  }
  registerSecretEnvNames(Object.values(config.models).map((model) => model.apiKeyEnv));
  return config;
}

export function applyFileConfig(
  base: KulmiConfig,
  raw: unknown,
  source = "configuration",
  trust: ConfigTrustLevel = "user",
): KulmiConfig {
  return mergeConfig(base, parseFileConfig(raw, source, trust));
}


function mergeConfig(base: KulmiConfig, file: FileConfig): KulmiConfig {
  const models = { ...base.models };
  for (const [name, raw] of Object.entries(file.models ?? {})) {
    const existing = models[name];
    const previous = existing ?? modelDefaults;
    const model = raw.model ?? previous.model;
    const baseUrl = raw.base_url ?? raw.baseUrl ?? previous.baseUrl;
    const apiKeyEnv = raw.api_key_env ?? raw.apiKeyEnv ?? previous.apiKeyEnv;
    if (!existing) {
      if (!model) throw new Error(`model ${name}: model is required`);
      if (!baseUrl) throw new Error(`model ${name}: base_url is required`);
      if (!apiKeyEnv) throw new Error(`model ${name}: api_key_env is required`);
    }
    models[name] = {
      model,
      ...(raw.provider ?? previous.provider ? { provider: raw.provider ?? previous.provider } : {}),
      ...(raw.protocol ?? previous.protocol ? { protocol: raw.protocol ?? previous.protocol } : {}),
      baseUrl,
      apiKeyEnv,
      thinking: raw.thinking ?? previous.thinking,
      ...(raw.reasoning_effort ?? raw.reasoningEffort ?? previous.reasoningEffort
        ? { reasoningEffort: raw.reasoning_effort ?? raw.reasoningEffort ?? previous.reasoningEffort }
        : {}),
      contextWindow: raw.context_window ?? raw.contextWindow ?? previous.contextWindow,
      maxOutputTokens: raw.max_output_tokens ?? raw.maxOutputTokens ?? previous.maxOutputTokens,
    };
  }
  const search = file.search;
  const sandbox = file.sandbox;
  const undo = file.undo;
  const hooks = file.hooks;
  const merged: KulmiConfig = {
    defaultModel: file.default_model ?? file.defaultModel ?? file.default?.default_model ?? file.default?.defaultModel ?? base.defaultModel,
    defaultAutonomy: file.default_autonomy ?? file.defaultAutonomy ?? file.default?.default_autonomy ?? file.default?.defaultAutonomy ?? base.defaultAutonomy,
    maxSteps: file.max_steps ?? base.maxSteps,
    maxSubagents: file.max_subagents ?? base.maxSubagents,
    commandTimeoutSeconds: file.command_timeout_seconds ?? base.commandTimeoutSeconds,
    maxOutputBytes: file.max_output_bytes ?? base.maxOutputBytes,
    models,
    search: {
      mode: search?.mode ?? base.search.mode,
      resultLimit: search?.result_limit ?? search?.resultLimit ?? base.search.resultLimit,
      provider: search?.provider ?? base.search.provider,
      searxngUrl: search?.searxng_url ?? search?.searxngUrl ?? base.search.searxngUrl,
    },
    sandbox: {
      mode: sandbox?.mode ?? base.sandbox.mode,
      network: sandbox?.network ?? base.sandbox.network,
    },
    undo: {
      messageHistory: undo?.message_history ?? undo?.messageHistory ?? base.undo.messageHistory,
    },
    hooks: hooks
      ? {
        toolPre: parseHookScripts(hooks.tool_pre ?? hooks.toolPre ?? []),
        toolPost: parseHookScripts(hooks.tool_post ?? hooks.toolPost ?? []),
      }
      : base.hooks,
    mcpServers: file.mcp?.servers
      ? Object.entries(file.mcp.servers).map(([name, server]) => ({
        name,
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
      }))
      : base.mcpServers,
  };
  validateMergedConfig(merged);
  return merged;
}

function parseFileConfig(raw: unknown, source: string, trust: ConfigTrustLevel = "user"): FileConfig {
  const parsed = fileConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${source}: ${z.prettifyError(parsed.error)}`);
  return trust === "project" ? restrictProjectFileConfig(parsed.data, source) : parsed.data;
}

function restrictProjectFileConfig(file: FileConfig, source: string): FileConfig {
  const ignored: string[] = [];
  const next: FileConfig = { ...file };

  if (next.sandbox !== undefined) {
    ignored.push("sandbox");
    delete next.sandbox;
  }
  if (next.hooks !== undefined) {
    ignored.push("hooks");
    delete next.hooks;
  }
  if (next.mcp !== undefined) {
    ignored.push("mcp");
    delete next.mcp;
  }
  if (next.default_autonomy !== undefined || next.defaultAutonomy !== undefined) {
    ignored.push("default_autonomy");
    delete next.default_autonomy;
    delete next.defaultAutonomy;
  }
  if (next.default) {
    const table = { ...next.default };
    if (table.default_autonomy !== undefined || table.defaultAutonomy !== undefined) {
      ignored.push("default.default_autonomy");
      delete table.default_autonomy;
      delete table.defaultAutonomy;
      if (table.default_model === undefined && table.defaultModel === undefined) {
        delete next.default;
      } else {
        next.default = table;
      }
    }
  }

  if (ignored.length > 0) {
    const unique = [...new Set(ignored)];
    process.stderr.write(
      `warning: ${source}: ignoring privileged settings (${unique.join(", ")}); ` +
        `set them in ~/.config/kulmi/config.toml only\n`,
    );
  }
  return next;
}


function validateMergedConfig(config: KulmiConfig): void {
  if (Object.keys(config.models).length === 0) {
    if (config.defaultModel) throw new Error(`unknown default model ${config.defaultModel}`);
  } else if (!config.defaultModel || !config.models[config.defaultModel]) {
    throw new Error(config.defaultModel
      ? `unknown default model ${config.defaultModel}`
      : "default_model is required when models are configured");
  }
  if (config.search.provider === "searxng" && !config.search.searxngUrl) {
    throw new Error("search.provider=searxng requires search.searxng_url");
  }
  for (const [name, model] of Object.entries(config.models)) {
    if (!model.model) throw new Error(`model ${name}: model is required`);
    if (!model.baseUrl) throw new Error(`model ${name}: base_url is required`);
    if (!model.apiKeyEnv) throw new Error(`model ${name}: api_key_env is required`);
    if (model.maxOutputTokens > model.contextWindow) {
      throw new Error(`model ${name} max_output_tokens exceeds context_window`);
    }
  }
}

function parseHookScripts(values: z.infer<typeof hookScriptFileSchema>[]): HookScriptConfig[] {
  return values.map((value) => typeof value === "string"
    ? { command: value, timeoutSeconds: 30 }
    : { command: value.command, timeoutSeconds: value.timeout_seconds ?? value.timeoutSeconds ?? 30, ...(value.tool ? { tool: value.tool } : {}) });
}

export function resolveModel(config: KulmiConfig, name?: string): ResolvedModel {
  if (Object.keys(config.models).length === 0) {
    throw new Error("no models configured. Run `kulmi init` and define at least one [models.*] profile.");
  }
  const modelName = name ?? config.defaultModel;
  if (!modelName) throw new Error("default_model is not set");
  const model = config.models[modelName];
  if (!model) throw new Error(`unknown model ${modelName}`);
  const apiKey = process.env[model.apiKeyEnv];
  if (!apiKey) throw new Error(`missing ${model.apiKeyEnv} for model ${modelName}`);
  return { ...model, name: modelName, apiKey };
}

export function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(path);
}

export function configTemplate(): string {
  return `# Kulmi autonomous coding harness configuration.
# No models are built in. Define your own OpenAI-compatible profiles.
# default_model = "my-model"
max_steps = 80
max_subagents = 3
command_timeout_seconds = 120

[search]
mode = "free" # off or free
result_limit = 5
provider = "auto" # auto, searxng, or bing-rss
# searxng_url = "http://127.0.0.1:8080" # optional self-hosted instance

[undo]
message_history = "truncate" # truncate or keep

# Privileged settings below apply only from ~/.config/kulmi/config.toml.
# Project .kulmi/config.toml cannot set sandbox, default autonomy, hooks, or MCP.
# default_autonomy = "medium"
#
# [sandbox]
# mode = "required" # required or off
# network = false # allow sandboxed project commands to use the network
#
# [hooks]
# tool_pre = ["npm run lint:changed"]
# tool_post = ["npm run verify:changed"]
# tool_pre = [{ tool = "edit_file", command = "npm run lint:changed", timeout_seconds = 30 }]
#
# MCP servers expose extra tools to the agent over stdio.
# [mcp.servers.filesystem]
# command = "npx"
# args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]

# Example profile. Replace with your provider endpoint and credentials env var.
# default_model = "my-model"
# [models.my-model]
# model = "your-model-id"
# base_url = "https://api.example.com/v1"
# api_key_env = "MY_PROVIDER_API_KEY"
# protocol = "openai" # openai (chat completions) or anthropic (messages api)
# thinking = false
# context_window = 128000
# max_output_tokens = 16384
`;
}