export type AutonomyLevel = "read" | "low" | "medium" | "high";

export type AgentMode = "chat" | "task" | "subagent";

export type AgentStatus =
  | "idle"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
  evidence?: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  owner?: string;
}

export interface VerificationRecord {
  command: string;
  exitCode: number;
  timestamp: string;
  revision: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface CompletionRecord {
  status: "completed" | "blocked";
  summary: string;
  evidence: string[];
}

export interface RunState {
  agentId: string;
  parentAgentId?: string;
  mode: AgentMode;
  status: AgentStatus;
  plan: PlanStep[];
  modifiedFiles: Set<string>;
  verifications: VerificationRecord[];
  revision: number;
  completion?: CompletionRecord;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens?: number;
}

export type OutputFormat = "text" | "json" | "stream-json";
