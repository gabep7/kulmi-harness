import type { ResolvedModel } from "../config/config.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ProviderError,
  type FunctionToolCall,
  type ModelProvider,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderResponse,
  type WebCitation,
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

const wireContentPartSchema = z.union([
  z.string(),
  z.object({
    text: z.string().optional(),
    content: z.string().optional(),
  }).passthrough(),
]);

interface WireCitation {
  type?: string | undefined;
  url?: string | undefined;
  title?: string | undefined;
  summary?: string | undefined;
  site_name?: string | undefined;
  publish_time?: string | undefined;
  logo_url?: string | undefined;
}

const wireChunkSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({
      content: z.union([z.string(), z.array(wireContentPartSchema), z.null()]).optional(),
      reasoning_content: z.string().nullable().optional(),
      error_message: z.string().nullable().optional(),
      annotations: z.array(z.object({
        type: z.string().optional(),
        url: z.string().optional(),
        title: z.string().optional(),
        summary: z.string().optional(),
        site_name: z.string().optional(),
        publish_time: z.string().optional(),
        logo_url: z.string().optional(),
      }).passthrough()).nullable().optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative().nullable().optional(),
        id: z.string().nullable().optional(),
        type: z.string().nullable().optional(),
        function: z.object({
          name: z.string().nullable().optional(),
          arguments: z.string().nullable().optional(),
        }).passthrough().nullable().optional(),
      }).passthrough()).nullable().optional(),
    }).passthrough().optional(),
    finish_reason: z.string().nullable().optional(),
  }).passthrough()).optional(),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    completion_tokens_details: z.object({
      reasoning_tokens: z.number().int().nonnegative().optional(),
    }).passthrough().optional(),
    prompt_tokens_details: z.object({
      cached_tokens: z.number().int().nonnegative().optional(),
    }).passthrough().nullable().optional(),
    prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
    prompt_cache_miss_tokens: z.number().int().nonnegative().optional(),
    web_search_usage: z.object({
      tool_usage: z.number().int().nonnegative().optional(),
      page_usage: z.number().int().nonnegative().optional(),
    }).passthrough().optional(),
  }).passthrough().nullable().optional(),
  error: z.object({
    message: z.string().optional(),
    type: z.string().optional(),
    code: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();
type WireChunk = z.infer<typeof wireChunkSchema>;
type WireUsage = NonNullable<WireChunk["usage"]>;

interface CacheState {
  anchor: string;
  messages: string[];
}

type ReasoningStyle = "openai-o" | "reasoning_content" | "anthropic-thinking" | "none";

function resolveReasoningStyle(config: ResolvedModel): ReasoningStyle {
  if (config.reasoningStyle) {
    if (config.reasoningStyle === "anthropic-thinking") return "none";
    return config.reasoningStyle;
  }
  const id = config.model.toLowerCase();
  if (/\b(o1|o3|o4|gpt-5)\b/.test(id) || id.includes("gpt-5")) return "openai-o";
  if (id.includes("deepseek") || id.includes("qwen") || id.includes("r1") || id.includes("reason")) return "reasoning_content";
  return "none";
}

export interface OpenAIProviderOptions {
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRetryAfterMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  random?: () => number;
}

export class OpenAIProvider implements ModelProvider {
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
  readonly #cacheStates = new Map<string, CacheState>();

  constructor(
    config: ResolvedModel,
    options: OpenAIProviderOptions = {},
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
    const reasoningEffort = request.reasoningEffort ?? this.#config.reasoningEffort;
    const reasoningStyle = resolveReasoningStyle(this.#config);
    const maxCompletionTokens = Math.min(
      this.#config.maxOutputTokens,
      Math.max(1, Math.trunc(request.maxCompletionTokens ?? this.#config.maxOutputTokens)),
    );
    const tools = request.tools.map((tool) => ({
      ...tool,
      function: { ...tool.function, strict: true },
    }));
    const messages = request.messages.map(toWireMessage);
    validateConversation(messages, thinking, reasoningStyle);
    const body = JSON.stringify({
      model: this.model,
      messages,
      ...(tools.length ? { tools } : {}),
      stream: true,
      max_completion_tokens: maxCompletionTokens,
      ...(this.#config.streamUsage ?? true ? { stream_options: { include_usage: true } } : {}),
      ...(reasoningStyle === "reasoning_content" && thinking ? { thinking: { type: "enabled" } } : {}),
      ...(reasoningStyle === "openai-o" && reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    });
    if (request.cacheScope) {
      const anchor = createHash("sha256").update(JSON.stringify({
        model: this.model,
        thinking,
        system: messages.filter((message) => message.role === "system"),
        tools,
      })).digest("hex");
      const messageHashes = messages.map((message) =>
        createHash("sha256").update(JSON.stringify(message)).digest("hex")
      );
      const previous = this.#cacheStates.get(request.cacheScope);
      if (previous && previous.anchor !== anchor) {
        throw new Error(`cache prefix changed inside scope ${request.cacheScope}`);
      }
      if (previous && !isPrefix(previous.messages, messageHashes)) {
        throw new Error(`message history was rewritten inside cache scope ${request.cacheScope}`);
      }
      this.#cacheStates.set(request.cacheScope, { anchor, messages: messageHashes });
    }

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
    let content = "";
    let finishReason: string | null = null;
    let searchError: string | undefined;
    const citations: WebCitation[] = [];
    let usage: ProviderResponse["usage"] = emptyUsage();
    let wireUsage: WireUsage = {};
    const calls = new Map<number, FunctionToolCall>();
    const announcedCalls = new Set<number>();
    let sawDone = false;

    for await (const data of parseSse(response.body, signal)) {
      if (data === "[DONE]") {
        sawDone = true;
        break;
      }
      let chunk: WireChunk;
      try {
        chunk = wireChunkSchema.parse(JSON.parse(data));
      } catch (error) {
        const detail = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
        throw new Error(`invalid stream chunk: ${detail}; data=${data.slice(0, 300)}`);
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      const textDelta = wireContentText(delta?.content);
      if (
        chunk.usage ||
        chunk.error ||
        choice?.finish_reason ||
        delta?.reasoning_content ||
        textDelta ||
        delta?.error_message ||
        (delta?.annotations?.length ?? 0) > 0 ||
        (delta?.tool_calls?.length ?? 0) > 0
      ) resetIdleTimer();
      if (chunk.error?.message) {
        throw createProviderStreamError("OpenAI", chunk.error.message, chunk.error.type ?? chunk.error.code);
      }
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content;
        if (request.onReasoningDelta) {
          markEmitted();
          await request.onReasoningDelta(delta.reasoning_content);
        }
      }
      if (textDelta) {
        content += textDelta;
        if (request.onTextDelta) {
          markEmitted();
          await request.onTextDelta(textDelta);
        }
      }
      if (delta?.annotations?.length) {
        const knownUrls = new Set(citations.map((citation) => citation.url));
        const additions = delta.annotations
          .map(toCitation)
          .filter((item): item is WebCitation => item !== undefined)
          .filter((item) => {
            if (knownUrls.has(item.url)) return false;
            knownUrls.add(item.url);
            return true;
          });
        citations.push(...additions);
        if (additions.length > 0 && request.onCitations) {
          markEmitted();
          await request.onCitations(additions);
        }
      }
      if (delta?.error_message) searchError = delta.error_message;
      for (const [position, part] of (delta?.tool_calls ?? []).entries()) {
        const index = part.index ?? position;
        let call = calls.get(index);
        if (!call) {
          call = {
            id: part.id ?? `call_${index}`,
            type: "function",
            function: { name: "", arguments: "" },
          };
          calls.set(index, call);
        }
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
        if (!announcedCalls.has(index) && call.function.name && request.onToolCallStart) {
          announcedCalls.add(index);
          markEmitted();
          await request.onToolCallStart(call);
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) {
        wireUsage = mergeWireUsage(wireUsage, chunk.usage);
        usage = normalizeUsage(wireUsage);
      }
    }

    if (!sawDone) throw new Error(`stream ended before [DONE]`);
    const toolCalls = [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call);
    validateToolCalls(toolCalls);
    const message: ProviderResponse["message"] = { role: "assistant", content: content || null };
    if ((request.thinking ?? this.#config.thinking) && resolveReasoningStyle(this.#config) === "reasoning_content" && toolCalls.length > 0) message.reasoning_content = reasoning;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    return {
      message,
      finishReason,
      usage,
      ...(citations.length ? { citations } : {}),
      ...(searchError ? { searchError } : {}),
    };
  }

  async #fetch(body: string, signal: AbortSignal): Promise<Response> {
    const url = `${this.#config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#config.apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body,
      signal,
    });
    if (response.ok) return response;
    const errorBody = (await response.text()).slice(0, 2_000);
    throw createProviderHttpError(
      "OpenAI",
      response.status,
      errorBody,
      response.headers.get("retry-after"),
      this.#maxRetryAfterMs,
    );
  }
}

function wireContentText(
  content: string | Array<z.infer<typeof wireContentPartSchema>> | null | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    return part.text ?? part.content ?? "";
  }).join("");
}

function toWireMessage(message: ProviderMessage): ProviderMessage {
  if (message.role !== "tool") return message;
  return {
    role: "tool",
    content: message.content,
    tool_call_id: message.tool_call_id,
  };
}

function isPrefix(previous: readonly string[], current: readonly string[]): boolean {
  return previous.length <= current.length && previous.every((message, index) => current[index] === message);
}

function validateConversation(messages: readonly ProviderMessage[], thinking: boolean, reasoningStyle: ReasoningStyle): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "tool") {
      throw new Error(`tool result ${message.tool_call_id} has no preceding assistant tool call`);
    }
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    if (thinking && reasoningStyle === "reasoning_content" && !("reasoning_content" in message)) {
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



function emptyUsage(): ProviderResponse["usage"] {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
    webSearchCalls: 0,
    webSearchPages: 0,
  };
}

function normalizeUsage(usage: NonNullable<WireChunk["usage"]>): ProviderResponse["usage"] {
  const reportedHit = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
  const reportedMiss = usage.prompt_cache_miss_tokens;
  const prompt = Math.max(usage.prompt_tokens ?? 0, reportedHit + (reportedMiss ?? 0));
  const hit = Math.min(prompt, reportedHit);
  const miss = reportedMiss === undefined
    ? Math.max(0, prompt - hit)
    : Math.min(Math.max(0, prompt - hit), reportedMiss);
  const completion = usage.completion_tokens ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: Math.max(usage.total_tokens ?? 0, prompt + completion),
    cacheHitTokens: hit,
    cacheMissTokens: miss,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    webSearchCalls: usage.web_search_usage?.tool_usage ?? 0,
    webSearchPages: usage.web_search_usage?.page_usage ?? 0,
  };
}

function mergeWireUsage(previous: WireUsage, next: WireUsage): WireUsage {
  const merged: WireUsage = { ...previous, ...next };
  mergeMaximum(merged, previous, next, [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "prompt_cache_hit_tokens",
    "prompt_cache_miss_tokens",
  ]);
  if (previous.prompt_tokens_details || next.prompt_tokens_details) {
    merged.prompt_tokens_details = {
      ...previous.prompt_tokens_details,
      ...next.prompt_tokens_details,
    };
    mergeMaximum(merged.prompt_tokens_details, previous.prompt_tokens_details ?? {}, next.prompt_tokens_details ?? {}, ["cached_tokens"]);
  }
  if (previous.completion_tokens_details || next.completion_tokens_details) {
    merged.completion_tokens_details = {
      ...previous.completion_tokens_details,
      ...next.completion_tokens_details,
    };
    mergeMaximum(
      merged.completion_tokens_details,
      previous.completion_tokens_details ?? {},
      next.completion_tokens_details ?? {},
      ["reasoning_tokens"],
    );
  }
  if (previous.web_search_usage || next.web_search_usage) {
    merged.web_search_usage = {
      ...previous.web_search_usage,
      ...next.web_search_usage,
    };
    mergeMaximum(
      merged.web_search_usage,
      previous.web_search_usage ?? {},
      next.web_search_usage ?? {},
      ["tool_usage", "page_usage"],
    );
  }
  return merged;
}

function mergeMaximum<T extends object, K extends keyof T>(
  target: T,
  previous: T,
  next: T,
  keys: readonly K[],
): void {
  for (const key of keys) {
    const left = previous[key];
    const right = next[key];
    if (typeof left === "number" || typeof right === "number") {
      target[key] = Math.max(
        typeof left === "number" ? left : 0,
        typeof right === "number" ? right : 0,
      ) as T[K];
    }
  }
}

function toCitation(value: WireCitation): WebCitation | undefined {
  if (!value.url || !value.title) return undefined;
  return {
    url: value.url,
    title: value.title,
    ...(value.summary ? { summary: value.summary } : {}),
    ...(value.site_name ? { siteName: value.site_name } : {}),
    ...(value.publish_time ? { publishedAt: value.publish_time } : {}),
    ...(value.logo_url ? { logoUrl: value.logo_url } : {}),
  };
}

