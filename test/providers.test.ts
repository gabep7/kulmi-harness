import { describe, expect, it } from "vitest";
import { providerPresets, findProviderPreset, defaultModelForProvider } from "../src/config/providers.js";

describe("provider presets", () => {
  it("includes Ollama as the first provider", () => {
    expect(providerPresets[0]?.id).toBe("ollama");
    expect(providerPresets[0]?.apiKeyRequired).toBe(false);
    expect(providerPresets[0]?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("includes all major providers", () => {
    const ids = providerPresets.map((p) => p.id);
    expect(ids).toContain("ollama");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
    expect(ids).toContain("google");
    expect(ids).toContain("deepseek");
    expect(ids).toContain("groq");
    expect(ids).toContain("mistral");
    expect(ids).toContain("xai");
    expect(ids).toContain("openrouter");
    expect(ids).toContain("together");
    expect(ids).toContain("fireworks");
    expect(ids).toContain("custom");
  });

  it("each provider has at least one model (except custom)", () => {
    for (const provider of providerPresets) {
      if (provider.id === "custom") continue;
      expect(provider.models.length).toBeGreaterThan(0);
    }
  });

  it("each model has valid context window and max output tokens", () => {
    for (const provider of providerPresets) {
      for (const model of provider.models) {
        expect(model.contextWindow).toBeGreaterThan(0);
        expect(model.maxOutputTokens).toBeGreaterThan(0);
        expect(model.id.length).toBeGreaterThan(0);
        expect(model.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("finds a provider by id", () => {
    const anthropic = findProviderPreset("anthropic");
    expect(anthropic?.label).toBe("Anthropic (Claude)");
    expect(anthropic?.protocol).toBe("anthropic");
  });

  it("returns undefined for unknown provider id", () => {
    expect(findProviderPreset("nonexistent")).toBeUndefined();
  });

  it("finds the default model for a provider", () => {
    const ollama = findProviderPreset("ollama");
    const defaultModel = ollama ? defaultModelForProvider(ollama) : undefined;
    expect(defaultModel?.id).toBe("qwen3-coder:32b");
  });

  it("Anthropic uses the anthropic protocol", () => {
    expect(findProviderPreset("anthropic")?.protocol).toBe("anthropic");
  });

  it("OpenAI uses the openai-responses protocol", () => {
    expect(findProviderPreset("openai")?.protocol).toBe("openai-responses");
  });

  it("Google uses the openai protocol with Google base URL", () => {
    const google = findProviderPreset("google");
    expect(google?.protocol).toBe("openai");
    expect(google?.baseUrl).toContain("generativelanguage.googleapis.com");
  });

  it("Ollama does not require an API key", () => {
    expect(findProviderPreset("ollama")?.apiKeyRequired).toBe(false);
  });

  it("reasoning models have thinking and reasoning efforts", () => {
    const anthropic = findProviderPreset("anthropic");
    const sonnet = anthropic?.models.find((m) => m.id === "claude-sonnet-4-20250514");
    expect(sonnet?.thinking).toBe(true);
    expect(sonnet?.reasoningEfforts).toContain("low");
    expect(sonnet?.reasoningEfforts).toContain("medium");
    expect(sonnet?.reasoningEfforts).toContain("high");
  });

  it("vision models have vision flag", () => {
    const anthropic = findProviderPreset("anthropic");
    const sonnet = anthropic?.models.find((m) => m.id === "claude-sonnet-4-20250514");
    expect(sonnet?.vision).toBe(true);
  });

  it("custom provider has configurable base URL", () => {
    expect(findProviderPreset("custom")?.configurableBaseUrl).toBe(true);
  });

  it("Ollama has configurable base URL for remote instances", () => {
    expect(findProviderPreset("ollama")?.configurableBaseUrl).toBe(true);
  });
});
