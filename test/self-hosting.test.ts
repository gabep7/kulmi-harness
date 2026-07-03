import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { EventBus } from "../src/core/events.js";
import type { RunState } from "../src/core/types.js";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "../src/provider/types.js";
import { ArtifactStore } from "../src/runtime/artifacts.js";
import { CheckpointStore } from "../src/runtime/checkpoints.js";
import { SessionStore } from "../src/runtime/session-store.js";
import { fileTools } from "../src/tools/files.js";
import { progressTools } from "../src/tools/progress.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { shellTool } from "../src/tools/shell.js";

const exec = promisify(execFile);

describe("Kulmi self-hosting path", () => {
  it("plans, inspects, edits, verifies, and completes a repository change", async () => {
    const data = await realpath(await mkdtemp(join(tmpdir(), "kulmi-self-data-")));
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "kulmi-self-workspace-")));
    process.env.XDG_DATA_HOME = data;
    await exec("git", ["init", workspace]);
    await exec("git", ["-C", workspace, "config", "user.email", "test@example.test"]);
    await exec("git", ["-C", workspace, "config", "user.name", "Test"]);
    const original = "export const reliable = false;\n";
    await writeFile(join(workspace, "feature.ts"), original);
    await writeFile(join(workspace, "package.json"), '{"scripts":{"test":"true"}}\n');
    await exec("git", ["-C", workspace, "add", "."]);
    await exec("git", ["-C", workspace, "commit", "-m", "initial"]);

    const provider = new ScriptedProvider([
      call("plan", "update_plan", {
        steps: [{ id: "implement", title: "Enable reliability", status: "in_progress" }],
      }),
      call("read", "read_file", { path: "feature.ts" }),
      call("edit", "edit_file", {
        path: "feature.ts",
        old_text: "export const reliable = false;",
        new_text: "export const reliable = true;",
        expected_sha256: digest(original),
      }),
      call("verify", "shell", { command: "npm test" }),
      call("finish-plan", "update_plan", {
        steps: [{ id: "implement", title: "Enable reliability", status: "completed", evidence: "npm test passed" }],
      }),
      call("complete", "complete_task", {
        status: "completed",
        summary: "enabled and verified",
        evidence: ["feature.ts updated", "npm test passed"],
        verification_command: "npm test",
      }),
      text("Implemented and verified."),
    ]);
    const events = new EventBus();
    const session = await SessionStore.create({ cwd: workspace, model: provider.model });
    session.attach(events);
    const state: RunState = {
      agentId: "agent_self_host",
      mode: "task",
      status: "idle",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    };
    const agent = new Agent({
      provider,
      tools: new ToolRegistry([...fileTools(), shellTool, ...progressTools()]),
      events,
      session,
      checkpoint: new CheckpointStore(session.path, workspace),
      artifacts: new ArtifactStore(session.path),
      state,
      systemPrompt: "stable self-hosting contract",
      workspaceRoot: workspace,
      cwd: workspace,
      autonomy: "medium",
      maxSteps: 10,
      commandTimeoutMs: 10_000,
      maxOutputBytes: 100_000,
      contextWindow: 1_000_000,
    });

    const result = await agent.run("make the implementation reliable", new AbortController().signal);
    expect(result).toMatchObject({ status: "completed", text: "enabled and verified" });
    expect(await readFile(join(workspace, "feature.ts"), "utf8")).toBe("export const reliable = true;\n");
    expect(state.modifiedFiles).toEqual(new Set(["feature.ts"]));
    expect(state.verifications.at(-1)).toMatchObject({ command: "npm test", exitCode: 0, revision: 1 });
    expect(state.completion).toMatchObject({ status: "completed", summary: "enabled and verified" });
    for (let index = 1; index < provider.requests.length; index += 1) {
      const previous = provider.requests[index - 1]!;
      const current = provider.requests[index]!;
      expect(current.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
      expect(current.tools).toEqual(provider.requests[0]!.tools);
    }
  });
});

class ScriptedProvider implements ModelProvider {
  readonly name = "self-host-test";
  readonly model = "mimo-v2.5-pro";
  readonly requests: ProviderRequest[] = [];
  readonly #responses: ProviderResponse[];

  constructor(responses: ProviderResponse[]) {
    this.#responses = responses;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push({
      messages: structuredClone(request.messages),
      tools: structuredClone(request.tools),
      signal: request.signal,
      ...(request.cacheScope ? { cacheScope: request.cacheScope } : {}),
    });
    const response = this.#responses.shift();
    if (!response) throw new Error("missing scripted response");
    return response;
  }
}

function call(id: string, name: string, argumentsValue: unknown): ProviderResponse {
  return {
    message: {
      role: "assistant",
      content: null,
      reasoning_content: `use ${name}`,
      tool_calls: [{
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(argumentsValue) },
      }],
    },
    finishReason: "tool_calls",
    usage: usage(),
  };
}

function text(content: string): ProviderResponse {
  return { message: { role: "assistant", content }, finishReason: "stop", usage: usage() };
}

function usage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
