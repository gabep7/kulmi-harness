import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../src/provider/openai.js";
import type { ResolvedModel } from "../src/config/config.js";
import { ProviderError, type ProviderRetryNotice } from "../src/provider/types.js";

describe("OpenAIProvider", () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("uses the OpenAI wire contract and preserves reasoning with tool calls", async () => {
    let requestBody: Record<string, unknown> = {};
    let authHeader = "";
    const url = await serve(servers, (request, response) => {
      authHeader = String(request.headers["authorization"] ?? "");
      collectJson(request).then((body) => {
        requestBody = body;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"choices":[{"delta":{"reasoning_content":"inspect "}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_","arguments":"{\\"pa"}}]}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"th\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"completion_tokens_details":{"reasoning_tokens":12},"prompt_tokens_details":{"cached_tokens":80},"web_search_usage":{"tool_usage":1,"page_usage":3}}}\n\n');
        response.end('data: [DONE]\n\n');
      }).catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
    });
    const provider = new OpenAIProvider(model(url));
    const result = await provider.complete({
      messages: [{ role: "system", content: "stable" }, { role: "user", content: "read it" }],
      tools: [{
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      }],
      signal: new AbortController().signal,
      reasoningEffort: "high",
    });

    expect(authHeader).toBe("Bearer test-key");
    expect(requestBody).toMatchObject({
      model: "test-model",
      thinking: { type: "enabled" },
      stream: true,
      max_completion_tokens: 131_072,
      tools: [{ function: { name: "read_file", strict: true } }],
    });
    expect(requestBody).not.toHaveProperty("reasoning_effort");
    expect(requestBody).not.toHaveProperty("user_id");
    expect(requestBody).toMatchObject({ stream_options: { include_usage: true } });
    expect(requestBody).not.toHaveProperty("temperature");
    expect(requestBody).not.toHaveProperty("top_p");
    expect(result.message).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "inspect ",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"README.md"}' },
      }],
    });
    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cacheHitTokens: 80,
      cacheMissTokens: 20,
      reasoningTokens: 12,
      webSearchCalls: 1,
      webSearchPages: 3,
    });
  });

  it("tolerates null tool call fields in stream chunks", async () => {
    const url = await serve(servers, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":null}}]}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":null,"id":null,"function":{"name":null,"arguments":"{\\"path\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
      response.end('data: [DONE]\n\n');
    });

    const result = await new OpenAIProvider(model(url)).complete(simpleRequest());

    expect(result.message.tool_calls).toEqual([{
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"README.md"}' },
    }]);
  });

  it("allows a profile to opt out of streamed usage", async () => {
    let requestBody: Record<string, unknown> = {};
    const url = await serve(servers, (request, response) => {
      collectJson(request).then((body) => {
        requestBody = body;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      }).catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
    });

    await new OpenAIProvider({ ...model(url), streamUsage: false }).complete(simpleRequest());

    expect(requestBody).not.toHaveProperty("stream_options");
  });

  it("accepts missing tool indexes, alternate types, and content arrays", async () => {
    const url = await serve(servers, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: [{ type: "output_text", text: "hello " }, { content: "world" }] } }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{
          id: "call_compat",
          type: "tool_call",
          function: { name: "read_", arguments: '{"pa' },
        }] } }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        choices: [{
          delta: { tool_calls: [{ function: { name: "file", arguments: 'th":"README.md"}' } }] },
          finish_reason: "tool_calls",
        }],
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });

    const result = await new OpenAIProvider(model(url)).complete(simpleRequest());

    expect(result.message.content).toBe("hello world");
    expect(result.message.tool_calls).toEqual([{
      id: "call_compat",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"README.md"}' },
    }]);
  });

  it("cancels the response body after an early done marker", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    await new OpenAIProvider(model("https://provider.invalid/v1")).complete(simpleRequest());

    expect(cancelled).toBe(true);
  });

  it("returns native web citations and usage", async () => {
    const url = await serve(servers, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"annotations":[{"type":"url_citation","url":"https://example.com/a","title":"Example","summary":"Source"}],"content":"answer"}}]}\n\ndata: {"choices":[{"delta":{"annotations":[{"type":"url_citation","url":"https://example.com/a","title":"Duplicate"},{"type":"url_citation","url":"https://example.com/b","title":"Second"}]},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const seen: string[] = [];
    const result = await new OpenAIProvider(model(url)).complete({
      messages: [{ role: "user", content: "current fact" }],
      tools: [],
      signal: new AbortController().signal,
      onCitations: (citations: { url: string }[]) => { seen.push(...citations.map((citation) => citation.url)); },
    });
    expect(seen).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(result.citations?.map((citation) => citation.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(result.citations?.[0]).toMatchObject({ title: "Example", url: "https://example.com/a" });
  });

  it("normalizes legacy cache telemetry when detailed usage is absent", async () => {
    const url = await serve(servers, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_cache_hit_tokens":7,"prompt_cache_miss_tokens":3,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n');
    });
    const result = await new OpenAIProvider(model(url)).complete(simpleRequest());
    expect(result.usage).toMatchObject({
      promptTokens: 10,
      cacheHitTokens: 7,
      cacheMissTokens: 3,
    });
  });

  it("merges search and token telemetry delivered in separate chunks", async () => {
    const url = await serve(servers, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[],"usage":{"web_search_usage":{"tool_usage":2,"page_usage":6}}}\n\ndata: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":8}}}\n\ndata: [DONE]\n\n');
    });
    const result = await new OpenAIProvider(model(url)).complete(simpleRequest());
    expect(result.usage).toMatchObject({
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      cacheHitTokens: 8,
      cacheMissTokens: 2,
      webSearchCalls: 2,
      webSearchPages: 6,
    });
  });

  it("merges cache and completion counts delivered in separate usage chunks", async () => {
    const url = await serve(servers, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[],"usage":{"prompt_cache_hit_tokens":100}}\n\ndata: {"choices":[],"usage":{"prompt_cache_miss_tokens":50}}\n\ndata: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"completion_tokens":20,"total_tokens":120}}\n\ndata: [DONE]\n\n');
    });
    const result = await new OpenAIProvider(model(url)).complete(simpleRequest());
    expect(result.usage).toMatchObject({
      promptTokens: 150,
      completionTokens: 20,
      totalTokens: 170,
      cacheHitTokens: 100,
      cacheMissTokens: 50,
    });
  });

  it("retries a disconnected stream only before model output", async () => {
    let requests = 0;
    const url = await serve(servers, (_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(requests === 1 ? "" : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const result = await new OpenAIProvider(model(url), { retryBaseDelayMs: 0, random: () => 0 }).complete(simpleRequest());
    expect(result.message.content).toBe("ok");
    expect(requests).toBe(2);
  });

  it("honors Retry-After beyond the stream idle timeout before a successful retry", async () => {
    let requests = 0;
    const url = await serve(servers, (_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "0.1" });
        response.end('{"error":{"message":"rate limited"}}');
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });

    const result = await new OpenAIProvider(model(url), {
      idleTimeoutMs: 25,
      retryBaseDelayMs: 0,
      random: () => 0,
    }).complete(simpleRequest());

    expect(result.message.content).toBe("recovered");
    expect(requests).toBe(2);
  });

  it("retries buffered output when no callback observed it", async () => {
    let requests = 0;
    const url = await serve(servers, (_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(requests === 1
        ? 'data: {"choices":[{"delta":{"content":"discarded"}}]}\n\n'
        : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const result = await new OpenAIProvider(model(url), { retryBaseDelayMs: 0, random: () => 0 }).complete(simpleRequest());
    expect(result.message.content).toBe("ok");
    expect(requests).toBe(2);
  });

  it("does not replay after output has escaped", async () => {
    let requests = 0;
    const url = await serve(servers, (_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    });
    let visible = "";
    await expect(new OpenAIProvider(model(url)).complete({
      ...simpleRequest(),
      onTextDelta: (text: string) => { visible += text; },
    })).rejects.toThrow("before [DONE]");
    expect(visible).toBe("partial");
    expect(requests).toBe(1);
  });

  it("fails fast on authentication errors", async () => {
    let requests = 0;
    const url = await serve(servers, (_request, response) => {
      requests += 1;
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":{"message":"invalid key"}}');
    });
    await expect(new OpenAIProvider(model(url)).complete(simpleRequest())).rejects.toThrow("HTTP 401");
    expect(requests).toBe(1);
  });

  it.each([
    { status: 401, type: "authentication_error", message: "bad key", kind: "auth", retryable: false },
    { status: 429, type: "rate_limit_error", message: "slow down", kind: "rate_limit", retryable: true },
    { status: 429, type: "billing_error", message: "quota exhausted", kind: "quota", retryable: false },
    { status: 400, type: "context_length_exceeded", message: "maximum context length exceeded", kind: "context_length", retryable: false },
    { status: 400, type: "invalid_request_error", message: "bad request", kind: "invalid_request", retryable: false },
    { status: 529, type: "overloaded_error", message: "overloaded", kind: "overloaded", retryable: true },
    { status: 503, type: "api_error", message: "unavailable", kind: "server", retryable: true },
    { status: 408, type: "request_timeout", message: "timed out", kind: "transport", retryable: true },
    { status: 409, type: "conflict_error", message: "conflict", kind: "invalid_request", retryable: false },
  ] as const)("classifies HTTP $status as $kind", async ({ status, type, message, kind, retryable }) => {
    let requests = 0;
    const url = await serve(servers, (_request, response) => {
      requests += 1;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type, message } }));
    });
    let caught: unknown;

    try {
      await new OpenAIProvider(model(url), { maxAttempts: 1 }).complete(simpleRequest());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught).toMatchObject({
      name: "ProviderError",
      kind,
      status,
      providerErrorType: type,
      retryable,
    });
    expect(requests).toBe(1);
  });

  it("rejects an excessive retry-after without sleeping or retrying", async () => {
    let requests = 0;
    const url = await serve(servers, (_request, response) => {
      requests += 1;
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "3600",
      });
      response.end('{"error":{"type":"rate_limit_error","message":"slow down"}}');
    });

    await expect(new OpenAIProvider(model(url), {
      maxRetryAfterMs: 50,
    }).complete(simpleRequest())).rejects.toMatchObject({
      kind: "rate_limit",
      status: 429,
      retryable: false,
      retryAfterMs: 50,
      message: expect.stringContaining("retry-after exceeds 50ms maximum"),
    });
    expect(requests).toBe(1);
  });

  it("uses exponential jitter and reports each retry attempt", async () => {
    vi.useFakeTimers();
    let requests = 0;
    const notices: ProviderRetryNotice[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      requests += 1;
      if (requests < 3) {
        return new Response('{"error":{"type":"api_error","message":"unavailable"}}', {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });

    const pending = new OpenAIProvider(model("https://provider.invalid/v1"), {
      retryBaseDelayMs: 100,
      random: () => 1,
      totalTimeoutMs: 1_000,
    }).complete({
      ...simpleRequest(),
      onRetry: (notice) => { notices.push(notice); },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(130);
    await vi.advanceTimersByTimeAsync(260);

    await expect(pending).resolves.toMatchObject({ message: { content: "ok" } });
    expect(requests).toBe(3);
    expect(notices.map(({ attempt, delayMs }) => ({ attempt, delayMs }))).toEqual([
      { attempt: 2, delayMs: 130 },
      { attempt: 3, delayMs: 260 },
    ]);
  });

  it("times out while waiting for response headers", async () => {
    const url = await serve(servers, () => undefined);
    await expect(new OpenAIProvider(model(url), { idleTimeoutMs: 100, maxAttempts: 1 }).complete(simpleRequest()))
      .rejects.toThrow(/stalled|aborted/i);
  });

  it("retries a stalled attempt with a fresh controller and reports the retry", async () => {
    vi.useFakeTimers();
    let requests = 0;
    const notices: ProviderRetryNotice[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests += 1;
      if (requests === 2) {
        return new Response(
          'data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": waiting\n\n"));
          signal?.addEventListener("abort", () => {
            controller.error(signal.reason ?? new Error("aborted"));
          }, { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const pending = new OpenAIProvider(model("https://provider.invalid/v1"), {
      idleTimeoutMs: 25,
      requestTimeoutMs: 200,
      totalTimeoutMs: 500,
      retryBaseDelayMs: 0,
      random: () => 0,
    }).complete({
      ...simpleRequest(),
      onRetry: (notice) => { notices.push(notice); },
    });
    await vi.advanceTimersByTimeAsync(26);
    const result = await pending;

    expect(result.message.content).toBe("recovered");
    expect(requests).toBe(2);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      attempt: 2,
      maxAttempts: 3,
      error: { kind: "transport", retryable: true },
    });
  });

  it("does not treat keepalive data as idle progress", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const keepalive = setInterval(() => {
            controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
          }, 5);
          signal?.addEventListener("abort", () => {
            clearInterval(keepalive);
            controller.error(signal.reason ?? new Error("aborted"));
          }, { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const pending = new OpenAIProvider(model("https://provider.invalid/v1"), {
      idleTimeoutMs: 30,
      requestTimeoutMs: 200,
      totalTimeoutMs: 300,
      maxAttempts: 1,
    }).complete(simpleRequest());
    const rejection = expect(pending).rejects.toMatchObject({
      name: "ProviderError",
      kind: "transport",
      retryable: true,
      message: "stream stalled",
    });
    await vi.advanceTimersByTimeAsync(31);
    await rejection;
  });

  it("enforces per-attempt and total deadlines independently", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const progress = setInterval(() => {
            controller.enqueue(new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"."}}]}\n\n',
            ));
          }, 5);
          signal?.addEventListener("abort", () => {
            clearInterval(progress);
            controller.error(signal.reason ?? new Error("aborted"));
          }, { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const attempt = new OpenAIProvider(model("https://provider.invalid/v1"), {
      idleTimeoutMs: 100,
      requestTimeoutMs: 30,
      totalTimeoutMs: 200,
      maxAttempts: 1,
    }).complete(simpleRequest());
    const attemptRejection = expect(attempt).rejects.toMatchObject({
      kind: "transport",
      message: "request attempt timed out",
    });
    await vi.advanceTimersByTimeAsync(31);
    await attemptRejection;

    const total = new OpenAIProvider(model("https://provider.invalid/v1"), {
      idleTimeoutMs: 100,
      requestTimeoutMs: 15,
      totalTimeoutMs: 35,
      retryBaseDelayMs: 100,
      maxAttempts: 3,
      random: () => 0,
    }).complete(simpleRequest());
    const totalRejection = expect(total).rejects.toMatchObject({
      kind: "transport",
      retryable: false,
      message: "total request deadline exceeded",
    });
    await vi.advanceTimersByTimeAsync(36);
    await totalRejection;
  });

  it("replays complete reasoning content with historical tool calls", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let requestCount = 0;
    const url = await serve(servers, (request, response) => {
      collectJson(request).then((body) => {
        bodies.push(body);
        requestCount += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (requestCount === 1) {
          response.end('data: {"choices":[{"delta":{"reasoning_content":"must inspect"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
        } else {
          response.end('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        }
      }).catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
    });
    const provider = new OpenAIProvider(model(url));
    const first = await provider.complete(simpleRequest());
    await provider.complete({
      messages: [
        { role: "user", content: "inspect" },
        first.message,
        { role: "tool", tool_call_id: "call_a", name: "read_file", content: "contents" },
      ],
      tools: [],
      signal: new AbortController().signal,
    });
    expect((bodies[1]?.messages as Array<Record<string, unknown>>)[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "must inspect",
      tool_calls: [{ id: "call_a" }],
    });
    expect((bodies[1]?.messages as Array<Record<string, unknown>>)[2]).toEqual({
      role: "tool",
      tool_call_id: "call_a",
      content: "contents",
    });
  });

  it("rejects incomplete reasoning and mispaired tool history before requesting", async () => {
    let requests = 0;
    const url = await serve(servers, (_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"unexpected"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const provider = new OpenAIProvider(model(url));
    await expect(provider.complete({
      ...simpleRequest(),
      messages: [
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_a", content: "result" },
      ],
    })).rejects.toThrow("missing reasoning_content");
    await expect(provider.complete({
      ...simpleRequest(),
      messages: [
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "inspect both",
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } },
            { id: "call_b", type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_b", content: "second" },
        { role: "tool", tool_call_id: "call_a", content: "first" },
      ],
    })).rejects.toThrow("call_a is missing its ordered tool result");
    expect(requests).toBe(0);
  });

  it("fails closed when a session cache prefix changes", async () => {
    const url = await serve(servers, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const provider = new OpenAIProvider(model(url));
    await provider.complete({ ...simpleRequest(), cacheScope: "agent_1" });
    await expect(provider.complete({
      ...simpleRequest(),
      cacheScope: "agent_1",
      tools: [{
        type: "function",
        function: { name: "new_tool", description: "changed", parameters: { type: "object" } },
      }],
    })).rejects.toThrow("cache prefix changed");
  });

  it("invalidates matching cache scopes without weakening unrelated scopes", async () => {
    let requests = 0;
    const url = await serve(servers, (_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const provider = new OpenAIProvider(model(url));
    const changedTools = [{
      type: "function" as const,
      function: { name: "changed_tool", description: "changed", parameters: { type: "object" } },
    }];
    await provider.complete({ ...simpleRequest(), cacheScope: "agent_1:turn" });
    await provider.complete({ ...simpleRequest(), cacheScope: "agent_10:turn" });

    provider.invalidateCacheScopes("agent_1:");

    await expect(provider.complete({
      ...simpleRequest(),
      cacheScope: "agent_1:turn",
      tools: changedTools,
    })).resolves.toMatchObject({ message: { content: "ok" } });
    await expect(provider.complete({
      ...simpleRequest(),
      cacheScope: "agent_10:turn",
      tools: changedTools,
    })).rejects.toThrow("cache prefix changed");
    expect(requests).toBe(3);
  });

  it("accepts append-only cache history and rejects rewritten messages", async () => {
    let requests = 0;
    const url = await serve(servers, (_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const provider = new OpenAIProvider(model(url));
    const initial = [
      { role: "system" as const, content: "stable" },
      { role: "user" as const, content: "first" },
    ];
    await provider.complete({ ...simpleRequest(), messages: initial, cacheScope: "agent_1" });
    await provider.complete({
      ...simpleRequest(),
      messages: [...initial, { role: "assistant" as const, content: "ok" }, { role: "user" as const, content: "second" }],
      cacheScope: "agent_1",
    });
    await expect(provider.complete({
      ...simpleRequest(),
      messages: [...initial.slice(0, 1), { role: "user" as const, content: "rewritten" }],
      cacheScope: "agent_1",
    })).rejects.toThrow("message history was rewritten");
    expect(requests).toBe(2);
  });

  it("rejects duplicate completed tool-call ids", async () => {
    const url = await serve(servers, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"duplicate","function":{"name":"first","arguments":"{}"}},{"index":1,"id":"duplicate","function":{"name":"second","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    });
    await expect(new OpenAIProvider(model(url)).complete(simpleRequest()))
      .rejects.toThrow("duplicate tool call id duplicate");
  });

  it("parses split CRLF boundaries and a final usage-only chunk", async () => {
    const url = await serve(servers, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\r');
      setTimeout(() => response.end('\n\r\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":8}}}\r\n\r\ndata: [DONE]\r\n\r\n'), 5);
    });
    const result = await new OpenAIProvider(model(url)).complete(simpleRequest());
    expect(result.message.content).toBe("ok");
    expect(result.usage).toMatchObject({ promptTokens: 10, cacheHitTokens: 8, cacheMissTokens: 2 });
  });
});

function model(baseUrl: string, modelId: string = "test-model"): ResolvedModel {
  return {
    name: modelId,
    model: modelId,
    baseUrl,
    apiKeyEnv: "TEST_API_KEY",
    apiKey: "test-key",
    thinking: true,
    reasoningStyle: "reasoning_content",
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
  };
}

function simpleRequest() {
  return {
    messages: [{ role: "user" as const, content: "hello" }],
    tools: [],
    signal: new AbortController().signal,
  };
}

async function serve(
  servers: Array<ReturnType<typeof createServer>>,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return `http://127.0.0.1:${address.port}`;
}

async function collectJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
