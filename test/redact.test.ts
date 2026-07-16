import { afterEach, describe, expect, it } from "vitest";
import { redactKnownSecrets } from "../src/core/redact.js";

describe("secret redaction", () => {
  const original = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  });

  it("redacts known environment credentials in nested values", () => {
    process.env.OPENAI_API_KEY = "sk-test-secret-value";
    expect(redactKnownSecrets({ output: "key=sk-test-secret-value", nested: ["sk-test-secret-value"] }))
      .toEqual({
        output: "key=[redacted:OPENAI_API_KEY]",
        nested: ["[redacted:OPENAI_API_KEY]"],
      });
  });
});