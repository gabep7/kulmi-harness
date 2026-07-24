import { afterEach, describe, expect, it } from "vitest";
import { applyFileConfig, configTemplate, loadConfig, type KulmiConfig, type ModelConfig } from "../src/config/config.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("configuration", () => {
  it("generates a template without built-in model endpoints", () => {
    const template = configTemplate();
    expect(template).toContain("No models are built in");
    expect(template).toContain("# [models.my-model]");
    expect(template).toContain("# base_url = \"https://api.example.com/v1\"");
    expect(template).not.toContain("openai.com");
    expect(template).not.toContain("xiaomimimo");
    expect(template).toContain('# [sandbox]\n# mode = "required"');
    expect(template).toContain('[undo]\nmessage_history = "truncate"');
    expect(template).toContain("Privileged settings below apply only from ~/.config/kulmi/config.toml");
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

  it("rejects invalid limits and endpoints, and parses MCP servers", () => {
    const base = config(payg());
    expect(() => applyFileConfig(base, { max_steps: 0 })).toThrow("max_steps");
    expect(() => applyFileConfig(base, { models: { api: { base_url: "file:///tmp/model" } } })).toThrow("http or https");
    expect(() => applyFileConfig(base, { mcp: { servers: { "bad name": { command: "x" } } } })).toThrow();
    const withMcp = applyFileConfig(base, {
      mcp: { servers: { files: { command: "npx", args: ["-y", "server-filesystem"], env: { DEBUG: "1" } } } },
    });
    expect(withMcp.mcpServers).toEqual([
      { name: "files", command: "npx", args: ["-y", "server-filesystem"], env: { DEBUG: "1" } },
    ]);
  });

  it("accepts custom model profiles with arbitrary model names", () => {
    const changed = applyFileConfig(config(payg()), {
      models: {
        "claude-sonnet": {
          model: "claude-sonnet-4-20250514",
          base_url: "https://api.anthropic.com/v1",
          api_key_env: "ANTHROPIC_API_KEY",
          protocol: "anthropic",
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
      protocol: "anthropic",
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

  describe("project config privilege split", () => {
    it("keeps sandbox required when project tries to disable it", () => {
      const base = applyFileConfig(config(payg()), {
        sandbox: { mode: "required", network: false },
      });
      const changed = applyFileConfig(base, {
        sandbox: { mode: "off", network: true },
      }, "project config", "project");
      expect(changed.sandbox).toEqual({ mode: "required", network: false });
    });

    it("ignores project sandbox.network=true against defaults", () => {
      const changed = applyFileConfig(config(payg()), {
        sandbox: { network: true },
      }, "project config", "project");
      expect(changed.sandbox).toEqual({ mode: "required", network: false });
    });

    it("ignores project default_autonomy above user/default medium", () => {
      const changed = applyFileConfig(config(payg()), {
        default_autonomy: "trusted",
      }, "project config", "project");
      expect(changed.defaultAutonomy).toBe("medium");

      const nested = applyFileConfig(config(payg()), {
        default: { default_autonomy: "trusted", default_model: "api" },
      }, "project config", "project");
      expect(nested.defaultAutonomy).toBe("medium");
      expect(nested.defaultModel).toBe("api");
    });

    it("ignores project MCP servers", () => {
      const changed = applyFileConfig(config(payg()), {
        mcp: { servers: { files: { command: "npx", args: ["-y", "evil"] } } },
      }, "project config", "project");
      expect(changed.mcpServers).toEqual([]);
    });

    it("ignores project hooks", () => {
      const base = applyFileConfig(config(payg()), {
        hooks: { tool_pre: ["user-hook"] },
      });
      const changed = applyFileConfig(base, {
        hooks: {
          tool_pre: ["project-hook"],
          tool_post: ["project-post"],
        },
      }, "project config", "project");
      expect(changed.hooks.toolPre).toEqual([{ command: "user-hook", timeoutSeconds: 30 }]);
      expect(changed.hooks.toolPost).toEqual([]);
    });

    it("still allows project search, limits, and model profiles", () => {
      const changed = applyFileConfig(config(payg()), {
        max_steps: 12,
        search: { mode: "off", result_limit: 3 },
        models: {
          local: {
            model: "local-model",
            base_url: "http://127.0.0.1:8080/v1",
            api_key_env: "LOCAL_API_KEY",
            thinking: false,
            context_window: 32_000,
            max_output_tokens: 4_096,
          },
        },
        default_model: "local",
      }, "project config", "project");
      expect(changed.maxSteps).toBe(12);
      expect(changed.search.mode).toBe("off");
      expect(changed.search.resultLimit).toBe(3);
      expect(changed.defaultModel).toBe("local");
      expect(changed.models.local).toMatchObject({
        model: "local-model",
        baseUrl: "http://127.0.0.1:8080/v1",
        apiKeyEnv: "LOCAL_API_KEY",
      });
      expect(changed.sandbox).toEqual({ mode: "required", network: false });
      expect(changed.defaultAutonomy).toBe("medium");
    });

    it("lets user config set sandbox off, network, hooks, mcp, and trusted autonomy", () => {
      const changed = applyFileConfig(config(payg()), {
        sandbox: { mode: "off", network: true },
        default_autonomy: "trusted",
        hooks: { tool_pre: ["user-hook"] },
        mcp: { servers: { files: { command: "npx", args: ["-y", "server-filesystem"] } } },
      }, "user config", "user");
      expect(changed.sandbox).toEqual({ mode: "off", network: true });
      expect(changed.defaultAutonomy).toBe("trusted");
      expect(changed.hooks.toolPre).toEqual([{ command: "user-hook", timeoutSeconds: 30 }]);
      expect(changed.mcpServers).toEqual([
        { name: "files", command: "npx", args: ["-y", "server-filesystem"] },
      ]);
    });

    it("loadConfig applies user privileged settings and strips project ones", async () => {
      const home = await mkdtemp(join(tmpdir(), "kulmi-config-home-"));
      const root = await mkdtemp(join(tmpdir(), "kulmi-config-project-"));
      process.env.HOME = home;
      await mkdir(join(home, ".config", "kulmi"), { recursive: true });
      await mkdir(join(root, ".kulmi"), { recursive: true });
      await writeFile(join(home, ".config", "kulmi", "config.toml"), `
default_model = "api"
default_autonomy = "high"

[sandbox]
mode = "required"
network = false

[hooks]
tool_pre = ["user-hook"]

[mcp.servers.files]
command = "npx"
args = ["-y", "from-user"]

[models.api]
model = "user-model"
base_url = "https://api.example.com/v1"
api_key_env = "EXAMPLE_API_KEY"
thinking = false
context_window = 100000
max_output_tokens = 8000
`, "utf8");
      await writeFile(join(root, ".kulmi", "config.toml"), `
default_autonomy = "trusted"
max_steps = 9

[sandbox]
mode = "off"
network = true

[hooks]
tool_pre = ["project-hook"]

[mcp.servers.evil]
command = "npx"
args = ["-y", "from-project"]

[search]
mode = "off"

[models.local]
model = "local-model"
base_url = "http://127.0.0.1:9/v1"
api_key_env = "LOCAL_API_KEY"
thinking = false
context_window = 32000
max_output_tokens = 1000
`, "utf8");

      const loaded = loadConfig(root);
      expect(loaded.sandbox).toEqual({ mode: "required", network: false });
      expect(loaded.defaultAutonomy).toBe("high");
      expect(loaded.hooks.toolPre).toEqual([{ command: "user-hook", timeoutSeconds: 30 }]);
      expect(loaded.mcpServers).toEqual([
        { name: "files", command: "npx", args: ["-y", "from-user"] },
      ]);
      expect(loaded.maxSteps).toBe(9);
      expect(loaded.search.mode).toBe("off");
      expect(loaded.models.local?.model).toBe("local-model");
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
    mcpServers: [],
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
