import type { AgentStatus, PlanStep, TokenUsage } from "./types.js";
import type { WebCitation } from "../provider/types.js";
import type { PermissionRequest } from "../tools/types.js";
import { redactKnownSecrets } from "./redact.js";

export type RuntimeEvent =
  | { type: "session.started"; sessionId: string; model: string; cwd: string }
  | { type: "session.finished"; sessionId: string; status: AgentStatus }
  | { type: "agent.started"; agentId: string; parentAgentId?: string; prompt: string }
  | { type: "agent.finished"; agentId: string; status: AgentStatus; result?: string }
  | { type: "assistant.reasoning.delta"; agentId: string; text: string }
  | { type: "assistant.text.delta"; agentId: string; text: string }
  | { type: "assistant.message"; agentId: string; text: string }
  | { type: "assistant.citations"; agentId: string; citations: WebCitation[] }
  | { type: "tool.started"; agentId: string; callId: string; tool: string; input: unknown }
  | { type: "permission.requested"; agentId: string; requestId: string; request: PermissionRequest }
  | { type: "permission.resolved"; agentId: string; requestId: string; approved: boolean }
  | {
      type: "tool.finished";
      agentId: string;
      callId: string;
      tool: string;
      output: string;
      isError: boolean;
      durationMs: number;
    }
  | { type: "plan.updated"; agentId: string; steps: PlanStep[] }
  | { type: "usage"; agentId: string; usage: TokenUsage }
  | { type: "notice"; agentId?: string; message: string }
  | { type: "error"; agentId?: string; message: string };

export interface EventEnvelope {
  sequence: number;
  timestamp: string;
  event: RuntimeEvent;
}

export type EventListener = (event: EventEnvelope) => void | Promise<void>;

export class EventBus {
  readonly #listeners = new Set<EventListener>();
  #sequence = 0;

  on(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async emit(event: RuntimeEvent): Promise<EventEnvelope> {
    const envelope: EventEnvelope = {
      sequence: ++this.#sequence,
      timestamp: new Date().toISOString(),
      event: redactKnownSecrets(event),
    };

    await Promise.all([...this.#listeners].map((listener) => listener(envelope)));
    return envelope;
  }
}
