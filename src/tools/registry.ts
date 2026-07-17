import { z } from "zod";
import type { EventBus } from "../core/events.js";
import type { ProviderTool } from "../provider/types.js";
import { redactKnownSecrets } from "../core/redact.js";
import { runToolHooks } from "../runtime/hooks.js";
import type { AnyTool, ToolContext, ToolResult } from "./types.js";

export interface ToolExecution {
  content: string;
  isError: boolean;
}

export class ToolRegistry {
  readonly #tools = new Map<string, AnyTool>();
  readonly #providerTools: ProviderTool[];
  readonly #providerToolsByName = new Map<string, ProviderTool>();

  constructor(tools: AnyTool[]) {
    for (const tool of tools) {
      if (this.#tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
      this.#tools.set(tool.name, tool);
    }
    this.#providerTools = [...this.#tools.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: canonicalize(tool.inputSchema ?? z.toJSONSchema(tool.schema)) as Record<string, unknown>,
        },
      }));
    for (const tool of this.#providerTools) this.#providerToolsByName.set(tool.function.name, tool);
  }

  providerTools(names?: readonly string[]): ProviderTool[] {
    if (names) {
      return names
        .map((name) => this.#providerToolsByName.get(name))
        .filter((tool): tool is ProviderTool => tool !== undefined);
    }
    return this.#providerTools;
  }

  names(): string[] {
    return [...this.#tools.keys()].sort();
  }

  isParallelSafe(name: string, argumentsJson: string): boolean {
    const tool = this.#tools.get(name);
    if (!tool || !tool.readOnly) return false;
    if (!tool.isParallelSafe) return true;
    try {
      const parsed = parseArguments(argumentsJson);
      const validated = tool.schema.safeParse(parsed);
      return validated.success && tool.isParallelSafe(validated.data);
    } catch {
      return false;
    }
  }

  async execute(options: {
    name: string;
    argumentsJson: string;
    callId: string;
    context: ToolContext;
  }): Promise<ToolExecution> {
    const started = performance.now();
    const tool = this.#tools.get(options.name);
    if (!tool) {
      return this.#finishUnknown(options.context.events, options, started);
    }

    let raw: unknown;
    try {
      raw = parseArguments(options.argumentsJson);
    } catch (error) {
      return this.#finishValidationError(tool, options, started, String(error));
    }
    const parsed = tool.schema.safeParse(raw);
    if (!parsed.success) {
      return this.#finishValidationError(
        tool,
        options,
        started,
        z.prettifyError(parsed.error),
      );
    }

    const preHook = options.context.hooks
      ? await runToolHooks(options.context.hooks, {
        phase: "tool_pre",
        tool: tool.name,
        callId: options.callId,
        agentId: options.context.state.agentId,
        cwd: options.context.cwd,
        workspaceRoot: options.context.workspaceRoot,
        ...(options.context.sandbox ? { sandbox: options.context.sandbox } : {}),
        signal: options.context.signal,
        input: parsed.data,
      })
      : { ok: true, output: "" };
    if (!preHook.ok) {
      return this.#finishHookError(tool, options, started, `pre-tool hook failed for ${tool.name}: ${preHook.output}`);
    }

    await options.context.events.emit({
      type: "tool.started",
      agentId: options.context.state.agentId,
      callId: options.callId,
      tool: tool.name,
      input: parsed.data,
    });

    let result: ToolResult;
    try {
      result = await tool.execute(options.context, parsed.data);
    } catch (error) {
      result = { content: error instanceof Error ? error.message : String(error), isError: true };
    }
    if (options.context.hooks) {
      const postHook = await runToolHooks(options.context.hooks, {
        phase: "tool_post",
        tool: tool.name,
        callId: options.callId,
        agentId: options.context.state.agentId,
        cwd: options.context.cwd,
        workspaceRoot: options.context.workspaceRoot,
        ...(options.context.sandbox ? { sandbox: options.context.sandbox } : {}),
        signal: options.context.signal,
        input: parsed.data,
        result,
      });
      if (!postHook.ok) {
        await options.context.events.emit({
          type: "error",
          agentId: options.context.state.agentId,
          message: `post-tool hook failed for ${tool.name}: ${postHook.output}`,
        });
      }
    }
    if (
      !tool.readOnly &&
      tool.name !== "complete_task" &&
      !result.isError &&
      result.mutated !== false
    ) {
      delete options.context.state.completion;
    }
    const materialized = await options.context.artifacts.materialize(
      tool.name,
      options.callId,
      redactKnownSecrets(result.content),
    );
    const execution = { content: materialized.content, isError: result.isError ?? false };
    await options.context.events.emit({
      type: "tool.finished",
      agentId: options.context.state.agentId,
      callId: options.callId,
      tool: tool.name,
      output: execution.content,
      ...(result.diff ? { diff: redactKnownSecrets(result.diff) } : {}),
      isError: execution.isError,
      durationMs: Math.round(performance.now() - started),
    });
    return execution;
  }

  async #finishUnknown(
    events: EventBus,
    options: { name: string; callId: string; context: ToolContext },
    started: number,
  ): Promise<ToolExecution> {
    const content = `unknown tool ${options.name}; available: ${this.names().join(", ")}`;
    await events.emit({
      type: "tool.finished",
      agentId: options.context.state.agentId,
      callId: options.callId,
      tool: options.name,
      output: content,
      isError: true,
      durationMs: Math.round(performance.now() - started),
    });
    return { content, isError: true };
  }

  async #finishValidationError(
    tool: AnyTool,
    options: { callId: string; context: ToolContext },
    started: number,
    detail: string,
  ): Promise<ToolExecution> {
    const content = `invalid arguments for ${tool.name}: ${detail}`;
    await options.context.events.emit({
      type: "tool.finished",
      agentId: options.context.state.agentId,
      callId: options.callId,
      tool: tool.name,
      output: content,
      isError: true,
      durationMs: Math.round(performance.now() - started),
    });
    return { content, isError: true };
  }

  async #finishHookError(
    tool: AnyTool,
    options: { callId: string; context: ToolContext },
    started: number,
    detail: string,
  ): Promise<ToolExecution> {
    const content = redactKnownSecrets(detail);
    await options.context.events.emit({
      type: "tool.finished",
      agentId: options.context.state.agentId,
      callId: options.callId,
      tool: tool.name,
      output: content,
      isError: true,
      durationMs: Math.round(performance.now() - started),
    });
    return { content, isError: true };
  }
}

function parseArguments(value: string): unknown {
  if (!value.trim()) return {};
  return JSON.parse(value) as unknown;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "$schema")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}
