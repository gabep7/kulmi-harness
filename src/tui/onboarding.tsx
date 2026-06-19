import { useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { credentialHint, validateCredential, type CredentialChoice, type CredentialKind } from "../auth/credentials.js";
import { glyph, theme } from "./theme.js";

export class CredentialSetupCancelledError extends Error {
  constructor() {
    super("credential setup cancelled");
    this.name = "CredentialSetupCancelledError";
  }
}

export async function runCredentialOnboarding(initial: CredentialKind = "api"): Promise<CredentialChoice> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("MiMo credentials are missing. Set MIMO_API_KEY or MIMO_TOKEN_PLAN_API_KEY.");
  }
  let resolveChoice!: (choice: CredentialChoice) => void;
  let rejectChoice!: (error: Error) => void;
  const choice = new Promise<CredentialChoice>((resolve, reject) => {
    resolveChoice = resolve;
    rejectChoice = reject;
  });
  process.stdout.write("\u001B[?1049h\u001B[?25l");
  const instance = render(
    <CredentialSetup
      initial={initial}
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
    return await choice;
  } finally {
    instance.unmount();
    await instance.waitUntilExit();
    process.stdout.write("\u001B[?25h\u001B[?1049l");
  }
}

export function CredentialSetup({ initial, onComplete, onCancel = () => undefined }: {
  initial: CredentialKind;
  onComplete: (choice: CredentialChoice) => void;
  onCancel?: () => void;
}) {
  const { exit } = useApp();
  const [step, setStep] = useState<"plan" | "key">("plan");
  const [kind, setKind] = useState<CredentialKind>(initial);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");

  useInput((input, pressed) => {
    if (pressed.ctrl && input === "c") {
      onCancel();
      exit();
      return;
    }
    if (step === "plan" && (pressed.upArrow || pressed.downArrow || pressed.tab)) {
      setKind((value) => value === "api" ? "token-plan" : "api");
    }
    if (step === "plan" && pressed.return) setStep("key");
    if (step === "key" && pressed.escape) {
      setKey("");
      setError("");
      setStep("plan");
    }
  });

  const submit = (value: string) => {
    const clean = value.trim();
    if (!validateCredential(kind, clean)) {
      setError(credentialHint(kind));
      return;
    }
    onComplete({ kind, key: clean });
    exit();
  };

  return (
    <Box minHeight={18} flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={theme.caramel} bold>{glyph.brand} kulmi</Text>
      <Box marginTop={2} flexDirection="column">
        <Text color={theme.cream} bold>Connect MiMo</Text>
        <Text color={theme.muted}>Choose how you access MiMo V2.5 Pro. You can change this later.</Text>
      </Box>
      {step === "plan" ? (
        <Box marginTop={2} flexDirection="column">
          <Choice active={kind === "api"} title="API" detail="Pay as you go · key starts with sk-" />
          <Choice active={kind === "token-plan"} title="Token Plan" detail="Subscription quota · key starts with tp-" />
          <Box marginTop={1}><Text color={theme.faint}>↑↓ choose  ·  enter continue</Text></Box>
        </Box>
      ) : (
        <Box marginTop={2} flexDirection="column">
          <Text color={theme.sand}>{kind === "api" ? "API key" : "Token Plan key"}</Text>
          <Box borderStyle="round" borderColor={error ? theme.rose : theme.cocoa} paddingX={1}>
            <TextInput
              value={key}
              onChange={(value) => { setKey(value); setError(""); }}
              onSubmit={submit}
              placeholder={kind === "api" ? "sk-…" : "tp-…"}
              mask="•"
              showCursor
            />
          </Box>
          {error
            ? <Text color={theme.rose}>{error}</Text>
            : <Text color={theme.faint}>Will be stored in macOS Keychain, never in project files.</Text>}
          <Text color={theme.faint}>enter connect  ·  esc back</Text>
        </Box>
      )}
    </Box>
  );
}

function Choice({ active, title, detail }: { active: boolean; title: string; detail: string }) {
  return (
    <Box>
      <Text color={active ? theme.caramel : theme.faint}>{active ? "●" : "○"} </Text>
      <Text color={active ? theme.cream : theme.muted} bold={active}>{title.padEnd(12)}</Text>
      <Text color={active ? theme.sand : theme.faint}>{detail}</Text>
    </Box>
  );
}
