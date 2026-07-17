import type { ResolvedModel } from "../config/config.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  FunctionToolCall,
  ModelProvider,
  ProviderContentPart,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
} from "./types.js";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_THINKING_BUDGET_TOKENS = 4_096;
const MIN_THINKING_BUDGET_TOKENS = 1_024;

export type AnthropicThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export interface AnthropicAssistantMessage extends Extract<ProviderMessage, { role: "assistant" }> {
  reasoning_signature?: string;
  thinking_blocks?: AnthropicThinkingBlock[];
}

interface CacheControl {
  type: "ephemeral";
}

type WireBlock =
  | { type: "text"; text: string; cache_control?: CacheControl }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
      cache_control?: CacheControl;
    }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown; cache_control?: CacheControl }
  | { type: "tool_result"; tool_use_id: string; content: string; cache_control?: CacheControl };

interface WireMessage {
  role: "user" | "assistant";
  content: WireBlock[];
}

interface WireTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
}

const wireUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().nullable().optional(),
  output_tokens: z.number().int().nonnegative().nullable().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().nullable().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().nullable().optional(),
}).passthrough();

const wireEventSchema = z.object({
  type: z.string(),
  index: z.number().int().nonnegative().optional(),
  message: z.object({
    usage: wireUsageSchema.nullable().optional(),
  }).passthrough().optional(),
  content_block: z.object({
    type: z.string(),
    id: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    thinking: z.string().optional(),
    signature: z.string().optional(),
    data: z.string().optional(),
  }).passthrough().optional(),
  delta: z.object({
    type: z.string().optional(),
    text: z.string().optional(),
    partial_json: z.string().optional(),
    thinking: z.string().optional(),
    signature: z.string().optional(),
    stop_reason: z.string().nullable().optional(),
  }).passthrough().optional(),
  usage: wireUsageSchema.nullable().optional(),
  error: z.object({
    type: z.string().optional(),
    message: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();
type WireEvent = z.infer<typeof wireEventSchema>;
type WireUsage = z.infer<typeof wireUsageSchema>;

const stopReasonMap: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
};

interface CacheState {
  anchor: string;
  messages: string[];
}

export class AnthropicProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly #config: ResolvedModel;
  readonly #idleTimeoutMs: number;
  readonly #thinkingBudgetTokens: number;
  readonly #cacheStates = new Map<string, CacheState>();

  constructor(
    config: ResolvedModel,
    options: { idleTimeoutMs?: number; thinkingBudgetTokens?: number } = {},
  ) {
    this.#config = config;
    this.name = config.name;
    this.model = config.model;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
    this.#thinkingBudgetTokens = options.thinkingBudgetTokens ?? DEFAULT_THINKING_BUDGET_TOKENS;
  }

  invalidateCacheScopes(prefix: string): void {
    for (const scope of this.#cacheStates.keys()) {
      if (scope.startsWith(prefix)) this.#cacheStates.delete(scope);
    }
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const thinking = request.thinking ?? this.#config.thinking;
    const maxTokens = Math.min(
      this.#config.maxOutputTokens,
      Math.max(1, Math.trunc(request.maxCompletionTokens ?? this.#config.maxOutputTokens)),
    );
    validateConversation(request.messages, thinking);
    const { system, messages } = toWireConversation(request.messages, thinking);
    const tools: WireTool[] = request.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
    const lastTool = tools[tools.length - 1];
    if (lastTool) lastTool.cache_control = { type: "ephemeral" };
    const lastSystem = system[system.length - 1];
    if (lastSystem && lastSystem.type === "text") lastSystem.cache_control = { type: "ephemeral" };
    const lastMessage = messages[messages.length - 1];
    if (lastMessage) placeCacheBreakpoint(lastMessage.content);
    const budgetTokens = Math.max(
      MIN_THINKING_BUDGET_TOKENS,
      Math.min(this.#thinkingBudgetTokens, maxTokens - 1),
    );
    const body = JSON.stringify({
      model: this.model,
      max_tokens: maxTokens,
      ...(system.length ? { system } : {}),
      messages,
      ...(tools.length ? { tools } : {}),
      stream: true,
      ...(thinking ? { thinking: { type: "enabled", budget_tokens: budgetTokens } } : {}),
    });
    if (request.cacheScope) {
      const anchor = createHash("sha256").update(JSON.stringify({
        model: this.model,
        thinking,
        system,
        tools,
      })).digest("hex");
      const messageHashes = request.messages.map((message) =>
        createHash("sha256").update(JSON.stringify(message)).digest("hex")
      );
      const previous = this.#cacheStates.get(request.cacheScope);
      if (previous && previous.anchor !== anchor) {
        throw new Error(`cache prefix changed inside scope ${request.cacheScope}`);
      }
      const appendOnly = previous === undefined ||
        (previous.messages.length <= messageHashes.length &&
          previous.messages.every((hash, index) => messageHashes[index] === hash));
      if (!appendOnly) {
        throw new Error(`message history was rewritten inside cache scope ${request.cacheScope}`);
      }
      this.#cacheStates.set(request.cacheScope, { anchor, messages: messageHashes });
    }

    const controller = new AbortController();
    const relayAbort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", relayAbort, { once: true });
    if (request.signal.aborted) relayAbort();

    let idleTimer: NodeJS.Timeout | undefined;
    const clearIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    const resetIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(
        () => controller.abort(new Error("stream stalled")),
        this.#idleTimeoutMs,
      );
      idleTimer.unref();
    };

    try {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        let emitted = false;
        try {
          resetIdleTimer();
          try {
            const response = await this.#fetch(body, controller.signal);
            return await this.#readResponse(
              response,
              request,
              controller.signal,
              resetIdleTimer,
              () => { emitted = true; },
            );
          } finally {
            clearIdleTimer();
          }
        } catch (error) {
          if (
            controller.signal.aborted ||
            emitted ||
            attempt === 2 ||
            (error instanceof AnthropicHttpError && !error.retryable)
          ) throw error;
          lastError = error;
          const delay = error instanceof AnthropicHttpError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : 500 * 2 ** attempt + Math.floor(Math.random() * 200);
          await sleep(delay, controller.signal);
        }
      }
      throw lastError instanceof Error ? lastError : new Error("stream failed");
    } finally {
      request.signal.removeEventListener("abort", relayAbort);
      clearIdleTimer();
    }
  }

  async #readResponse(
    response: Response,
    request: ProviderRequest,
    signal: AbortSignal,
    resetIdleTimer: () => void,
    markEmitted: () => void,
  ): Promise<ProviderResponse> {
    if (!response.body) throw new Error("empty response body");

    let reasoning = "";
    let signature = "";
    let content = "";
    let stopReason: string | null = null;
    let wireUsage: WireUsage = {};
    const calls = new Map<number, FunctionToolCall>();
    const thinkingBlocks: AnthropicThinkingBlock[] = [];
    let openThinking: { thinking: string; signature: string } | null = null;
    let sawStop = false;

    const flushThinking = (): void => {
      if (!openThinking) return;
      thinkingBlocks.push({
        type: "thinking",
        thinking: openThinking.thinking,
        signature: openThinking.signature,
      });
      openThinking = null;
    };

    resetIdleTimer();
    for await (const data of parseSse(response.body, signal, resetIdleTimer)) {
      let event: WireEvent;
      try {
        event = wireEventSchema.parse(JSON.parse(data));
      } catch (error) {
        const detail = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
        throw new Error(`invalid stream event: ${detail}; data=${data.slice(0, 300)}`);
      }
      if (event.type === "error") {
        throw new Error(event.error?.message ?? "anthropic stream error");
      }
      if (event.type === "message_stop") {
        sawStop = true;
        break;
      }
      if (event.type === "message_start") {
        if (event.message?.usage) wireUsage = mergeWireUsage(wireUsage, event.message.usage);
        continue;
      }
      if (event.type === "message_delta") {
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        if (event.usage) wireUsage = mergeWireUsage(wireUsage, event.usage);
        continue;
      }
      if (event.type === "content_block_start" && event.content_block) {
        const block = event.content_block;
        if (block.type === "tool_use") {
          flushThinking();
          const call: FunctionToolCall = {
            id: block.id ?? `toolu_${event.index ?? calls.size}`,
            type: "function",
            function: { name: block.name ?? "", arguments: "" },
          };
          calls.set(event.index ?? calls.size, call);
          if (call.function.name && request.onToolCallStart) {
            markEmitted();
            await request.onToolCallStart(call);
          }
        } else if (block.type === "text") {
          flushThinking();
          if (block.text) {
            content += block.text;
            if (request.onTextDelta) {
              markEmitted();
              await request.onTextDelta(block.text);
            }
          }
        } else if (block.type === "thinking") {
          flushThinking();
          openThinking = {
            thinking: block.thinking ?? "",
            signature: block.signature ?? "",
          };
          if (block.thinking) {
            reasoning += block.thinking;
            if (request.onReasoningDelta) {
              markEmitted();
              await request.onReasoningDelta(block.thinking);
            }
          }
          if (block.signature) signature += block.signature;
        } else if (block.type === "redacted_thinking") {
          flushThinking();
          thinkingBlocks.push({ type: "redacted_thinking", data: block.data ?? "" });
        }
        continue;
      }
      if (event.type === "content_block_delta" && event.delta) {
        const delta = event.delta;
        if (delta.type === "text_delta" && delta.text) {
          content += delta.text;
          if (request.onTextDelta) {
            markEmitted();
            await request.onTextDelta(delta.text);
          }
        } else if (delta.type === "thinking_delta" && delta.thinking) {
          if (openThinking) openThinking.thinking += delta.thinking;
          reasoning += delta.thinking;
          if (request.onReasoningDelta) {
            markEmitted();
            await request.onReasoningDelta(delta.thinking);
          }
        } else if (delta.type === "signature_delta" && delta.signature) {
          if (openThinking) openThinking.signature += delta.signature;
          signature += delta.signature;
        } else if (delta.type === "input_json_delta" && delta.partial_json !== undefined) {
          const call = calls.get(event.index ?? -1);
          if (call) call.function.arguments += delta.partial_json;
        }
      }
    }

    if (!sawStop) throw new Error(`stream ended before message_stop`);
    flushThinking();
    const toolCalls = [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call);
    for (const call of toolCalls) {
      if (!call.function.arguments) call.function.arguments = "{}";
    }
    validateToolCalls(toolCalls);
    const message: AnthropicAssistantMessage = { role: "assistant", content: content || null };
    if ((request.thinking ?? this.#config.thinking) && toolCalls.length > 0) {
      message.reasoning_content = reasoning;
      if (signature) message.reasoning_signature = signature;
      if (thinkingBlocks.length > 0) message.thinking_blocks = thinkingBlocks;
    }
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    return {
      message,
      finishReason: stopReason === null ? null : stopReasonMap[stopReason] ?? stopReason,
      usage: normalizeUsage(wireUsage),
    };
  }

  async #fetch(body: string, signal: AbortSignal): Promise<Response> {
    const base = (this.#config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.#config.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body,
      signal,
    });
    if (response.ok) return response;
    const errorBody = (await response.text()).slice(0, 2_000);
    throw new AnthropicHttpError(
      `HTTP ${response.status}: ${errorBody}`,
      [408, 409, 429].includes(response.status) || response.status >= 500,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
}

function toWireConversation(
  messages: readonly ProviderMessage[],
  thinking: boolean,
): { system: WireBlock[]; messages: WireMessage[] } {
  const system: WireBlock[] = [];
  const wire: WireMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      system.push({ type: "text", text: message.content });
      continue;
    }
    if (message.role === "user") {
      wire.push({ role: "user", content: toUserBlocks(message.content) });
      continue;
    }
    if (message.role === "tool") {
      const block: WireBlock = {
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: message.content,
      };
      const previous = wire[wire.length - 1];
      if (previous?.role === "user" && previous.content.every((item) => item.type === "tool_result")) {
        previous.content.push(block);
      } else {
        wire.push({ role: "user", content: [block] });
      }
      continue;
    }
    const blocks: WireBlock[] = [];
    const hasToolCalls = (message.tool_calls?.length ?? 0) > 0;
    if (thinking && hasToolCalls) {
      const anthropicMessage = message as AnthropicAssistantMessage;
      if (anthropicMessage.thinking_blocks?.length) {
        for (const block of anthropicMessage.thinking_blocks) {
          if (block.type === "thinking") {
            blocks.push({
              type: "thinking",
              thinking: block.thinking,
              signature: block.signature,
            });
          } else {
            blocks.push({ type: "redacted_thinking", data: block.data });
          }
        }
      } else if (message.reasoning_content !== undefined) {
        blocks.push({
          type: "thinking",
          thinking: message.reasoning_content,
          signature: anthropicMessage.reasoning_signature ?? "",
        });
      }
    }
    if (message.content) blocks.push({ type: "text", text: message.content });
    for (const call of message.tool_calls ?? []) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: parseToolInput(call),
      });
    }
    wire.push({ role: "assistant", content: blocks });
  }
  return { system, messages: wire };
}

