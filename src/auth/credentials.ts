import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../config/config.js";

const execFileAsync = promisify(execFile);
const keychainService = "dev.kulmi.api-key";

export interface CredentialChoice {
  key: string;
}

export interface CredentialResolution {
  model: string;
  source: "environment" | "keychain" | "prompt";
}

export interface Keychain {
  read(): Promise<string | undefined>;
  save(key: string): Promise<boolean>;
}

type SecurityRunner = (
  file: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export class MacKeychain implements Keychain {
  readonly #run: SecurityRunner;
  readonly #platform: NodeJS.Platform;

  constructor(options: { run?: SecurityRunner; platform?: NodeJS.Platform } = {}) {
    this.#run = options.run ?? (execFileAsync as SecurityRunner);
    this.#platform = options.platform ?? process.platform;
  }

  async read(): Promise<string | undefined> {
    if (this.#platform !== "darwin") return undefined;
    try {
      const { stdout } = await this.#run("/usr/bin/security", [
        "find-generic-password",
        "-s", keychainService,
        "-a", "default",
        "-w",
      ], { encoding: "utf8", timeout: 5_000 });
      const key = stdout.trim();
      return key || undefined;
    } catch {
      return undefined;
    }
  }

  async save(key: string): Promise<boolean> {
    if (this.#platform !== "darwin") return false;
    try {
      await this.#run("/usr/bin/security", [
        "add-generic-password",
        "-U",
        "-s", keychainService,
        "-a", "default",
        "-w", key,
      ], { encoding: "utf8", timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}

export async function resolveExistingCredential(options: {
  cwd: string;
  requestedModel?: string;
  keychain?: Keychain;
}): Promise<CredentialResolution | undefined> {
  const config = loadConfig(options.cwd);
  if (Object.keys(config.models).length === 0) return undefined;
  const modelName = options.requestedModel ?? config.defaultModel;
  if (!modelName) return undefined;
  const model = config.models[modelName];
  if (!model) {
    if (options.requestedModel) throw new Error(`unknown model ${options.requestedModel}`);
    return undefined;
  }
  const envKey = process.env[model.apiKeyEnv];
  if (envKey) {
    return { model: modelName, source: "environment" };
  }
  const keychain = options.keychain ?? new MacKeychain();
  const key = await keychain.read();
  if (!key) return undefined;
  process.env[model.apiKeyEnv] = key;
  return { model: modelName, source: "keychain" };
}

export async function acceptCredential(options: {
  choice: CredentialChoice;
  cwd: string;
  requestedModel?: string;
  keychain?: Keychain;
}): Promise<CredentialResolution & { stored: boolean }> {
  const config = loadConfig(options.cwd);
  const modelName = options.requestedModel ?? config.defaultModel;
  const model = config.models[modelName];
  if (!model) throw new Error(`unknown model ${modelName}`);
  process.env[model.apiKeyEnv] = options.choice.key;
  const stored = await (options.keychain ?? new MacKeychain()).save(options.choice.key);
  return {
    model: modelName,
    source: "prompt",
    stored,
  };
}

export function validateCredential(_key: string): boolean {
  return true;
}

export function credentialHint(): string {
  return "Enter your API key.";
}
export function defaultModelFor(): string {
  throw new Error("no default model is built in; configure a model profile first");
}