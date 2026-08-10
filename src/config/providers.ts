import type { ModelProtocol } from "./config.js";

/**
 * Built-in provider presets. Users select one during onboarding or /login
 * to get the right base URL, protocol, context window, and reasoning
 * parameters without manual configuration.
 */

export interface ProviderModelPreset {
  /** Model ID sent to the API, e.g. "claude-sonnet-4-20250514" */
  id: string;
  /** Human-readable label shown in the picker */
  label: string;
  /** Maximum input + output context window in tokens */
  contextWindow: number;
  /** Maximum output tokens per response */
  maxOutputTokens: number;
  /** Supports extended thinking / reasoning */
  thinking?: boolean;
  /** Default reasoning effort level */
  reasoningEffort?: string;
  /** Available reasoning effort levels */
  reasoningEfforts?: string[];
  /** Supports image / vision input */
  vision?: boolean;
  /** Is this the recommended default model for the provider? */
  default?: boolean;
}

export interface ProviderPreset {
  /** Stable identifier, e.g. "ollama", "anthropic" */
  id: string;
  /** Display label, e.g. "Ollama (local)", "Anthropic (Claude)" */
  label: string;
  /** Protocol used by this provider */
  protocol: ModelProtocol;
  /** Default base URL */
  baseUrl: string;
  /** Whether an API key is required */
  apiKeyRequired: boolean;
  /** Conventional environment variable for the key */
  apiKeyEnv?: string;
  /** Hint shown in the key input field */
  apiKeyHint?: string;
  /** Whether the base URL can be overridden (e.g. remote Ollama) */
  configurableBaseUrl?: boolean;
  /** Known models for this provider */
  models: ProviderModelPreset[];
  /** Short description shown in the picker */
  description: string;
}

