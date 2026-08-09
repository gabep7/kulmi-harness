import type { ResolvedModel } from "../config/config.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ProviderError,
  type FunctionToolCall,
  type ModelProvider,
  type ProviderContentPart,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderResponse,
} from "./types.js";
import {
  createProviderHttpError,
  createProviderStreamError,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_RETRY_AFTER_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  parseSse,
  withProviderRetries,
} from "./stream.js";

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

const progressEventTypes: Partial<Record<string, true>> = {
  message_start: true,
  content_block_start: true,
  content_block_delta: true,
  content_block_stop: true,
  message_delta: true,
  message_stop: true,
  error: true,
};
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
  lastBreakpointIndex?: number;
}

export interface AnthropicProviderOptions {
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRetryAfterMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  random?: () => number;
  thinkingBudgetTokens?: number;
}

export class AnthropicProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly #config: ResolvedModel;
  readonly #idleTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #totalTimeoutMs: number;
  readonly #maxRetryAfterMs: number;
  readonly #maxAttempts: number | undefined;
  readonly #retryBaseDelayMs: number;
  readonly #random: (() => number) | undefined;
  readonly #thinkingBudgetTokens: number;
  readonly #cacheStates = new Map<string, CacheState>();

  constructor(
    config: ResolvedModel,
    options: AnthropicProviderOptions = {},
  ) {
    this.#config = config;
    this.name = config.name;
    this.model = config.model;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#totalTimeoutMs = options.totalTimeoutMs ?? config.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    this.#maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    this.#maxAttempts = options.maxAttempts;
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
    this.#random = options.random;
    this.#thinkingBudgetTokens = options.thinkingBudgetTokens ?? DEFAULT_THINKING_BUDGET_TOKENS;
  }

  invalidateCacheScopes(prefix: string): void {
    for (const scope of this.#cacheStates.keys()) {
      if (scope.startsWith(prefix)) this.#cacheStates.delete(scope);
    }
  }
  resetCacheScope(scope: string): void {
    this.#cacheStates.delete(scope);
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

    const previous = request.cacheScope ? this.#cacheStates.get(request.cacheScope) : undefined;
    let anchor: string | undefined;
    let messageHashes: string[] | undefined;
    if (request.cacheScope) {
      anchor = createHash("sha256").update(JSON.stringify({
        model: this.model,
        thinking,
        system,
        tools,
      })).digest("hex");
      messageHashes = request.messages.map((message) =>
        createHash("sha256").update(JSON.stringify(message)).digest("hex")
      );
      if (previous && previous.anchor !== anchor) {
        throw new Error(`cache prefix changed inside scope ${request.cacheScope}`);
      }
      const appendOnly = previous === undefined ||
        (previous.messages.length <= messageHashes.length &&
          previous.messages.every((hash, index) => messageHashes?.[index] === hash));
      if (!appendOnly) {
        throw new Error(`message history was rewritten inside cache scope ${request.cacheScope}`);
      }
    }

    const tailBreakpointIndex = findCacheableMessageIndex(messages);
    const laggingBreakpointIndex = previous?.lastBreakpointIndex;
    if (
      laggingBreakpointIndex !== undefined &&
      laggingBreakpointIndex !== tailBreakpointIndex
    ) {
      const lagging = messages[laggingBreakpointIndex];
      if (lagging) placeCacheBreakpoint(lagging.content);
    }
    if (tailBreakpointIndex !== undefined) {
      const tail = messages[tailBreakpointIndex];
      if (tail) placeCacheBreakpoint(tail.content);
    }
    if (request.cacheScope && anchor && messageHashes) {
      this.#cacheStates.set(request.cacheScope, {
        anchor,
        messages: messageHashes,
        ...(tailBreakpointIndex === undefined ? {} : { lastBreakpointIndex: tailBreakpointIndex }),
      });
    }

    // Anthropic requires budget_tokens to be strictly less than max_tokens.
    // A small output cap (<= 1024) would otherwise force the 1024 floor above
    // the cap and produce a request the API rejects with a 400.
    const budgetTokens = Math.max(
      MIN_THINKING_BUDGET_TOKENS,
      Math.min(this.#thinkingBudgetTokens, maxTokens - 1),
    );
    const thinkingEnabled = thinking && budgetTokens < maxTokens;
    const body = JSON.stringify({
      model: this.model,
      max_tokens: maxTokens,
      ...(system.length ? { system } : {}),
      messages,
      ...(tools.length ? { tools } : {}),
      stream: true,
      ...(thinkingEnabled ? { thinking: { type: "enabled", budget_tokens: budgetTokens } } : {}),
    });

    return withProviderRetries({
      callerSignal: request.signal,
      idleTimeoutMs: this.#idleTimeoutMs,
      requestTimeoutMs: this.#requestTimeoutMs,
      totalTimeoutMs: this.#totalTimeoutMs,
      maxRetryAfterMs: this.#maxRetryAfterMs,
      retryBaseDelayMs: this.#retryBaseDelayMs,
      ...(this.#maxAttempts === undefined ? {} : { maxAttempts: this.#maxAttempts }),
      ...(this.#random === undefined ? {} : { random: this.#random }),
      ...(request.onRetry === undefined ? {} : { onRetry: request.onRetry }),
      runAttempt: async ({ signal, resetIdleTimer, markEmitted }) => {
        const response = await this.#fetch(body, signal);
        return this.#readResponse(
          response,
          request,
          signal,
          resetIdleTimer,
          markEmitted,
        );
      },
    });
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
    for await (const data of parseSse(response.body, signal)) {
      let event: WireEvent;
      try {
        event = wireEventSchema.parse(JSON.parse(data));
      } catch (error) {
        const detail = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
        throw new Error(`invalid stream event: ${detail}; data=${data.slice(0, 300)}`);
      }
      if (progressEventTypes[event.type]) resetIdleTimer();
      if (event.type === "error") {
        throw createProviderStreamError(
          "Anthropic",
          event.error?.message ?? "anthropic stream error",
          event.error?.type,
        );
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
    throw createProviderHttpError(
      "Anthropic",
      response.status,
      errorBody,
      response.headers.get("retry-after"),
      this.#maxRetryAfterMs,
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

function findCacheableMessageIndex(messages: readonly WireMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.content.some((block) => block.type !== "thinking" && block.type !== "redacted_thinking")) {
      return index;
    }
  }
  return undefined;
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
    if (!call.id.trim()) throw new ProviderError("tool call without an id", { kind: "invalid_request", retryable: false });
    if (!call.function.name.trim()) throw new ProviderError("tool call without a function name", { kind: "invalid_request", retryable: false });
    if (ids.has(call.id)) throw new ProviderError(`duplicate tool call id ${call.id}`, { kind: "invalid_request", retryable: false });
    ids.add(call.id);
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



