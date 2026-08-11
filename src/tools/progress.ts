import { z } from "zod";
import { assertGitWorkTree } from "../config/config.js";
import type { PlanStep } from "../core/types.js";
import { defineTool, type AnyTool, type ToolContext } from "./types.js";

export function progressTools(): AnyTool[] {
  return [inspectPlanTool, updatePlanTool, completeTaskTool, startTaskTool];
}

export function workerProgressTools(): AnyTool[] {
  return [reportWorkerTool];
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
    const steps = await commitPlan(context, input.steps);
    return { content: JSON.stringify({
      accepted: true,
      step_count: steps.length,
      completed: steps.filter((step) => step.status === "completed").length,
      in_progress: steps.find((step) => step.status === "in_progress")?.id ?? null,
    }) };
  },
});

const startTaskTool = defineTool({
  name: "start_task",
  description:
    "Promote chat to task mode for concrete implementation, inspection, code-review, or research. If the user says \"this\", \"here\", current repo/project/app/site/codebase/files, or asks for improvements/review, assume they mean the current workspace and use this tool.",
  schema: z.object({
    goal: z.string().min(1).max(2000).describe("Short description of what needs to be done"),
  }),
  readOnly: false,
  async execute(context) {
    if (context.state.mode === "task") {
      return { content: JSON.stringify({ accepted: true, already_task: true }) };
    }
    assertGitWorkTree(context.cwd);
    context.state.mode = "task";
    return { content: JSON.stringify({ accepted: true, mode: "task" }) };
  },
});

const completeTaskTool = defineTool({
  name: "complete_task",
  description:
    "Request task completion or report a hard blocker. Completion requires a non-empty evidence-backed plan: pass steps here to record it in the same call instead of calling update_plan first. Modified work also requires a successful current-revision verification_command.",
  schema: z.object({
    status: z.enum(["completed", "blocked"]),
    summary: z.string().min(1).max(4_000),
    evidence: z.array(z.string().min(1).max(1_000)).max(30).default([]),
    verification_command: z.string().min(1).max(2_000).optional(),
    steps: z.array(z.object({
      id: z.string().min(1).max(40),
      title: z.string().min(1).max(200),
      status: z.enum(["pending", "in_progress", "completed"]),
      evidence: z.string().max(1_000).optional(),
    })).max(30).optional()
      .describe("Final plan. Use this to record the plan and complete in one call."),
  }),
  readOnly: false,
  async execute(context, input) {
    // Accepting the plan here saves a model round trip per task. The invariant
    // is that completion is backed by an evidence-bearing plan, not that the
    // plan arrived in its own call.
    if (input.steps && input.steps.length > 0) await commitPlan(context, input.steps);
    if (input.status === "completed") {
      const pendingWorkers = context.subagents?.pending() ?? [];
      if (pendingWorkers.length > 0) {
        throw new Error(`cannot complete while child agents are still running: ${pendingWorkers.join(", ")}`);
      }
      if (context.state.plan.length === 0) {
        throw new Error("cannot complete a task without a plan: pass steps to this call, each completed step carrying its evidence");
      }
      const unfinished = context.state.plan.filter((step) => step.status !== "completed");
      if (unfinished.length > 0) {
        throw new Error(`cannot complete task with unfinished plan steps: ${unfinished.map((step) => step.id).join(", ")}. Pass steps here marking them completed with evidence, or report the blocker.`);
      }
      // Evidence may arrive either as the evidence list or on the plan steps.
      // Both are the same substance, and demanding the list separately made
      // models retry with the identical content in a different field.
      const stepEvidence = context.state.plan.filter((step) => step.evidence?.trim()).length;
      if (input.evidence.length === 0 && stepEvidence === 0) {
        throw new Error("cannot complete a task without explicit evidence: pass evidence as a list of concrete observations, such as the command you ran and its result, or put the evidence on each completed plan step");
      }
      if (context.state.modifiedFiles.size > 0) {
        if (!input.verification_command) {
          throw new Error(`modified work requires an explicit verification_command. ${availableVerifications(context)}`);
        }
        const verification = findVerification(context, input.verification_command);
        if (!verification) {
          throw new Error(`verification_command was not a successful current-revision check: ${input.verification_command}. ${availableVerifications(context)}`);
        }
        const uncovered = [...context.state.modifiedFiles].filter((path) => !verification.changedFiles.includes(path));
        if (uncovered.length > 0) {
          throw new Error(`verification does not cover modified files: ${uncovered.join(", ")}`);
        }
      }
    }
    if (input.status === "blocked" && input.evidence.length === 0) {
      throw new Error("reporting a blocker requires explicit evidence");
    }
    context.state.completion = {
      status: input.status,
      summary: input.summary,
      // Fall back to the plan's evidence so the recorded completion is never
      // emptier than what the agent actually supplied.
      evidence: input.evidence.length > 0
        ? input.evidence
        : context.state.plan.flatMap((step) => step.evidence?.trim() ? [`${step.title}: ${step.evidence.trim()}`] : []),
    };
    return {
      content: JSON.stringify({
        accepted: true,
        status: input.status,
        modified_files: [...context.state.modifiedFiles],
        verification_command: input.verification_command ?? null,
      }),
    };
  },
});

