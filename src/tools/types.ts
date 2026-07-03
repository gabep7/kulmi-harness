import type { z } from "zod";
import type { EventBus } from "../core/events.js";
import type { AutonomyLevel, RunState } from "../core/types.js";
import type { CheckpointStore } from "../runtime/checkpoints.js";
import type { ArtifactStore } from "../runtime/artifacts.js";
import type { SandboxConfig } from "../config/config.js";

export interface ToolResult {
  content: string;
  isError?: boolean;
  diff?: string;
  mutated?: boolean;
}

export interface SubagentApi {
  spawn(input: {
    prompt: string;
    description?: string;
    mode: "explore" | "review" | "implement";
    background: boolean;
    parentAgentId: string;
    signal: AbortSignal;
  }): Promise<string>;
  wait(jobIds: string[], signal: AbortSignal): Promise<string>;
  inspect(jobId: string): string;
  integrate(jobId: string): Promise<string>;
  cancel(jobId: string): Promise<string>;
  retry(jobId: string, signal: AbortSignal): Promise<string>;
  steer(jobId: string, message: string): Promise<string>;
  pending(): string[];
}

export interface PermissionRequest {
  tool: string;
  risk: "low" | "medium" | "high";
  reason: string;
  command?: string;
  input: unknown;
}

export interface PermissionApi {
  request(input: PermissionRequest): Promise<boolean>;
}

export interface ToolContext {
  workspaceRoot: string;
  cwd: string;
  autonomy: AutonomyLevel;
  signal: AbortSignal;
  events: EventBus;
  state: RunState;
  checkpoint: CheckpointStore;
  artifacts: ArtifactStore;
  commandTimeoutMs: number;
  maxOutputBytes: number;
  sandbox?: SandboxConfig;
  subagents?: SubagentApi;
  permissions?: PermissionApi;
}

export interface Tool<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: TSchema;
  readOnly: boolean;
  isParallelSafe?: (input: z.output<TSchema>) => boolean;
  execute(context: ToolContext, input: z.output<TSchema>): Promise<ToolResult>;
}

export type AnyTool = Tool<any>;

export function defineTool<TSchema extends z.ZodType>(tool: Tool<TSchema>): Tool<TSchema> {
  return tool;
}
