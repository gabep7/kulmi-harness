import { describe, expect, it } from "vitest";
import { applyFileConfig, configTemplate, type KulmiConfig, type ModelConfig } from "../src/config/config.js";

describe("configuration", () => {
  it("generates a template without built-in model endpoints", () => {
    const template = configTemplate();
    expect(template).toContain("No models are built in");
    expect(template).toContain("# [models.my-model]");
    expect(template).toContain("# base_url = \"https://api.example.com/v1\"");
    expect(template).not.toContain("openai.com");
    expect(template).not.toContain("xiaomimimo");
    expect(template).toContain('[sandbox]\nmode = "required"');
    expect(template).toContain('[undo]\nmessage_history = "truncate"');
  });

  it("accepts the documented default table for default profile settings", () => {
    const changed = applyFileConfig(config(payg()), {
      default: { default_autonomy: "trusted", default_model: "api" },
    });
    expect(changed.defaultAutonomy).toBe("trusted");
    expect(changed.defaultModel).toBe("api");
  });

  it("configures command isolation and undo transcript retention explicitly", () => {
    const changed = applyFileConfig(config(payg()), {
      sandbox: { mode: "off", network: true },
      undo: { message_history: "keep" },
    });
    expect(changed.sandbox).toEqual({ mode: "off", network: true });
    expect(changed.undo).toEqual({ messageHistory: "keep" });
    expect(() => applyFileConfig(config(payg()), {
      undo: { message_history: "delete" },
    })).toThrow("message_history");
  });

  it("parses hook script commands and explicit timeouts from file config", () => {
    const changed = applyFileConfig(config(payg()), {
      hooks: {
        tool_pre: ["npm run lint:changed", { command: "npm test -- --changed", timeout_seconds: 12 }],
        toolPost: [{ command: "node scripts/notify-hook.mjs", timeoutSeconds: 7 }],
      },
    });

    expect(changed.hooks.toolPre.map((hook) => hook.command)).toEqual([
      "npm run lint:changed",
      "npm test -- --changed",
    ]);
    expect(changed.hooks.toolPre[1]).toEqual({ command: "npm test -- --changed", timeoutSeconds: 12 });
    expect(changed.hooks.toolPost).toEqual([{ command: "node scripts/notify-hook.mjs", timeoutSeconds: 7 }]);
    expect(() => applyFileConfig(config(payg()), {
      hooks: { tool_pre: [{ command: "too fast", timeout_seconds: 0 }] },
    })).toThrow("timeout_seconds");
  });

  it("rejects invalid limits, endpoints, and removed MCP config", () => {
    const base = config(payg());
    expect(() => applyFileConfig(base, { max_steps: 0 })).toThrow("max_steps");
    expect(() => applyFileConfig(base, { models: { api: { base_url: "file:///tmp/model" } } })).toThrow("http or https");
    expect(() => applyFileConfig(base, { mcp: { servers: {} } })).toThrow("MCP configuration is no longer supported");
  });

  it("accepts custom model profiles with arbitrary model names", () => {
    const changed = applyFileConfig(config(payg()), {
      models: {
        "claude-sonnet": {
          model: "claude-sonnet-4-20250514",
          base_url: "https://api.anthropic.com/v1",
          api_key_env: "ANTHROPIC_API_KEY",
          thinking: true,
          context_window: 200_000,
          max_output_tokens: 64_000,
        },
      },
    });
    expect(changed.models["claude-sonnet"]).toEqual({
      model: "claude-sonnet-4-20250514",
      baseUrl: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      thinking: true,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    });
  });

  it("requires complete model definitions when creating a profile", () => {
    const empty = emptyConfig();
    expect(() => applyFileConfig(empty, {
      models: { incomplete: { model: "x" } },
    })).toThrow("base_url is required");
  });

  it("rejects an unknown default model", () => {
    expect(() => applyFileConfig(config(payg()), {
      default_model: "nonexistent",
    })).toThrow("unknown default model nonexistent");
  });

  it.each([
    { scope: "root", input: { surprise: true }, key: "surprise" },
    { scope: "model", input: { models: { api: { surprise: true } } }, key: "surprise" },
  ])("rejects an unknown $scope configuration key", ({ input, key }) => {
    expect(() => applyFileConfig(config(payg()), input)).toThrow(key);
  });

  it("accepts compatibility spellings while applying their supported behavior", () => {
    const changed = applyFileConfig(config(payg()), {
      defaultModel: "api",
      defaultAutonomy: "high",
      api_keys: { legacy: "ignored" },
      apiKeys: { newerLegacy: "ignored" },
      models: {
        api: {
          provider: "openai",
          model: "custom-model",
          baseUrl: "https://api.example.com/v1",
          apiKeyEnv: "EXAMPLE_API_KEY",
          thinking: false,
          reasoning_effort: "high",
          reasoningEffort: "high",
          contextWindow: 262_144,
          maxOutputTokens: 65_536,
        },
      },
    });

    expect(changed).toMatchObject({ defaultModel: "api", defaultAutonomy: "high" });
    expect(changed.models.api).toEqual({
      model: "custom-model",
      provider: "openai",
      baseUrl: "https://api.example.com/v1",
      apiKeyEnv: "EXAMPLE_API_KEY",
      thinking: false,
      reasoningEffort: "high",
      contextWindow: 262_144,
      maxOutputTokens: 65_536,
    });
  });
});

function emptyConfig(): KulmiConfig {
  return {
    defaultModel: "",
    defaultAutonomy: "medium",
    maxSteps: 80,
    maxSubagents: 3,
    commandTimeoutSeconds: 120,
    maxOutputBytes: 200_000,
    models: {},
    search: {
      mode: "off",
      resultLimit: 5,
      provider: "auto",
      searxngUrl: "",
    },
    sandbox: { mode: "required", network: false },
    undo: { messageHistory: "truncate" },
    hooks: { toolPre: [], toolPost: [] },
  };
}

function config(...models: ModelConfig[]): KulmiConfig {
  const names = models.map((_model, index) => index === 0 ? "api" : `api${index}`);
  return {
    ...emptyConfig(),
    defaultModel: names[0]!,
    models: Object.fromEntries(models.map((model, index) => [names[index], model])),
  };
}

function payg(): ModelConfig {
  return {
    model: "custom-model",
    baseUrl: "https://api.example.com/v1",
    apiKeyEnv: "EXAMPLE_API_KEY",
    thinking: false,
    contextWindow: 400_000,
    maxOutputTokens: 32_768,
  };
}
