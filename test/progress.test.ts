import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanStep, RunState } from "../src/core/types.js";
import { progressTools, validatePlan } from "../src/tools/progress.js";
import type { ToolContext } from "../src/tools/types.js";

describe("plan validation", () => {
  it("does not promote chat to task outside a git worktree", async () => {
    const startTask = progressTools().find((tool) => tool.name === "start_task")!;
    const root = await mkdtemp(join(tmpdir(), "kulmi-start-task-no-git-"));
    const state: RunState = {
      agentId: "agent",
      mode: "chat",
      status: "running",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };

    await expect(startTask.execute({ cwd: root, state } as ToolContext, {
      goal: "edit files",
    })).rejects.toThrow("requires a git worktree");
    expect(state.mode).toBe("chat");
  });

  it("accepts a concise evidence-backed plan", () => {
    expect(() => validatePlan([
      step("inspect", "completed", "repo mapped"),
      step("implement", "in_progress"),
      step("review", "pending"),
    ])).not.toThrow();
  });

  it("rejects duplicate IDs and completed steps without evidence", () => {
    expect(() => validatePlan([
      step("a", "pending"),
      step("a", "pending"),
    ])).toThrow("IDs must be unique");
    expect(() => validatePlan([step("a", "completed")])).toThrow("requires evidence");
    expect(() => validatePlan([
      step("a", "in_progress"),
      step("b", "in_progress"),
    ])).toThrow("at most one in-progress step");
  });

  it("requires evidence for a hard blocker", async () => {
    const complete = progressTools().find((tool) => tool.name === "complete_task")!;
    const state: RunState = {
      agentId: "agent",
      mode: "task",
      status: "running",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    await expect(complete.execute({ state } as ToolContext, {
      status: "blocked",
      summary: "missing dependency",
      evidence: [],
    })).rejects.toThrow("requires explicit evidence");
  });

  it("requires a plan, explicit evidence, and a current verification covering modified files", async () => {
    const complete = progressTools().find((tool) => tool.name === "complete_task")!;
    const state: RunState = {
      agentId: "agent",
      mode: "task",
      status: "running",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    await expect(complete.execute({ state } as ToolContext, {
      status: "completed",
      summary: "done",
      evidence: ["done"],
    })).rejects.toThrow("without a plan");

    state.plan = [step("done", "completed", "implemented")];
    state.modifiedFiles.add("src/a.ts");
    state.revision = 1;
    state.verifications.push({
      command: "npm test",
      exitCode: 0,
      timestamp: new Date().toISOString(),
      revision: 1,
      timedOut: false,
      truncated: false,
      changedFiles: [],
    });
    await expect(complete.execute({ state } as ToolContext, {
      status: "completed",
      summary: "done",
      evidence: ["implemented"],
      verification_command: "npm test",
    })).rejects.toThrow("does not cover modified files");

    state.verifications[0]!.changedFiles = ["src/a.ts"];
    await expect(complete.execute({ state } as ToolContext, {
      status: "completed",
      summary: "done",
      evidence: ["implemented"],
      verification_command: "npm test",
    })).resolves.toMatchObject({ content: expect.stringContaining('"accepted":true') });
  });

  it("accepts a paraphrased verification command but not a failing or stale one", async () => {
    const complete = progressTools().find((tool) => tool.name === "complete_task")!;
    const events = { emit: async () => undefined };
    const baseState = (): RunState => ({
      agentId: "agent",
      mode: "task",
      status: "running",
      plan: [step("done", "completed", "implemented")],
      modifiedFiles: new Set(["src/a.ts"]),
      verifications: [],
      revision: 1,
    });

    // The shell ran the check with trailing noise; the model reports the core
    // command. That used to be rejected even though the check passed.
    const state = baseState();
    state.verifications.push({
      command: 'node test.mjs; echo "exit=$?"',
      exitCode: 0,
      timestamp: new Date().toISOString(),
      revision: 1,
      timedOut: false,
      truncated: false,
      changedFiles: ["src/a.ts"],
    });
    await expect(complete.execute({ state, events } as unknown as ToolContext, {
      status: "completed",
      summary: "done",
      evidence: ["test passes"],
      verification_command: "node test.mjs",
    })).resolves.toMatchObject({ content: expect.stringContaining('"accepted":true') });

    // A failing check must never satisfy the gate.
    const failing = baseState();
    failing.verifications.push({
      command: "node test.mjs",
      exitCode: 1,
      timestamp: new Date().toISOString(),
      revision: 1,
      timedOut: false,
      truncated: false,
      changedFiles: ["src/a.ts"],
    });
    await expect(complete.execute({ state: failing, events } as unknown as ToolContext, {
      status: "completed",
      summary: "done",
      evidence: ["test passes"],
      verification_command: "node test.mjs",
    })).rejects.toThrow("not a successful current-revision check");

    // Nor may a check from before the latest edit.
    const stale = baseState();
    stale.revision = 2;
    stale.verifications.push({
      command: "node test.mjs",
      exitCode: 0,
      timestamp: new Date().toISOString(),
      revision: 1,
      timedOut: false,
      truncated: false,
      changedFiles: ["src/a.ts"],
    });
    await expect(complete.execute({ state: stale, events } as unknown as ToolContext, {
      status: "completed",
      summary: "done",
      evidence: ["test passes"],
      verification_command: "node test.mjs",
    })).rejects.toThrow("not a successful current-revision check");

    // An unrelated passing check must not vouch for the claim.
    const unrelated = baseState();
    unrelated.verifications.push({
      command: "pnpm lint",
      exitCode: 0,
      timestamp: new Date().toISOString(),
      revision: 1,
      timedOut: false,
      truncated: false,
      changedFiles: ["src/a.ts"],
    });
    await expect(complete.execute({ state: unrelated, events } as unknown as ToolContext, {
      status: "completed",
      summary: "done",
      evidence: ["test passes"],
      verification_command: "node test.mjs",
    })).rejects.toThrow("pnpm lint");
  });

  it("records the final plan passed to complete_task in one call", async () => {
    const complete = progressTools().find((tool) => tool.name === "complete_task")!;
    const emitted: unknown[] = [];
    const events = { emit: async (event: unknown) => { emitted.push(event); } };
    const state: RunState = {
      agentId: "agent",
      mode: "task",
      status: "running",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };

    // Saves a model round trip: no separate update_plan call is needed.
    await expect(complete.execute({ state, events } as unknown as ToolContext, {
      status: "completed",
      summary: "answered the question",
      evidence: ["counted the lines"],
      steps: [{ id: "count", title: "Count lines", status: "completed", evidence: "31 lines" }],
    })).resolves.toMatchObject({ content: expect.stringContaining('"accepted":true') });
    expect(state.plan).toHaveLength(1);
    expect(emitted).toHaveLength(1);

    // The inline path must keep update_plan's invariants.
    const regressing: RunState = { ...state, plan: [step("count", "completed", "31 lines")] };
    await expect(complete.execute({ state: regressing, events } as unknown as ToolContext, {
      status: "completed",
      summary: "x",
      evidence: ["y"],
      steps: [{ id: "count", title: "Count lines", status: "pending" }],
    })).rejects.toThrow("cannot regress");
  });

  it("treats plan step evidence as evidence and records it", async () => {
    const complete = progressTools().find((tool) => tool.name === "complete_task")!;
    const events = { emit: async () => undefined };
    const state: RunState = {
      agentId: "agent",
      mode: "task",
      status: "running",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };

    // Requiring the evidence list separately from step evidence made models
    // retry with identical content in a different field, burning turns.
    await expect(complete.execute({ state, events } as unknown as ToolContext, {
      status: "completed",
      summary: "fixed the off-by-one",
      evidence: [],
      steps: [{ id: "fix", title: "Fix loop bound", status: "completed", evidence: "node test.mjs prints ok" }],
    })).resolves.toMatchObject({ content: expect.stringContaining('"accepted":true') });
    expect(state.completion?.evidence).toEqual(["Fix loop bound: node test.mjs prints ok"]);

    // Evidence must still exist somewhere.
    const bare: RunState = {
      agentId: "agent",
      mode: "task",
      status: "running",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    await expect(complete.execute({ state: bare, events } as unknown as ToolContext, {
      status: "completed",
      summary: "no evidence anywhere",
      evidence: [],
      steps: [{ id: "fix", title: "Fix loop bound", status: "completed" }],
    })).rejects.toThrow(/evidence/);
  });
});

function step(
  id: string,
  status: PlanStep["status"],
  evidence?: string,
): PlanStep {
  return {
    id,
    title: id,
    status,
    dependsOn: [],
    acceptanceCriteria: [],
    ...(evidence ? { evidence } : {}),
  };
}
