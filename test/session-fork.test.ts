import { describe, expect, it } from "vitest";
import { forkSession, SessionStore } from "../src/runtime/session-store.js";
import type { WorkerJob } from "../src/agent/scheduler.js";

describe("session forking", () => {
  it("copies history into an independent idle session", async () => {
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = `/tmp/kulmi-fork-${crypto.randomUUID()}`;
    try {
      const source = await SessionStore.create({ cwd: "/tmp/project", model: "test-model", prompt: "fix it" });
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

  it("does not share child-agent orchestration state with the fork", async () => {
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = `/tmp/kulmi-fork-${crypto.randomUUID()}`;
    try {
      const source = await SessionStore.create({ cwd: "/tmp/project", model: "test-model" });
      await source.saveMessages([{ role: "user", content: "delegate it" }]);
      const worker: WorkerJob = {
        id: "worker_1234567890abcdef",
        parentAgentId: "agent_parent",
        description: "implement",
        prompt: "implement it",
        mode: "implement",
        status: "completed",
        result: "done",
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      await source.saveWorkerJobs([worker]);

      const fork = await forkSession(source.id);
      const loaded = await SessionStore.open(fork.id);
      expect(loaded.session.workers).toBeUndefined();
      expect(loaded.session.messages.at(-1)).toMatchObject({
        role: "user",
        content: expect.stringContaining("were not inherited"),
      });
      expect((await SessionStore.open(source.id)).session.workers).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previous;
    }
  });
});
