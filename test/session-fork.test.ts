import { describe, expect, it } from "vitest";
import { forkSession, SessionStore } from "../src/runtime/session-store.js";

describe("session forking", () => {
  it("copies history into an independent idle session", async () => {
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = `/tmp/kulmi-fork-${crypto.randomUUID()}`;
    try {
      const source = await SessionStore.create({ cwd: "/tmp/project", model: "mimo-v2.5-pro", prompt: "fix it" });
      await source.saveMessages([{ role: "user", content: "original" }]);
      const fork = await forkSession(source.id);
      const loaded = await SessionStore.open(fork.id);
      expect(fork.id).not.toBe(source.id);
      expect(fork.status).toBe("idle");
      expect(loaded.session.messages).toEqual([{ role: "user", content: "original" }]);
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previous;
    }
  });
});
