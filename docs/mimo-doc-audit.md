# MiMo documentation audit

Audit date: 2026-06-18

This is the implementation ledger for the English MiMo documentation surface. The client-rendered navigation was enumerated from every top-level section. API, model, thinking, search, pricing, Token Plan, integration, FAQ, release, and deprecation pages were checked. Product news and legal pages were classified for runtime impact.

## Provider contract implemented

| Concern | MiMo contract | Kulmi implementation |
| --- | --- | --- |
| Primary model | `mimo-v2.5-pro`, 1M context, 131,072 default maximum completion tokens | Default model and full output allowance |
| Secondary model | `mimo-v2.5`, 1M context, 32,768 default maximum completion tokens | Secondary API and Token Plan profiles |
| API endpoint | `https://api.xiaomimimo.com/v1/chat/completions` | Direct fetch and SSE adapter |
| Authentication | `api-key` or Bearer; Kulmi uses `api-key` | `MIMO_API_KEY`, never forwarded to tools |
| Token Plan | Separate `tp-` key and cluster-specific URL | Separate key env, profile validation, AMS default; SGP and CN configurable |
| Thinking | `thinking: {"type":"enabled"}`; enabled by default on V2.5 | Explicitly enabled by default and independently configurable |
| Thinking sampling | Thinking mode forces temperature 1.0 and top_p 0.95 | Neither field is sent, keeping the request stable |
| Thinking output | Streaming `reasoning_content` precedes visible `content` | Separate typed reasoning events |
| Tool continuation | Complete reasoning must be returned on every assistant tool-call message or MiMo can return HTTP 400 | Stored immediately and replayed verbatim with the tool calls |
| Output budget | `max_completion_tokens` covers thinking plus visible output | Native field, model-specific limits |
| Cache accounting | `prompt_tokens_details.cached_tokens` | Normalized cached and fresh token counters |
| Prompt cache | Automatic prefix cache; cached prefix billed at cache-hit price; writes currently free | Stable system prompt, canonical tools and schemas, append-only history, safe compaction |
| Native search | `type:web_search`, `max_keyword`, `force_search`, `limit`, approximate location | Documented but intentionally not exposed because it is separately billable |
| Native search billing | Each keyword can be one plugin call; fetched pages add input tokens | Replaced by free-only SearXNG or keyless Bing RSS search plus `fetch_url` |
| Streaming completion | Usage can arrive in a final chunk with empty choices, then `[DONE]` | Usage-only chunks retained and `[DONE]` required |
| Rate limits | 100 RPM and 10M TPM for both V2.5 text models | Retry and jitter on 408, 409, 429, and 5xx, only before output escapes |
| Errors | 400 invalid/reasoning, 401 credential/profile mismatch, 402 balance, 421 filter, 429 limit/quota, 500/503 transient | Non-retryable and retryable classification with response detail |

## Cache design

MiMo does not document a cache creation endpoint or a cache key request field. Its public contract is automatic prefix matching plus `cached_tokens` telemetry. Kulmi therefore treats cache shape as a runtime invariant:

1. The system message is created once and never mutated during a session.
2. Tool definitions are sorted by name.
3. Tool JSON schemas are recursively key-sorted once.
4. Model history is append-only between compaction epochs.
5. Assistant tool calls, full reasoning, and tool results retain their original order.
6. Plans, worker progress, timestamps, usage, and UI state are not injected into the system prefix.
7. Compaction happens only when estimated context reaches 78 percent and only at a complete assistant/tool boundary.
8. Every request exposes cached, fresh, completion, and reasoning tokens to the CLI and JSON stream.

MiMo V2.5 Pro overseas prices observed on the audit date were $0.0036 per million cache-hit input tokens, $0.435 per million cache-miss input tokens, and $0.87 per million output tokens. This makes deterministic prefix reuse materially more important than small prompt reductions that rewrite earlier bytes.

## Search design

MiMo native web search is useful because citations and fetched context are integrated by the provider. It is expensive relative to a coding harness search tool. The overseas plugin price observed on the audit date was $5 per 1,000 calls, each concurrent keyword is separately counted, and fetched pages increase MiMo input tokens. MiMo also documents a five-minute propagation cache when its plugin is enabled or disabled in the console.

Kulmi exposes two modes:

| Mode | Behavior | Cost property |
| --- | --- | --- |
| `off` | No web search surface | No search charges |
| `off` | No search or page-fetch tools | No search cost |
| `free` | Self-hosted SearXNG when configured, otherwise keyless Bing RSS, plus protected page fetching | No search API key or paid search API |

Native search is OpenAI-protocol only according to the current guide. Kulmi still uses the OpenAI-compatible endpoint for model calls, but deliberately does not submit the native search tool.

## Token Plan

Token Plan keys and pay-as-you-go keys cannot be mixed. Token Plan is restricted to coding tools and is not intended for general custom application backends. Kulmi is a coding tool, and its native client connects to the same coding-agent runtime rather than exposing a general-purpose model proxy.

