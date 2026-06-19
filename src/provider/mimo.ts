import type { ResolvedModel } from "../config/config.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  FunctionToolCall,
  ModelProvider,
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
  }).passthrough().nullable().optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
}).passthrough();
type WireChunk = z.infer<typeof wireChunkSchema>;

export class MiMoProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly #config: ResolvedModel;
  readonly #idleTimeoutMs: number;
  readonly #cachePrefixes = new Map<string, string>();

  constructor(
    config: ResolvedModel,
    options: { idleTimeoutMs?: number } = {},
  ) {
    this.#config = config;
    this.name = config.name;
    this.model = config.model;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const thinking = request.thinking ?? this.#config.thinking;
    const maxCompletionTokens = Math.min(
      this.#config.maxOutputTokens,
      Math.max(1, Math.trunc(request.maxCompletionTokens ?? this.#config.maxOutputTokens)),
    );
    const tools: Array<(typeof request.tools)[number] | Record<string, unknown>> = [...request.tools];
    const body = JSON.stringify({
      model: this.model,
      messages: request.messages,
      ...(tools.length ? { tools } : {}),
      stream: true,
      max_completion_tokens: maxCompletionTokens,
      thinking: { type: thinking ? "enabled" : "disabled" },
    });
    if (request.cacheScope) {
      const fingerprint = createHash("sha256").update(JSON.stringify({
        model: this.model,
        thinking,
        system: request.messages.filter((message) => message.role === "system"),
        tools,
      })).digest("hex");
      const previous = this.#cachePrefixes.get(request.cacheScope);
      if (previous && previous !== fingerprint) {
        throw new Error(`MiMo cache prefix changed inside scope ${request.cacheScope}`);
      }
      this.#cachePrefixes.set(request.cacheScope, fingerprint);
    }

    const controller = new AbortController();
    const relayAbort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", relayAbort, { once: true });
    if (request.signal.aborted) relayAbort();

    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
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
          const response = await this.#fetch(body, controller.signal);
          return await this.#readResponse(
            response,
            request,
            controller.signal,
            resetIdleTimer,
            () => { emitted = true; },
          );
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
      if (idleTimer) clearTimeout(idleTimer);
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
    let citations: WebCitation[] = [];
    let usage: ProviderResponse["usage"] = emptyUsage();
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
        markEmitted();
        reasoning += delta.reasoning_content;
        await request.onReasoningDelta?.(delta.reasoning_content);
      }
      if (delta?.content) {
        markEmitted();
        content += delta.content;
        await request.onTextDelta?.(delta.content);
      }
      if (delta?.annotations?.length) {
        markEmitted();
        citations = delta.annotations.map(toCitation).filter((item): item is WebCitation => item !== undefined);
        await request.onCitations?.(citations);
      }
      if (delta?.error_message) searchError = delta.error_message;
      for (const part of delta?.tool_calls ?? []) {
        markEmitted();
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
        if (!announcedCalls.has(part.index) && call.function.name) {
          announcedCalls.add(part.index);
          await request.onToolCallStart?.(call);
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = normalizeUsage(chunk.usage);
    }

    if (!sawDone) throw new Error("MiMo stream ended before [DONE]");
    const toolCalls = [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call);
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
  };
}

function normalizeUsage(usage: NonNullable<WireChunk["usage"]>): ProviderResponse["usage"] {
  const prompt = usage.prompt_tokens ?? 0;
  const hit = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    cacheHitTokens: hit,
    cacheMissTokens: Math.max(0, prompt - hit),
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
  };
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
