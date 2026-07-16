import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AnthropicProvider, type AnthropicAssistantMessage } from "../src/provider/anthropic.js";
import type { ResolvedModel } from "../src/config/config.js";
import type { ProviderMessage, ProviderTool } from "../src/provider/types.js";

describe("AnthropicProvider", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("maps requests to the Anthropic wire contract and returns thinking plus tool_use", async () => {
    let requestBody: Record<string, unknown> = {};
    let apiKeyHeader = "";
    let versionHeader = "";
    const url = await serve(servers, (request, response) => {
      apiKeyHeader = String(request.headers["x-api-key"] ?? "");
      versionHeader = String(request.headers["anthropic-version"] ?? "");
      collectJson(request).then((body) => {
        requestBody = body;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":80,"cache_creation_input_tokens":20,"output_tokens":1}}}\n\n');
        response.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n');
        response.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"inspect "}}\n\n');
        response.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-abc"}}\n\n');
        response.write('data: {"type":"content_block_stop","index":0}\n\n');
        response.write('data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}\n\n');
        response.write('data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"pa"}}\n\n');
        response.write('data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"th\\":\\"README.md\\"}"}}\n\n');
        response.write('data: {"type":"content_block_stop","index":1}\n\n');
        response.write('data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\n');
        response.end('data: {"type":"message_stop"}\n\n');
      }).catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
    });
    const provider = new AnthropicProvider(model(url));
    const result = await provider.complete({
      messages: [
        { role: "system", content: "stable" },
        { role: "user", content: "read it" },
      ],
      tools: [readFileTool()],
      signal: new AbortController().signal,
    });

    expect(apiKeyHeader).toBe("test-key");
    expect(versionHeader).toBe("2023-06-01");
    expect(requestBody).toMatchObject({
      model: "test-model",
      stream: true,
      max_tokens: 131_072,
      thinking: { type: "enabled", budget_tokens: 4_096 },
      system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
      tools: [{
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        cache_control: { type: "ephemeral" },
      }],
      messages: [{
        role: "user",
        content: [{ type: "text", text: "read it", cache_control: { type: "ephemeral" } }],
      }],
    });
    expect(requestBody).not.toHaveProperty("max_completion_tokens");
    expect(requestBody).not.toHaveProperty("temperature");
    expect(result.message).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "inspect ",
      reasoning_signature: "sig-abc",
      tool_calls: [{
        id: "toolu_1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"README.md"}' },
      }],
    });
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage).toEqual({
      promptTokens: 110,
      completionTokens: 20,
      totalTokens: 130,
      cacheHitTokens: 80,
      cacheMissTokens: 30,
      reasoningTokens: 0,
      webSearchCalls: 0,
      webSearchPages: 0,
    });
  });

  it("replays thinking with its signature on tool-call turns and merges tool results", async () => {
    let requestBody: Record<string, unknown> = {};
    const url = await serve(servers, (request, response) => {
      collectJson(request).then((body) => {
        requestBody = body;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n');
        response.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        response.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\n');
        response.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n');
        response.end('data: {"type":"message_stop"}\n\n');
      }).catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
    });
    const assistantTurn: AnthropicAssistantMessage = {
      role: "assistant",
      content: null,
      reasoning_content: "plan both reads",
      reasoning_signature: "sig-1",
      tool_calls: [
        { id: "toolu_a", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
        { id: "toolu_b", type: "function", function: { name: "read_file", arguments: '{"path":"b.txt"}' } },
      ],
    };
    const messages: ProviderMessage[] = [
      { role: "user", content: "read both" },
      assistantTurn,
      { role: "tool", content: "alpha", tool_call_id: "toolu_a" },
      { role: "tool", content: "beta", tool_call_id: "toolu_b" },
    ];
    const result = await new AnthropicProvider(model(url)).complete({
      messages,
      tools: [readFileTool()],
      signal: new AbortController().signal,
    });

    expect(requestBody["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "read both" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan both reads", signature: "sig-1" },
          { type: "tool_use", id: "toolu_a", name: "read_file", input: { path: "a.txt" } },
          { type: "tool_use", id: "toolu_b", name: "read_file", input: { path: "b.txt" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "alpha" },
          { type: "tool_result", tool_use_id: "toolu_b", content: "beta", cache_control: { type: "ephemeral" } },
        ],
      },
    ]);
    expect(result.message).toEqual({ role: "assistant", content: "done" });
    expect(result.finishReason).toBe("stop");
  });

  it("streams text and thinking deltas through callbacks across split chunks", async () => {
    const url = await serve(servers, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":1}}}\r\n\r\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\r\n\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\r\n\r\ndata: {"type":"content_block_start","index":1,"content_block":{"ty', () => {
        response.end('pe":"text","text":""}}\r\n\r\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hel"}}\r\n\r\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"lo"}}\r\n\r\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":9}}\r\n\r\ndata: {"type":"message_stop"}\r\n\r\n');
      });
    });
    let text = "";
    let reasoning = "";
    const result = await new AnthropicProvider(model(url)).complete({
      ...simpleRequest(),
      onTextDelta: (delta: string) => { text += delta; },
      onReasoningDelta: (delta: string) => { reasoning += delta; },
    });
    expect(text).toBe("hello");
    expect(reasoning).toBe("hmm");
    expect(result.message.content).toBe("hello");
    expect(result.finishReason).toBe("length");
    expect(result.usage.completionTokens).toBe(9);
  });

  it("retries a 429 honoring retry-after beyond the idle timeout", async () => {
    let requests = 0;
    const url = await serve(servers, (_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "0.1" });
        response.end('{"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}');
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":1}}}\n\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"recovered"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\ndata: {"type":"message_stop"}\n\n');
    });

    const result = await new AnthropicProvider(model(url), { idleTimeoutMs: 25 }).complete(simpleRequest());

    expect(result.message.content).toBe("recovered");
    expect(requests).toBe(2);
  });

  it("fails fast on authentication errors", async () => {
    let requests = 0;
    const url = await serve(servers, (_request, response) => {
      requests += 1;
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"type":"error","error":{"type":"authentication_error","message":"invalid key"}}');
    });
    await expect(new AnthropicProvider(model(url)).complete(simpleRequest())).rejects.toThrow("HTTP 401");
    expect(requests).toBe(1);
  });

  it("propagates aborts through the caller signal", async () => {
    const controller = new AbortController();
    const url = await serve(servers, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":1}}}\n\n', () => {
        controller.abort(new Error("user cancelled"));
      });
    });
    const pending = new AnthropicProvider(model(url)).complete({
      ...simpleRequest(),
      signal: controller.signal,
    });
    await expect(pending).rejects.toThrow("user cancelled");
  });

  it("does not retry once output has escaped through a callback", async () => {
    let requests = 0;
    const url = await serve(servers, (_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n');
    });
    let visible = "";
    await expect(new AnthropicProvider(model(url)).complete({
      ...simpleRequest(),
      onTextDelta: (delta: string) => { visible += delta; },
    })).rejects.toThrow("before message_stop");
    expect(visible).toBe("partial");
    expect(requests).toBe(1);
  });

  it("rejects tool history that is missing reasoning or ordered results", async () => {
    const provider = new AnthropicProvider(model("http://127.0.0.1:1"));
    const missingReasoning: ProviderMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "toolu_a", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", content: "alpha", tool_call_id: "toolu_a" },
    ];
    await expect(provider.complete({ messages: missingReasoning, tools: [], signal: new AbortController().signal }))
      .rejects.toThrow("missing reasoning_content");

    const orphanResult: ProviderMessage[] = [
      { role: "user", content: "go" },
      { role: "tool", content: "alpha", tool_call_id: "toolu_a" },
    ];
    await expect(provider.complete({ messages: orphanResult, tools: [], signal: new AbortController().signal }))
      .rejects.toThrow("no preceding assistant tool call");
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

function readFileTool(): ProviderTool {
  return {
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
  servers: Server[],
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