function toUserBlocks(content: string | ProviderContentPart[]): WireBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part): WireBlock => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image_url") return { type: "image", source: toImageSource(part.image_url.url) };
    throw new Error(
      `image attachment ${part.path} must be inlined as a data URL before reaching the anthropic provider`,
    );
  });
}

function toImageSource(
  url: string,
): { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  const mediaType = match?.[1];
  const data = match?.[2];
  if (mediaType && data) return { type: "base64", media_type: mediaType, data };
  return { type: "url", url };
}

function parseToolInput(call: FunctionToolCall): unknown {
  const raw = call.function.arguments.trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`tool call ${call.id} has malformed JSON arguments`);
  }
}

function placeCacheBreakpoint(blocks: WireBlock[]): void {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!block || block.type === "thinking" || block.type === "redacted_thinking") continue;
    block.cache_control = { type: "ephemeral" };
    return;
  }
}

function validateConversation(messages: readonly ProviderMessage[], thinking: boolean): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "tool") {
      throw new Error(`tool result ${message.tool_call_id} has no preceding assistant tool call`);
    }
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    if (
      thinking
      && !("reasoning_content" in message)
      && !((message as AnthropicAssistantMessage).thinking_blocks?.length)
    ) {
      throw new Error(`assistant tool-call history is missing reasoning_content`);
    }
    for (const [offset, call] of message.tool_calls.entries()) {
      const result = messages[index + offset + 1];
      if (result?.role !== "tool" || result.tool_call_id !== call.id) {
        throw new Error(`tool call ${call.id} is missing its ordered tool result`);
      }
    }
    index += message.tool_calls.length;
  }
}

