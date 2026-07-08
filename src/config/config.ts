import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import type { AutonomyLevel } from "../core/types.js";

export type MiMoBilling = "pay-as-you-go" | "token-plan";
export type SearchMode = "off" | "free";
export type FreeSearchProvider = "auto" | "searxng" | "bing-rss";
export type SandboxMode = "required" | "off";
export type UndoMessageHistory = "truncate" | "keep";

export type ModelId = "mimo-v2.5-pro" | "mimo-v2.5";

export interface ModelConfig {
  model: ModelId;
  billing: MiMoBilling;
  baseUrl: string;
  apiKeyEnv: string;
  thinking: boolean;
  contextWindow: number;
  maxOutputTokens: number;
}

const knownModels = ["mimo-v2.5-pro", "mimo-v2.5"] as const;
const payAsYouGoBaseUrl = "https://api.xiaomimimo.com/v1";
const tokenPlanBaseUrl = "https://token-plan-ams.xiaomimimo.com/v1";

export function apiKeyEnvFor(billing: MiMoBilling): string {
  return billing === "token-plan" ? "MIMO_TOKEN_PLAN_API_KEY" : "MIMO_API_KEY";
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
}

export interface ResolvedModel extends ModelConfig {
  name: string;
  apiKey: string;
}

const defaults: KulmiConfig = {
  defaultModel: "mimo-v2.5-pro",
  defaultAutonomy: "medium",
  maxSteps: 80,
  maxSubagents: 3,
  commandTimeoutSeconds: 120,
  maxOutputBytes: 200_000,
  models: {
    "mimo-v2.5-pro": {
      model: "mimo-v2.5-pro",
      billing: "pay-as-you-go",
      baseUrl: payAsYouGoBaseUrl,
      apiKeyEnv: "MIMO_API_KEY",
      thinking: true,
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
    },
    "mimo-v2.5": {
      model: "mimo-v2.5",
      billing: "pay-as-you-go",
      baseUrl: payAsYouGoBaseUrl,
      apiKeyEnv: "MIMO_API_KEY",
      thinking: true,
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
    },
    "mimo-v2.5-pro-token-plan": {
      model: "mimo-v2.5-pro",
      billing: "token-plan",
      baseUrl: tokenPlanBaseUrl,
      apiKeyEnv: "MIMO_TOKEN_PLAN_API_KEY",
      thinking: true,
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
    },
    "mimo-v2.5-token-plan": {
      model: "mimo-v2.5",
      billing: "token-plan",
      baseUrl: tokenPlanBaseUrl,
      apiKeyEnv: "MIMO_TOKEN_PLAN_API_KEY",
      thinking: true,
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
    },
  },
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
};

const httpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "must use http or https");
const positiveInt = z.number().int().positive();
const modelFileSchema = z.object({
  vendor: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  billing: z.enum(["pay-as-you-go", "token-plan"]).optional(),
  base_url: httpUrlSchema.optional(),
  baseUrl: httpUrlSchema.optional(),
  api_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  thinking: z.boolean().optional(),
  context_window: positiveInt.optional(),
  contextWindow: positiveInt.optional(),
  max_output_tokens: positiveInt.optional(),
  maxOutputTokens: positiveInt.optional(),
}).passthrough();
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
  default: defaultFileSchema.optional(),
  search: searchFileSchema.optional(),
  sandbox: sandboxFileSchema.optional(),
  undo: undoFileSchema.optional(),
  hooks: hooksFileSchema.optional(),
  models: z.record(z.string().min(1), modelFileSchema).optional(),
}).passthrough();
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

export function loadConfig(cwd: string): KulmiConfig {
  const root = findWorkspaceRoot(cwd);
  let config = structuredClone(defaults);
  for (const path of [
    join(homedir(), ".config", "kulmi", "config.toml"),
    join(root, ".kulmi", "config.toml"),
  ]) {
    if (!existsSync(path)) continue;
    config = mergeConfig(config, parseFileConfig(parse(readFileSync(path, "utf8")), path));
  }
  return config;
}

export function applyFileConfig(base: KulmiConfig, raw: unknown, source = "configuration"): KulmiConfig {
  return mergeConfig(base, parseFileConfig(raw, source));
}

