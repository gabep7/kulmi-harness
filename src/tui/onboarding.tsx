import { useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { validateCredential, credentialHint, type CredentialChoice } from "../auth/credentials.js";
import { glyph, theme } from "./theme.js";

export class CredentialSetupCancelledError extends Error {
  constructor() {
    super("credential setup cancelled");
    this.name = "CredentialSetupCancelledError";
  }
}

export async function runCredentialOnboarding(): Promise<CredentialChoice> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("API key is missing. Set the environment variable named by your model profile's api_key_env.");
  }
  const { promise, resolve: resolveChoice, reject: rejectChoice } = Promise.withResolvers<CredentialChoice>();
  process.stdout.write("\u001B[?1049h\u001B[?25l");
  const instance = render(
    <CredentialSetup
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
    process.stdout.write("\u001B?25h\u001B[?1049l");
  }
}

export function CredentialSetup({ onComplete, onCancel = () => undefined }: {
  onComplete: (choice: CredentialChoice) => void;
  onCancel?: () => void;
}) {
  const { exit } = useApp();
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

  const submit = (value: string) => {
    const clean = value.trim();
    if (!validateCredential(clean)) {
      setError(credentialHint());
      return;
    }
    onComplete({ key: clean });
    exit();
  };

  return (
    <Box minHeight={14} flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={theme.caramel} bold>{glyph.brand} kulmi</Text>
      <Box marginTop={2} flexDirection="column">
        <Text color={theme.cream} bold>Connect</Text>
        <Text color={theme.muted}>Enter your API key. You can change this later with `kulmi auth`.</Text>
      </Box>
      <Box marginTop={2} flexDirection="column">
        <Text color={theme.sand}>API key</Text>
        <Box borderStyle="round" borderColor={error ? theme.rose : theme.cocoa} paddingX={1}>
          <TextInput
            value={key}
            onChange={(value) => { setKey(value); setError(""); }}
            onSubmit={submit}
            placeholder="sk-…"
            mask="•"
            showCursor
          />
        </Box>
        {error
          ? <Text color={theme.rose}>{error}</Text>
          : <Text color={theme.faint}>Will be stored in macOS Keychain, never in project files.</Text>}
        <Text color={theme.faint}>enter connect  ·  esc cancel</Text>
      </Box>
    </Box>
  );
}