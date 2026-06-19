import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { CredentialSetup } from "../src/tui/onboarding.js";

afterEach(cleanup);

describe("credential setup screen", () => {
  it("chooses Token Plan and keeps the pasted key masked", async () => {
    const complete = vi.fn();
    const view = render(<CredentialSetup initial="api" onComplete={complete} />);
    expect(view.lastFrame()).toContain("Connect MiMo");
    expect(view.lastFrame()).toContain("Pay as you go");

    view.stdin.write("\u001B[B");
    view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).toContain("Token Plan key");

    view.stdin.write("tp-123456789");
    await tick();
    expect(view.lastFrame()).not.toContain("tp-123456789");
    expect(view.lastFrame()).toContain("••••");
    view.stdin.write("\r");
    await tick();
    expect(complete).toHaveBeenCalledWith({ kind: "token-plan", key: "tp-123456789" });
  });

  it("cancels cleanly with ctrl+c", async () => {
    const cancel = vi.fn();
    const view = render(<CredentialSetup initial="api" onComplete={() => undefined} onCancel={cancel} />);
    view.stdin.write("\u0003");
    await tick();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
