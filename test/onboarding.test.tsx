import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { CredentialSetup } from "../src/tui/onboarding.js";

afterEach(cleanup);

describe("credential setup screen", () => {
  it("starts with provider fields when no profile exists", async () => {
    const view = render(<CredentialSetup needsProfile onComplete={() => undefined} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("Set up a model provider");
    expect(frame).toContain("Base URL");
    expect(frame).toContain("OpenAI-compatible");
  });

  it("shows the existing profile and only asks for a key", async () => {
    const view = render(
      <CredentialSetup
        needsProfile={false}
        existingProfile={{
          name: "a6-grok",
          model: "grok-4.5",
          baseUrl: "https://a6.a6api.com/v1",
          apiKeyEnv: "A6_GROK_API_KEY",
        }}
        onComplete={() => undefined}
      />,
    );
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("Connect");
    expect(frame).toContain("a6-grok");
    expect(frame).toContain("grok-4.5");
    expect(frame).toContain("https://a6.a6api.com/v1");
    expect(frame).toContain("API key");
    expect(frame).not.toContain("Base URL");
    expect(frame).not.toContain("Set up a model provider");
  });

  it("cancels cleanly with ctrl+c", async () => {
    const cancel = vi.fn();
    const view = render(
      <CredentialSetup needsProfile={false} onComplete={() => undefined} onCancel={cancel} />,
    );
    view.stdin.write("\u0003");
    await tick();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

function tick(ms = 20): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
