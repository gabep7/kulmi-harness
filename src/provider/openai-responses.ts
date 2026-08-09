import { createHash } from "node:crypto";
import { z } from "zod";
import type { ResolvedModel } from "../config/config.js";
import {
  ProviderError,
  type FunctionToolCall,
  type ModelProvider,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderTool,
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

const responseEventSchema = z.looseObject({ type: z.string() });
type ResponseEvent = z.infer<typeof responseEventSchema>;

type InputText = { type: "input_text"; text: string };
type InputImage = { type: "input_image"; image_url: string; detail: "auto" };
type ResponsesInputItem =
  | { role: "system" | "user"; content: string | Array<InputText | InputImage> }
  | { type: "message"; role: "assistant"; content: [{ type: "output_text"; text: string }]; status: "completed" }
  | { type: "function_call"; call_id: string; name: string; arguments: string; id?: string }
  | { type: "function_call_output"; call_id: string; output: string };
type ResponsesTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type CacheState = {
  anchor: string;
  messages: string[];
};

export interface OpenAIResponsesProviderOptions {
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRetryAfterMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  random?: () => number;
}

export class OpenAIResponsesProvider implements ModelProvider {
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

  constructor(config: ResolvedModel, options: OpenAIResponsesProviderOptions = {}) {
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
    const maxOutputTokens = Math.min(
      this.#config.maxOutputTokens,
      Math.max(1, Math.trunc(request.maxCompletionTokens ?? this.#config.maxOutputTokens)),
    );
    validateConversation(request.messages);
    const input = toResponsesInput(request.messages);
    const tools = toResponsesTools(request.tools);
    const body = JSON.stringify({
      model: this.model,
      input,
      ...(tools.length ? { tools } : {}),
      stream: true,
      max_output_tokens: maxOutputTokens,
      ...(thinking && reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    });
    this.#recordCacheScope(request, input, tools, thinking, reasoningEffort);

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
        return this.#readResponse(response, request, signal, resetIdleTimer, markEmitted);
      },
    });
  }

  #recordCacheScope(
    request: ProviderRequest,
    input: ResponsesInputItem[],
    tools: ResponsesTool[],
    thinking: boolean,
    reasoningEffort: string | undefined,
  ): void {
    if (!request.cacheScope) return;
    const anchor = createHash("sha256").update(JSON.stringify({
      model: this.model,
      thinking,
      reasoningEffort,
      tools,
    })).digest("hex");
    const messageHashes = input.map((item) => createHash("sha256").update(JSON.stringify(item)).digest("hex"));
    const previous = this.#cacheStates.get(request.cacheScope);
    if (previous && previous.anchor !== anchor) {
      throw new Error(`cache prefix changed inside scope ${request.cacheScope}`);
    }
    if (previous && !isPrefix(previous.messages, messageHashes)) {
      throw new Error(`message history was rewritten inside cache scope ${request.cacheScope}`);
    }
    this.#cacheStates.set(request.cacheScope, { anchor, messages: messageHashes });
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
    let usage = emptyUsage();
    let sawTerminal = false;
    let sawDone = false;
    const calls = new Map<string, FunctionToolCall>();
    const callAliases = new Map<string, string>();
    const callOrder: string[] = [];
    const announcedCalls = new Set<FunctionToolCall>();

    const appendReasoning = async (text: string): Promise<void> => {
      if (!text) return;
      reasoning += text;
      if (request.onReasoningDelta) {
        markEmitted();
        await request.onReasoningDelta(text);
      }
    };
    const appendText = async (text: string): Promise<void> => {
      if (!text) return;
      content += text;
      if (request.onTextDelta) {
        markEmitted();
        await request.onTextDelta(text);
      }
    };
    const announce = async (call: FunctionToolCall): Promise<void> => {
      if (!call.function.name || announcedCalls.has(call) || !request.onToolCallStart) return;
      announcedCalls.add(call);
      markEmitted();
      await request.onToolCallStart(call);
    };
    const upsertCall = async (item: Record<string, unknown>, fallbackItemId?: string): Promise<FunctionToolCall> => {
      const candidates = [stringValue(item.id), fallbackItemId, stringValue(item.call_id)]
        .filter((value): value is string => value !== undefined && value.length > 0);
      const itemKey = candidates.map((candidate) => callAliases.get(candidate) ?? candidate)
        .find((candidate) => calls.has(candidate)) ?? candidates[0] ?? `call_${callOrder.length}`;
      const existing = calls.get(itemKey);
      const call = existing ?? {
        id: stringValue(item.call_id) ?? itemKey,
        type: "function",
        function: {
          name: stringValue(item.name) ?? "",
          arguments: stringValue(item.arguments) ?? "",
        },
      };
      if (!existing) {
        calls.set(itemKey, call);
        callOrder.push(itemKey);
      }
      for (const candidate of candidates) callAliases.set(candidate, itemKey);
      const callId = stringValue(item.call_id);
      const name = stringValue(item.name);
      const argumentsText = stringValue(item.arguments);
      if (callId) call.id = callId;
      if (name) call.function.name = name;
      if (argumentsText !== undefined) call.function.arguments = argumentsText;
      await announce(call);
      return call;
    };

    for await (const data of parseSse(response.body, signal)) {
      if (data === "[DONE]") {
        sawDone = true;
        break;
      }
      let event: ResponseEvent;
      try {
        event = responseEventSchema.parse(JSON.parse(data));
      } catch (error) {
        const detail = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
        throw new Error(`invalid Responses stream event: ${detail}; data=${data.slice(0, 300)}`);
      }
      resetIdleTimer();
      const eventType = event.type;
      if (eventType === "error") {
        const error = asRecord(event.error);
        throw createProviderStreamError(
          "OpenAI Responses",
          stringValue(error?.message) ?? "Responses stream error",
          stringValue(error?.type) ?? stringValue(error?.code),
        );
      }
      if (eventType === "response.failed") {
        const responseValue = asRecord(event.response);
        const error = asRecord(responseValue?.error);
        throw createProviderStreamError(
          "OpenAI Responses",
          stringValue(error?.message) ?? stringValue(responseValue?.status) ?? "Responses request failed",
          stringValue(error?.code),
        );
      }
      const itemKey = stringValue(event.item_id) ?? numberValue(event.output_index)?.toString();
      if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
        const item = asRecord(event.item);
        if (item?.type === "function_call") await upsertCall(item, itemKey);
        if (eventType === "response.output_item.done" && item?.type === "message") {
          const text = outputMessageText(item);
          if (!content) await appendText(text);
        }
        continue;
      }
      if (eventType === "response.output_text.delta" || eventType === "response.refusal.delta") {
        await appendText(stringValue(event.delta) ?? "");
        continue;
      }
      if (eventType === "response.output_text.done" || eventType === "response.refusal.done") {
        if (!content) await appendText(stringValue(event.text) ?? stringValue(event.refusal) ?? "");
        continue;
      }
      if (
        eventType === "response.reasoning_summary_text.delta" ||
        eventType === "response.reasoning_text.delta" ||
        eventType === "response.reasoning_content.delta"
      ) {
        await appendReasoning(stringValue(event.delta) ?? stringValue(event.text) ?? "");
        continue;
      }
      if (eventType === "response.function_call_arguments.delta") {
        const call = await upsertCall({ name: stringValue(event.name) ?? "" }, itemKey);
        call.function.arguments += stringValue(event.delta) ?? "";
        continue;
      }
      if (eventType === "response.function_call_arguments.done") {
        await upsertCall({
          name: stringValue(event.name) ?? "",
          arguments: stringValue(event.arguments) ?? "",
        }, itemKey);
        continue;
      }
      if (eventType === "response.completed" || eventType === "response.incomplete") {
        const responseValue = asRecord(event.response);
        const responseUsage = asRecord(responseValue?.usage);
        if (responseUsage) usage = normalizeUsage(responseUsage);
        await consumeOutput(responseValue?.output, content, reasoning, appendText, appendReasoning, upsertCall);
        sawTerminal = true;
        if (eventType === "response.completed") finishReason = calls.size > 0 ? "tool_calls" : "stop";
        else finishReason = incompleteFinishReason(asRecord(responseValue?.incomplete_details));
        break;
      }
    }

    // A stream that reaches [DONE] without a response.completed/incomplete event
    // would otherwise "succeed" with all-zero usage and a guessed finish reason,
    // silently corrupting cost accounting. Treat any missing terminal event as
    // an error so the caller never consumes fabricated telemetry.
    if (!sawTerminal) throw new Error("Responses stream ended before a terminal response event");
    if (finishReason === null) finishReason = calls.size > 0 ? "tool_calls" : "stop";
    const toolCalls = callOrder.map((key) => calls.get(key)).filter((call): call is FunctionToolCall => call !== undefined);
    for (const call of toolCalls) {
      if (!call.function.arguments) call.function.arguments = "{}";
    }
    validateToolCalls(toolCalls);
    const message: ProviderResponse["message"] = { role: "assistant", content: content || null };
    if (reasoning && (request.thinking ?? this.#config.thinking)) message.reasoning_content = reasoning;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    return { message, finishReason, usage };
  }

  async #fetch(body: string, signal: AbortSignal): Promise<Response> {
    const base = this.#config.baseUrl.replace(/\/$/, "");
    const response = await fetch(`${base}/responses`, {
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
      "OpenAI Responses",
      response.status,
      errorBody,
      response.headers.get("retry-after"),
      this.#maxRetryAfterMs,
    );
  }
}

function toResponsesInput(messages: ProviderMessage[]): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      input.push({ role: "system", content: message.content });
      continue;
    }
    if (message.role === "user") {
      if (typeof message.content === "string") {
        input.push({ role: "user", content: message.content });
      } else {
        const content = message.content.map((part): InputText | InputImage => {
          if (part.type === "text") return { type: "input_text", text: part.text };
          if (part.type === "image_url") return { type: "input_image", image_url: part.image_url.url, detail: "auto" };
          throw new Error(`image attachment ${part.attachment_id} was not materialized before Responses encoding`);
        });
        input.push({ role: "user", content });
      }
      continue;
    }
    if (message.role === "assistant") {
      if (message.content) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: message.content }],
          status: "completed",
        });
      }
      for (const call of message.tool_calls ?? []) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }
    input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content });
  }
  return input;
}

