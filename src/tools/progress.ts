import { z } from "zod";
import type { PlanStep } from "../core/types.js";
import { defineTool, type AnyTool } from "./types.js";

export function progressTools(): AnyTool[] {
  return [inspectPlanTool, updatePlanTool, completeTaskTool, startTaskTool];
}

const inspectPlanTool = defineTool({
  name: "inspect_plan",
  description: "Read the canonical task plan, dependency state, evidence, modified files, and verification records.",
  schema: z.object({}),
  readOnly: true,
  async execute(context) {
    return { content: JSON.stringify({
      steps: context.state.plan,
      modified_files: [...context.state.modifiedFiles],
      verifications: context.state.verifications,
    }, null, 2) };
  },
});

const updatePlanTool = defineTool({
  name: "update_plan",
  description:
    "Replace the canonical dependency plan. Independent worker-owned steps may run together. Every completed step needs evidence and all dependencies complete first.",
  schema: z.object({
    steps: z.array(z.object({
      id: z.string().min(1).max(40),
      title: z.string().min(1).max(200),
      status: z.enum(["pending", "in_progress", "completed"]),
      evidence: z.string().max(1_000).optional(),
      depends_on: z.array(z.string().min(1).max(40)).max(20).default([]),
      acceptance_criteria: z.array(z.string().min(1).max(500)).max(20).default([]),
      owner: z.string().min(1).max(80).optional(),
    })).min(1).max(30),
  }),
  readOnly: false,
  async execute(context, input) {
    const steps: PlanStep[] = input.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      dependsOn: step.depends_on,
      acceptanceCriteria: step.acceptance_criteria,
      ...(step.evidence ? { evidence: step.evidence } : {}),
      ...(step.owner ? { owner: step.owner } : {}),
    }));
    validatePlan(steps);
    const previous = new Map(context.state.plan.map((step) => [step.id, step]));
    for (const step of steps) {
      if (previous.get(step.id)?.status === "completed" && step.status !== "completed") {
        throw new Error(`completed plan step ${step.id} cannot regress`);
      }
    }
    context.state.plan = steps;
    await context.events.emit({ type: "plan.updated", agentId: context.state.agentId, steps: context.state.plan });
    return { content: JSON.stringify({ accepted: true, steps: context.state.plan }) };
  },
});

const startTaskTool = defineTool({
  name: "start_task",
  description:
    "Promote this session from free-form chat to goal-oriented task mode. In task mode you must create a plan, work through it step by step, and call complete_task to finish. Use this when the user has given you a concrete implementation or research request rather than casual conversation.",
  schema: z.object({
    goal: z.string().min(1).max(2000).describe("Short description of what needs to be done"),
  }),
  readOnly: false,
  async execute(context, input) {
    if (context.state.mode === "task") {
      return { content: JSON.stringify({ accepted: true, already_task: true, goal: input.goal }) };
    }
    context.state.mode = "task";
    return { content: JSON.stringify({ accepted: true, mode: "task", goal: input.goal }) };
  },
});

const completeTaskTool = defineTool({
  name: "complete_task",
  description:
    "Request task completion or report a hard blocker. Completed work is accepted only when every plan step is complete and modified files have successful verification evidence.",
  schema: z.object({
    status: z.enum(["completed", "blocked"]),
    summary: z.string().min(1).max(4_000),
    evidence: z.array(z.string().min(1).max(1_000)).max(30).default([]),
  }),
  readOnly: false,
  async execute(context, input) {
    if (input.status === "completed") {
      const pendingWorkers = context.subagents?.pending() ?? [];
      if (pendingWorkers.length > 0) {
        throw new Error(`cannot complete while child agents are still running: ${pendingWorkers.join(", ")}`);
      }
      const unfinished = context.state.plan.filter((step) => step.status !== "completed");
      if (unfinished.length > 0) {
        throw new Error(`cannot complete task with unfinished plan steps: ${unfinished.map((step) => step.id).join(", ")}`);
      }
      if (
        context.state.modifiedFiles.size > 0 &&
        !context.state.verifications.some((verification) =>
          verification.exitCode === 0 &&
          !verification.timedOut &&
          !verification.truncated &&
          verification.revision === context.state.revision
        )
      ) {
        throw new Error("cannot complete modified work without a successful test, check, lint, or build command");
      }
    }
    context.state.completion = {
      status: input.status,
      summary: input.summary,
      evidence: input.evidence,
    };
    return {
      content: JSON.stringify({
        accepted: true,
        status: input.status,
        modified_files: [...context.state.modifiedFiles],
        verifications: context.state.verifications,
      }),
    };
  },
});

export function validatePlan(steps: PlanStep[]): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (byId.size !== steps.length) throw new Error("plan step IDs must be unique");
  for (const step of steps) {
    if (step.status === "completed" && !step.evidence?.trim()) {
      throw new Error(`completed plan step ${step.id} requires evidence`);
    }
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`plan step ${step.id} has unknown dependency ${dependency}`);
      if (dependency === step.id) throw new Error(`plan step ${step.id} cannot depend on itself`);
      if (step.status !== "pending" && byId.get(dependency)?.status !== "completed") {
        throw new Error(`plan step ${step.id} cannot be ${step.status} before dependency ${dependency} completes`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`plan dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}
