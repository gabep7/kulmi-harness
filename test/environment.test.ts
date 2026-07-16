import { access } from "node:fs/promises";
import { delimiter, isAbsolute } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { disposeChildEnvironment, safeChildEnvironment } from "../src/security/environment.js";

describe("safe child environment", () => {
  const original = process.env.OPENAI_API_KEY;
  afterEach(() => {
    restore("OPENAI_API_KEY", original);
  });

  it("does not pass provider credentials to model-controlled processes", () => {
    process.env.OPENAI_API_KEY = "sk-secret";
    const env = safeChildEnvironment();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.HOME).not.toBe(process.env.HOME);
    expect(env.PATH?.split(delimiter).every((entry) => isAbsolute(entry))).toBe(true);
    disposeChildEnvironment(env);
  });

  it("removes the per-child sandbox directory when disposed", async () => {
    const env = safeChildEnvironment();
    const root = env.KULMI_SANDBOX_ROOT;
    if (!root) throw new Error("safeChildEnvironment did not expose a sandbox root");
    try {
      await expect(access(root)).resolves.toBeUndefined();
    } finally {
      disposeChildEnvironment(env);
    }
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}