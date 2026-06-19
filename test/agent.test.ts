import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Agent, sanitizeToolPairing } from "../src/agent/agent.js";
import { EventBus } from "../src/core/events.js";
import type { RunState } from "../src/core/types.js";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "../src/provider/types.js";
import type { ProviderMessage } from "../src/provider/types.js";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import { SessionStore } from "../src/runtime/session-store.js";
import { ArtifactStore } from "../src/runtime/artifacts.js";
import { progressTools } from "../src/tools/progress.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { defineTool } from "../src/tools/types.js";
import { z } from "zod";

describe("Agent", () => {
  beforeEach(async () => {
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-data-"));
  });

  it("round-trips reasoning and enforces explicit completion", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-workspace-"));
    const provider = new ScriptedProvider([
      toolResponse("call_plan", "update_plan", JSON.stringify({
        steps: [{
          id: "inspect",
          title: "Inspect",
          status: "completed",
          evidence: "done",
          depends_on: [],
          acceptance_criteria: ["workspace inspected"],
        }],
      }), "reason about plan"),
      toolResponse("call_complete", "complete_task", JSON.stringify({
        status: "completed",
        summary: "done",
        evidence: ["inspection complete"],
      }), "reason about completion"),
      textResponse("Task completed."),
    ]);
    const events = new EventBus();
    const session = await SessionStore.create({ cwd: workspace, model: provider.model });
    session.attach(events);
    const state: RunState = {
      agentId: "agent_test",
      mode: "task",
      status: "idle",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    const agent = new Agent({
      provider,
      tools: new ToolRegistry(progressTools()),
      events,
      session,
      checkpoint: new CheckpointStore(session.path, workspace),
      artifacts: new ArtifactStore(session.path),
      state,
      systemPrompt: "stable",
      workspaceRoot: workspace,
      cwd: workspace,
      autonomy: "medium",
      maxSteps: 10,
      commandTimeoutMs: 1_000,
      maxOutputBytes: 10_000,
      contextWindow: 1_000_000,
    });

    const result = await agent.run("do it", new AbortController().signal);
    expect(result).toMatchObject({ status: "completed", text: "Task completed." });
    expect(provider.requests[1]?.messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      reasoning_content: "reason about plan",
    }));
    expect(provider.requests[1]?.messages).toContainEqual(expect.objectContaining({
      role: "tool",
      tool_call_id: "call_plan",
    }));
  });

  it("keeps an append-only, cache-stable request prefix across turns", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-workspace-"));
    const provider = new ScriptedProvider([
      toolResponse("call_plan", "update_plan", JSON.stringify({
        steps: [{ id: "inspect", title: "Inspect", status: "completed", evidence: "done", depends_on: [], acceptance_criteria: ["done"] }],
      }), "reason about plan"),
      toolResponse("call_complete", "complete_task", JSON.stringify({ status: "completed", summary: "done", evidence: ["done"] }), "reason about completion"),
      textResponse("Task completed."),
    ]);
    const events = new EventBus();
    const session = await SessionStore.create({ cwd: workspace, model: provider.model });
    session.attach(events);
    const state: RunState = {
      agentId: "agent_prefix",
      mode: "task",
      status: "idle",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    const agent = new Agent({
      provider,
      tools: new ToolRegistry(progressTools()),
      events,
      session,
      checkpoint: new CheckpointStore(session.path, workspace),
      artifacts: new ArtifactStore(session.path),
      state,
      systemPrompt: "stable",
      workspaceRoot: workspace,
      cwd: workspace,
      autonomy: "medium",
      maxSteps: 10,
      commandTimeoutMs: 1_000,
      maxOutputBytes: 10_000,
      contextWindow: 1_000_000,
    });

    await agent.run("do it", new AbortController().signal);

    const requests = provider.requests;
    expect(requests.length).toBeGreaterThanOrEqual(3);
    for (let index = 1; index < requests.length; index++) {
      const previous = requests[index - 1]!.messages;
      const current = requests[index]!.messages;
      // Each turn must be a strict prefix-extension of the previous request so
      // MiMo's automatic prefix cache keeps hitting. Rewriting earlier history
      // (not just appending) would silently destroy the cache prefix.
      expect(current.length).toBeGreaterThan(previous.length);
      expect(current.slice(0, previous.length)).toEqual(previous);
      // The tool block must stay byte-identical for the cached prefix to match.
      expect(requests[index]!.tools).toEqual(requests[0]!.tools);
    }
    // The system message is the cache anchor and must never change.
    for (const request of requests) {
      expect(request.messages[0]).toEqual({ role: "system", content: "stable" });
    }
  });

  it("defers task tools in chat and changes cache scope after promotion", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-workspace-"));
    const provider = new ScriptedProvider([
      toolResponse("call_start", "start_task", JSON.stringify({ goal: "inspect it" }), "promote"),
      toolResponse("call_plan", "update_plan", JSON.stringify({
        steps: [{ id: "inspect", title: "Inspect", status: "completed", evidence: "done", depends_on: [], acceptance_criteria: ["done"] }],
      }), "plan"),
      toolResponse("call_complete", "complete_task", JSON.stringify({ status: "completed", summary: "done", evidence: ["done"] }), "complete"),
      textResponse("done"),
    ]);
    const events = new EventBus();
    const session = await SessionStore.create({ cwd: workspace, model: provider.model });
    session.attach(events);
    const state: RunState = {
      agentId: "agent_deferred",
      mode: "chat",
      status: "idle",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    const agent = new Agent({
      provider,
      tools: new ToolRegistry(progressTools()),
      events,
      session,
      checkpoint: new CheckpointStore(session.path, workspace),
      artifacts: new ArtifactStore(session.path),
      state,
      systemPrompt: "stable",
      workspaceRoot: workspace,
      cwd: workspace,
      autonomy: "medium",
      maxSteps: 10,
      commandTimeoutMs: 1_000,
      maxOutputBytes: 10_000,
      contextWindow: 1_000_000,
    });

    expect((await agent.run("inspect it", new AbortController().signal)).text).toBe("done");
    expect(provider.requests[0]?.tools.map((tool) => tool.function.name)).toEqual(["start_task"]);
    for (const request of provider.requests.slice(1)) {
      expect(request.tools.map((tool) => tool.function.name)).toEqual(["complete_task", "inspect_plan", "update_plan"]);
    }
    expect(provider.requests[0]?.cacheScope).toBe("agent_deferred:chat");
    expect(provider.requests[1]?.cacheScope).toBe("agent_deferred:task");
  });

  it("commits mid-turn narration to the transcript before its tool rows", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-workspace-"));
    const provider = new ScriptedProvider([
      {
        message: {
          role: "assistant",
          content: "Looking into it",
          reasoning_content: "think",
          tool_calls: [{ id: "c1", type: "function", function: { name: "noop", arguments: "{}" } }],
        },
        finishReason: "tool_calls",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
      },
      textResponse("Done."),
    ]);
    const events = new EventBus();
    const order: string[] = [];
    events.on((envelope) => {
      const event = envelope.event;
      if (event.type === "assistant.message") order.push(`msg:${event.text}`);
      else if (event.type === "tool.started") order.push(`tool:${event.tool}`);
    });
    const session = await SessionStore.create({ cwd: workspace, model: provider.model });
    session.attach(events);
    const noop = defineTool({ name: "noop", description: "noop", schema: z.object({}), readOnly: true, async execute() { return { content: "ok" }; } });
    const state: RunState = {
      agentId: "agent_order",
      mode: "chat",
      status: "idle",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([noop]),
      events,
      session,
      checkpoint: new CheckpointStore(session.path, workspace),
      artifacts: new ArtifactStore(session.path),
      state,
      systemPrompt: "stable",
      workspaceRoot: workspace,
      cwd: workspace,
      autonomy: "medium",
      maxSteps: 10,
      commandTimeoutMs: 1_000,
      maxOutputBytes: 10_000,
      contextWindow: 1_000_000,
    });

    await agent.run("go", new AbortController().signal);
    expect(order).toEqual(["msg:Looking into it", "tool:noop", "msg:Done."]);
  });

  it("repairs interrupted tool groups as uncertain instead of replaying them", () => {
    const repaired = sanitizeToolPairing([
      { role: "system", content: "stable" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "reasoning",
        tool_calls: [
          { id: "one", type: "function", function: { name: "edit_file", arguments: "{}" } },
          { id: "two", type: "function", function: { name: "shell", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "one", name: "edit_file", content: "done" },
    ]);
    expect(repaired).toHaveLength(4);
    expect(repaired[3]).toMatchObject({ role: "tool", tool_call_id: "two" });
    expect((repaired[3] as { content: string }).content).toContain("uncertain");
  });

  it("archives and compacts long histories at a safe boundary", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-workspace-"));
    const provider = new ScriptedProvider([textResponse("durable summary"), textResponse("continued")]);
    const events = new EventBus();
    const session = await SessionStore.create({ cwd: workspace, model: provider.model });
    session.attach(events);
    const messages: ProviderMessage[] = [{ role: "system", content: "stable" }];
    for (let index = 0; index < 8; index++) {
      messages.push({ role: "user", content: `old question ${index}` });
      messages.push({ role: "assistant", content: `old answer ${index}` });
    }
    const state: RunState = {
      agentId: "agent_compact",
      mode: "chat",
      status: "idle",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([]),
      events,
      session,
      checkpoint: new CheckpointStore(session.path, workspace),
      artifacts: new ArtifactStore(session.path),
      state,
      systemPrompt: "stable",
      workspaceRoot: workspace,
      cwd: workspace,
      autonomy: "read",
      maxSteps: 3,
      commandTimeoutMs: 1_000,
      maxOutputBytes: 10_000,
      contextWindow: 1,
      messages,
    });

    expect((await agent.run("continue", new AbortController().signal)).text).toBe("continued");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.tools).toEqual([]);
    expect((await readdir(join(session.path, "archives"))).length).toBe(1);
    expect(agent.messages.some((message) =>
      message.role === "user" && message.content.includes("<compaction-summary>"))).toBe(true);
    expect(agent.messages[0]).toEqual({ role: "system", content: "stable" });
  });

  it("invalidates accepted completion when a later mutating tool runs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-workspace-"));
    const completedPlan = JSON.stringify({
      steps: [{
        id: "step",
        title: "step",
        status: "completed",
        evidence: "done",
        depends_on: [],
        acceptance_criteria: ["change remains valid"],
      }],
    });
    const completion = JSON.stringify({ status: "completed", summary: "done", evidence: ["plan complete"] });
    const provider = new ScriptedProvider([
      toolResponse("plan", "update_plan", completedPlan, "plan"),
      toolResponse("complete_one", "complete_task", completion, "complete"),
      toolResponse("mutate", "mutate", "{}", "change after completion"),
      textResponse("premature"),
      toolResponse("complete_two", "complete_task", completion, "complete again"),
      textResponse("done"),
    ]);
    const session = await SessionStore.create({ cwd: workspace, model: provider.model });
    const events = new EventBus();
    session.attach(events);
    const state: RunState = {
      agentId: "agent_revalidate",
      mode: "task",
      status: "idle",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    const mutate = defineTool({
      name: "mutate",
      description: "test mutator",
      schema: z.object({}),
      readOnly: false,
      async execute() { return { content: "changed" }; },
    });
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([...progressTools(), mutate]),
      events,
      session,
      checkpoint: new CheckpointStore(session.path, workspace),
      artifacts: new ArtifactStore(session.path),
      state,
      systemPrompt: "stable",
      workspaceRoot: workspace,
      cwd: workspace,
      autonomy: "medium",
      maxSteps: 10,
      commandTimeoutMs: 1_000,
      maxOutputBytes: 10_000,
      contextWindow: 1_000_000,
    });

    expect((await agent.run("do it", new AbortController().signal)).text).toBe("done");
    expect(provider.requests).toHaveLength(6);
  });
});

class ScriptedProvider implements ModelProvider {
  readonly name = "fake";
  readonly model = "mimo-v2.5-pro";
  readonly requests: ProviderRequest[] = [];
  readonly #responses: ProviderResponse[];

  constructor(responses: ProviderResponse[]) {
    this.#responses = responses;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(structuredCloneRequest(request));
    const response = this.#responses.shift();
    if (!response) throw new Error("no scripted response");
    return response;
  }
}

function structuredCloneRequest(request: ProviderRequest): ProviderRequest {
  return {
    messages: structuredClone(request.messages),
    tools: structuredClone(request.tools),
    signal: request.signal,
    ...(request.cacheScope ? { cacheScope: request.cacheScope } : {}),
  };
}

function toolResponse(id: string, name: string, args: string, reasoning: string): ProviderResponse {
  return {
    message: {
      role: "assistant",
      content: null,
      reasoning_content: reasoning,
      tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
    },
    finishReason: "tool_calls",
    usage: zeroUsage(),
  };
}

function textResponse(content: string): ProviderResponse {
  return { message: { role: "assistant", content }, finishReason: "stop", usage: zeroUsage() };
}

function zeroUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
}
