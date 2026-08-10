import { useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { validateCredential, credentialHint, type CredentialChoice } from "../auth/credentials.js";
import { loadConfig, type ModelProtocol } from "../config/config.js";
import { providerPresets, findProviderPreset, defaultModelForProvider, type ProviderPreset, type ProviderModelPreset } from "../config/providers.js";
import { glyph, theme } from "./theme.js";

export class CredentialSetupCancelledError extends Error {
  constructor() {
    super("credential setup cancelled");
    this.name = "CredentialSetupCancelledError";
  }
}

export async function runCredentialOnboarding(cwd = process.cwd(), requestedModel?: string): Promise<CredentialChoice> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "API key is missing. Configure a model profile in ~/.config/kulmi/config.toml and set the env var named by api_key_env.",
    );
  }
  const config = loadConfig(cwd);
  const needsProfile = Object.keys(config.models).length === 0;
  const selectedModel = requestedModel ? config.models[requestedModel] : undefined;
  const selectedName = requestedModel && selectedModel ? requestedModel : config.defaultModel;
  const existingProfile = selectedName && config.models[selectedName]
    ? {
        name: selectedName,
        model: config.models[selectedName]!.model,
        baseUrl: safeDisplayUrl(config.models[selectedName]!.baseUrl),
        apiKeyEnv: config.models[selectedName]!.apiKeyEnv,
      }
    : undefined;

  const { promise, resolve: resolveChoice, reject: rejectChoice } = Promise.withResolvers<CredentialChoice>();
  process.stdout.write("\u001B[?1049h\u001B[?25l");
  const instance = render(
    <CredentialSetup
      needsProfile={needsProfile}
      {...(existingProfile ? { existingProfile } : {})}
      onComplete={resolveChoice}
      onCancel={() => rejectChoice(new CredentialSetupCancelledError())}
    />,
    {
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: 30,
    },
  );
  try {
    return await promise;
  } finally {
    instance.unmount();
    await instance.waitUntilExit();
    process.stdout.write("\u001B[?25h\u001B[?1049l");
  }
}

type Step = "provider" | "model" | "base_url" | "model_id" | "protocol" | "api_key";

