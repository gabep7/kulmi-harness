import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/runtime/session-store.js";

describe("SessionStore", () => {
  beforeEach(async () => {
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-session-data-"));
  });

  it("rejects path traversal in session IDs", async () => {
    const outside = join(process.env.XDG_DATA_HOME!, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "session.json"), "{}");
    await expect(SessionStore.open("../../outside")).rejects.toThrow("invalid session ID");
  });

  it("persists the billing-specific model profile", async () => {
    const store = await SessionStore.create({
      cwd: process.cwd(),
      model: "mimo-v2.5-pro",
      modelProfile: "mimo-v2.5-pro-token-plan",
    });
    const loaded = await SessionStore.open(store.id);
    expect(loaded.session.metadata.modelProfile).toBe("mimo-v2.5-pro-token-plan");
  });
});