function mergeConfig(base: KulmiConfig, file: FileConfig): KulmiConfig {
  const models = { ...base.models };
  for (const [name, raw] of Object.entries(file.models ?? {})) {
    const existing = models[name];
    const previous = existing ?? defaults.models["mimo-v2.5-pro"]!;
    const model = raw.model ?? previous.model;
    if (!knownModels.includes(model as ModelId)) continue;
    if (raw.vendor && raw.vendor !== "mimo") {
      throw new Error(`model ${name}: vendor must be mimo`);
    }
    const billing = raw.billing ?? previous.billing;
    models[name] = {
      model: model as ModelId,
      billing,
      baseUrl: raw.base_url ?? raw.baseUrl ?? (
        existing && billing === previous.billing
          ? previous.baseUrl
          : billing === "token-plan" ? tokenPlanBaseUrl : payAsYouGoBaseUrl
      ),
      apiKeyEnv: raw.api_key_env ?? raw.apiKeyEnv ?? apiKeyEnvFor(billing),
      thinking: raw.thinking ?? previous.thinking,
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
  };
  validateMergedConfig(merged);
  return merged;
}

function parseFileConfig(raw: unknown, source: string): FileConfig {
  if (raw && typeof raw === "object" && "mcp" in raw) {
    throw new Error(`${source}: MCP configuration is no longer supported`);
  }
  const parsed = fileConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${source}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function validateMergedConfig(config: KulmiConfig): void {
  if (!config.models[config.defaultModel]) throw new Error(`unknown default model ${config.defaultModel}`);
  if (config.search.provider === "searxng" && !config.search.searxngUrl) {
    throw new Error("search.provider=searxng requires search.searxng_url");
  }
  for (const [name, model] of Object.entries(config.models)) {
    if (model.maxOutputTokens > model.contextWindow) {
      throw new Error(`model ${name} max_output_tokens exceeds context_window`);
    }
    if (!knownModels.includes(model.model)) {
      throw new Error(`model ${name}: only mimo-v2.5-pro and mimo-v2.5 are supported`);
    }
    const expectedEnv = apiKeyEnvFor(model.billing);
    if (model.apiKeyEnv !== expectedEnv) {
      throw new Error(`model ${name} (${model.billing}) must use ${expectedEnv}`);
    }
  }
}

function parseHookScripts(values: z.infer<typeof hookScriptFileSchema>[]): HookScriptConfig[] {
  return values.map((value) => typeof value === "string"
    ? { command: value, timeoutSeconds: 30 }
    : { command: value.command, timeoutSeconds: value.timeout_seconds ?? value.timeoutSeconds ?? 30, ...(value.tool ? { tool: value.tool } : {}) });
}

export function resolveModel(config: KulmiConfig, name?: string): ResolvedModel {
  const modelName = name ?? config.defaultModel;
  const model = config.models[modelName];
  if (!model) throw new Error(`unknown model ${modelName}`);
  const apiKey = process.env[model.apiKeyEnv];
  if (!apiKey) throw new Error(`missing ${model.apiKeyEnv} for model ${modelName}`);
  if (model.billing === "token-plan" && !/^tp-\S{7,}$/.test(apiKey)) {
    throw new Error(`${model.apiKeyEnv} must be a Token Plan key beginning with tp-`);
  } else if (model.billing === "pay-as-you-go" && apiKey.startsWith("tp-")) {
    throw new Error(`${model.apiKeyEnv} is a Token Plan key but ${modelName} uses pay-as-you-go`);
  } else if (model.billing === "pay-as-you-go" && !/^sk-\S{7,}$/.test(apiKey)) {
    throw new Error(`${model.apiKeyEnv} must be a pay-as-you-go key beginning with sk-`);
  }
  return { ...model, name: modelName, apiKey };
}

export function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(path);
}

export function configTemplate(): string {
  return `# Kulmi is MiMo V2.5 native. The default profile uses pay-as-you-go.
default_model = "mimo-v2.5-pro"
default_autonomy = "medium"
max_steps = 80
max_subagents = 3
command_timeout_seconds = 120

[search]
mode = "free" # off or free
result_limit = 5
provider = "auto" # auto, searxng, or bing-rss
# searxng_url = "http://127.0.0.1:8080" # optional self-hosted instance

[sandbox]
mode = "required" # required or off
network = false # allow sandboxed project commands to use the network

[undo]
message_history = "truncate" # truncate or keep

[hooks]
# tool_pre = ["npm run lint:changed"]
# tool_post = ["npm run verify:changed"]
# tool_pre = [{ tool = "edit_file", command = "npm run lint:changed", timeout_seconds = 30 }]

[models.mimo-v2.5-pro]
model = "mimo-v2.5-pro"
billing = "pay-as-you-go"
base_url = "https://api.xiaomimimo.com/v1"
api_key_env = "MIMO_API_KEY"
thinking = true
context_window = 1048576
max_output_tokens = 131072

[models.mimo-v2.5]
model = "mimo-v2.5"
billing = "pay-as-you-go"
base_url = "https://api.xiaomimimo.com/v1"
api_key_env = "MIMO_API_KEY"
thinking = true
context_window = 1048576
max_output_tokens = 131072

# Europe Token Plan. Use -sgp or -cn in base_url for another cluster.
[models.mimo-v2.5-pro-token-plan]
model = "mimo-v2.5-pro"
billing = "token-plan"
base_url = "https://token-plan-ams.xiaomimimo.com/v1"
api_key_env = "MIMO_TOKEN_PLAN_API_KEY"
thinking = true
context_window = 1048576
max_output_tokens = 131072

[models.mimo-v2.5-token-plan]
model = "mimo-v2.5"
billing = "token-plan"
base_url = "https://token-plan-ams.xiaomimimo.com/v1"
api_key_env = "MIMO_TOKEN_PLAN_API_KEY"
thinking = true
context_window = 1048576
max_output_tokens = 131072
`;
}
