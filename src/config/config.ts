import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import type { AutonomyLevel } from "../core/types.js";

export type MiMoBilling = "pay-as-you-go" | "token-plan";
export type ModelVendor = "mimo" | "stepfun";
export type SearchMode = "off" | "free";
export type FreeSearchProvider = "auto" | "searxng" | "bing-rss";

export type ModelId = "mimo-v2.5-pro" | "mimo-v2.5" | "step-3.7-flash";

export interface ModelConfig {
  vendor: ModelVendor;
  model: ModelId;
  billing: MiMoBilling;
  baseUrl: string;
  apiKeyEnv: string;
  thinking: boolean;
  contextWindow: number;
  maxOutputTokens: number;
}

const knownModels: readonly ModelId[] = ["mimo-v2.5-pro", "mimo-v2.5", "step-3.7-flash"];

export function vendorForModel(model: ModelId): "mimo" | "stepfun" {
  return model.startsWith("step-") ? "stepfun" : "mimo";
}

export function apiKeyEnvFor(vendor: "mimo" | "stepfun", billing: MiMoBilling): string {
  if (vendor === "stepfun") return "STEPFUN_API_KEY";
  return billing === "token-plan" ? "MIMO_TOKEN_PLAN_API_KEY" : "MIMO_API_KEY";
}

export interface SearchConfig {
  mode: SearchMode;
  resultLimit: number;
  provider: FreeSearchProvider;
  searxngUrl: string;
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
      vendor: "mimo",
      model: "mimo-v2.5-pro",
      billing: "pay-as-you-go",
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiKeyEnv: "MIMO_API_KEY",
      thinking: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
    },
    "mimo-v2.5": {
      vendor: "mimo",
      model: "mimo-v2.5",
      billing: "pay-as-you-go",
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiKeyEnv: "MIMO_API_KEY",
      thinking: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 32_768,
    },
    "mimo-v2.5-pro-token-plan": {
      vendor: "mimo",
      model: "mimo-v2.5-pro",
      billing: "token-plan",
      baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
      apiKeyEnv: "MIMO_TOKEN_PLAN_API_KEY",
      thinking: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
    },
    "mimo-v2.5-token-plan": {
      vendor: "mimo",
      model: "mimo-v2.5",
      billing: "token-plan",
      baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
      apiKeyEnv: "MIMO_TOKEN_PLAN_API_KEY",
      thinking: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 32_768,
    },
    "step-3.7-flash": {
      vendor: "stepfun",
      model: "step-3.7-flash",
      billing: "pay-as-you-go",
      baseUrl: "https://api.stepfun.ai/step_plan/v1",
      apiKeyEnv: "STEPFUN_API_KEY",
      thinking: true,
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
    },
  },
  search: {
    mode: "free",
    resultLimit: 5,
    provider: "auto",
    searxngUrl: "",
  },
};

const httpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "must use http or https");
const positiveInt = z.number().int().positive();
const modelFileSchema = z.object({
  vendor: z.enum(["mimo", "stepfun"]).optional(),
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
const fileConfigSchema = z.object({
  default_model: z.string().min(1).optional(),
  default_autonomy: z.enum(["read", "low", "medium", "high"]).optional(),
  max_steps: z.number().int().min(1).max(10_000).optional(),
  max_subagents: z.number().int().min(1).max(64).optional(),
  command_timeout_seconds: z.number().int().min(1).max(1_800).optional(),
  max_output_bytes: z.number().int().min(1_024).max(100_000_000).optional(),
  search: searchFileSchema.optional(),
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
    const previous = models[name] ?? defaults.models["mimo-v2.5-pro"]!;
    const model = (raw.model ?? previous.model) as ModelId;
    if (!knownModels.includes(model)) continue;
    const vendor = raw.vendor ?? previous.vendor ?? vendorForModel(model);
    const billing = raw.billing ?? previous.billing;
    models[name] = {
      vendor,
      model,
      billing,
      baseUrl: raw.base_url ?? raw.baseUrl ?? previous.baseUrl,
      apiKeyEnv: raw.api_key_env ?? raw.apiKeyEnv ?? apiKeyEnvFor(vendor, billing),
      thinking: raw.thinking ?? previous.thinking,
      contextWindow: raw.context_window ?? raw.contextWindow ?? previous.contextWindow,
      maxOutputTokens: raw.max_output_tokens ?? raw.maxOutputTokens ?? previous.maxOutputTokens,
    };
  }
  const search = file.search;
  const merged: KulmiConfig = {
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
    if (model.vendor !== "mimo" && model.vendor !== "stepfun") {
      throw new Error(`model ${name}: only MiMo and StepFun are supported`);
    }
    const expectedEnv = apiKeyEnvFor(model.vendor, model.billing);
    if (model.apiKeyEnv !== expectedEnv) {
      throw new Error(`model ${name} (${model.vendor}/${model.billing}) must use ${expectedEnv}`);
    }
  }
}

export function resolveModel(config: KulmiConfig, name?: string): ResolvedModel {
  const modelName = name ?? config.defaultModel;
  const model = config.models[modelName];
  if (!model) throw new Error(`unknown model ${modelName}`);
  const apiKey = process.env[model.apiKeyEnv];
  if (!apiKey) throw new Error(`missing ${model.apiKeyEnv} for model ${modelName}`);
  if (model.vendor === "stepfun") {
    if (!apiKey.startsWith("sk-")) {
      throw new Error(`${model.apiKeyEnv} must be a StepFun key beginning with sk-`);
    }
  } else if (model.billing === "token-plan" && !apiKey.startsWith("tp-")) {
    throw new Error(`${model.apiKeyEnv} must be a Token Plan key beginning with tp-`);
  } else if (model.billing === "pay-as-you-go" && apiKey.startsWith("tp-")) {
    throw new Error(`${model.apiKeyEnv} is a Token Plan key but ${modelName} uses pay-as-you-go`);
  } else if (model.billing === "pay-as-you-go" && !apiKey.startsWith("sk-")) {
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
  return `# Kulmi is MiMo V2.5 and StepFun Step Plan native. The default profile uses MiMo pay-as-you-go.
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

# StepFun Step Plan (set STEPFUN_API_KEY). reasoning_effort is set automatically from thinking.
[models.step-3.7-flash]
vendor = "stepfun"
model = "step-3.7-flash"
base_url = "https://api.stepfun.ai/step_plan/v1"
api_key_env = "STEPFUN_API_KEY"
thinking = true
context_window = 128000
max_output_tokens = 8192
`;
}