export function CredentialSetup({
  needsProfile,
  existingProfile,
  onComplete,
  onCancel = () => undefined,
}: {
  needsProfile: boolean;
  existingProfile?: { name: string; model: string; baseUrl: string; apiKeyEnv: string };
  onComplete: (choice: CredentialChoice) => void;
  onCancel?: () => void;
}) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>(needsProfile ? "provider" : "api_key");
  const [provider, setProvider] = useState<ProviderPreset | undefined>();
  const [providerCursor, setProviderCursor] = useState(0);
  const [modelPreset, setModelPreset] = useState<ProviderModelPreset | undefined>();
  const [modelCursor, setModelCursor] = useState(0);
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [protocol, setProtocol] = useState<ModelProtocol>("openai");
  const [protocolInput, setProtocolInput] = useState("openai");
  const [key, setKey] = useState("");
  const [error, setError] = useState("");

  useInput((input, pressed) => {
    if (pressed.ctrl && input === "c") {
      onCancel();
      exit();
      return;
    }
    if (pressed.escape) {
      if (step === "provider" || !needsProfile) {
        onCancel();
        exit();
        return;
      }
      // Go back one step
      if (step === "api_key") setStep(provider?.models.length ? "model" : "model_id");
      else if (step === "model") setStep("provider");
      else if (step === "model_id") setStep(provider?.configurableBaseUrl ? "base_url" : "provider");
      else if (step === "base_url") setStep("provider");
      else if (step === "protocol") setStep("model_id");
      return;
    }
  });

  // ===== Provider picker =====
  useInput((_input, key) => {
    if (step !== "provider" || !needsProfile) return;
    if (key.upArrow) {
      setProviderCursor((c) => (c - 1 + providerPresets.length) % providerPresets.length);
      return;
    }
    if (key.downArrow) {
      setProviderCursor((c) => (c + 1) % providerPresets.length);
      return;
    }
    if (key.return) {
      const selected = providerPresets[providerCursor]!;
      setProvider(selected);
      setProtocol(selected.protocol);
      setError("");
      if (selected.id === "custom") {
        setStep("base_url");
      } else if (selected.configurableBaseUrl) {
        // For configurable providers like Ollama, ask for URL first (pre-filled)
        setBaseUrl(selected.baseUrl);
        setStep("base_url");
      } else if (selected.models.length > 0) {
        setStep("model");
      } else {
        setStep("model_id");
      }
    }
  });

  // ===== Model picker =====
  useInput((_input, key) => {
    if (step !== "model" || !provider || provider.models.length === 0) return;
    if (key.upArrow) {
      setModelCursor((c) => (c - 1 + provider.models.length) % provider.models.length);
      return;
    }
    if (key.downArrow) {
      setModelCursor((c) => (c + 1) % provider.models.length);
      return;
    }
    if (key.return) {
      const selected = provider.models[modelCursor]!;
      setModelPreset(selected);
      setModelId(selected.id);
      setError("");
      if (provider.apiKeyRequired) {
        setStep("api_key");
      } else {
        // No key needed (Ollama local) — finish with a dummy key
        finishWithProvider(selected, "ollama");
      }
    }
  });

  function finishWithProvider(model: ProviderModelPreset, apiKey: string) {
    if (!provider) return;
    const profileName = slugifyProfile(model.id);
    onComplete({
      key: apiKey,
      baseUrl: normalizeBaseUrl((baseUrl || provider.baseUrl).trim(), provider.protocol),
      model: model.id,
      profileName,
      protocol: provider.protocol,
      apiKeyEnv: provider.apiKeyEnv ?? `KULMI_${profileName.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_API_KEY`,
      thinking: model.thinking ?? false,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
      ...(model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts } : {}),
      ...(model.vision !== undefined ? { vision: model.vision } : {}),
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      providerPreset: provider.id,
      modelPreset: model.id,
    });
    exit();
  }

  const finish = (value: string) => {
    const clean = value.trim();
    if (!needsProfile) {
      if (!validateCredential(clean)) {
        setError(credentialHint());
        return;
      }
      onComplete({ key: clean });
      exit();
      return;
    }
    if (provider && modelPreset) {
      if (provider.apiKeyRequired && !validateCredential(clean)) {
        setError(credentialHint());
        return;
      }
      finishWithProvider(modelPreset, clean || "ollama");
      return;
    }
    // Custom provider flow
    if (!validateCredential(clean)) {
      setError(credentialHint());
      return;
    }
    const profileName = slugifyProfile(modelId);
    onComplete({
      key: clean,
      baseUrl: normalizeBaseUrl(baseUrl.trim(), protocol),
      model: modelId.trim(),
      profileName,
      protocol,
      apiKeyEnv: `KULMI_${profileName.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_API_KEY`,
      thinking: false,
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
    });
    exit();
  };

  const submitBaseUrl = (value: string) => {
    const clean = value.trim().replace(/\/$/, "");
    try {
      const url = new URL(clean);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    } catch {
      setError("Enter a full http(s) base URL, for example https://api.example.com/v1");
      return;
    }
    setBaseUrl(clean);
    setError("");
    if (provider?.id === "custom") {
      setStep("model_id");
    } else {
      // For configurable providers with preset models (Ollama), go to model picker
      setStep("model");
    }
  };

  const submitModelId = (value: string) => {
    const clean = value.trim();
    if (!clean) {
      setError("Model id is required");
      return;
    }
    setModelId(clean);
    setError("");
    setStep("protocol");
  };

  const submitProtocol = (value: string) => {
    const clean = value.trim().toLowerCase();
    if (clean === "" || clean === "openai" || clean === "o") {
      setProtocol("openai");
      setProtocolInput("openai");
      setError("");
      setStep("api_key");
      return;
    }
    if (clean === "responses" || clean === "openai-responses" || clean === "r") {
      setProtocol("openai-responses");
      setProtocolInput("openai-responses");
      setError("");
      setStep("api_key");
      return;
    }
    if (clean === "anthropic" || clean === "a") {
      setProtocol("anthropic");
      setProtocolInput("anthropic");
      setError("");
      setStep("api_key");
      return;
    }
    setError("Type openai, openai-responses, or anthropic");
  };

  // ===== Render =====
  return (
    <Box minHeight={16} flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={theme.caramel} bold>{glyph.brand} kulmi</Text>
      <Box marginTop={2} flexDirection="column">
        <Text color={theme.cream} bold>{needsProfile ? "Set up a model provider" : "Connect"}</Text>
        {needsProfile && step === "provider" && (
          <Text color={theme.muted}>Select your provider. Use ↑↓ to navigate, Enter to select.</Text>
        )}
        {needsProfile && step !== "provider" && provider && (
          <Text color={theme.muted}>{provider.label} — {provider.description}</Text>
        )}
        {!needsProfile && existingProfile && (
          <Text color={theme.muted}>
            Profile {existingProfile.name} → {existingProfile.model} at {existingProfile.baseUrl}
          </Text>
        )}
        {!needsProfile && !existingProfile && (
          <Text color={theme.muted}>Enter the API key for your default model profile.</Text>
        )}
      </Box>

      {/* Provider picker */}
      {needsProfile && step === "provider" && (
        <Box marginTop={1} flexDirection="column">
          {providerPresets.map((p, i) => (
            <Box key={p.id} paddingLeft={1}>
              <Text color={i === providerCursor ? theme.caramel : theme.muted} bold={i === providerCursor}>
                {i === providerCursor ? "▸ " : "  "}
                {p.label.padEnd(28)}
              </Text>
              <Text color={theme.faint}> {p.description}</Text>
            </Box>
          ))}
          {error ? <Text color={theme.rose}>{error}</Text> : <Text color={theme.faint}>↑↓ navigate  ·  enter select  ·  esc cancel</Text>}
        </Box>
      )}

      {/* Model picker */}
      {needsProfile && step === "model" && provider && provider.models.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.sand}>Select a model for {provider.label}:</Text>
          {provider.models.map((m, i) => (
            <Box key={m.id} paddingLeft={1}>
              <Text color={i === modelCursor ? theme.caramel : theme.muted} bold={i === modelCursor}>
                {i === modelCursor ? "▸ " : "  "}
                {m.label.padEnd(36)}
              </Text>
              <Text color={theme.faint}> {(m.contextWindow / 1000).toFixed(0)}k ctx{m.thinking ? "  thinking" : ""}{m.vision ? "  vision" : ""}</Text>
            </Box>
          ))}
          {error ? <Text color={theme.rose}>{error}</Text> : <Text color={theme.faint}>↑↓ navigate  ·  enter select  ·  esc back</Text>}
        </Box>
      )}

      {/* Configurable base URL (Ollama remote or custom) */}
      {needsProfile && step === "base_url" && (
        <Field
          label="Base URL"
          value={baseUrl}
          onChange={(value) => { setBaseUrl(value); setError(""); }}
          onSubmit={submitBaseUrl}
          placeholder={provider?.baseUrl ?? "https://api.example.com/v1"}
          error={error}
          hint={provider?.configurableBaseUrl && provider.id !== "custom" ? "Press Enter to use the default, or type a remote URL" : "Provider endpoint root, including /v1 when the API uses it"}
        />
      )}

      {/* Custom model ID */}
      {needsProfile && step === "model_id" && (
        <Field
          label="Model id"
          value={modelId}
          onChange={(value) => { setModelId(value); setError(""); }}
          onSubmit={submitModelId}
          placeholder="provider-model-id"
          error={error}
          hint={`Endpoint: ${baseUrl}`}
        />
      )}

      {/* Custom protocol */}
      {needsProfile && step === "protocol" && (
        <Field
          label="Protocol"
          value={protocolInput}
          onChange={(value) => { setProtocolInput(value); setError(""); }}
          onSubmit={submitProtocol}
          placeholder="openai"
          error={error}
          hint="openai (chat completions), openai-responses, or anthropic (messages). Enter accepts openai."
        />
      )}

      {/* API key */}
      {step === "api_key" && (
        <Field
          label="API key"
          value={key}
          onChange={(value) => { setKey(value); setError(""); }}
          onSubmit={finish}
          placeholder={provider?.apiKeyHint ?? "sk-…"}
          mask="•"
          error={error}
          hint={
            needsProfile && provider
              ? provider.apiKeyRequired
                ? `Will save profile ${slugifyProfile(modelPreset?.id ?? modelId)} (${provider.protocol}) and store the key in the macOS Keychain`
                : "Press Enter to skip — this provider does not require an API key"
              : existingProfile
                ? `Stored for env ${existingProfile.apiKeyEnv}, never in project files`
                : "Will be stored in macOS Keychain, never in project files"
          }
        />
      )}

      <Text color={theme.faint}>enter continue  ·  esc back/cancel</Text>
    </Box>
  );
}

function Field({
  label,
  value,
  onChange,
  onSubmit,
  placeholder,
  mask,
  error,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  mask?: string;
  error: string;
  hint: string;
}) {
  return (
    <Box marginTop={2} flexDirection="column">
      <Text color={theme.sand}>{label}</Text>
      <Box borderStyle="round" borderColor={error ? theme.rose : theme.cocoa} paddingX={1}>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          {...(placeholder !== undefined ? { placeholder } : {})}
          {...(mask !== undefined ? { mask } : {})}
          showCursor
        />
      </Box>
      {error ? <Text color={theme.rose}>{error}</Text> : <Text color={theme.faint}>{hint}</Text>}
    </Box>
  );
}

function slugifyProfile(model: string): string {
  const slug = model
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "default";
}

function safeDisplayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "configured endpoint";
  }
}

function normalizeBaseUrl(value: string, protocol: ModelProtocol): string {
  const clean = value.replace(/\/$/, "");
  return protocol === "anthropic" && clean.endsWith("/v1") ? clean.slice(0, -3) : clean;
}
