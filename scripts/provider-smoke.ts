import { OpenAIProvider } from "../src/provider/openai.js";
import { loadConfig, resolveModel, type ResolvedModel } from "../src/config/config.js";
import type { ProviderMessage, ProviderTool } from "../src/provider/types.js";
import { resolveExistingCredential } from "../src/auth/credentials.js";

await resolveExistingCredential({ cwd: process.cwd() }).catch(() => undefined);

const config = loadConfig(process.cwd());
const modelName = process.env.KULMI_MODEL ?? config.defaultModel;
const resolved: ResolvedModel = resolveModel(config, modelName);
const provider = new OpenAIProvider(resolved);

const tool: ProviderTool = {
  type: "function",
  function: {
    name: "echo_payload",
    description: "Return the supplied smoke-test value.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
};
const signal = AbortSignal.timeout(300_000);
const messages: ProviderMessage[] = [
  { role: "system", content: "You are a provider contract smoke test. Follow the tool instruction exactly." },
  { role: "user", content: "Call echo_payload exactly once with value KULMI_SMOKE_OK, then report its result." },
];
const first = await provider.complete({
  messages,
  tools: [tool],
  signal,
  cacheScope: "live_smoke",
  maxCompletionTokens: 1_024,
});
const call = first.message.tool_calls?.[0];
if (!call || call.function.name !== "echo_payload") {
  throw new Error(`provider did not produce the expected tool call: ${JSON.stringify(first.message)}`);
}
messages.push(first.message, {
  role: "tool",
  tool_call_id: call.id,
  name: call.function.name,
  content: "KULMI_SMOKE_OK",
});
const second = await provider.complete({
  messages,
  tools: [tool],
  signal,
  cacheScope: "live_smoke",
  maxCompletionTokens: 1_024,
});
if (!second.message.content?.includes("KULMI_SMOKE_OK")) {
  throw new Error(`provider did not consume the paired tool result: ${second.message.content ?? ""}`);
}
process.stdout.write(`${JSON.stringify({
  ok: true,
  model: resolved.model,
  firstUsage: first.usage,
  secondUsage: second.usage,
})}\n`);