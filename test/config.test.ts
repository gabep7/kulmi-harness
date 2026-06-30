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
  });

  it("documents MiMo V2.5 (with regional Token Plan) profiles", () => {
    const template = configTemplate();
    expect(template).toContain('model = "mimo-v2.5-pro"');
    expect(template).toContain('model = "mimo-v2.5"');
    expect(template).toContain("token-plan-ams.xiaomimimo.com/v1");
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
  };
}

function payg(): ModelConfig {
  return {
    vendor: "mimo",
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
