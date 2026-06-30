import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, type MiMoBilling } from "../config/config.js";

const execFileAsync = promisify(execFile);
const keychainService = "dev.kulmi.mimo";
const selectionService = "dev.kulmi.mimo.selection";

export type CredentialKind = "api" | "token-plan";

export interface CredentialChoice {
  kind: CredentialKind;
  key: string;
}

export interface CredentialResolution {
  model: string;
  kind: CredentialKind;
  source: "environment" | "keychain" | "prompt";
}

export interface Keychain {
  read(kind: CredentialKind): Promise<string | undefined>;
  readSelection(): Promise<CredentialKind | undefined>;
  save(choice: CredentialChoice): Promise<boolean>;
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

  async read(kind: CredentialKind): Promise<string | undefined> {
    if (this.#platform !== "darwin") return undefined;
    try {
      const { stdout } = await this.#run("/usr/bin/security", [
        "find-generic-password",
        "-s", keychainService,
        "-a", kind,
        "-w",
      ], { encoding: "utf8", timeout: 5_000 });
      const key = stdout.trim();
      return validateCredential(kind, key) ? key : undefined;
    } catch {
      return undefined;
    }
  }

  async readSelection(): Promise<CredentialKind | undefined> {
    if (this.#platform !== "darwin") return undefined;
    try {
      const { stdout } = await this.#run("/usr/bin/security", [
        "find-generic-password",
        "-s", selectionService,
        "-a", "default",
        "-w",
      ], { encoding: "utf8", timeout: 5_000 });
      const value = stdout.trim();
      return value === "api" || value === "token-plan" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async save(choice: CredentialChoice): Promise<boolean> {
    if (this.#platform !== "darwin") return false;
    try {
      await this.#run("/usr/bin/security", [
        "add-generic-password",
        "-U",
        "-s", keychainService,
        "-a", choice.kind,
        "-w", choice.key,
      ], { encoding: "utf8", timeout: 5_000 });
      await this.#run("/usr/bin/security", [
        "add-generic-password",
        "-U",
        "-s", selectionService,
        "-a", "default",
        "-w", choice.kind,
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
  const requested = options.requestedModel ? config.models[options.requestedModel] : undefined;
  if (options.requestedModel && !requested) throw new Error(`unknown model ${options.requestedModel}`);
  const requestedKind = requested ? kindForBilling(requested.billing) : undefined;
  const environmentKind = requestedKind ?? detectEnvironmentKind();
  if (environmentKind) {
    const key = process.env[envName(environmentKind)];
    if (key && validateCredential(environmentKind, key)) {
      return {
        model: options.requestedModel ?? defaultModelFor(environmentKind),
        kind: environmentKind,
        source: "environment",
      };
    }
  }

  const keychain = options.keychain ?? new MacKeychain();
  const selected = requestedKind ?? await keychain.readSelection() ?? kindForBilling(config.models[config.defaultModel]?.billing ?? "pay-as-you-go");
  const key = await keychain.read(selected);
  if (!key) return undefined;
  process.env[envName(selected)] = key;
  return {
    model: options.requestedModel ?? defaultModelFor(selected),
    kind: selected,
    source: "keychain",
  };
}

export async function acceptCredential(options: {
  choice: CredentialChoice;
  cwd: string;
  requestedModel?: string;
  keychain?: Keychain;
}): Promise<CredentialResolution & { stored: boolean }> {
  if (!validateCredential(options.choice.kind, options.choice.key)) {
    throw new Error(credentialHint(options.choice.kind));
  }
  process.env[envName(options.choice.kind)] = options.choice.key;
  const stored = await (options.keychain ?? new MacKeychain()).save(options.choice);
  const config = loadConfig(options.cwd);
  const requested = options.requestedModel ? config.models[options.requestedModel] : undefined;
  const model = requested && kindForBilling(requested.billing) === options.choice.kind
    ? options.requestedModel!
    : defaultModelFor(options.choice.kind);
  return {
    model,
    kind: options.choice.kind,
    source: "prompt",
    stored,
  };
}

export function validateCredential(kind: CredentialKind, key: string): boolean {
  const prefix = kind === "token-plan" ? "tp-" : "sk-";
  return key.startsWith(prefix) && key.length >= 10 && !/\s/.test(key);
}

export function credentialHint(kind: CredentialKind): string {
  if (kind === "token-plan") return "Token Plan keys begin with tp-.";
  return "Pay-as-you-go API keys begin with sk-.";
}

export function defaultModelFor(kind: CredentialKind): string {
  return kind === "api" ? "mimo-v2.5-pro" : "mimo-v2.5-pro-token-plan";
}

function detectEnvironmentKind(): CredentialKind | undefined {
  if (validateCredential("api", process.env.MIMO_API_KEY ?? "")) return "api";
  if (validateCredential("token-plan", process.env.MIMO_TOKEN_PLAN_API_KEY ?? "")) return "token-plan";
  return undefined;
}

function envName(kind: CredentialKind): "MIMO_API_KEY" | "MIMO_TOKEN_PLAN_API_KEY" {
  return kind === "api" ? "MIMO_API_KEY" : "MIMO_TOKEN_PLAN_API_KEY";
}

function kindForBilling(billing: MiMoBilling): CredentialKind {
  return billing === "token-plan" ? "token-plan" : "api";
}
