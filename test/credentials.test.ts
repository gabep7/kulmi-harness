import { afterEach, describe, expect, it } from "vitest";
import {
  acceptCredential,
  MacKeychain,
  resolveExistingCredential,
  validateCredential,
  type CredentialChoice,
  type CredentialKind,
  type Keychain,
} from "../src/auth/credentials.js";

const originalApi = process.env.MIMO_API_KEY;
const originalPlan = process.env.MIMO_TOKEN_PLAN_API_KEY;

afterEach(() => {
  restore("MIMO_API_KEY", originalApi);
  restore("MIMO_TOKEN_PLAN_API_KEY", originalPlan);
});

describe("MiMo credential onboarding", () => {
  it("validates billing-specific prefixes without accepting whitespace", () => {
    expect(validateCredential("api", "sk-123456789")).toBe(true);
    expect(validateCredential("token-plan", "tp-123456789")).toBe(true);
    expect(validateCredential("api", "tp-123456789")).toBe(false);
    expect(validateCredential("api", "sk-1234 56789")).toBe(false);
  });

  it("uses a selected Keychain credential and matching model profile", async () => {
    delete process.env.MIMO_API_KEY;
    delete process.env.MIMO_TOKEN_PLAN_API_KEY;
    const result = await resolveExistingCredential({
      cwd: process.cwd(),
      keychain: new FakeKeychain({ kind: "token-plan", key: "tp-123456789" }),
    });
    expect(result).toMatchObject({ kind: "token-plan", model: "mimo-v2.5-pro-token-plan", source: "keychain" });
    expect(process.env.MIMO_TOKEN_PLAN_API_KEY).toBe("tp-123456789");
  });

  it("switches away from an incompatible requested profile", async () => {
    const result = await acceptCredential({
      cwd: process.cwd(),
      requestedModel: "mimo-v2.5-pro",
      choice: { kind: "token-plan", key: "tp-123456789" },
      keychain: new FakeKeychain(),
    });
    expect(result.model).toBe("mimo-v2.5-pro-token-plan");
    expect(result.stored).toBe(true);
  });

  it("reads and updates macOS Keychain entries through the security tool", async () => {
    const calls: string[][] = [];
    const keychain = new MacKeychain({
      platform: "darwin",
      run: async (_file, args) => {
        calls.push(args);
        return {
          stdout: args[0] === "find-generic-password" ? "sk-123456789\n" : "",
          stderr: "",
        };
      },
    });
    await expect(keychain.read("api")).resolves.toBe("sk-123456789");
    await expect(keychain.save({ kind: "api", key: "sk-123456789" })).resolves.toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(["find-generic-password", "-s", "dev.kulmi.mimo", "-a", "api", "-w"]);
    expect(calls[1]).toContain("sk-123456789");
    expect(calls[2]).toContain("api");
  });
});

class FakeKeychain implements Keychain {
  #choice: CredentialChoice | undefined;

  constructor(choice?: CredentialChoice) {
    this.#choice = choice;
  }

  async read(kind: CredentialKind): Promise<string | undefined> {
    return this.#choice?.kind === kind ? this.#choice.key : undefined;
  }

  async readSelection(): Promise<CredentialKind | undefined> {
    return this.#choice?.kind;
  }

  async save(choice: CredentialChoice): Promise<boolean> {
    this.#choice = choice;
    return true;
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
