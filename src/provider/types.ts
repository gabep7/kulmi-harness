import type { TokenUsage } from "../core/types.js";

export interface FunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ProviderMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
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
  maxCompletionTokens?: number;
  onReasoningDelta?: (text: string) => void | Promise<void>;
  onTextDelta?: (text: string) => void | Promise<void>;
  onToolCallStart?: (call: FunctionToolCall) => void | Promise<void>;
  onCitations?: (citations: WebCitation[]) => void | Promise<void>;
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
}
