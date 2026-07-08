import { afterEach, describe, expect, it } from "vitest";
import { applyFileConfig, configTemplate, resolveModel, type KulmiConfig, type ModelConfig } from "../src/config/config.js";

describe("MiMo configuration", () => {
  const saved = { api: process.env.MIMO_API_KEY, plan: process.env.MIMO_TOKEN_PLAN_API_KEY };
  afterEach(() => {
    restore("MIMO_API_KEY", saved.api);
    restore("MIMO_TOKEN_PLAN_API_KEY", saved.plan);
  });

  it("keeps pay-as-you-go and Token Plan keys separate", () => {
    process.env.MIMO_API_KEY = "tp-wrong-profile";
    expect(() => resolveModel(config(payg()), "api")).toThrow("Token Plan key");

    process.env.MIMO_TOKEN_PLAN_API_KEY = "sk-wrong-profile";
    expect(() => resolveModel(config(tokenPlan()), "plan")).toThrow("must be a Token Plan key");

    process.env.MIMO_API_KEY = "sk-short";
    expect(() => resolveModel(config(payg()), "api")).toThrow("pay-as-you-go key");
  });

  it("documents MiMo V2.5 (with regional Token Plan) profiles", () => {
    const template = configTemplate();
    expect(template).toContain('model = "mimo-v2.5-pro"');
    expect(template).toContain('model = "mimo-v2.5"');
    expect(template).toContain("token-plan-ams.xiaomimimo.com/v1");
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

  it("rejects invalid limits, endpoints, billing environments, and removed MCP config", () => {
    const base = config(payg());
    expect(() => applyFileConfig(base, { max_steps: 0 })).toThrow("max_steps");
    expect(() => applyFileConfig(base, { models: { api: { base_url: "file:///tmp/model" } } })).toThrow("http or https");
    expect(() => applyFileConfig(base, {
      models: { api: { billing: "token-plan", api_key_env: "MIMO_API_KEY" } },
    })).toThrow("MIMO_TOKEN_PLAN_API_KEY");
    expect(() => applyFileConfig(base, { mcp: { servers: {} } })).toThrow("MCP configuration is no longer supported");
  });

  it("switches to the matching endpoint when a profile changes billing type", () => {
    const changed = applyFileConfig(config(payg()), {
      models: { api: { billing: "token-plan" } },
    });
    expect(changed.models.api).toMatchObject({
      billing: "token-plan",
      baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
      apiKeyEnv: "MIMO_TOKEN_PLAN_API_KEY",
    });
  });

  it("ignores unselected legacy profiles but never activates unsupported models", () => {
    const base = config(payg());
    const migrated = applyFileConfig(base, {
      models: { legacy: { vendor: "removed-provider", model: "unsupported-model" } },
    });
    expect(migrated.models.legacy).toBeUndefined();
    expect(() => applyFileConfig(base, {
      default_model: "legacy",
      models: { legacy: { vendor: "removed-provider", model: "unsupported-model" } },
    })).toThrow("unknown default model legacy");
  });
});

function config(...models: ModelConfig[]): KulmiConfig {
  const names = models.map((model) => model.billing === "token-plan" ? "plan" : "api");
  return {
    defaultModel: names[0]!,
    defaultAutonomy: "medium",
    maxSteps: 80,
    maxSubagents: 3,
    commandTimeoutSeconds: 120,
    maxOutputBytes: 200_000,
    models: Object.fromEntries(models.map((model, index) => [names[index], model])),
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

function payg(): ModelConfig {
  return {
    model: "mimo-v2.5-pro",
    billing: "pay-as-you-go",
    baseUrl: "https://api.xiaomimimo.com/v1",
    apiKeyEnv: "MIMO_API_KEY",
    thinking: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
  };
}

function tokenPlan(): ModelConfig {
  return { ...payg(), billing: "token-plan", apiKeyEnv: "MIMO_TOKEN_PLAN_API_KEY" };
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
