import { z } from "zod";
import { defineTool, type AnyTool } from "./types.js";

export function subagentTools(): AnyTool[] {
  return [spawnAgentTool, waitAgentsTool, inspectAgentTool, steerAgentTool, integrateAgentTool, cancelAgentTool, retryAgentTool];
}

const spawnAgentTool = defineTool({
  name: "spawn_agent",
  description:
    "Spawn a focused child agent with its own context and transcript. Explore and review workers are read-only. Implement workers use isolated git worktrees and may run in parallel; integrate their results explicitly.",
  schema: z.object({
    prompt: z.string().min(1).max(20_000),
    description: z.string().min(1).max(120).optional(),
    mode: z.enum(["explore", "review", "implement"]).default("explore"),
    background: z.boolean().default(true),
  }),
  readOnly: false,
  async execute(context, input) {
    if (!context.subagents) throw new Error("subagents are unavailable in this agent");
    if (context.autonomy === "read" && input.mode === "implement") {
      throw new Error("implement subagents require low autonomy or higher");
    }
    const content = await context.subagents.spawn({
      prompt: input.prompt,
      ...(input.description ? { description: input.description } : {}),
      mode: input.mode,
      background: input.background,
      parentAgentId: context.state.agentId,
      signal: context.signal,
    });
    return { content };
  },
});

const waitAgentsTool = defineTool({
  name: "wait_agents",
  description: "Wait for background child agents and return their structured results. An empty list waits for all workers.",
  schema: z.object({ job_ids: z.array(z.string()).default([]) }),
  readOnly: true,
  async execute(context, input) {
    if (!context.subagents) throw new Error("subagents are unavailable in this agent");
    return { content: await context.subagents.wait(input.job_ids, context.signal) };
  },
});

const inspectAgentTool = defineTool({
  name: "inspect_agent",
  description: "Inspect one child agent's current state without waiting.",
  schema: z.object({ job_id: z.string().min(1) }),
  readOnly: true,
  async execute(context, input) {
    if (!context.subagents) throw new Error("subagents are unavailable in this agent");
    return { content: context.subagents.inspect(input.job_id) };
  },
});

const steerAgentTool = defineTool({
  name: "steer_agent",
  description: "Send additional instructions to a running child agent. The message is applied at its next model boundary.",
  schema: z.object({ job_id: z.string().min(1), message: z.string().min(1).max(20_000) }),
  readOnly: false,
  async execute(context, input) {
    if (!context.subagents) throw new Error("subagents are unavailable in this agent");
    return { content: await context.subagents.steer(input.job_id, input.message) };
  },
});

const integrateAgentTool = defineTool({
  name: "integrate_agent",
  description:
    "Integrate one completed implement agent's non-conflicting regular-file changes into the parent checkout. The worktree is retained for review.",
  schema: z.object({ job_id: z.string().min(1) }),
  readOnly: false,
  async execute(context, input) {
    if (!context.subagents) throw new Error("subagents are unavailable in this agent");
    return { content: await context.subagents.integrate(input.job_id) };
  },
});

const cancelAgentTool = defineTool({
  name: "cancel_agent",
  description: "Cancel one queued or running child agent and wait for it to stop.",
  schema: z.object({ job_id: z.string().min(1) }),
  readOnly: false,
  async execute(context, input) {
    if (!context.subagents) throw new Error("subagents are unavailable in this agent");
    return { content: await context.subagents.cancel(input.job_id) };
  },
});

const retryAgentTool = defineTool({
  name: "retry_agent",
  description: "Retry a failed or cancelled child agent as a new durable job with the same prompt and isolation mode.",
  schema: z.object({ job_id: z.string().min(1) }),
  readOnly: false,
  async execute(context, input) {
    if (!context.subagents) throw new Error("subagents are unavailable in this agent");
    return { content: await context.subagents.retry(input.job_id, context.signal) };
  },
});
