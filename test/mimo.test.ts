import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MiMoProvider } from "../src/provider/mimo.js";
import type { ResolvedModel } from "../src/config/config.js";

describe("MiMoProvider", () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("uses the MiMo-native wire contract and preserves reasoning with tool calls", async () => {
    let requestBody: Record<string, unknown> = {};
    let apiKey = "";
    const url = await serve(servers, (request, response) => {
      apiKey = String(request.headers["api-key"] ?? "");
      collectJson(request).then((body) => {
        requestBody = body;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"choices":[{"delta":{"reasoning_content":"inspect "}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_","arguments":"{\\"pa"}}]}}]}\n\n');
        response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"th\\":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"completion_tokens_details":{"reasoning_tokens":12},"prompt_tokens_details":{"cached_tokens":80},"web_search_usage":{"tool_usage":1,"page_usage":3}}}\n\n');
        response.end('data: [DONE]\n\n');
      }).catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
    });
    const provider = new MiMoProvider(model(url));
    const result = await provider.complete({
      messages: [{ role: "system", content: "stable" }, { role: "user", content: "read it" }],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(apiKey).toBe("test-key");
    expect(requestBody).toMatchObject({
      model: "mimo-v2.5-pro",
      thinking: { type: "enabled" },
      stream: true,
      max_completion_tokens: 131_072,
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
    });
  });

  it("returns native web citations and usage", async () => {
    const url = await serve(servers, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"annotations":[{"type":"url_citation","url":"https://example.com/a","title":"Example","summary":"Source"}],"content":"answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const seen: string[] = [];
    const result = await new MiMoProvider(model(url)).complete({
      messages: [{ role: "user", content: "current fact" }],
      tools: [],
      signal: new AbortController().signal,
      onCitations: (citations) => { seen.push(...citations.map((citation) => citation.url)); },
    });
    expect(seen).toEqual(["https://example.com/a"]);
    expect(result.citations?.[0]).toMatchObject({ title: "Example", url: "https://example.com/a" });
  });

  it("retries a disconnected stream only before model output", async () => {
    let requests = 0;
    const url = await serve(servers, (_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(requests === 1 ? "" : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const result = await new MiMoProvider(model(url)).complete(simpleRequest());
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
    await expect(new MiMoProvider(model(url)).complete({
      ...simpleRequest(),
      onTextDelta: (text) => { visible += text; },
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
    await expect(new MiMoProvider(model(url)).complete(simpleRequest())).rejects.toThrow("MiMo HTTP 401");
    expect(requests).toBe(1);
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
    const provider = new MiMoProvider(model(url));
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
  });

  it("fails closed when a session cache prefix changes", async () => {
    const url = await serve(servers, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const provider = new MiMoProvider(model(url));
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

  it("parses split CRLF boundaries and a final usage-only chunk", async () => {
    const url = await serve(servers, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\r');
      setTimeout(() => response.end('\n\r\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":8}}}\r\n\r\ndata: [DONE]\r\n\r\n'), 5);
    });
    const result = await new MiMoProvider(model(url)).complete(simpleRequest());
    expect(result.message.content).toBe("ok");
    expect(result.usage).toMatchObject({ promptTokens: 10, cacheHitTokens: 8, cacheMissTokens: 2 });
  });
});

function model(baseUrl: string): ResolvedModel {
  return {
    name: "mimo-v2.5-pro",
    model: "mimo-v2.5-pro",
    billing: "pay-as-you-go",
    baseUrl,
    apiKeyEnv: "MIMO_API_KEY",
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