function toResponsesTools(tools: ProviderTool[]): ResponsesTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

function validateConversation(messages: readonly ProviderMessage[]): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "tool") {
      throw new Error(`tool result ${message.tool_call_id} has no preceding assistant tool call`);
    }
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
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

function outputMessageText(item: Record<string, unknown>): string {
  const content = item.content;
  if (!Array.isArray(content)) return stringValue(item.text) ?? "";
  return content.map((part) => {
    const recordPart = asRecord(part);
    return stringValue(recordPart?.text) ?? stringValue(recordPart?.refusal) ?? "";
  }).join("");
}

async function consumeOutput(
  value: unknown,
  currentContent: string,
  currentReasoning: string,
  appendText: (text: string) => Promise<void>,
  appendReasoning: (text: string) => Promise<void>,
  upsertCall: (item: Record<string, unknown>) => Promise<FunctionToolCall>,
): Promise<void> {
  if (!Array.isArray(value)) return;
  for (const rawItem of value) {
    const item = asRecord(rawItem);
    if (!item) continue;
    if (item.type === "function_call") {
      await upsertCall(item);
      continue;
    }
    if (item.type === "message" && !currentContent) {
      await appendText(outputMessageText(item));
      continue;
    }
    if (item.type === "reasoning" && !currentReasoning) {
      const summary = Array.isArray(item.summary)
        ? item.summary.map((part) => stringValue(asRecord(part)?.text) ?? "").join("")
        : "";
      await appendReasoning(summary);
    }
  }
}


