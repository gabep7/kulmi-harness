import { describe, expect, it } from "vitest";
import type { PlanStep, RunState } from "../src/core/types.js";
import { progressTools, validatePlan } from "../src/tools/progress.js";
import type { ToolContext } from "../src/tools/types.js";

describe("plan validation", () => {
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
