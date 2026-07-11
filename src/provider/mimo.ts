import type { ResolvedModel } from "../config/config.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  FunctionToolCall,
  ModelProvider,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  WebCitation,
} from "./types.js";

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
      content: z.string().nullable().optional(),
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
        index: z.number().int().nonnegative(),
        id: z.string().optional(),
        type: z.literal("function").optional(),
        function: z.object({
          name: z.string().optional(),
          arguments: z.string().optional(),
        }).passthrough().optional(),
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
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
}).passthrough();
type WireChunk = z.infer<typeof wireChunkSchema>;
type WireUsage = NonNullable<WireChunk["usage"]>;

interface CacheState {
  anchor: string;
  messages: string[];
}

export class MiMoProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly #config: ResolvedModel;
  readonly #idleTimeoutMs: number;
  readonly #cacheStates = new Map<string, CacheState>();

  constructor(
    config: ResolvedModel,
    options: { idleTimeoutMs?: number } = {},
  ) {
    this.#config = config;
    this.name = config.name;
    this.model = config.model;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
  }

  invalidateCacheScopes(prefix: string): void {
    for (const scope of this.#cacheStates.keys()) {
      if (scope.startsWith(prefix)) this.#cacheStates.delete(scope);
    }
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const thinking = request.thinking ?? this.#config.thinking;
    const maxCompletionTokens = Math.min(
      this.#config.maxOutputTokens,
      Math.max(1, Math.trunc(request.maxCompletionTokens ?? this.#config.maxOutputTokens)),
    );
    const tools = request.tools.map((tool) => ({
      ...tool,
      function: { ...tool.function, strict: true },
    }));
    if (this.model !== "mimo-v2.5" && request.messages.some(hasImagePart)) {
      throw new Error("image attachments require mimo-v2.5; mimo-v2.5-pro is text-only");
    }
    const messages = request.messages.map(toWireMessage);
    validateConversation(messages, thinking);
    const body = JSON.stringify({
      model: this.model,
      messages,
      ...(tools.length ? { tools } : {}),
      stream: true,
      max_completion_tokens: maxCompletionTokens,
      thinking: { type: thinking ? "enabled" : "disabled" },
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
        throw new Error(`MiMo cache prefix changed inside scope ${request.cacheScope}`);
      }
      if (previous && !isPrefix(previous.messages, messageHashes)) {
        throw new Error(`MiMo message history was rewritten inside cache scope ${request.cacheScope}`);
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
        () => controller.abort(new Error("MiMo stream stalled")),
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
            (error instanceof MiMoHttpError && !error.retryable)
          ) throw error;
          lastError = error;
          const delay = error instanceof MiMoHttpError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : 500 * 2 ** attempt + Math.floor(Math.random() * 200);
          await sleep(delay, controller.signal);
        }
      }
      throw lastError instanceof Error ? lastError : new Error("MiMo stream failed");
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
    if (!response.body) throw new Error("MiMo returned an empty response body");

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

    resetIdleTimer();
    for await (const data of parseSse(response.body, signal, resetIdleTimer)) {
      if (data === "[DONE]") {
        sawDone = true;
        break;
      }
      let chunk: WireChunk;
      try {
        chunk = wireChunkSchema.parse(JSON.parse(data));
      } catch (error) {
        const detail = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
        throw new Error(`invalid MiMo stream chunk: ${detail}; data=${data.slice(0, 300)}`);
      }
      if (chunk.error?.message) throw new Error(`MiMo: ${chunk.error.message}`);

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.reasoning_content) {
        reasoning += delta.reasoning_content;
        if (request.onReasoningDelta) {
          markEmitted();
          await request.onReasoningDelta(delta.reasoning_content);
        }
      }
      if (delta?.content) {
        content += delta.content;
        if (request.onTextDelta) {
          markEmitted();
          await request.onTextDelta(delta.content);
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
      for (const part of delta?.tool_calls ?? []) {
        let call = calls.get(part.index);
        if (!call) {
          call = {
            id: part.id ?? `call_${part.index}`,
            type: "function",
            function: { name: "", arguments: "" },
          };
          calls.set(part.index, call);
        }
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
        if (!announcedCalls.has(part.index) && call.function.name && request.onToolCallStart) {
          announcedCalls.add(part.index);
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

    if (!sawDone) throw new Error(`MiMo stream ended before [DONE]`);
    const toolCalls = [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call);
    validateToolCalls(toolCalls);
    const message: ProviderResponse["message"] = { role: "assistant", content: content || null };
    if ((request.thinking ?? this.#config.thinking) && toolCalls.length > 0) message.reasoning_content = reasoning;
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
        "api-key": this.#config.apiKey,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body,
      signal,
    });
    if (response.ok) return response;
    const errorBody = (await response.text()).slice(0, 2_000);
    const quotaExhausted = response.status === 429 && /(?:quota|credit|exhaust|套餐|额度)/i.test(errorBody);
    throw new MiMoHttpError(
      `MiMo HTTP ${response.status}: ${errorBody}`,
      !quotaExhausted && ([408, 409, 429].includes(response.status) || response.status >= 500),
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
}

function toWireMessage(message: ProviderMessage): ProviderMessage {
  if (message.role !== "tool") return message;
  return {
    role: "tool",
    content: message.content,
    tool_call_id: message.tool_call_id,
  };
}

function hasImagePart(message: ProviderMessage): boolean {
  return message.role === "user" && Array.isArray(message.content) &&
    message.content.some((part) => part.type === "image_url");
}

function isPrefix(previous: readonly string[], current: readonly string[]): boolean {
  return previous.length <= current.length && previous.every((message, index) => current[index] === message);
}

function validateConversation(messages: readonly ProviderMessage[], thinking: boolean): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "tool") {
      throw new Error(`MiMo tool result ${message.tool_call_id} has no preceding assistant tool call`);
    }
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    if (thinking && !("reasoning_content" in message)) {
      throw new Error(`MiMo assistant tool-call history is missing reasoning_content`);
    }
    for (const [offset, call] of message.tool_calls.entries()) {
      const result = messages[index + offset + 1];
      if (result?.role !== "tool" || result.tool_call_id !== call.id) {
        throw new Error(`MiMo tool call ${call.id} is missing its ordered tool result`);
      }
    }
    index += message.tool_calls.length;
  }
}

function validateToolCalls(calls: FunctionToolCall[]): void {
  const ids = new Set<string>();
  for (const call of calls) {
    if (!call.function.name.trim()) throw new Error(`MiMo returned a tool call without a function name`);
    if (ids.has(call.id)) throw new Error(`MiMo returned duplicate tool call id ${call.id}`);
    ids.add(call.id);
  }
}

class MiMoHttpError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.name = "MiMoHttpError";
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("request aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
