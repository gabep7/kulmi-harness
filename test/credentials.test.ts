import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptCredential,
  MacKeychain,
  resolveExistingCredential,
  type Keychain,
} from "../src/auth/credentials.js";
import { TEST_API_KEY_ENV, TEST_MODEL_PROFILE, writeTestModelConfig } from "./helpers/test-config.js";

const originalKey = process.env[TEST_API_KEY_ENV];
const originalHome = process.env.HOME;

afterEach(() => {
  restore(TEST_API_KEY_ENV, originalKey);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("credential onboarding", () => {
  it("uses a Keychain credential and matching model profile", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kulmi-credentials-"));
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    await writeTestModelConfig(cwd);
    delete process.env[TEST_API_KEY_ENV];
    const result = await resolveExistingCredential({
      cwd,
      keychain: new FakeKeychain("sk-123456789"),
    });
    expect(result).toMatchObject({ model: TEST_MODEL_PROFILE, source: "keychain" });
    expect(process.env[TEST_API_KEY_ENV]).toBe("sk-123456789");
  });

  it("prefers the environment credential when available", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kulmi-credentials-"));
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    await writeTestModelConfig(cwd);
    process.env[TEST_API_KEY_ENV] = "sk-123456789";
    await expect(resolveExistingCredential({ cwd, keychain: new FakeKeychain() })).resolves.toMatchObject({
      model: TEST_MODEL_PROFILE,
      source: "environment",
    });
  });

  it("accepts a new credential and stores it in the keychain", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kulmi-credentials-"));
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-home-"));
    await writeTestModelConfig(cwd);
    const result = await acceptCredential({
      cwd,
      choice: { key: "sk-123456789" },
      keychain: new FakeKeychain(),
    });
    expect(result.model).toBe(TEST_MODEL_PROFILE);
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
    await expect(keychain.read()).resolves.toBe("sk-123456789");
    await expect(keychain.save("sk-123456789")).resolves.toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["find-generic-password", "-s", "dev.kulmi.api-key", "-a", "default", "-w"]);
    expect(calls[1]).toContain("sk-123456789");
  });
});

class FakeKeychain implements Keychain {
  #key: string | undefined;

  constructor(key?: string) {
    this.#key = key;
  }

  async read(): Promise<string | undefined> {
    return this.#key;
  }

  async save(key: string): Promise<boolean> {
    this.#key = key;
    return true;
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
