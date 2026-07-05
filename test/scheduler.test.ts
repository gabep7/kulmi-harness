import { describe, expect, it } from "vitest";
import { SubagentScheduler } from "../src/agent/scheduler.js";

describe("SubagentScheduler", () => {
  it("runs background workers and returns durable job state", async () => {
    const scheduler = new SubagentScheduler(2, async (job) => `result:${job.prompt}`);
    const signal = new AbortController().signal;
    const spawned = JSON.parse(await scheduler.spawn({
      prompt: "inspect auth",
      mode: "explore",
      background: true,
      parentAgentId: "parent",
      signal,
    })) as { job_id: string };
    const results = JSON.parse(await scheduler.wait([spawned.job_id], signal)) as Array<{ status: string; result: string }>;
    expect(results[0]).toMatchObject({ status: "completed", result: "result:inspect auth" });
  });

  it("keeps background writers pending until integration", async () => {
    const scheduler = new SubagentScheduler(1, async () => "changed", async () => ["src/a.ts"]);
    const signal = new AbortController().signal;
    const spawned = JSON.parse(await scheduler.spawn({
      prompt: "edit",
      mode: "implement",
      background: true,
      parentAgentId: "parent",
      signal,
    })) as { job_id: string };
    await scheduler.wait([spawned.job_id], signal);
    expect(scheduler.pending()).toEqual([spawned.job_id]);
    const integrated = JSON.parse(await scheduler.integrate(spawned.job_id)) as { integratedFiles: string[] };
    expect(integrated.integratedFiles).toEqual(["src/a.ts"]);
    expect(scheduler.pending()).toEqual([]);
  });

  it("retries failed workers as new durable jobs", async () => {
    let attempts = 0;
    const scheduler = new SubagentScheduler(1, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient failure");
      return "recovered";
    });
    const signal = new AbortController().signal;
    const first = JSON.parse(await scheduler.spawn({
      prompt: "inspect",
      mode: "explore",
      background: true,
      parentAgentId: "parent",
      signal,
    })) as { job_id: string };
    await scheduler.wait([first.job_id], signal);
    const retried = JSON.parse(await scheduler.retry(first.job_id, signal)) as { job_id: string };
    expect(retried.job_id).not.toBe(first.job_id);
    const result = JSON.parse(await scheduler.wait([retried.job_id], signal)) as Array<{ status: string; result: string }>;
    expect(result[0]).toMatchObject({ status: "completed", result: "recovered" });
  });

  it("steers a running worker and persists the instruction", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const received: string[] = [];
    const scheduler = new SubagentScheduler(
      1,
      async () => { await gate; return "done"; },
      undefined,
      undefined,
      [],
      (_job, message) => received.push(message),
    );
    const signal = new AbortController().signal;
    const spawned = JSON.parse(await scheduler.spawn({
      prompt: "inspect",
      mode: "explore",
      background: true,
      parentAgentId: "parent",
      signal,
    })) as { job_id: string };
    await new Promise((resolve) => setTimeout(resolve, 0));
    const steered = JSON.parse(await scheduler.steer(spawned.job_id, "focus on caching")) as { steering: unknown[] };
    expect(received).toEqual(["focus on caching"]);
    expect(steered.steering).toHaveLength(1);
    release();
    await scheduler.wait([spawned.job_id], signal);
  });

  it("records cancellation while a worker is still queued", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new SubagentScheduler(1, async (job) => {
      if (job.prompt === "first") await gate;
      return "done";
    });
    const signal = new AbortController().signal;
    const first = JSON.parse(await scheduler.spawn({
      prompt: "first",
      mode: "explore",
      background: true,
      parentAgentId: "parent",
      signal,
    })) as { job_id: string };
    const second = JSON.parse(await scheduler.spawn({
      prompt: "second",
      mode: "explore",
      background: true,
      parentAgentId: "parent",
      signal,
    })) as { job_id: string };

    const cancelled = JSON.parse(await scheduler.cancel(second.job_id)) as { status: string; collectedAt?: string };
    expect(cancelled).toMatchObject({ status: "cancelled", collectedAt: expect.any(String) });
    expect(scheduler.pending()).not.toContain(second.job_id);
    release();
    await scheduler.wait([first.job_id], signal);
  });

  it("persists foreground collection and treats integration as collection", async () => {
    const snapshots: Array<Array<{ collectedAt?: string; integratedAt?: string }>> = [];
    const scheduler = new SubagentScheduler(
      1,
      async () => "done",
      async () => ["src/a.ts"],
      async (jobs) => { snapshots.push(jobs); },
    );
    const signal = new AbortController().signal;
    await scheduler.spawn({
      prompt: "foreground",
      mode: "explore",
      background: false,
      parentAgentId: "parent",
      signal,
    });
    expect(snapshots.at(-1)?.[0]?.collectedAt).toEqual(expect.any(String));

    const background = JSON.parse(await scheduler.spawn({
      prompt: "implement",
      mode: "implement",
      background: true,
      parentAgentId: "parent",
      signal,
    })) as { job_id: string };
    await new Promise((resolve) => setTimeout(resolve, 0));
    await scheduler.integrate(background.job_id);
    expect(scheduler.pending()).not.toContain(background.job_id);
    expect(snapshots.at(-1)?.[1]).toMatchObject({
      collectedAt: expect.any(String),
      integratedAt: expect.any(String),
    });
  });

  it("stores materialized worker result previews with artifact IDs", async () => {
    const scheduler = new SubagentScheduler(
      1,
      async () => "full worker result that belongs in an artifact",
      undefined,
      undefined,
      [],
      undefined,
      async (_job, result) => ({
        content: `preview:${result.slice(0, 18)}`,
        artifactId: "artifact_worker_result",
      }),
    );
    const signal = new AbortController().signal;
    const spawned = JSON.parse(await scheduler.spawn({
      prompt: "summarize expensive output",
      mode: "explore",
      background: true,
      parentAgentId: "parent",
      signal,
    }));
    if (!spawned || typeof spawned !== "object" || !("job_id" in spawned) || typeof spawned.job_id !== "string") {
      throw new Error("spawn did not return a job ID");
    }

    const results = JSON.parse(await scheduler.wait([spawned.job_id], signal));
    expect(results).toEqual([
      expect.objectContaining({
        status: "completed",
        result: "preview:full worker result",
        resultArtifactId: "artifact_worker_result",
      }),
    ]);
  });
});
