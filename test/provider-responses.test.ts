import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedModel } from "../src/config/config.js";
import { OpenAIResponsesProvider } from "../src/provider/openai-responses.js";

describe("OpenAIResponsesProvider", () => {
  const servers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("encodes input and tools and decodes streamed text, reasoning, and function calls", async () => {
    let requestBody: Record<string, unknown> = {};
    let authorization = "";
    const url = await serve(servers, (request, response) => {
      authorization = String(request.headers.authorization ?? "");
      collectJson(request).then((body) => {
        requestBody = body;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          sse({ type: "response.output_text.delta", delta: "inspect " }),
          sse({ type: "response.reasoning_summary_text.delta", delta: "checking" }),
          sse({
            type: "response.output_item.added",
            item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" },
          }),
          sse({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":"x"}' }),
          sse({
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "read_file",
              arguments: '{"path":"x"}',
              status: "completed",
            },
          }),
          sse({
            type: "response.completed",
            response: {
              output: [],
              usage: {
                input_tokens: 10,
                output_tokens: 4,
                total_tokens: 14,
                input_tokens_details: { cached_tokens: 3 },
                output_tokens_details: { reasoning_tokens: 2 },
              },
            },
          }),
          "data: [DONE]\n\n",
        ].join("\n"));
      });
    });

    const reasoning: string[] = [];
    const text: string[] = [];
    const calls: string[] = [];
    const result = await new OpenAIResponsesProvider(model(url)).complete({
      messages: [
        { role: "system", content: "rules" },
        {
          role: "user",
          content: [
            { type: "text", text: "read" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
          ],
        },
        {
          role: "assistant",
          content: "old",
          reasoning_content: "old reasoning",
          tool_calls: [{
            id: "call_old",
            type: "function",
            function: { name: "old_tool", arguments: "{}" },
          }],
        },
        { role: "tool", tool_call_id: "call_old", content: "old result" },
      ],
      tools: [{
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
        },
      }],
      signal: new AbortController().signal,
      maxCompletionTokens: 128,
      onReasoningDelta: (value) => { reasoning.push(value); },
      onTextDelta: (value) => { text.push(value); },
      onToolCallStart: (call) => { calls.push(call.id); },
    });

    expect(authorization).toBe("Bearer test-key");
    expect(requestBody).toMatchObject({
      model: "gpt-5.6-luna",
      stream: true,
      max_output_tokens: 128,
      reasoning: { effort: "max" },
    });
    expect(requestBody).not.toHaveProperty("messages");
    expect(requestBody.input).toEqual([
      { role: "system", content: "rules" },
      {
        role: "user",
        content: [
          { type: "input_text", text: "read" },
          { type: "input_image", image_url: "data:image/png;base64,abc", detail: "auto" },
        ],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "old" }],
        status: "completed",
      },
      { type: "function_call", call_id: "call_old", name: "old_tool", arguments: "{}" },
      { type: "function_call_output", call_id: "call_old", output: "old result" },
    ]);
    expect(requestBody.tools).toEqual([{
      type: "function",
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: {} },
    }]);
    expect(text).toEqual(["inspect "]);
    expect(reasoning).toEqual(["checking"]);
    expect(calls).toEqual(["call_1"]);
    expect(result.message).toEqual({
      role: "assistant",
      content: "inspect ",
      reasoning_content: "checking",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"x"}' },
      }],
    });
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
      cacheHitTokens: 3,
      cacheMissTokens: 7,
      reasoningTokens: 2,
      webSearchCalls: 0,
      webSearchPages: 0,
    });
  });

  it("errors when a [DONE] arrives without a terminal response event instead of returning zeroed usage", async () => {
    const url = await serve(servers, (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        sse({ type: "response.output_text.delta", delta: "partial" }),
        "data: [DONE]\n\n",
      ].join("\n"));
    });
    const provider = new OpenAIResponsesProvider(model(url));
    await expect(
      provider.complete({
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/terminal response event/);
  });
});

function model(baseUrl: string): ResolvedModel {
  return {
    name: "luna",
    model: "gpt-5.6-luna",
    protocol: "openai-responses",
    baseUrl,
    apiKeyEnv: "TEST_API_KEY",
    apiKey: "test-key",
    thinking: true,
    reasoningEffort: "max",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
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
  return `http://127.0.0.1:${address.port}/v1`;
}

function sse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function collectJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
