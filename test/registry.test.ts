import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fileTools } from "../src/tools/files.js";
import { readArtifactTool } from "../src/tools/artifacts.js";
import { astGrepTool } from "../src/tools/ast-grep.js";
import { browserQaTool } from "../src/tools/browser.js";
import { gitTools } from "../src/tools/git.js";
import { lspTool } from "../src/tools/lsp.js";
import { attachImageTool } from "../src/tools/media.js";
import { progressTools } from "../src/tools/progress.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { shellTool } from "../src/tools/shell.js";
import { skillTools } from "../src/tools/skills.js";
import { subagentTools } from "../src/tools/subagents.js";
import { EventBus, type RuntimeEvent } from "../src/core/events.js";
import { sandboxAvailability } from "../src/runtime/process.js";
import type { AgentDefinition } from "../src/config/agents.js";
import { defineTool, type SubagentApi, type ToolContext } from "../src/tools/types.js";
import { fetchUrlTool, freeWebSearchTool } from "../src/tools/web-search.js";

describe("ToolRegistry", () => {
  it("emits byte-stable canonically ordered provider schemas", () => {
    const first = new ToolRegistry([...progressTools(), ...fileTools()]);
    const second = new ToolRegistry([...fileTools(), ...progressTools()]);
    expect(JSON.stringify(first.providerTools())).toBe(JSON.stringify(second.providerTools()));
    expect(first.providerTools().map((tool) => tool.function.name)).toEqual(
      [...first.names()].sort(),
    );
  });

  it("can expose a stable deferred subset without changing execution tools", () => {
    const registry = new ToolRegistry([...fileTools(), ...progressTools()]);
    const chatTools = registry.providerTools(["start_task"]);
    expect(chatTools.map((tool) => tool.function.name)).toEqual(["start_task"]);
    expect(Buffer.byteLength(JSON.stringify(chatTools), "utf8")).toBeLessThan(700);
    expect(registry.providerTools(["missing", "start_task"]).map((tool) => tool.function.name)).toEqual(["start_task"]);
    expect(registry.names()).toContain("read_file");
  });

  it("keeps subagent provider guidance compact and accurate about integration cleanup", () => {
    const registry = new ToolRegistry(subagentTools());
    const providerTools = registry.providerTools();
    expect(Buffer.byteLength(JSON.stringify(providerTools), "utf8")).toBeLessThan(5_000);

    const spawnDescription = descriptionFor(registry, "spawn_agent").toLowerCase();
    expect(spawnDescription).toContain("built-in presets");
    for (const name of ["tester", "reviewer", "security", "performance", "release"]) {
      expect(spawnDescription).toContain(name);
    }
    expect(spawnDescription).not.toContain("worker preset: tester");
    expect(spawnDescription).not.toContain("run only the targeted test command");

    const description = descriptionFor(registry, "integrate_agent").toLowerCase();
    expect(description).toMatch(/successful integration removes .* child worktree/);
    expect(description).toMatch(/failed or conflicting .* retain/);
    expect(description).not.toContain("always retain");
    expect(description).not.toContain("always retained");
  });

  it("routes built-in worker presets to their scheduler modes with preset guidance", async () => {
    const cases = [
      { agent: "tester", expectedMode: "implement" },
      { agent: "reviewer", expectedMode: "review" },
      { agent: "security", expectedMode: "review" },
      { agent: "performance", expectedMode: "review" },
      { agent: "release", expectedMode: "review" },
    ] as const;

    for (const testCase of cases) {
      const subagents = fakeSubagents();
      const registry = new ToolRegistry(subagentTools());
      const result = await registry.execute({
        name: "spawn_agent",
        argumentsJson: JSON.stringify({
          agent: testCase.agent,
          prompt: "Handle the assigned scope.",
          background: false,
        }),
        callId: `spawn_${testCase.agent}`,
        context: fakeToolContext(subagents, "low"),
      });

      expect(result).toEqual({ content: "job_1", isError: false });
      expect(subagents.spawnCalls).toHaveLength(1);
      expect(subagents.spawnCalls[0]).toMatchObject({
        mode: testCase.expectedMode,
        background: false,
        parentAgentId: "agent_1",
      });
      expect(subagents.spawnCalls[0]!.prompt).toContain(`Worker preset: ${testCase.agent}.`);
      expect(subagents.spawnCalls[0]!.prompt).toContain("Handle the assigned scope.");
    }
  });

  it("rejects conflicting explicit modes before spawning a built-in preset", async () => {
    const subagents = fakeSubagents();
    const registry = new ToolRegistry(subagentTools());

    const result = await registry.execute({
      name: "spawn_agent",
      argumentsJson: JSON.stringify({
        agent: "tester",
        mode: "review",
        prompt: "Write tests for this change.",
      }),
      callId: "spawn_conflict",
      context: fakeToolContext(subagents, "low"),
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("agent tester requires implement mode");
    expect(subagents.spawnCalls).toEqual([]);
  });

  it("lists built-in presets when an agent name is unknown", async () => {
    const subagents = fakeSubagents();
    const registry = new ToolRegistry(subagentTools());

    const result = await registry.execute({
      name: "spawn_agent",
      argumentsJson: JSON.stringify({
        agent: "does-not-exist",
        prompt: "Use the right specialist.",
      }),
      callId: "spawn_unknown",
      context: fakeToolContext(subagents, "low"),
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("unknown agent does-not-exist");
    for (const name of ["tester", "reviewer", "security", "performance", "release"]) {
      expect(result.content).toContain(name);
    }
    expect(subagents.spawnCalls).toEqual([]);
  });

  it("lets custom agents override built-in preset names", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-agent-"));
    const customPath = join(root, "tester.md");
    const customPrompt = [
      "---",
      "name: tester",
      "description: project-specific tester",
      "mode: review",
      "---",
      "",
      "Custom tester instructions.",
    ].join("\n");
    await writeFile(customPath, customPrompt);
    const customAgents: AgentDefinition[] = [{
      name: "tester",
      description: "project-specific tester",
      mode: "review",
      path: customPath,
      source: "project",
    }];
    const subagents = fakeSubagents();
    const registry = new ToolRegistry(subagentTools(customAgents));

    const result = await registry.execute({
      name: "spawn_agent",
      argumentsJson: JSON.stringify({
        agent: "tester",
        mode: "review",
        prompt: "Review the tests.",
      }),
      callId: "spawn_custom_tester",
      context: fakeToolContext(subagents, "read"),
    });

    expect(result).toEqual({ content: "job_1", isError: false });
    expect(subagents.spawnCalls[0]).toMatchObject({ mode: "review" });
    expect(subagents.spawnCalls[0]!.prompt).toContain("Custom tester instructions.");
    expect(subagents.spawnCalls[0]!.prompt).not.toContain("Worker preset: tester.");
  });

  it("blocks a tool when a pre-hook fails but only reports post-hook failures after the tool result", async () => {
    let executions = 0;
    const hooked = defineTool({
      name: "hooked_tool",
      description: "test hook behavior",
      schema: z.object({ value: z.string() }),
      readOnly: false,
      async execute(_context, input) {
        executions += 1;
        return { content: `ran ${input.value}` };
      },
    });
    const registry = new ToolRegistry([hooked]);

    const preEvents: RuntimeEvent[] = [];
    const preContext = fakeToolContext(fakeSubagents(), "medium");
    preContext.events.on((envelope) => { preEvents.push(envelope.event); }, { critical: true });
    preContext.hooks = {
      toolPre: [{ command: "echo pre blocked; exit 9", timeoutSeconds: 1 }],
      toolPost: [],
    };
    const blocked = await registry.execute({
      name: "hooked_tool",
      argumentsJson: JSON.stringify({ value: "blocked" }),
      callId: "hook_pre",
      context: preContext,
    });

    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain("pre-tool hook failed for hooked_tool");
    expect(blocked.content).toContain("pre blocked");
    expect(executions).toBe(0);
    expect(preEvents.map((event) => event.type)).toEqual(["tool.finished"]);

    const postEvents: RuntimeEvent[] = [];
    const postContext = fakeToolContext(fakeSubagents(), "medium");
    postContext.events.on((envelope) => { postEvents.push(envelope.event); }, { critical: true });
    postContext.hooks = {
      toolPre: [],
      toolPost: [{ command: "echo post failed; exit 4", timeoutSeconds: 1 }],
    };
    const completed = await registry.execute({
      name: "hooked_tool",
      argumentsJson: JSON.stringify({ value: "ok" }),
      callId: "hook_post",
      context: postContext,
    });

    expect(completed).toEqual({ content: "ran ok", isError: false });
    expect(executions).toBe(1);
    expect(postEvents.map((event) => event.type)).toEqual(["tool.started", "error", "tool.finished"]);
    const postError = postEvents.find((event) => event.type === "error");
    expect(postError).toMatchObject({
      type: "error",
      message: expect.stringContaining("post-tool hook failed for hooked_tool"),
    });
  });

  it.runIf(sandboxAvailability().available)("preserves hook metadata while required sandboxing denies writes outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-hook-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "kulmi-hook-outside-"));
    let executions = 0;
    try {
      const hooked = defineTool({
        name: "contained_tool",
        description: "test hook containment",
        schema: z.object({ value: z.string() }),
        readOnly: false,
        async execute() {
          executions += 1;
          return { content: "ran" };
        },
      });
      const registry = new ToolRegistry([hooked]);
      const context = fakeToolContext(fakeSubagents(), "medium");
      context.cwd = workspace;
      context.workspaceRoot = workspace;
      context.sandbox = { mode: "required", network: false };
      context.hooks = {
        toolPre: [{
          command: `printf '%s' "$KULMI_HOOK_PHASE|$KULMI_HOOK_TOOL|$KULMI_HOOK_CALL_ID|$KULMI_HOOK_AGENT_ID|$KULMI_WORKSPACE_ROOT|$KULMI_TOOL_INPUT" > hook-env.txt; printf denied > ${JSON.stringify(join(outside, "escaped.txt"))}`,
          timeoutSeconds: 5,
        }],
        toolPost: [],
      };

      const result = await registry.execute({
        name: "contained_tool",
        argumentsJson: JSON.stringify({ value: "preserved" }),
        callId: "hook_containment",
        context,
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("pre-tool hook failed");
      expect(await readFile(join(workspace, "hook-env.txt"), "utf8")).toBe(
        `tool_pre|contained_tool|hook_containment|agent_1|${workspace}|{\"value\":\"preserved\"}`,
      );
      expect(executions).toBe(0);
      await expect(access(join(outside, "escaped.txt"))).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps the complete built-in tool catalog compact while exposing browser, image, and git workflow tools", () => {
    const registry = new ToolRegistry([
      ...fileTools(),
      readArtifactTool,
      astGrepTool,
      lspTool,
      shellTool,
      ...progressTools(),
      ...subagentTools(),
      ...skillTools([]),
      freeWebSearchTool({ mode: "free", resultLimit: 5, provider: "auto", searxngUrl: "" }),
      fetchUrlTool(),
      ...gitTools(),
      browserQaTool,
      attachImageTool,
    ]);
    const providerTools = registry.providerTools();
    expect(registry.names()).toEqual(expect.arrayContaining([
      "attach_image",
      "browser_qa",
      "commit_changes",
      "list_conflicts",
      "read_conflict",
      "resolve_conflict",
    ]));
    expect(providerTools.map((tool) => tool.function.name)).toEqual([...registry.names()].sort());
    expect(Buffer.byteLength(JSON.stringify(providerTools), "utf8")).toBeLessThan(16_500);
    expect(Buffer.byteLength(JSON.stringify(providerTools.filter((tool) => tool.function.name !== "start_task")), "utf8"))
      .toBeLessThan(16_000);
    expect(providerTools.find((tool) => tool.function.name === "start_task")).toMatchObject({
      function: {
        description: expect.stringContaining("assume they mean the current workspace"),
      },
    });
    expect(providerTools.find((tool) => tool.function.name === "attach_image")).toMatchObject({
      function: {
        description: expect.stringContaining("@image <path>"),
        parameters: { properties: { path: { type: "string" } } },
      },
    });
    expect(providerTools.find((tool) => tool.function.name === "browser_qa")).toMatchObject({
      function: {
        description: expect.stringContaining("headless Chromium"),
        parameters: { properties: { url: { format: "uri", type: "string" } } },
      },
    });
  });

  it("treats malformed arguments as not parallel-safe instead of throwing", () => {
    const tool = defineTool({
      name: "parallel_probe",
      description: "probe parallel safety",
      schema: z.object({ path: z.string() }),
      readOnly: true,
      isParallelSafe: () => true,
      async execute() {
        return { content: "ok" };
      },
    });
    const registry = new ToolRegistry([tool]);

    expect(registry.isParallelSafe("parallel_probe", "{")).toBe(false);
    expect(registry.isParallelSafe("parallel_probe", "not-json")).toBe(false);
    expect(registry.isParallelSafe("parallel_probe", JSON.stringify({ path: 1 }))).toBe(false);
    expect(registry.isParallelSafe("parallel_probe", JSON.stringify({ path: "src/a.ts" }))).toBe(true);
    expect(registry.isParallelSafe("missing_tool", "{}")).toBe(false);
  });

  it("redacts secrets from tool result diffs before emitting tool.finished", async () => {
    const secret = "sk-registry-diff-secret";
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = secret;
    try {
      const tool = defineTool({
        name: "diff_tool",
        description: "returns a diff with a secret",
        schema: z.object({}),
        readOnly: false,
        async execute() {
          return {
            content: `wrote key=${secret}`,
            diff: `--- a\n+++ b\n+api_key=${secret}\n`,
          };
        },
      });
      const registry = new ToolRegistry([tool]);
      const events: RuntimeEvent[] = [];
      const context = fakeToolContext(fakeSubagents(), "medium");
      context.events.on((envelope) => {
        events.push(envelope.event);
      }, { critical: true });

      const result = await registry.execute({
        name: "diff_tool",
        argumentsJson: "{}",
        callId: "diff_1",
        context,
      });

      expect(result.content).toBe("wrote key=[redacted:OPENAI_API_KEY]");
      expect(result.content).not.toContain(secret);

      const finished = events.find((event) => event.type === "tool.finished");
      expect(finished).toMatchObject({
        type: "tool.finished",
        output: "wrote key=[redacted:OPENAI_API_KEY]",
        diff: "--- a\n+++ b\n+api_key=[redacted:OPENAI_API_KEY]\n",
      });
      if (finished?.type === "tool.finished") {
        expect(finished.diff).not.toContain(secret);
        expect(finished.output).not.toContain(secret);
      }
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });
});

function descriptionFor(registry: ToolRegistry, name: string): string {
  const tool = registry.providerTools([name])[0];
  if (!tool) throw new Error(`missing provider tool ${name}`);
  return tool.function.description;
}

type SpawnInput = Parameters<SubagentApi["spawn"]>[0];

interface FakeSubagentApi extends SubagentApi {
  spawnCalls: SpawnInput[];
}

function fakeSubagents(): FakeSubagentApi {
  const spawnCalls: SpawnInput[] = [];
  return {
    spawnCalls,
    async spawn(input) {
      spawnCalls.push(input);
      return `job_${spawnCalls.length}`;
    },
    async wait() {
      throw new Error("wait should not be called");
    },
    inspect() {
      throw new Error("inspect should not be called");
    },
    async integrate() {
      throw new Error("integrate should not be called");
    },
    async cancel() {
      throw new Error("cancel should not be called");
    },
    async retry() {
      throw new Error("retry should not be called");
    },
    async steer() {
      throw new Error("steer should not be called");
    },
    pending() {
      return [];
    },
  };
}

function fakeToolContext(
  subagents: SubagentApi,
  autonomy: ToolContext["autonomy"],
): ToolContext {
  return {
    workspaceRoot: "/workspace",
    cwd: "/workspace",
    autonomy,
    signal: new AbortController().signal,
    events: new EventBus(),
    state: {
      agentId: "agent_1",
      mode: "chat",
      status: "running",
      plan: [],
      modifiedFiles: new Set(),
      verifications: [],
      revision: 0,
    },
    checkpoint: {} as ToolContext["checkpoint"],
    artifacts: {
      async materialize(_tool: string, _callId: string, content: string) {
        return { content };
      },
    } as ToolContext["artifacts"],
    commandTimeoutMs: 10_000,
    maxOutputBytes: 100_000,
    subagents,
  };
}
