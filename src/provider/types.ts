import type { TokenUsage } from "../core/types.js";
export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "quota"
  | "context_length"
  | "invalid_request"
  | "overloaded"
  | "server"
  | "transport";

export interface ProviderErrorOptions {
  kind: ProviderErrorKind;
  status?: number;
  providerErrorType?: string;
  retryable: boolean;
  retryAfterMs?: number;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  readonly providerErrorType: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly cause: unknown;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message);
    this.name = "ProviderError";
    this.kind = options.kind;
    this.status = options.status;
    this.providerErrorType = options.providerErrorType;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.cause = options.cause;
  }
}

export interface ProviderRetryNotice {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: ProviderError;
}


export interface FunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ProviderContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "image_attachment"; attachment_id: string; mime_type: string; path: string };

export type ProviderMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ProviderContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: FunctionToolCall[];
    }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

export interface ProviderTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface WebCitation {
  url: string;
  title: string;
  summary?: string;
  siteName?: string;
  publishedAt?: string;
  logoUrl?: string;
}

export interface ProviderRequest {
  messages: ProviderMessage[];
  tools: ProviderTool[];
  signal: AbortSignal;
  cacheScope?: string;
  thinking?: boolean;
  reasoningEffort?: string;
  maxCompletionTokens?: number;
  onReasoningDelta?: (text: string) => void | Promise<void>;
  onTextDelta?: (text: string) => void | Promise<void>;
  onToolCallStart?: (call: FunctionToolCall) => void | Promise<void>;
  onCitations?: (citations: WebCitation[]) => void | Promise<void>;
  onRetry?: (notice: ProviderRetryNotice) => void | Promise<void>;
}

export interface ProviderResponse {
  message: Extract<ProviderMessage, { role: "assistant" }>;
  finishReason: string | null;
  usage: TokenUsage;
  citations?: WebCitation[];
  searchError?: string;
}

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  invalidateCacheScopes?(prefix: string): void;
  resetCacheScope?(scope: string): void;
}
