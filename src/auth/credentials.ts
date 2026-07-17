import { execFile, spawn } from "node:child_process";
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
  read(account: string): Promise<string | undefined>;
  save(account: string, key: string): Promise<boolean>;
}

type SecurityRunner = (
  file: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; input?: string },
) => Promise<{ stdout: string; stderr: string }>;

function defaultSecurityRunner(
  file: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; input?: string },
): Promise<{ stdout: string; stderr: string }> {
  if (options.input === undefined) {
    return execFileAsync(file, args, { encoding: options.encoding, timeout: options.timeout });
  }
  const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
  const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
  }, options.timeout);
  child.stdout.setEncoding(options.encoding);
  child.stderr.setEncoding(options.encoding);
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code === 0) {
      resolve({ stdout, stderr });
      return;
    }
    const error = new Error(`Command failed: ${file} ${args.join(" ")}`);
    Object.assign(error, { code, signal, stdout, stderr });
    reject(error);
  });
  child.stdin.end(options.input);
  return promise;
}

export class MacKeychain implements Keychain {
  readonly #run: SecurityRunner;
  readonly #platform: NodeJS.Platform;

  constructor(options: { run?: SecurityRunner; platform?: NodeJS.Platform } = {}) {
    this.#run = options.run ?? defaultSecurityRunner;
    this.#platform = options.platform ?? process.platform;
  }

  async read(account: string): Promise<string | undefined> {
    if (this.#platform !== "darwin") return undefined;
    try {
      const { stdout } = await this.#run("/usr/bin/security", [
        "find-generic-password",
        "-s", keychainService,
        "-a", account,
        "-w",
      ], { encoding: "utf8", timeout: 5_000 });
      const key = stdout.trim();
      return key || undefined;
    } catch {
      return undefined;
    }
  }

  async save(account: string, key: string): Promise<boolean> {
    if (this.#platform !== "darwin") return false;
    try {
      await this.#run("/usr/bin/security", [
        "add-generic-password",
        "-U",
        "-s", keychainService,
        "-a", account,
        "-w",
      ], { encoding: "utf8", timeout: 5_000, input: `${key}\n${key}\n` });
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
  const key = await keychain.read(model.apiKeyEnv);
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
  const stored = await (options.keychain ?? new MacKeychain()).save(model.apiKeyEnv, options.choice.key);
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