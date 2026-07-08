import { z } from "zod";
import { readAgentPrompt, type AgentDefinition } from "../config/agents.js";
import { defineTool, type AnyTool } from "./types.js";

type WorkerPresetName = "tester" | "reviewer" | "security" | "performance" | "release";

interface WorkerPreset {
  name: WorkerPresetName;
  description: string;
  mode: "explore" | "review" | "implement";
  prompt: string;
}

const workerPresets: WorkerPreset[] = [
  {
    name: "tester",
    description: "writes high-signal tests and runs the narrow verification they cover",
    mode: "implement",
    prompt: `Worker preset: tester.
- Add or repair tests that defend behavior, invariants, edge cases, and regressions.
- Avoid tests that only assert implementation plumbing or restate current code.
- Keep scope to the assigned files and related tests.
- Run only the targeted test command needed for your changes and report it exactly.`,
  },
  {
    name: "reviewer",
    description: "reviews changed code for correctness, regressions, and maintainability",
    mode: "review",
    prompt: `Worker preset: reviewer.
- Inspect the assigned scope without editing files.
- Report correctness, regression, maintainability, and performance issues with exact files and lines.
- Prioritize findings as P0, P1, P2, or P3.
- Omit praise and speculative nits.`,
  },
  {
    name: "security",
    description: "reviews sandbox, credential, path, command, and replay safety risks",
    mode: "review",
    prompt: `Worker preset: security.
- Inspect the assigned scope without editing files.
- Focus on sandbox escapes, credential exposure, path traversal, unsafe shell policy, network or publication risk, and non-idempotent replay.
- Report exploitable issues with exact files, lines, impact, and a concrete fix.
- Omit generic security advice.`,
  },
  {
    name: "performance",
    description: "reviews hot paths for avoidable token, render, process, and allocation costs",
    mode: "review",
    prompt: `Worker preset: performance.
- Inspect the assigned scope without editing files.
- Focus on avoidable allocations, repeated parsing, excessive prompt or tool bytes, render churn, subprocess overhead, and unbounded output.
- Report only changes that improve real latency, memory, token use, or reliability.
- Include exact files, lines, and the expected effect.`,
  },
  {
    name: "release",
    description: "reviews install, package, build, and release-gate correctness",
    mode: "review",
    prompt: `Worker preset: release.
- Inspect the assigned scope without editing files.
- Focus on install scripts, package contents, version checks, generated dist, release bundles, and documented release gates.
- Report exact breakage risk, files, and the smallest fix.
- Do not create changelogs or release notes unless explicitly assigned.`,
  },
];

const workerPresetByName = new Map(workerPresets.map((preset) => [preset.name, preset]));

const presetNames = workerPresets.map((preset) => preset.name);

const presetInventory = workerPresets.map((preset) => `${preset.name}: ${preset.description}`).join("; ");

export function subagentTools(customAgents?: AgentDefinition[]): AnyTool[] {
  const byName = new Map((customAgents ?? []).map((agent) => [agent.name, agent]));
  const customNames = [...byName.keys()];
  const agentNames = [...new Set([...presetNames, ...customNames])];
  const customInventory = customNames.length > 0 ? ` Custom agents available: ${customNames.join(", ")}.` : "";
  const spawnDescription = `Spawn a focused child agent with its own context and transcript. Explore and review workers are read-only. Implement workers use isolated git worktrees and may run in parallel; integrate their results explicitly. Built-in presets: ${presetInventory}.${customInventory}`;
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
        const preset = workerPresetByName.get(input.agent as WorkerPresetName);
        if (custom) {
          resolvedMode = resolvedMode ?? custom.mode;
          effectivePrompt = `${readAgentPrompt(custom)}\n\n${input.prompt}`;
        } else if (preset) {
          if (resolvedMode && resolvedMode !== preset.mode) {
            throw new Error(`agent ${preset.name} requires ${preset.mode} mode`);
          }
          resolvedMode = preset.mode;
          effectivePrompt = `${preset.prompt}\n\n${input.prompt}`;
        } else {
          throw new Error(`unknown agent ${input.agent}; available: ${agentNames.join(", ") || "none"}`);
        }
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
    "Integrate one completed implement agent's non-conflicting regular-file changes into the parent checkout. Successful integration removes the child worktree; failed or conflicting integrations retain it for review.",
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
