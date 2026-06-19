import { z } from "zod";
import type { WorkerJob } from "../agent/scheduler.js";
import type { RunState } from "../core/types.js";
import type { ProviderMessage } from "../provider/types.js";
import type { SessionMetadata } from "./session-store.js";

export const SESSION_SCHEMA_VERSION = 1;

const agentStatusSchema = z.enum(["idle", "running", "completed", "blocked", "failed", "cancelled"]);
const agentModeSchema = z.enum(["chat", "task", "subagent"]);
const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string(),
  }).strict(),
}).strict();

const providerMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }).strict(),
  z.object({ role: z.literal("user"), content: z.string() }).strict(),
  z.object({
    role: z.literal("assistant"),
    content: z.string().nullable(),
    reasoning_content: z.string().optional(),
    tool_calls: z.array(toolCallSchema).optional(),
  }).strict(),
  z.object({
    role: z.literal("tool"),
    content: z.string(),
    tool_call_id: z.string().min(1),
    name: z.string().optional(),
  }).strict(),
]);

const metadataSchema = z.object({
  id: z.string().regex(/^session_[a-f0-9]{16}$/),
  cwd: z.string().min(1),
  model: z.string().min(1),
  modelProfile: z.string().min(1).optional(),
  status: agentStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  prompt: z.string().optional(),
}).strict();

const planStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
  evidence: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  owner: z.string().optional(),
}).strict();

const verificationSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
  timestamp: z.string().min(1),
  revision: z.number().int().default(-1),
  timedOut: z.boolean().default(false),
  truncated: z.boolean().default(false),
  changedFiles: z.array(z.string()).default([]),
}).strict();

const completionSchema = z.object({
  status: z.enum(["completed", "blocked"]),
  summary: z.string(),
  evidence: z.array(z.string()),
}).strict();

const storedStateSchema = z.object({
  agentId: z.string().min(1),
  parentAgentId: z.string().min(1).optional(),
  mode: agentModeSchema,
  status: agentStatusSchema,
  plan: z.array(planStepSchema).default([]),
  modifiedFiles: z.array(z.string()).default([]),
  verifications: z.array(verificationSchema).default([]),
  revision: z.number().int().nonnegative().default(0),
  completion: completionSchema.optional(),
}).strict();

const workerSchema = z.object({
  id: z.string().min(1),
  parentAgentId: z.string().min(1),
  description: z.string(),
  prompt: z.string(),
  mode: z.enum(["explore", "review", "implement"]),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  result: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string().min(1),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  collectedAt: z.string().optional(),
  integratedFiles: z.array(z.string()).optional(),
  integratedAt: z.string().optional(),
  childSessionId: z.string().optional(),
  worktree: z.object({
    id: z.string().min(1),
    path: z.string().min(1),
    branch: z.string().min(1),
    baseCommit: z.string(),
  }).strict().optional(),
  steering: z.array(z.object({ message: z.string(), sentAt: z.string() }).strict()).optional(),
}).strict();

const currentMetadataSchema = metadataSchema.extend({ schemaVersion: z.literal(SESSION_SCHEMA_VERSION) }).strict();
const currentMessagesSchema = z.object({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  messages: z.array(providerMessageSchema),
}).strict();
const currentStateSchema = z.object({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  state: storedStateSchema,
}).strict();
const currentWorkersSchema = z.object({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  workers: z.array(workerSchema),
}).strict();

export interface Decoded<T> {
  value: T;
  migrated: boolean;
}

export function decodeMetadata(raw: unknown): Decoded<SessionMetadata> {
  if (hasCurrentVersion(raw)) {
    const { schemaVersion: _schemaVersion, ...metadata } = currentMetadataSchema.parse(raw);
    return { value: metadata as SessionMetadata, migrated: false };
  }
  return { value: metadataSchema.parse(raw) as SessionMetadata, migrated: true };
}

export function encodeMetadata(metadata: SessionMetadata): unknown {
  return { schemaVersion: SESSION_SCHEMA_VERSION, ...metadata };
}

export function decodeMessages(raw: unknown): Decoded<ProviderMessage[]> {
  if (hasCurrentVersion(raw)) {
    return { value: currentMessagesSchema.parse(raw).messages as ProviderMessage[], migrated: false };
  }
  return { value: z.array(providerMessageSchema).parse(raw) as ProviderMessage[], migrated: true };
}

export function encodeMessages(messages: ProviderMessage[]): unknown {
  return { schemaVersion: SESSION_SCHEMA_VERSION, messages };
}

export function decodeState(raw: unknown): Decoded<RunState> {
  const decoded = hasCurrentVersion(raw)
    ? { value: currentStateSchema.parse(raw).state, migrated: false }
    : { value: storedStateSchema.parse(raw), migrated: true };
  return {
    migrated: decoded.migrated,
    value: {
      ...decoded.value,
      modifiedFiles: new Set(decoded.value.modifiedFiles),
    } as RunState,
  };
}

export function encodeState(state: RunState): unknown {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    state: {
      ...state,
      modifiedFiles: [...state.modifiedFiles],
    },
  };
}

export function decodeWorkers(raw: unknown): Decoded<WorkerJob[]> {
  if (hasCurrentVersion(raw)) {
    return { value: currentWorkersSchema.parse(raw).workers as WorkerJob[], migrated: false };
  }
  return { value: z.array(workerSchema).parse(raw) as WorkerJob[], migrated: true };
}

export function encodeWorkers(workers: WorkerJob[]): unknown {
  return { schemaVersion: SESSION_SCHEMA_VERSION, workers };
}

function hasCurrentVersion(raw: unknown): boolean {
  return Boolean(raw && typeof raw === "object" && "schemaVersion" in raw);
}
