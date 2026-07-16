import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { CredentialSetup } from "../src/tui/onboarding.js";

afterEach(cleanup);

describe("credential setup screen", () => {
  it("accepts a pasted key and keeps it masked", async () => {
    const complete = vi.fn();
    const view = render(<CredentialSetup onComplete={complete} />);
    expect(view.lastFrame()).toContain("Connect");
    expect(view.lastFrame()).toContain("API key");

    view.stdin.write("sk-123456789");
    await tick();
    expect(view.lastFrame()).not.toContain("sk-123456789");
    expect(view.lastFrame()).toContain("••••");
    view.stdin.write("\r");
    await tick();
    expect(complete).toHaveBeenCalledWith({ key: "sk-123456789" });
  });

  it("cancels cleanly with ctrl+c", async () => {
    const cancel = vi.fn();
    const view = render(<CredentialSetup onComplete={() => undefined} onCancel={cancel} />);
    view.stdin.write("\u0003");
    await tick();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}