function incompleteFinishReason(details: Record<string, unknown> | undefined): string {
  const reason = stringValue(details?.reason);
  if (reason === "max_output_tokens" || reason === "max_tokens") return "length";
  if (reason === "content_filter") return "content_filter";
  return reason ?? "incomplete";
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

function normalizeUsage(usage: Record<string, unknown>): ProviderResponse["usage"] {
  const inputTokens = numberValue(usage.input_tokens) ?? numberValue(usage.prompt_tokens) ?? 0;
  const outputTokens = numberValue(usage.output_tokens) ?? numberValue(usage.completion_tokens) ?? 0;
  const totalTokens = numberValue(usage.total_tokens) ?? inputTokens + outputTokens;
  const inputDetails = asRecord(usage.input_tokens_details) ?? asRecord(usage.prompt_tokens_details);
  const outputDetails = asRecord(usage.output_tokens_details) ?? asRecord(usage.completion_tokens_details);
  const cacheHit = Math.min(inputTokens, numberValue(inputDetails?.cached_tokens) ?? numberValue(usage.prompt_cache_hit_tokens) ?? 0);
  const cacheMiss = Math.min(inputTokens - cacheHit, numberValue(usage.prompt_cache_miss_tokens) ?? Math.max(0, inputTokens - cacheHit));
  return {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: Math.max(totalTokens, inputTokens + outputTokens),
    cacheHitTokens: cacheHit,
    cacheMissTokens: cacheMiss,
    reasoningTokens: numberValue(outputDetails?.reasoning_tokens) ?? 0,
    webSearchCalls: numberValue(asRecord(usage.web_search_usage)?.tool_usage) ?? 0,
    webSearchPages: numberValue(asRecord(usage.web_search_usage)?.page_usage) ?? 0,
  };
}

function isPrefix(previous: readonly string[], current: readonly string[]): boolean {
  return previous.length <= current.length && previous.every((hash, index) => current[index] === hash);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
