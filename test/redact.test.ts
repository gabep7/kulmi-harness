import { afterEach, describe, expect, it } from "vitest";
import { redactKnownSecrets } from "../src/core/redact.js";

describe("secret redaction", () => {
  const original = process.env.MIMO_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.MIMO_API_KEY;
    else process.env.MIMO_API_KEY = original;
  });

  it("redacts known environment credentials in nested values", () => {
    process.env.MIMO_API_KEY = "sk-test-secret-value";
    expect(redactKnownSecrets({ output: "key=sk-test-secret-value", nested: ["sk-test-secret-value"] }))
      .toEqual({
        output: "key=[redacted:MIMO_API_KEY]",
        nested: ["[redacted:MIMO_API_KEY]"],
      });
  });
});
