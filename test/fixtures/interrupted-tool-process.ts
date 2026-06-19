import { writeFile } from "node:fs/promises";
import { Agent } from "../../src/agent/agent.js";
import { EventBus } from "../../src/core/events.js";
import type { RunState } from "../../src/core/types.js";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "../../src/provider/types.js";
import { ArtifactStore } from "../../src/runtime/artifacts.js";
import { CheckpointStore } from "../../src/runtime/checkpoints.js";
import { SessionStore } from "../../src/runtime/session-store.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { defineTool } from "../../src/tools/types.js";
import { z } from "zod";

const [mode, workspace, marker, output] = process.argv.slice(2);
const sessionId = "session_0123456789abcdef";
if (!mode || !workspace || !marker || !output) throw new Error("missing fixture arguments");

async function startInterruptedRun(): Promise<void> {
  const events = new EventBus();
  const session = await SessionStore.create({ cwd: workspace!, model: "mimo-v2.5-pro", id: sessionId });
  session.attach(events);
  const state = freshState();
  await session.saveRunState(state);
  const mutate = defineTool({
    name: "mutate",
    description: "Start a non-idempotent mutation and wait",
    schema: z.object({}),
    readOnly: false,
    async execute() {
      await writeFile(marker!, "started\n", "utf8");
      setInterval(() => undefined, 1_000);
      return await new Promise<never>(() => undefined);
    },
  });
  const agent = createAgent(session, state, events, new CrashProvider(), new ToolRegistry([mutate]));
  await agent.run("mutate once", new AbortController().signal);
}

async function resumeRun(): Promise<void> {
  const loaded = await SessionStore.open(sessionId);
  const events = new EventBus();
  loaded.store.attach(events);
  const provider = new RecoveryProvider(output!);
  const agent = createAgent(
    loaded.store,
    loaded.session.state ?? freshState(),
    events,
    provider,
    new ToolRegistry([]),
    loaded.session.messages,
  );
  await agent.run("resume safely", new AbortController().signal);
  await loaded.store.close("completed");
}

function createAgent(
  session: SessionStore,
  state: RunState,
  events: EventBus,
  provider: ModelProvider,
  tools: ToolRegistry,
  messages?: ProviderRequest["messages"],
): Agent {
  return new Agent({
    provider,
    tools,
    events,
    session,
    checkpoint: new CheckpointStore(session.path, workspace!),
    artifacts: new ArtifactStore(session.path),
    state,
    systemPrompt: "stable",
    workspaceRoot: workspace!,
    cwd: workspace!,
    autonomy: "medium",
    maxSteps: 5,
    commandTimeoutMs: 5_000,
    maxOutputBytes: 10_000,
    contextWindow: 1_000_000,
    ...(messages ? { messages } : {}),
  });
}

function freshState(): RunState {
  return {
    agentId: "agent_process_test",
    mode: "chat",
    status: "idle",
    plan: [],
    modifiedFiles: new Set(),
    verifications: [],
    revision: 0,
  };
}

class CrashProvider implements ModelProvider {
  readonly name = "fixture";
  readonly model = "mimo-v2.5-pro";
  async complete(): Promise<ProviderResponse> {
    return {
      message: {
        role: "assistant",
        content: null,
        reasoning_content: "perform mutation",
        tool_calls: [{ id: "call_mutate", type: "function", function: { name: "mutate", arguments: "{}" } }],
      },
      finishReason: "tool_calls",
      usage: zeroUsage(),
    };
  }
}

class RecoveryProvider implements ModelProvider {
  readonly name = "fixture";
  readonly model = "mimo-v2.5-pro";
  constructor(readonly outputPath: string) {}
  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    await writeFile(this.outputPath, `${JSON.stringify(request.messages, null, 2)}\n`, "utf8");
    return {
      message: { role: "assistant", content: "recovered" },
      finishReason: "stop",
      usage: zeroUsage(),
    };
  }
}

function zeroUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
}

if (mode === "crash") await startInterruptedRun();
else if (mode === "resume") await resumeRun();
else throw new Error(`unknown fixture mode ${mode}`);