const reportWorkerTool = defineTool({
  name: "report_worker",
  description:
    "Submit the worker's evidence-backed completion or blocker report. Modified work requires the exact successful current-revision verification_command.",
  schema: z.object({
    status: z.enum(["completed", "blocked"]),
    summary: z.string().min(1).max(4_000),
    evidence: z.array(z.string().min(1).max(1_000)).min(1).max(30),
    verification_command: z.string().min(1).max(2_000).optional(),
  }),
  readOnly: false,
  async execute(context, input) {
    if (input.status === "completed" && context.state.modifiedFiles.size > 0) {
      if (!input.verification_command) {
        throw new Error(`modified worker output requires an explicit verification_command. ${availableVerifications(context)}`);
      }
      const verification = findVerification(context, input.verification_command);
      if (!verification) {
        throw new Error(`verification_command was not a successful current-revision check: ${input.verification_command}. ${availableVerifications(context)}`);
      }
      const uncovered = [...context.state.modifiedFiles].filter((path) => !verification.changedFiles.includes(path));
      if (uncovered.length > 0) {
        throw new Error(`verification does not cover modified files: ${uncovered.join(", ")}`);
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
        verification_command: input.verification_command ?? null,
      }),
      mutated: false,
    };
  },
});

interface PlanStepInput {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
  evidence?: string | undefined;
}

// Shared by update_plan and complete_task so both paths enforce the same
// invariants: a valid plan, and no silently un-completing a finished step.
async function commitPlan(context: ToolContext, input: PlanStepInput[]): Promise<PlanStep[]> {
  const steps: PlanStep[] = input.map((step) => ({
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
  return steps;
}

function passingVerifications(context: ToolContext) {
  return context.state.verifications.filter((candidate) =>
    candidate.exitCode === 0 &&
    !candidate.timedOut &&
    candidate.revision === context.state.revision
  );
}

function normalizeCommand(command: string): string {
  return command.replace(/["']/g, "").replace(/\s+/g, " ").trim();
}

// The recorded verification is the real evidence, but models paraphrase the
// command they ran, reporting "node test.mjs" for `node test.mjs; echo "exit=$?"`.
// Demanding a byte-exact string rejected genuinely passing checks and pushed
// agents into writing throwaway wrapper scripts. Success, freshness, and file
// coverage are still enforced strictly.
function findVerification(context: ToolContext, claimed: string) {
  const passing = passingVerifications(context);
  const wanted = normalizeCommand(claimed);
  return passing.find((candidate) => candidate.command === claimed)
    ?? passing.find((candidate) => normalizeCommand(candidate.command) === wanted)
    // A prefix match tolerates appended shell noise without letting an
    // unrelated check vouch for the claim.
    ?? passing.find((candidate) => {
      const actual = normalizeCommand(candidate.command);
      return actual.startsWith(wanted) || wanted.startsWith(actual);
    });
}

function availableVerifications(context: ToolContext): string {
  const passing = passingVerifications(context);
  if (passing.length === 0) {
    return "No successful verification is recorded for the current revision. Run a recognized check first: a test runner (pnpm test, pytest, cargo test, make check), a test or verify script (node test.mjs, ./verify.sh), or an assertion (test -f ...). The shell result line shows verification: recorded when it counts.";
  }
  const commands = [...new Set(passing.map((candidate) => candidate.command))];
  return `Recorded passing checks for this revision: ${commands.map((command) => JSON.stringify(command)).join(", ")}. Pass one of these verbatim.`;
}

export function validatePlan(steps: PlanStep[]): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (byId.size !== steps.length) throw new Error("plan step IDs must be unique");
  if (steps.filter((step) => step.status === "in_progress").length > 1) {
    throw new Error("a plan can have at most one in-progress step");
  }
  for (const step of steps) {
    if (step.status === "completed" && !step.evidence?.trim()) {
      throw new Error(`completed plan step ${step.id} requires evidence`);
    }
  }
}
