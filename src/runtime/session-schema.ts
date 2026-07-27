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

const providerContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({ url: z.string().min(1) }).strict(),
  }).strict(),
  z.object({
    type: z.literal("image_attachment"),
    attachment_id: z.string().regex(/^attachment_[a-f0-9]{16}$/),
    mime_type: z.string().min(1),
    path: z.string().min(1),
  }).strict(),
]);

const providerMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }).strict(),
  z.object({ role: z.literal("user"), content: z.union([z.string(), z.array(providerContentPartSchema).min(1)]) }).strict(),
  z.object({
    role: z.literal("assistant"),
    content: z.string().nullable(),
    reasoning_content: z.string().optional(),
    reasoning_signature: z.string().optional(),
    thinking_blocks: z.array(z.discriminatedUnion("type", [
      z.object({
        type: z.literal("thinking"),
        thinking: z.string(),
        signature: z.string(),
      }).strict(),
      z.object({
        type: z.literal("redacted_thinking"),
        data: z.string(),
      }).strict(),
    ])).optional(),
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
  usage: z.object({
    promptTokens: z.number().int().nonnegative().default(0),
    completionTokens: z.number().int().nonnegative().default(0),
    totalTokens: z.number().int().nonnegative().default(0),
    cacheHitTokens: z.number().int().nonnegative().default(0),
    cacheMissTokens: z.number().int().nonnegative().default(0),
  }).strict().optional(),
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
  resultArtifactId: z.string().optional(),
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
    parentHead: z.string().optional(),
    parentUnborn: z.boolean().optional(),
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

export class NewerSessionVersionError extends Error {
  readonly version: number;
  readonly supportedVersion = SESSION_SCHEMA_VERSION;

  constructor(readonly fileKind: string, version: number) {
    super(`${fileKind} uses schema version ${version}, but this Kulmi build supports up to version ${SESSION_SCHEMA_VERSION}`);
    this.name = "NewerSessionVersionError";
    this.version = version;
  }
}

type SessionFileKind = "session metadata" | "session messages" | "run state" | "worker state";
type SessionMigration = (raw: unknown) => unknown;

const migrations: Record<SessionFileKind, SessionMigration[]> = {
  "session metadata": [migrateVersionZeroMetadata],
  "session messages": [migrateVersionZeroMessages],
  "run state": [migrateVersionZeroState],
  "worker state": [migrateVersionZeroWorkers],
};

export function decodeMetadata(raw: unknown): Decoded<SessionMetadata> {
  const decoded = migrateToCurrent(raw, "session metadata");
  const { schemaVersion: _schemaVersion, ...metadata } = currentMetadataSchema.parse(decoded.raw);
  return { value: metadata as SessionMetadata, migrated: decoded.migrated };
}

export function encodeMetadata(metadata: SessionMetadata): unknown {
  return { schemaVersion: SESSION_SCHEMA_VERSION, ...metadata };
}

export function decodeMessages(raw: unknown): Decoded<ProviderMessage[]> {
  const decoded = migrateToCurrent(raw, "session messages");
  return { value: currentMessagesSchema.parse(decoded.raw).messages as ProviderMessage[], migrated: decoded.migrated };
}

export function encodeMessages(messages: ProviderMessage[]): unknown {
  return { schemaVersion: SESSION_SCHEMA_VERSION, messages };
}

export function decodeState(raw: unknown): Decoded<RunState> {
  const decoded = migrateToCurrent(raw, "run state");
  const state = currentStateSchema.parse(decoded.raw).state;
  return {
    migrated: decoded.migrated,
    value: {
      ...state,
      modifiedFiles: new Set(state.modifiedFiles),
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
  const decoded = migrateToCurrent(raw, "worker state");
  return { value: currentWorkersSchema.parse(decoded.raw).workers as WorkerJob[], migrated: decoded.migrated };
}

export function encodeWorkers(workers: WorkerJob[]): unknown {
  return { schemaVersion: SESSION_SCHEMA_VERSION, workers };
}

function migrateToCurrent(raw: unknown, kind: SessionFileKind): { raw: unknown; migrated: boolean } {
  const version = readSchemaVersion(raw);
  if (version === undefined) {
    const migration = migrations[kind][0];
    if (!migration) throw new Error(`no migration exists for unversioned ${kind}`);
    return { raw: migration(raw), migrated: true };
  }
  if (version > SESSION_SCHEMA_VERSION) throw new NewerSessionVersionError(kind, version);
  let value = raw;
  for (let from = version; from < SESSION_SCHEMA_VERSION; from += 1) {
    const migration = migrations[kind][from];
    if (!migration) throw new Error(`no migration exists for ${kind} schema version ${from}`);
    value = migration(value);
  }
  return { raw: value, migrated: version !== SESSION_SCHEMA_VERSION };
}

function readSchemaVersion(raw: unknown): number | undefined {
  if (!isRecord(raw) || !("schemaVersion" in raw)) return undefined;
  const version = raw.schemaVersion;
  if (!Number.isInteger(version) || (version as number) < 0) {
    throw new Error("schemaVersion must be a non-negative integer");
  }
  return version as number;
}

function migrateVersionZeroMetadata(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const { schemaVersion: _schemaVersion, ...metadata } = raw;
  return { schemaVersion: SESSION_SCHEMA_VERSION, ...metadata };
}

function migrateVersionZeroMessages(raw: unknown): unknown {
  if (Array.isArray(raw)) return { schemaVersion: SESSION_SCHEMA_VERSION, messages: raw };
  if (!isRecord(raw)) return raw;
  return { schemaVersion: SESSION_SCHEMA_VERSION, messages: raw.messages };
}

function migrateVersionZeroState(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if ("state" in raw) return { schemaVersion: SESSION_SCHEMA_VERSION, state: raw.state };
  const { schemaVersion: _schemaVersion, ...state } = raw;
  return { schemaVersion: SESSION_SCHEMA_VERSION, state };
}

function migrateVersionZeroWorkers(raw: unknown): unknown {
  if (Array.isArray(raw)) return { schemaVersion: SESSION_SCHEMA_VERSION, workers: raw };
  if (!isRecord(raw)) return raw;
  return { schemaVersion: SESSION_SCHEMA_VERSION, workers: raw.workers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

