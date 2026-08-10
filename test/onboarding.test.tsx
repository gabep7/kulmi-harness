import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { CredentialSetup } from "../src/tui/onboarding.js";

afterEach(cleanup);

describe("credential setup screen", () => {
  it("starts with provider picker when no profile exists", async () => {
    const view = render(<CredentialSetup needsProfile onComplete={() => undefined} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("Set up a model provider");
    expect(frame).toContain("Select your provider");
    // Provider picker should show known providers
    expect(frame).toContain("Ollama Cloud");
    expect(frame).toContain("Anthropic");
    expect(frame).toContain("OpenAI");
    expect(frame).toContain("Google");
  });

  it("shows the existing profile and only asks for a key", async () => {
    const view = render(
      <CredentialSetup
        needsProfile={false}
        existingProfile={{
          name: "claude-sonnet-4-20250514",
          model: "claude-sonnet-4-20250514",
          baseUrl: "https://api.anthropic.com",
          apiKeyEnv: "ANTHROPIC_API_KEY",
        }}
        onComplete={() => undefined}
      />,
    );
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("Connect");
    expect(frame).toContain("claude-sonnet-4-20250514");
    expect(frame).toContain("https://api.anthropic.com");
    expect(frame).toContain("API key");
    expect(frame).not.toContain("Select your provider");
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

  it("navigates the provider list with arrow keys", async () => {
    const view = render(<CredentialSetup needsProfile onComplete={() => undefined} />);
    const frame1 = view.lastFrame() ?? "";
    // First item (Ollama Cloud) should be highlighted
    expect(frame1).toContain("▸");
    expect(frame1).toContain("Ollama Cloud");

    // Move down
    view.stdin.write("\u001B[B"); // down arrow
    await tick();
    const frame2 = view.lastFrame() ?? "";
    expect(frame2).toContain("Anthropic");
  });
});

function tick(ms = 20): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
