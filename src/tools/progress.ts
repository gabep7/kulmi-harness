import { z } from "zod";
import type { PlanStep } from "../core/types.js";
import { defineTool, type AnyTool } from "./types.js";

export function progressTools(): AnyTool[] {
  return [inspectPlanTool, updatePlanTool, completeTaskTool, startTaskTool];
}

const inspectPlanTool = defineTool({
  name: "inspect_plan",
  description: "Read the task plan, evidence, modified files, and verification records.",
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
    "Replace the task plan. Keep it concise. Every completed step needs concrete evidence.",
  schema: z.object({
    steps: z.array(z.object({
      id: z.string().min(1).max(40),
      title: z.string().min(1).max(200),
      status: z.enum(["pending", "in_progress", "completed"]),
      evidence: z.string().max(1_000).optional(),
    })).min(1).max(30),
  }),
  readOnly: false,
  async execute(context, input) {
    const steps: PlanStep[] = input.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      dependsOn: [],
      acceptanceCriteria: [],
      ...(step.evidence ? { evidence: step.evidence } : {}),
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
    "Request task completion or report a hard blocker. Completion requires a non-empty evidence-backed plan; modified work also requires the exact successful current-revision verification_command.",
  schema: z.object({
    status: z.enum(["completed", "blocked"]),
    summary: z.string().min(1).max(4_000),
    evidence: z.array(z.string().min(1).max(1_000)).max(30).default([]),
    verification_command: z.string().min(1).max(2_000).optional(),
  }),
  readOnly: false,
  async execute(context, input) {
    if (input.status === "completed") {
      const pendingWorkers = context.subagents?.pending() ?? [];
      if (pendingWorkers.length > 0) {
        throw new Error(`cannot complete while child agents are still running: ${pendingWorkers.join(", ")}`);
      }
      if (context.state.plan.length === 0) {
        throw new Error("cannot complete a task without a plan");
      }
      const unfinished = context.state.plan.filter((step) => step.status !== "completed");
      if (unfinished.length > 0) {
        throw new Error(`cannot complete task with unfinished plan steps: ${unfinished.map((step) => step.id).join(", ")}`);
      }
      if (input.evidence.length === 0) {
        throw new Error("cannot complete a task without explicit evidence");
      }
      if (context.state.modifiedFiles.size > 0) {
        if (!input.verification_command) {
          throw new Error("modified work requires an explicit verification_command");
        }
        const verification = context.state.verifications.find((candidate) =>
          candidate.command === input.verification_command &&
          candidate.exitCode === 0 &&
          !candidate.timedOut &&
          !candidate.truncated &&
          candidate.revision === context.state.revision
        );
        if (!verification) {
          throw new Error(`verification_command was not a successful current-revision check: ${input.verification_command}`);
        }
        const uncovered = [...context.state.modifiedFiles].filter((path) => !verification.changedFiles.includes(path));
        if (uncovered.length > 0) {
          throw new Error(`verification does not cover modified files: ${uncovered.join(", ")}`);
        }
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
        verification_command: input.verification_command ?? null,
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
  }
}