export const providerPresets: readonly ProviderPreset[] = [
  {
    id: "ollama",
    label: "Ollama Cloud",
    description: "Hosted Ollama models in the cloud. Get an API key at ollama.com.",
    protocol: "openai",
    baseUrl: "https://api.ollama.com/v1",
    apiKeyRequired: true,
    apiKeyEnv: "OLLAMA_API_KEY",
    apiKeyHint: "Get a key at ollama.com",
    models: [
      { id: "qwen3:32b", label: "Qwen3 32B", contextWindow: 131_072, maxOutputTokens: 32_768, default: true },
      { id: "qwen3-coder:32b", label: "Qwen3 Coder 32B", contextWindow: 131_072, maxOutputTokens: 32_768 },
      { id: "qwen3-coder:14b", label: "Qwen3 Coder 14B", contextWindow: 131_072, maxOutputTokens: 32_768 },
      { id: "deepseek-r1:32b", label: "DeepSeek R1 32B", contextWindow: 128_000, maxOutputTokens: 32_768, thinking: true, reasoningEffort: "high", reasoningEfforts: ["low", "medium", "high"] },
      { id: "deepseek-r1:14b", label: "DeepSeek R1 14B", contextWindow: 128_000, maxOutputTokens: 32_768, thinking: true, reasoningEffort: "high", reasoningEfforts: ["low", "medium", "high"] },
      { id: "llama3.3:70b", label: "Llama 3.3 70B", contextWindow: 128_000, maxOutputTokens: 32_768 },
      { id: "qwen2.5-coder:32b", label: "Qwen2.5 Coder 32B", contextWindow: 128_000, maxOutputTokens: 32_768 },
      { id: "llama3.2:3b", label: "Llama 3.2 3B (fast)", contextWindow: 128_000, maxOutputTokens: 8_192 },
    ],
  },

  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    description: "Claude models with extended thinking and vision.",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyRequired: true,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    apiKeyHint: "sk-ant-…",
    models: [
      { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", contextWindow: 200_000, maxOutputTokens: 16_384, thinking: true, reasoningEffort: "medium", reasoningEfforts: ["none", "low", "medium", "high"], vision: true, default: true },
      { id: "claude-opus-4-20250514", label: "Claude Opus 4", contextWindow: 200_000, maxOutputTokens: 16_384, thinking: true, reasoningEffort: "medium", reasoningEfforts: ["none", "low", "medium", "high"], vision: true },
      { id: "claude-haiku-3-5-20241022", label: "Claude 3.5 Haiku", contextWindow: 200_000, maxOutputTokens: 8_192, vision: true },
    ],
  },
  {
    id: "openai",
    label: "OpenAI (GPT)",
    description: "GPT-4.1, o3, o4-mini with reasoning and vision.",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKeyRequired: true,
    apiKeyEnv: "OPENAI_API_KEY",
    apiKeyHint: "sk-…",
    models: [
      { id: "gpt-4.1", label: "GPT-4.1", contextWindow: 1_047_576, maxOutputTokens: 32_768, vision: true, default: true },
      { id: "o3", label: "o3", contextWindow: 200_000, maxOutputTokens: 100_000, thinking: true, reasoningEffort: "medium", reasoningEfforts: ["low", "medium", "high"], vision: true },
      { id: "o4-mini", label: "o4-mini", contextWindow: 200_000, maxOutputTokens: 100_000, thinking: true, reasoningEffort: "medium", reasoningEfforts: ["low", "medium", "high"], vision: true },
      { id: "gpt-4.1-mini", label: "GPT-4.1 Mini", contextWindow: 1_047_576, maxOutputTokens: 32_768, vision: true },
      { id: "gpt-4.1-nano", label: "GPT-4.1 Nano (fast)", contextWindow: 1_047_576, maxOutputTokens: 32_768, vision: true },
    ],
  },
  {
    id: "google",
    label: "Google (Gemini)",
    description: "Gemini 2.5 models via OpenAI-compatible endpoint.",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyRequired: true,
    apiKeyEnv: "GOOGLE_API_KEY",
    apiKeyHint: "AIza…",
    models: [
      { id: "gemini-2.5-pro-preview-06-05", label: "Gemini 2.5 Pro", contextWindow: 1_048_576, maxOutputTokens: 65_536, thinking: true, reasoningEffort: "medium", reasoningEfforts: ["none", "low", "medium", "high"], vision: true, default: true },
      { id: "gemini-2.5-flash-preview-05-20", label: "Gemini 2.5 Flash", contextWindow: 1_048_576, maxOutputTokens: 65_536, thinking: true, reasoningEffort: "medium", reasoningEfforts: ["none", "low", "medium", "high"], vision: true },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek V3 and R1 models. Low cost, strong reasoning.",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyRequired: true,
    apiKeyEnv: "DEEPSEEK_API_KEY",
    apiKeyHint: "sk-…",
    models: [
      { id: "deepseek-chat", label: "DeepSeek V3", contextWindow: 64_000, maxOutputTokens: 8_192, default: true },
      { id: "deepseek-reasoner", label: "DeepSeek R1", contextWindow: 64_000, maxOutputTokens: 32_768, thinking: true, reasoningEffort: "high", reasoningEfforts: ["low", "medium", "high"] },
    ],
  },
  {
    id: "groq",
    label: "Groq",
    description: "Ultra-fast inference for Llama, DeepSeek, and Qwen models.",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyRequired: true,
    apiKeyEnv: "GROQ_API_KEY",
    apiKeyHint: "gsk_…",
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", contextWindow: 128_000, maxOutputTokens: 32_768, default: true },
      { id: "deepseek-r1-distill-llama-70b", label: "DeepSeek R1 Distill 70B", contextWindow: 128_000, maxOutputTokens: 32_768, thinking: true, reasoningEffort: "high", reasoningEfforts: ["low", "medium", "high"] },
      { id: "qwen-2.5-coder-32b", label: "Qwen2.5 Coder 32B", contextWindow: 128_000, maxOutputTokens: 32_768 },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B (instant)", contextWindow: 128_000, maxOutputTokens: 8_192 },
    ],
  },
  {
    id: "mistral",
    label: "Mistral AI",
    description: "Mistral and Codestral models.",
    protocol: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyRequired: true,
    apiKeyEnv: "MISTRAL_API_KEY",
    apiKeyHint: "…",
    models: [
      { id: "mistral-large-latest", label: "Mistral Large", contextWindow: 128_000, maxOutputTokens: 8_192, default: true },
      { id: "codestral-latest", label: "Codestral", contextWindow: 256_000, maxOutputTokens: 8_192 },
      { id: "mistral-medium-latest", label: "Mistral Medium", contextWindow: 128_000, maxOutputTokens: 8_192 },
      { id: "mistral-small-latest", label: "Mistral Small (fast)", contextWindow: 128_000, maxOutputTokens: 8_192 },
    ],
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    description: "Grok models with reasoning and vision.",
    protocol: "openai",
    baseUrl: "https://api.x.ai/v1",
    apiKeyRequired: true,
    apiKeyEnv: "XAI_API_KEY",
    apiKeyHint: "xai-…",
    models: [
      { id: "grok-4-0709", label: "Grok 4", contextWindow: 256_000, maxOutputTokens: 32_768, thinking: true, reasoningEffort: "medium", reasoningEfforts: ["low", "medium", "high"], vision: true, default: true },
      { id: "grok-3", label: "Grok 3", contextWindow: 131_072, maxOutputTokens: 16_384, vision: true },
      { id: "grok-3-mini", label: "Grok 3 Mini (fast)", contextWindow: 131_072, maxOutputTokens: 16_384, thinking: true, reasoningEffort: "medium", reasoningEfforts: ["low", "medium", "high"] },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    description: "Access 200+ models from all providers through one API.",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyRequired: true,
    apiKeyEnv: "OPENROUTER_API_KEY",
    apiKeyHint: "sk-or-…",
    models: [
      { id: "anthropic/claude-sonnet-4-20250514", label: "Claude Sonnet 4 (via OpenRouter)", contextWindow: 200_000, maxOutputTokens: 16_384, thinking: true, reasoningEffort: "medium", reasoningEfforts: ["none", "low", "medium", "high"], vision: true, default: true },
      { id: "openai/gpt-4.1", label: "GPT-4.1 (via OpenRouter)", contextWindow: 1_047_576, maxOutputTokens: 32_768, vision: true },
      { id: "google/gemini-2.5-pro-preview-06-05", label: "Gemini 2.5 Pro (via OpenRouter)", contextWindow: 1_048_576, maxOutputTokens: 65_536, thinking: true, reasoningEffort: "medium", reasoningEfforts: ["none", "low", "medium", "high"], vision: true },
      { id: "deepseek/deepseek-chat", label: "DeepSeek V3 (via OpenRouter)", contextWindow: 64_000, maxOutputTokens: 8_192 },
      { id: "x-ai/grok-4-0709", label: "Grok 4 (via OpenRouter)", contextWindow: 256_000, maxOutputTokens: 32_768, thinking: true, reasoningEffort: "medium", reasoningEfforts: ["low", "medium", "high"], vision: true },
    ],
  },
  {
    id: "together",
    label: "Together AI",
    description: "Open-source models with fast inference.",
    protocol: "openai",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyRequired: true,
    apiKeyEnv: "TOGETHER_API_KEY",
    apiKeyHint: "…",
    models: [
      { id: "Qwen/Qwen3-Coder-32B", label: "Qwen3 Coder 32B", contextWindow: 131_072, maxOutputTokens: 32_768, default: true },
      { id: "deepseek-ai/DeepSeek-R1", label: "DeepSeek R1", contextWindow: 128_000, maxOutputTokens: 32_768, thinking: true, reasoningEffort: "high", reasoningEfforts: ["low", "medium", "high"] },
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", label: "Llama 3.3 70B", contextWindow: 128_000, maxOutputTokens: 32_768 },
    ],
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    description: "Fast inference for open-source and fine-tuned models.",
    protocol: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyRequired: true,
    apiKeyEnv: "FIREWORKS_API_KEY",
    apiKeyHint: "…",
    models: [
      { id: "accounts/fireworks/models/qwen3-coder-32b", label: "Qwen3 Coder 32B", contextWindow: 131_072, maxOutputTokens: 32_768, default: true },
      { id: "accounts/fireworks/models/deepseek-r1", label: "DeepSeek R1", contextWindow: 128_000, maxOutputTokens: 32_768, thinking: true, reasoningEffort: "high", reasoningEfforts: ["low", "medium", "high"] },
      { id: "accounts/fireworks/models/llama-v3p3-70b-instruct", label: "Llama 3.3 70B", contextWindow: 128_000, maxOutputTokens: 32_768 },
    ],
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    description: "Any endpoint that speaks the OpenAI chat completions, Responses, or Anthropic Messages API.",
    protocol: "openai",
    baseUrl: "",
    apiKeyRequired: true,
    apiKeyEnv: "CUSTOM_API_KEY",
    apiKeyHint: "sk-…",
    configurableBaseUrl: true,
    models: [],
  },
] as const;

/** Find a provider preset by id */
export function findProviderPreset(id: string): ProviderPreset | undefined {
  return providerPresets.find((p) => p.id === id);
}

/** Find the default model for a provider */
export function defaultModelForProvider(provider: ProviderPreset): ProviderModelPreset | undefined {
  return provider.models.find((m) => m.default) ?? provider.models[0];
}
