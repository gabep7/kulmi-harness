import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import type { AutonomyLevel } from "../core/types.js";

export type MiMoBilling = "pay-as-you-go" | "token-plan";
export type SearchMode = "off" | "free";
export type FreeSearchProvider = "auto" | "searxng" | "bing-rss";

export interface ModelConfig {
  model: "mimo-v2.5-pro" | "mimo-v2.5";
  billing: MiMoBilling;
  baseUrl: string;
  apiKeyEnv: string;
  thinking: boolean;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface SearchConfig {
  mode: SearchMode;
  resultLimit: number;
  provider: FreeSearchProvider;
  searxngUrl: string;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: string[];
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
  mcpServers: Record<string, McpServerConfig>;
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
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiKeyEnv: "MIMO_API_KEY",
      thinking: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
    },
    "mimo-v2.5": {
      model: "mimo-v2.5",
      billing: "pay-as-you-go",
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiKeyEnv: "MIMO_API_KEY",
      thinking: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 32_768,
    },
    "mimo-v2.5-pro-token-plan": {
      model: "mimo-v2.5-pro",
      billing: "token-plan",
      baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
      apiKeyEnv: "MIMO_TOKEN_PLAN_API_KEY",
      thinking: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
    },
    "mimo-v2.5-token-plan": {
      model: "mimo-v2.5",
      billing: "token-plan",
      baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
      apiKeyEnv: "MIMO_TOKEN_PLAN_API_KEY",
      thinking: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 32_768,
    },
  },
  search: {
    mode: "free",
    resultLimit: 5,
    provider: "auto",
    searxngUrl: "",
  },
  mcpServers: {},
};

interface FileConfig {
  default_model?: string;
  default_autonomy?: AutonomyLevel;
  max_steps?: number;
  max_subagents?: number;
  command_timeout_seconds?: number;
  max_output_bytes?: number;
  search?: Partial<SearchConfig> & {
    result_limit?: number;
    provider?: FreeSearchProvider;
    searxng_url?: string;
  };
  models?: Record<string, Partial<ModelConfig> & {
    base_url?: string;
    api_key_env?: string;
    context_window?: number;
    max_output_tokens?: number;
  }>;
  mcp?: { servers?: Record<string, { command?: string; args?: string[]; env?: string[] }> };
}

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

export function loadConfig(cwd: string): KulmiConfig {
  const root = findWorkspaceRoot(cwd);
  let config = structuredClone(defaults);
  for (const path of [
    join(homedir(), ".config", "kulmi", "config.toml"),
    join(root, ".kulmi", "config.toml"),
  ]) {
    if (!existsSync(path)) continue;
    config = mergeConfig(config, parse(readFileSync(path, "utf8")) as FileConfig);
  }
  return config;
}

function mergeConfig(base: KulmiConfig, file: FileConfig): KulmiConfig {
  const models = { ...base.models };
  for (const [name, raw] of Object.entries(file.models ?? {})) {
    const previous = models[name] ?? defaults.models["mimo-v2.5-pro"]!;
    const model = raw.model ?? previous.model;
    if (model !== "mimo-v2.5-pro" && model !== "mimo-v2.5") {
      continue;
    }
    const billing = raw.billing ?? previous.billing;
    models[name] = {
      model,
      billing,
      baseUrl: raw.base_url ?? raw.baseUrl ?? previous.baseUrl,
      apiKeyEnv: raw.api_key_env ?? raw.apiKeyEnv ?? previous.apiKeyEnv,
      thinking: raw.thinking ?? previous.thinking,
      contextWindow: raw.context_window ?? raw.contextWindow ?? previous.contextWindow,
      maxOutputTokens: raw.max_output_tokens ?? raw.maxOutputTokens ?? previous.maxOutputTokens,
    };
  }
  const search = file.search;
  const mcpServers = { ...base.mcpServers };
  for (const [name, server] of Object.entries(file.mcp?.servers ?? {})) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error(`invalid MCP server name ${name}`);
    if (!server.command) throw new Error(`MCP server ${name} requires command`);
    mcpServers[name] = { command: server.command, args: server.args ?? [], env: server.env ?? [] };
  }
  return {
    defaultModel: file.default_model ?? base.defaultModel,
    defaultAutonomy: file.default_autonomy ?? base.defaultAutonomy,
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
    mcpServers,
  };
}

export function resolveModel(config: KulmiConfig, name?: string): ResolvedModel {
  const modelName = name ?? config.defaultModel;
  const model = config.models[modelName];
  if (!model) throw new Error(`unknown model ${modelName}`);
  const apiKey = process.env[model.apiKeyEnv];
  if (!apiKey) throw new Error(`missing ${model.apiKeyEnv} for model ${modelName}`);
  if (model.billing === "token-plan" && !apiKey.startsWith("tp-")) {
    throw new Error(`${model.apiKeyEnv} must be a Token Plan key beginning with tp-`);
  }
  if (model.billing === "pay-as-you-go" && apiKey.startsWith("tp-")) {
    throw new Error(`${model.apiKeyEnv} is a Token Plan key but ${modelName} uses pay-as-you-go`);
  }
  if (model.billing === "pay-as-you-go" && !apiKey.startsWith("sk-")) {
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

# Optional indexed fuzzy file and content search via https://github.com/dmtrKovalenko/fff
# Install fff-mcp first, then uncomment:
# [mcp.servers.fff]
# command = "fff-mcp"
# args = []
# env = []

[models.mimo-v2.5-pro]
model = "mimo-v2.5-pro"
billing = "pay-as-you-go"
base_url = "https://api.xiaomimimo.com/v1"
api_key_env = "MIMO_API_KEY"
thinking = true
context_window = 1000000
max_output_tokens = 131072

[models.mimo-v2.5]
model = "mimo-v2.5"
billing = "pay-as-you-go"
base_url = "https://api.xiaomimimo.com/v1"
api_key_env = "MIMO_API_KEY"
thinking = true
context_window = 1000000
max_output_tokens = 32768

# Europe Token Plan. Use -sgp or -cn in base_url for another cluster.
[models.mimo-v2.5-pro-token-plan]
model = "mimo-v2.5-pro"
billing = "token-plan"
base_url = "https://token-plan-ams.xiaomimimo.com/v1"
api_key_env = "MIMO_TOKEN_PLAN_API_KEY"
thinking = true
context_window = 1000000
max_output_tokens = 131072

[models.mimo-v2.5-token-plan]
model = "mimo-v2.5"
billing = "token-plan"
base_url = "https://token-plan-ams.xiaomimimo.com/v1"
api_key_env = "MIMO_TOKEN_PLAN_API_KEY"
thinking = true
context_window = 1000000
max_output_tokens = 32768
`;
}