OpenAI-compatible Token Plan endpoints:

- Europe: `https://token-plan-ams.xiaomimimo.com/v1`
- Singapore: `https://token-plan-sgp.xiaomimimo.com/v1`
- China: `https://token-plan-cn.xiaomimimo.com/v1`

The selected model profile, not only the model ID, is persisted in every session. This prevents a Token Plan session from silently resuming against pay-as-you-go.

## Full English page inventory

### Quick start and usage

- [Welcome](https://mimo.mi.com/docs/en-US/quick-start/summary/welcome): product entry points and current notices.
- [First API Call](https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call): key, endpoint, request, and response setup.
- [Models](https://mimo.mi.com/docs/en-US/quick-start/summary/model): model IDs, modality, context, and output limits.
- [Web Search](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/tool-calling/web-search): native search schema, activation, billing, citations, and propagation behavior.
- [Deep Thinking](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/deep-thinking): thinking defaults, streaming, sampling, and mandatory reasoning replay.
- [Image Understanding](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/image-understanding): relevant only to `mimo-v2.5`; Pro remains text-focused in Kulmi.
- [Audio Understanding](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/audio-understanding): multimodal input reference, not currently exposed by coding tools.
- [Video Understanding](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/video-understanding): multimodal input and token calculation, not currently exposed.
- [Speech Recognition](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/audio/Speech-Recognition): ASR product, outside the coding harness model scope.
- [V2.5 Speech Synthesis](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/audio/speech-synthesis-v2.5): TTS product, outside the coding harness model scope.
- [Legacy Speech Synthesis](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/audio/speech-synthesis): legacy TTS and deprecation context.
- [Refer and earn](https://mimo.mi.com/docs/en-US/quick-start/promotions/refer): no runtime impact.
- [Account and Authentication FAQ](https://mimo.mi.com/docs/en-US/quick-start/faq/account): account and key ownership.
- [Payment FAQ](https://mimo.mi.com/docs/en-US/quick-start/faq/payment): no wire impact.
- [API Integration FAQ](https://mimo.mi.com/docs/en-US/quick-start/faq/api-integration): headers, timeouts, retries, search behavior, and local upload limits.
- [Token Plan FAQ](https://mimo.mi.com/docs/en-US/quick-start/faq/token-plan): credential separation and validity.
- [Promotions FAQ](https://mimo.mi.com/docs/en-US/quick-start/faq/promotions): no runtime impact.
- [Other FAQ](https://mimo.mi.com/docs/en-US/quick-start/faq/others): classified for product support only.
- [Service Agreement](https://mimo.mi.com/docs/en-US/quick-start/terms/user-agreement): legal classification.
- [Privacy Policy](https://mimo.mi.com/docs/en-US/quick-start/terms/privacy-policy): legal classification.

### API reference

- [Rate Limit](https://mimo.mi.com/docs/en-US/api/guidance/rate-limit): 100 RPM and 10M TPM for both supported text models.
- [Model Hyperparameters](https://mimo.mi.com/docs/en-US/api/guidance/model-hyperparameters): thinking-mode sampling behavior.
- [Error Codes](https://mimo.mi.com/docs/en-US/api/guidance/error-codes): retry classification and MiMo reasoning replay error.
- [OpenAI API](https://mimo.mi.com/docs/en-US/api/chat/openai-api): authoritative Kulmi wire contract.
- [Anthropic API](https://mimo.mi.com/docs/en-US/api/chat/anthropic-api): compatibility reference; Kulmi deliberately uses the richer MiMo OpenAI shape.
- [ASR OpenAI Compatibility](https://mimo.mi.com/docs/en-US/api/audio/Speech-Recognition): outside the coding harness model scope.

### Pricing

- [Pay-as-you-go](https://mimo.mi.com/docs/en-US/price/pay-as-you-go): model, cache, output, and web plugin pricing.
- [Token Plan pricing and restrictions](https://mimo.mi.com/docs/en-US/price/token-plan): credits, cache ratios, subscription behavior, and coding-only use restriction.

### Token Plan and coding-tool integrations

- [Subscription Instructions](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription): plans, supported models, credit ratios, and quota behavior.
- [Quick Access](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access): key formats and regional endpoints.
- [Tools Overview](https://mimo.mi.com/docs/en-US/tokenplan/integration/tools-overview): comparison of supported coding clients.
- [MiMo Code](https://mimo.mi.com/docs/en-US/tokenplan/integration/mimo-code): official client setup and product comparison.
- [OpenCode](https://mimo.mi.com/docs/en-US/tokenplan/integration/opencode): OpenAI-compatible Token Plan configuration.
- [Claude Code](https://mimo.mi.com/docs/en-US/tokenplan/integration/claudecode): Anthropic-compatible configuration reference.
- [OpenClaw](https://mimo.mi.com/docs/en-US/tokenplan/integration/openclaw): agent configuration and reasoning compatibility reference.
- [Hermes Agent](https://mimo.mi.com/docs/en-US/tokenplan/integration/hermes-agent): agent configuration reference.
- [Kilo Code](https://mimo.mi.com/docs/en-US/tokenplan/integration/kilocode): editor client reference.
- [Cherry Studio](https://mimo.mi.com/docs/en-US/tokenplan/integration/cherrystudio): desktop client reference.
- [Qwen Code](https://mimo.mi.com/docs/en-US/tokenplan/integration/qwencode): CLI client reference.
- [CodeBuddy](https://mimo.mi.com/docs/en-US/tokenplan/integration/codebuddy): editor client reference.
- [Cline](https://mimo.mi.com/docs/en-US/tokenplan/integration/cline): editor agent reference.

### Current news reviewed for technical impact

- [MiMo Claw release](https://mimo.mi.com/docs/en-US/news/latest/mimoclaw)
- [MiMo Code release](https://mimo.mi.com/docs/en-US/news/latest/mimocode)
- [1,000 tokens per second partnership](https://mimo.mi.com/docs/en-US/news/latest/1000tps)
- [V2.5 inference optimization](https://mimo.mi.com/docs/en-US/news/latest/updqate)
- [V2.5 Orbit partners](https://mimo.mi.com/docs/en-US/news/latest/v2.5-orbit)
- [V2.5 price update](https://mimo.mi.com/docs/en-US/news/latest/v2.5-price-update)
- [V2.5 open source release](https://mimo.mi.com/docs/en-US/news/latest/v2.5-open-sourced)
- [V2.5 TTS and ASR release](https://mimo.mi.com/docs/en-US/news/latest/v2.5-tts-release)
- [V2.5 public beta](https://mimo.mi.com/docs/en-US/news/latest/v2.5-news)
- [Hermes integration](https://mimo.mi.com/docs/en-US/news/latest/hermes-free)
- [Token Plan release](https://mimo.mi.com/docs/en-US/news/latest/token-plan-release)
- [Agent framework trial extension](https://mimo.mi.com/docs/en-US/news/latest/free-trial-extension)
- [Agent framework first-week offer](https://mimo.mi.com/docs/en-US/news/latest/first-week-free)
- [V2 Pro release](https://mimo.mi.com/docs/en-US/news/latest/v2-pro-release)
- [V2 Omni release](https://mimo.mi.com/docs/en-US/news/latest/v2-omni-release)
- [V2 TTS release](https://mimo.mi.com/docs/en-US/news/latest/v2-tts-release)
- [March 2026 Flash release](https://mimo.mi.com/docs/en-US/news/previous-news/news20260303)
- [February 2026 Flash release](https://mimo.mi.com/docs/en-US/news/previous-news/news20260212)
- [Billing launch](https://mimo.mi.com/docs/en-US/news/previous-news/billing)
- [Recharge launch](https://mimo.mi.com/docs/en-US/news/previous-news/recharge)
- [January 2026 Flash release](https://mimo.mi.com/docs/en-US/news/previous-news/news20260112)
- [Public beta extension](https://mimo.mi.com/docs/en-US/news/previous-news/beta-free)
- [December 2025 Flash release](https://mimo.mi.com/docs/en-US/news/previous-news/news20251216)

Legacy V2 and Flash announcements were checked only for migration and compatibility implications. Kulmi does not expose legacy model IDs.

### Changelog

- [Model releases](https://mimo.mi.com/docs/en-US/updates/model): current model availability.
- [Model deprecations](https://mimo.mi.com/docs/en-US/updates/deprecate): V2 removal on 2026-06-30; no legacy profiles are included.
- [Feature updates](https://mimo.mi.com/docs/en-US/updates/feature): checked for provider-field and search changes.

## Harness research applied

- Reasonix: stable, append-only provider prefixes; cache hit and miss telemetry; safe compaction boundaries; cache-sensitive contract tests.
- Pi: a frontend-neutral session object, event subscription, durable message trees, compaction, and explicit SDK boundary.
- Oh My Pi: separate CLI, print, and RPC modes; tool factories; search provider chains; durable agent sessions; richer task orchestration.
- OpenCode: headless server boundary and event-driven clients.
- Subagent implementations: bounded concurrency, isolated sessions, persisted jobs, explicit wait/inspect/cancel operations, and worktree isolation for writers.

Kulmi does not copy the broad multi-provider abstraction used by these projects. The MiMo adapter remains first-class so `thinking`, `reasoning_content`, cache details, citations, search errors, and web usage cannot be normalized away.

## Documentation ambiguities

- No public page specifies prompt-cache TTL, minimum prefix length, cache routing scope, or a manual cache key. Kulmi does not invent these controls.
- MiMo documents a five-minute cache for changing the web search plugin switch in the console. This is separate from prompt caching.
- Token Plan pages state that the displayed Base URL is authoritative. Built-in regional URLs match the current quick-access page, but config remains overrideable.
- One current pricing page and an earlier notice disagree on the exact legacy TTS forwarding date. Kulmi excludes legacy TTS, so this has no runtime effect.
