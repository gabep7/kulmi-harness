import { afterEach, describe, expect, it } from "vitest";
import { redactKnownSecrets, registerSecretEnvNames } from "../src/core/redact.js";

describe("secret redaction", () => {
  const originalOpenAi = process.env.OPENAI_API_KEY;
  const originalCustom = process.env.CUSTOM_PROVIDER_KEY;
  afterEach(() => {
    if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAi;
    if (originalCustom === undefined) delete process.env.CUSTOM_PROVIDER_KEY;
    else process.env.CUSTOM_PROVIDER_KEY = originalCustom;
  });

  it("redacts known environment credentials in nested values", () => {
    process.env.OPENAI_API_KEY = "sk-test-secret-value";
    expect(redactKnownSecrets({ output: "key=sk-test-secret-value", nested: ["sk-test-secret-value"] }))
      .toEqual({
        output: "key=[redacted:OPENAI_API_KEY]",
        nested: ["[redacted:OPENAI_API_KEY]"],
      });
  });

  it("redacts registered custom api_key_env names", () => {
    process.env.CUSTOM_PROVIDER_KEY = "custom-secret-value";
    registerSecretEnvNames(["CUSTOM_PROVIDER_KEY"]);
    expect(redactKnownSecrets("token=custom-secret-value"))
      .toBe("token=[redacted:CUSTOM_PROVIDER_KEY]");
  });
});