import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAIProvider } from "../src/provider/openai.js";
import type { ResolvedModel } from "../src/config/config.js";

describe("OpenAIProvider", () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  afterEach(async () => {
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
    });

    expect(authHeader).toBe("Bearer test-key");
    expect(requestBody).toMatchObject({
      model: "test-model",
      thinking: { type: "enabled" },
      stream: true,
      max_completion_tokens: 131_072,
      tools: [{ function: { name: "read_file", strict: true } }],
    });
    expect(requestBody).not.toHaveProperty("user_id");
    expect(requestBody).not.toHaveProperty("reasoning_effort");
    expect(requestBody).not.toHaveProperty("stream_options");
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
    const result = await new OpenAIProvider(model(url)).complete(simpleRequest());
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

    const result = await new OpenAIProvider(model(url), { idleTimeoutMs: 25 }).complete(simpleRequest());

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
    const result = await new OpenAIProvider(model(url)).complete(simpleRequest());
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

  it("times out while waiting for response headers", async () => {
    const url = await serve(servers, () => undefined);
    await expect(new OpenAIProvider(model(url), { idleTimeoutMs: 100 }).complete(simpleRequest()))
      .rejects.toThrow(/stalled|aborted/i);
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