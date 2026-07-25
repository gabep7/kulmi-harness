import { useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { validateCredential, credentialHint, type CredentialChoice } from "../auth/credentials.js";
import { loadConfig, type ModelProtocol } from "../config/config.js";
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

type Step = "base_url" | "model" | "protocol" | "api_key";

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
  const [step, setStep] = useState<Step>(needsProfile ? "base_url" : "api_key");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
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
      onCancel();
      exit();
    }
  });

  const finish = (value: string) => {
    const clean = value.trim();
    if (!validateCredential(clean)) {
      setError(credentialHint());
      return;
    }
    if (!needsProfile) {
      onComplete({ key: clean });
      exit();
      return;
    }
    const profileName = slugifyProfile(model);
    onComplete({
      key: clean,
      baseUrl: normalizeBaseUrl(baseUrl.trim(), protocol),
      model: model.trim(),
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
    setStep("model");
  };

  const submitModel = (value: string) => {
    const clean = value.trim();
    if (!clean) {
      setError("Model id is required");
      return;
    }
    setModel(clean);
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
    if (clean === "anthropic" || clean === "a") {
      setProtocol("anthropic");
      setProtocolInput("anthropic");
      setError("");
      setStep("api_key");
      return;
    }
    setError("Type openai or anthropic");
  };

  return (
    <Box minHeight={16} flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={theme.caramel} bold>{glyph.brand} kulmi</Text>
      <Box marginTop={2} flexDirection="column">
        <Text color={theme.cream} bold>{needsProfile ? "Set up a model provider" : "Connect"}</Text>
        {needsProfile ? (
          <Text color={theme.muted}>
            Kulmi talks to any OpenAI-compatible /v1/chat/completions endpoint, or Anthropic Messages when protocol is anthropic.
          </Text>
        ) : existingProfile ? (
          <Text color={theme.muted}>
            Profile {existingProfile.name} → {existingProfile.model} at {existingProfile.baseUrl}
          </Text>
        ) : (
          <Text color={theme.muted}>Enter the API key for your default model profile.</Text>
        )}
      </Box>

      {needsProfile && step === "base_url" && (
        <Field
          label="Base URL"
          value={baseUrl}
          onChange={(value) => { setBaseUrl(value); setError(""); }}
          onSubmit={submitBaseUrl}
          placeholder="https://api.example.com/v1"
          error={error}
          hint="Provider endpoint root, including /v1 when the API uses it"
        />
      )}

      {needsProfile && step === "model" && (
        <Field
          label="Model id"
          value={model}
          onChange={(value) => { setModel(value); setError(""); }}
          onSubmit={submitModel}
          placeholder="provider-model-id"
          error={error}
          hint={`Endpoint: ${baseUrl}`}
        />
      )}

      {needsProfile && step === "protocol" && (
        <Field
          label="Protocol"
          value={protocolInput}
          onChange={(value) => { setProtocolInput(value); setError(""); }}
          onSubmit={submitProtocol}
          placeholder="openai"
          error={error}
          hint="openai (chat completions) or anthropic (messages). Enter accepts openai."
        />
      )}

      {step === "api_key" && (
        <Field
          label="API key"
          value={key}
          onChange={(value) => { setKey(value); setError(""); }}
          onSubmit={finish}
          placeholder="sk-…"
          mask="•"
          error={error}
          hint={
            needsProfile
              ? `Will save profile ${slugifyProfile(model)} (${protocol}) and store the key in the macOS Keychain`
              : existingProfile
                ? `Stored for env ${existingProfile.apiKeyEnv}, never in project files`
                : "Will be stored in macOS Keychain, never in project files"
          }
        />
      )}

      <Text color={theme.faint}>enter continue  ·  esc cancel</Text>
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