import { afterEach, describe, expect, it } from "vitest";
import { disposeChildEnvironment, safeChildEnvironment } from "../src/security/environment.js";
import { delimiter, isAbsolute } from "node:path";

describe("safe child environment", () => {
  const original = process.env.MIMO_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.MIMO_API_KEY;
    else process.env.MIMO_API_KEY = original;
  });

  it("does not pass provider credentials to model-controlled processes", () => {
    process.env.MIMO_API_KEY = "sk-secret";
    const env = safeChildEnvironment();
    expect(env.MIMO_API_KEY).toBeUndefined();
    expect(env.HOME).not.toBe(process.env.HOME);
    expect(env.PATH?.split(delimiter).every((entry) => isAbsolute(entry))).toBe(true);
    disposeChildEnvironment(env);
  });
});
