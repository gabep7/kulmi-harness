import { z } from "zod";
import { readAgentPrompt, type AgentDefinition } from "../config/agents.js";
import { defineTool, type AnyTool } from "./types.js";

export function subagentTools(customAgents?: AgentDefinition[]): AnyTool[] {
  const byName = new Map((customAgents ?? []).map((agent) => [agent.name, agent]));
  const agentNames = [...byName.keys()];
  const spawnDescription = agentNames.length > 0
    ? `Spawn a focused child agent with its own context and transcript. Explore and review workers are read-only. Implement workers use isolated git worktrees and may run in parallel; integrate their results explicitly. Custom agents available: ${agentNames.join(", ")}`
    : "Spawn a focused child agent with its own context and transcript. Explore and review workers are read-only. Implement workers use isolated git worktrees and may run in parallel; integrate their results explicitly.";
  const spawnAgentTool = defineTool({
    name: "spawn_agent",
    description: spawnDescription,
    schema: z.object({
      prompt: z.string().min(1).max(20_000),
      description: z.string().min(1).max(120).optional(),
      mode: z.enum(["explore", "review", "implement"]).optional(),
      agent: z.string().optional(),
      background: z.boolean().default(true),
    }),
    readOnly: false,
    async execute(context, input) {
      if (!context.subagents) throw new Error("subagents are unavailable in this agent");
      let resolvedMode = input.mode;
      let effectivePrompt = input.prompt;
      if (input.agent) {
        const custom = byName.get(input.agent);
        if (!custom) throw new Error(`unknown agent ${input.agent}; available: ${agentNames.join(", ") || "none"}`);
        resolvedMode = resolvedMode ?? custom.mode;
        effectivePrompt = `${readAgentPrompt(custom)}\n\n${input.prompt}`;
      }
      resolvedMode = resolvedMode ?? "explore";
      if (context.autonomy === "read" && resolvedMode === "implement") {
        throw new Error("implement subagents require low autonomy or higher");
      }
      const content = await context.subagents.spawn({
        prompt: effectivePrompt,
        ...(input.description ? { description: input.description } : {}),
        mode: resolvedMode,
        background: input.background,
        parentAgentId: context.state.agentId,
        signal: context.signal,
      });
      return { content };
    },
  });
  return [spawnAgentTool, waitAgentsTool, inspectAgentTool, steerAgentTool, integrateAgentTool, cancelAgentTool, retryAgentTool];
}

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
