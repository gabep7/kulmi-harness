import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
import { progressTools, workerProgressTools } from "../src/tools/progress.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { defineTool } from "../src/tools/types.js";
import { z } from "zod";

describe("Agent", () => {
  beforeEach(async () => {
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "kulmi-data-"));
  });

  it("restores the system contract for legacy history without a system message", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-workspace-"));
    const session = await SessionStore.create({ cwd: workspace, model: "test-model" });
    const state: RunState = {
      agentId: "agent_legacy",
      mode: "chat",
      status: "idle",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    const agent = new Agent({
      provider: new ScriptedProvider([]),
      tools: new ToolRegistry([]),
      events: new EventBus(),
      session,
      checkpoint: new CheckpointStore(session.path, workspace),
      artifacts: new ArtifactStore(session.path),
      state,
      systemPrompt: "restored contract",
      workspaceRoot: workspace,
      cwd: workspace,
      autonomy: "read",
      maxSteps: 1,
      commandTimeoutMs: 1_000,
      maxOutputBytes: 10_000,
      contextWindow: 1_000_000,
      messages: [{ role: "user", content: "legacy message" }],
    });
    expect(agent.messages.slice(0, 2)).toEqual([
      { role: "system", content: "restored contract" },
      { role: "user", content: "legacy message" },
    ]);
  });

  it("round-trips reasoning and returns the accepted completion summary", async () => {
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
    expect(result).toMatchObject({ status: "completed", text: "done" });
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
      // the automatic prefix cache keeps hitting. Rewriting earlier history
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
    execFileSync("git", ["init", workspace], { stdio: "ignore" });
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
    expect(provider.requests[0]?.cacheScope).toBe("agent_deferred:chat:0");
    expect(provider.requests[1]?.cacheScope).toBe("agent_deferred:task:0");
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
    expect(provider.requests[0]?.cacheScope).toBeUndefined();
    expect(provider.requests[1]?.cacheScope).toBe("agent_compact:chat:1");
    expect((await readdir(join(session.path, "archives"))).length).toBe(1);
    expect(agent.messages.some((message) =>
      message.role === "user" && typeof message.content === "string" && message.content.includes("<compaction-summary>"))).toBe(true);
    expect(agent.messages[0]).toEqual({ role: "system", content: "stable" });
  });

  it("prunes only old bulky tool output from compaction summary input", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-workspace-"));
    const provider = new ScriptedProvider([textResponse("durable summary"), textResponse("continued")]);
    const events = new EventBus();
    const session = await SessionStore.create({ cwd: workspace, model: provider.model });
    session.attach(events);
    const oldLargeOutput = `old-head\n${"x".repeat(4_500)}\nOLD_SECRET_MIDDLE\n${"x".repeat(4_500)}\nold-tail`;
    const liveLargeOutput = `live-head\n${"y".repeat(4_500)}\nLIVE_SECRET_MIDDLE\n${"y".repeat(4_500)}\nlive-tail`;
    const messages: ProviderMessage[] = [
      { role: "system", content: "stable" },
      { role: "user", content: "old request" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "old-read", type: "function", function: { name: "read_file", arguments: "{\"path\":\"old.ts\"}" } }],
      },
      { role: "tool", tool_call_id: "old-read", name: "read_file", content: oldLargeOutput },
      { role: "user", content: "empty search" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "empty-search", type: "function", function: { name: "grep", arguments: "{\"pattern\":\"missing\"}" } }],
      },
      { role: "tool", tool_call_id: "empty-search", name: "grep", content: "no matches" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "old decision" },
      { role: "assistant", content: "decision recorded" },
      { role: "user", content: "recent request at compaction boundary" },
      { role: "assistant", content: "recent answer" },
      { role: "user", content: "tail request" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "live-read", type: "function", function: { name: "read_file", arguments: "{\"path\":\"live.ts\"}" } }],
      },
      { role: "tool", tool_call_id: "live-read", name: "read_file", content: liveLargeOutput },
      { role: "user", content: "tail after tool" },
      { role: "assistant", content: "tail answer" },
      { role: "user", content: "tail two" },
      { role: "assistant", content: "tail answer two" },
      { role: "user", content: "tail three" },
      { role: "assistant", content: "tail answer three" },
    ];
    const state: RunState = {
      agentId: "agent_prune_compact",
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
      contextWindow: 6_000,
      messages,
    });

    expect((await agent.run("continue", new AbortController().signal)).text).toBe("continued");
    const compactionUser = provider.requests[0]?.messages[1];
    expect(compactionUser).toMatchObject({ role: "user" });
    if (!compactionUser || compactionUser.role !== "user") throw new Error("missing compaction request");
    if (typeof compactionUser.content !== "string") throw new Error("compaction request should be text");
    const summaryInput = JSON.stringify(JSON.parse(compactionUser.content));
    expect(summaryInput).toContain("[Tool result pruned before compaction:");
    expect(summaryInput).toContain("[...pruned...]");
    expect(summaryInput).not.toContain("OLD_SECRET_MIDDLE");
    expect(summaryInput).toContain("[Uneventful result elided]");
    expect(summaryInput).not.toContain("LIVE_SECRET_MIDDLE");

    const archives = await readdir(join(session.path, "archives"));
    expect(archives).toHaveLength(1);
    const archivedMessages = await readFile(join(session.path, "archives", archives[0]!), "utf8");
    expect(archivedMessages).toContain("OLD_SECRET_MIDDLE");
    expect(archivedMessages).toContain("LIVE_SECRET_MIDDLE");
    expect(JSON.stringify(agent.messages)).toContain("LIVE_SECRET_MIDDLE");
  });

  it("converts @image prompt attachments into provider content parts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-image-prompt-"));
    await writeFile(
      join(workspace, "pixel.png"),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/azYfHsAAAAASUVORK5CYII=", "base64"),
    );
    const provider = new ScriptedProvider([textResponse("seen")], "test-model");
    const session = await SessionStore.create({ cwd: workspace, model: provider.model });
    const state: RunState = {
      agentId: "agent_image_prompt",
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
      events: new EventBus(),
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
      contextWindow: 1_000_000,
    });

    await expect(agent.run("Compare @image pixel.png now", new AbortController().signal)).resolves.toMatchObject({ text: "seen" });
    const userMessage = provider.requests[0]?.messages[1];
    if (!userMessage || userMessage.role !== "user" || !Array.isArray(userMessage.content)) {
      throw new Error("image prompt should be sent as user content parts");
    }
    expect(userMessage.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^Compare\s+now$/) });
    expect(userMessage.content[1]).toEqual({
      type: "image_url",
      image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
    });
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

  it("requires an evidence-backed report before a worker can finish", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-worker-"));
    const provider = new ScriptedProvider([
      textResponse("premature report"),
      toolResponse("report", "report_worker", JSON.stringify({
        status: "completed",
        summary: "inspection complete",
        evidence: ["reviewed the assigned scope"],
      }), "report evidence"),
      textResponse("Completed the inspection with evidence."),
    ]);
    const session = await SessionStore.create({ cwd: workspace, model: provider.model });
    const state: RunState = {
      agentId: "worker_test",
      parentAgentId: "agent_parent",
      mode: "subagent",
      status: "idle",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    const agent = new Agent({
      provider,
      tools: new ToolRegistry(workerProgressTools()),
      events: new EventBus(),
      session,
      checkpoint: new CheckpointStore(session.path, workspace),
      artifacts: new ArtifactStore(session.path),
      state,
      systemPrompt: "worker",
      workspaceRoot: workspace,
      cwd: workspace,
      autonomy: "read",
      maxSteps: 5,
      commandTimeoutMs: 1_000,
      maxOutputBytes: 10_000,
      contextWindow: 1_000_000,
    });

    await expect(agent.run("inspect", new AbortController().signal)).resolves.toMatchObject({
      status: "completed",
      text: "inspection complete",
    });
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("report_worker"),
    });
    expect(state.completion).toMatchObject({ summary: "inspection complete" });
  });

  it("stops identical tool-call loops after one corrective warning", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-tool-loop-"));
    const provider = new ScriptedProvider([
      toolResponse("one", "noop", "{}", "first"),
      toolResponse("two", "noop", "{}", "again"),
      toolResponse("three", "noop", "{}", "again"),
      toolResponse("four", "noop", "{}", "again"),
    ]);
    const session = await SessionStore.create({ cwd: workspace, model: provider.model });
    let executions = 0;
    const noop = defineTool({
      name: "noop",
      description: "noop",
      schema: z.object({}),
      readOnly: true,
      async execute() {
        executions += 1;
        return { content: "ok" };
      },
    });
    const state: RunState = {
      agentId: "agent_loop",
      mode: "task",
      status: "idle",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([noop]),
      events: new EventBus(),
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

    await expect(agent.run("loop", new AbortController().signal)).rejects.toThrow(
      "repeated an identical tool call after being told to change approach",
    );
    expect(provider.requests).toHaveLength(4);
    expect(executions).toBe(2);
    expect(agent.messages.at(-1)).toMatchObject({
      role: "tool",
      content: "repeated identical tool call blocked; change the arguments or approach",
    });
  });

  it("restores an undo boundary and starts a new cache epoch", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-agent-undo-"));
    const provider = new ScriptedProvider([textResponse("continued")]);
    const session = await SessionStore.create({ cwd: workspace, model: provider.model });
    const state: RunState = {
      agentId: "agent_undo",
      mode: "task",
      status: "completed",
      plan: [{ id: "done", title: "done", status: "completed", evidence: "old", dependsOn: [], acceptanceCriteria: [] }],
      modifiedFiles: new Set(["old.txt"]),
      verifications: [],
      revision: 1,
    };
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([]),
      events: new EventBus(),
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
      contextWindow: 1_000_000,
      messages: [
        { role: "system", content: "stable" },
        { role: "user", content: "old turn" },
        { role: "assistant", content: "old answer" },
      ],
    });
    const before: RunState = {
      agentId: "agent_undo",
      mode: "chat",
      status: "idle",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };

    const transaction = await agent.applyUndo({
      messageCount: 1,
      state: before,
      history: "truncate",
      checkpointId: "0001-agent_undo",
    });
    expect(transaction.removedMessages).toHaveLength(2);
    expect(agent.messages).toEqual([{ role: "system", content: "stable" }]);
    expect(state).toMatchObject({ mode: "chat", status: "idle", revision: 0 });
    expect([...state.modifiedFiles]).toEqual([]);

    await expect(agent.run("continue", new AbortController().signal)).resolves.toMatchObject({ text: "continued" });
    expect(provider.requests[0]?.cacheScope).toBe("agent_undo:chat:1");
  });
});

class ScriptedProvider implements ModelProvider {
  readonly name = "fake";
  readonly model: string;
  readonly requests: ProviderRequest[] = [];
  readonly #responses: ProviderResponse[];

  constructor(responses: ProviderResponse[], model = "test-model") {
    this.model = model;
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