function validateToolCalls(calls: FunctionToolCall[]): void {
  const ids = new Set<string>();
  for (const call of calls) {
    if (!call.function.name.trim()) throw new Error(`tool call without a function name`);
    if (ids.has(call.id)) throw new Error(`duplicate tool call id ${call.id}`);
    ids.add(call.id);
  }
}

class AnthropicHttpError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.name = "AnthropicHttpError";
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function normalizeUsage(usage: WireUsage): ProviderResponse["usage"] {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const fresh = (usage.input_tokens ?? 0) + cacheCreation;
  const prompt = fresh + cacheRead;
  const completion = usage.output_tokens ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    cacheHitTokens: cacheRead,
    cacheMissTokens: fresh,
    reasoningTokens: 0,
    webSearchCalls: 0,
    webSearchPages: 0,
  };
}

function mergeWireUsage(previous: WireUsage, next: WireUsage): WireUsage {
  const merged: WireUsage = { ...previous, ...next };
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ] as const) {
    const left = previous[key];
    const right = next[key];
    if (typeof left === "number" || typeof right === "number") {
      merged[key] = Math.max(
        typeof left === "number" ? left : 0,
        typeof right === "number" ? right : 0,
      );
    }
  }
  return merged;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onActivity: () => void,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("request aborted");
      const { done, value } = await reader.read();
      if (done) break;
      onActivity();
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    buffer = buffer.replaceAll("\r\n", "\n");
    const data = buffer.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) yield data;
  } finally {
    reader.releaseLock();
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", abort);
    resolve();
  }, milliseconds);
  const abort = () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error("request aborted"));
  };
  signal.addEventListener("abort", abort, { once: true });
  return promise;
}
