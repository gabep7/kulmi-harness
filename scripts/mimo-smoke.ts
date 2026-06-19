import { MiMoProvider } from "../src/provider/mimo.js";
import type { ResolvedModel } from "../src/config/config.js";
import type { ProviderMessage, ProviderTool } from "../src/provider/types.js";
import { resolveExistingCredential } from "../src/auth/credentials.js";

// Hydrate the key from the macOS Keychain when no env var is set, matching how
// `kulmi exec` resolves credentials, so the live smoke runs without exporting a key.
await resolveExistingCredential({ cwd: process.cwd() }).catch(() => undefined);

const tokenPlanKey = process.env.MIMO_TOKEN_PLAN_API_KEY;
const apiKey = tokenPlanKey ?? process.env.MIMO_API_KEY;
if (!apiKey) throw new Error("set MIMO_API_KEY or MIMO_TOKEN_PLAN_API_KEY, or store one with `kulmi auth`");

const modelId = process.env.MIMO_MODEL === "mimo-v2.5" ? "mimo-v2.5" : "mimo-v2.5-pro";
const config: ResolvedModel = {
  name: tokenPlanKey ? `${modelId}-token-plan` : modelId,
  model: modelId,
  billing: tokenPlanKey ? "token-plan" : "pay-as-you-go",
  baseUrl: tokenPlanKey
    ? process.env.MIMO_TOKEN_PLAN_BASE_URL ?? "https://token-plan-ams.xiaomimimo.com/v1"
    : "https://api.xiaomimimo.com/v1",
  apiKeyEnv: tokenPlanKey ? "MIMO_TOKEN_PLAN_API_KEY" : "MIMO_API_KEY",
  apiKey,
  thinking: true,
  contextWindow: 1_000_000,
  maxOutputTokens: modelId === "mimo-v2.5-pro" ? 131_072 : 32_768,
};
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
const provider = new MiMoProvider(config);
const signal = AbortSignal.timeout(300_000);
const messages: ProviderMessage[] = [
  { role: "system", content: "You are a provider contract smoke test. Follow the tool instruction exactly." },
  { role: "user", content: "Call echo_payload exactly once with value KULMI_MIMO_OK, then report its result." },
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
  throw new Error(`MiMo did not produce the expected tool call: ${JSON.stringify(first.message)}`);
}
if (!("reasoning_content" in first.message)) {
  throw new Error("MiMo thinking tool call did not retain reasoning_content");
}
messages.push(first.message, {
  role: "tool",
  tool_call_id: call.id,
  name: call.function.name,
  content: "KULMI_MIMO_OK",
});
const second = await provider.complete({
  messages,
  tools: [tool],
  signal,
  cacheScope: "live_smoke",
  maxCompletionTokens: 1_024,
});
if (!second.message.content?.includes("KULMI_MIMO_OK")) {
  throw new Error(`MiMo did not consume the paired tool result: ${second.message.content ?? ""}`);
}
process.stdout.write(`${JSON.stringify({
  ok: true,
  model: config.model,
  billing: config.billing,
  firstUsage: first.usage,
  secondUsage: second.usage,
})}\n`);
