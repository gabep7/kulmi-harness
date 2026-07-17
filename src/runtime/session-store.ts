import { mkdir, readFile, rename, writeFile, appendFile, unlink, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EventBus, EventEnvelope } from "../core/events.js";
import { createId } from "../core/ids.js";
import type { AgentStatus, RunState } from "../core/types.js";
import type { ProviderMessage } from "../provider/types.js";
import { redactKnownSecrets } from "../core/redact.js";
import type { WorkerJob } from "../agent/scheduler.js";
import {
  decodeMessages,
  decodeMetadata,
  decodeState,
  decodeWorkers,
  encodeMessages,
  encodeMetadata,
  encodeState,
  encodeWorkers,
} from "./session-schema.js";

export interface SessionMetadata {
  id: string;
  cwd: string;
  model: string;
  modelProfile?: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  prompt?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
  };
}

export interface LoadedSession {
  metadata: SessionMetadata;
  messages: ProviderMessage[];
  state?: RunState;
  workers?: WorkerJob[];
}

export class SessionStore {
  readonly id: string;
  readonly path: string;
  readonly #metadataPath: string;
  readonly #messagesPath: string;
  readonly #eventsPath: string;
  readonly #statePath: string;
  readonly #workersPath: string;
  #metadata: SessionMetadata;
  #writeQueue = Promise.resolve();
  #unsubscribe: (() => void) | undefined;

  private constructor(path: string, metadata: SessionMetadata) {
    this.id = metadata.id;
    this.path = path;
    this.#metadata = metadata;
    this.#metadataPath = join(path, "session.json");
    this.#messagesPath = join(path, "messages.json");
    this.#eventsPath = join(path, "events.jsonl");
    this.#statePath = join(path, "state.json");
    this.#workersPath = join(path, "workers.json");
  }

  static async create(options: {
    cwd: string;
    model: string;
    modelProfile?: string;
    prompt?: string;
    id?: string;
  }): Promise<SessionStore> {
    const id = options.id ?? createId("session");
    if (!/^session_[a-f0-9]{16}$/.test(id)) throw new Error(`invalid session ID ${id}`);
    const timestamp = new Date().toISOString();
    const path = join(dataRoot(), "sessions", id);
    const metadata: SessionMetadata = {
      id,
      cwd: options.cwd,
      model: options.model,
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (options.prompt) metadata.prompt = options.prompt;
    if (options.modelProfile) metadata.modelProfile = options.modelProfile;

    await mkdir(path, { recursive: true, mode: 0o700 });
    const store = new SessionStore(path, metadata);
    await store.#writeMetadata();
    await store.saveMessages([]);
    await pruneSessions({ keepIds: [id] }).catch(() => undefined);
    return store;
  }

  static async open(id: string): Promise<{ store: SessionStore; session: LoadedSession }> {
    if (!/^session_[a-f0-9]{16}$/.test(id)) throw new Error(`invalid session ID ${id}`);
    const path = join(dataRoot(), "sessions", id);
    const decodedMetadata = decodeFile(
      await readRequiredJson(join(path, "session.json"), "session metadata"),
      "session metadata",
      decodeMetadata,
    );
    if (decodedMetadata.value.id !== id) {
      throw new Error(`invalid session metadata: expected ID ${id}, found ${decodedMetadata.value.id}`);
    }
    const decodedMessages = decodeFile(
      await readRequiredJson(join(path, "messages.json"), "session messages"),
      "session messages",
      decodeMessages,
    );
    const rawState = await readOptionalJson(join(path, "state.json"), "run state");
    const rawWorkers = await readOptionalJson(join(path, "workers.json"), "worker state");
    const decodedState = rawState === undefined ? undefined : decodeFile(rawState, "run state", decodeState);
    const decodedWorkers = rawWorkers === undefined ? undefined : decodeFile(rawWorkers, "worker state", decodeWorkers);
    const store = new SessionStore(path, decodedMetadata.value);
    if (decodedMetadata.migrated) await store.#writeMetadata();
    if (decodedMessages.migrated) await store.saveMessages(decodedMessages.value);
    if (decodedState?.migrated) await store.saveRunState(decodedState.value);
    if (decodedWorkers?.migrated) await store.saveWorkerJobs(decodedWorkers.value);
    return {
      store,
      session: {
        metadata: decodedMetadata.value,
        messages: decodedMessages.value,
        ...(decodedState ? { state: decodedState.value } : {}),
        ...(decodedWorkers ? { workers: decodedWorkers.value } : {}),
      },
    };
  }

  attach(bus: EventBus): void {
    this.#unsubscribe?.();
    this.#unsubscribe = bus.on((event) => {
      if (
        event.event.type === "assistant.reasoning.delta" ||
        event.event.type === "assistant.text.delta"
      ) return;
      return this.appendEvent(event);
    }, { critical: true });
  }

  async appendEvent(event: EventEnvelope): Promise<void> {
    await this.#enqueue(() => appendFile(this.#eventsPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    }));
  }

  async saveMessages(messages: ProviderMessage[]): Promise<void> {
    await this.#enqueue(() => writeJsonAtomic(this.#messagesPath, redactKnownSecrets(encodeMessages(messages))));
  }

  async saveRunState(state: RunState): Promise<void> {
    await this.#enqueue(() => writeJsonAtomic(this.#statePath, redactKnownSecrets(encodeState(state))));
  }

  async saveWorkerJobs(workers: WorkerJob[]): Promise<void> {
    await this.#enqueue(() => writeJsonAtomic(this.#workersPath, redactKnownSecrets(encodeWorkers(workers))));
  }

  async archiveMessages(messages: ProviderMessage[], reason: string): Promise<string> {
    const name = `${Date.now()}-${reason.replace(/[^a-z0-9_-]/gi, "_")}.json`;
    const path = join(this.path, "archives", name);
    await this.#enqueue(() => writeJsonAtomic(path, redactKnownSecrets(messages)));
    return path;
  }

  async setStatus(status: AgentStatus): Promise<void> {
    this.#metadata = {
      ...this.#metadata,
      status,
      updatedAt: new Date().toISOString(),
    };
    await this.#writeMetadata();
  }

  async setModel(model: string, modelProfile: string): Promise<void> {
    this.#metadata = {
      ...this.#metadata,
      model,
      modelProfile,
      updatedAt: new Date().toISOString(),
    };
    await this.#writeMetadata();
  }

  async addUsage(tokens: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
  }): Promise<void> {
    const prev = this.#metadata.usage;
    this.#metadata = {
      ...this.#metadata,
      usage: {
        promptTokens: (prev?.promptTokens ?? 0) + tokens.promptTokens,
        completionTokens: (prev?.completionTokens ?? 0) + tokens.completionTokens,
        totalTokens: (prev?.totalTokens ?? 0) + tokens.totalTokens,
        cacheHitTokens: (prev?.cacheHitTokens ?? 0) + tokens.cacheHitTokens,
        cacheMissTokens: (prev?.cacheMissTokens ?? 0) + tokens.cacheMissTokens,
      },
      updatedAt: new Date().toISOString(),
    };
    await this.#writeMetadata();
  }

  async close(status: AgentStatus): Promise<void> {
    await this.setStatus(status);
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    await this.#writeQueue;
  }

  #writeMetadata(): Promise<void> {
    return this.#enqueue(() => writeJsonAtomic(this.#metadataPath, encodeMetadata(this.#metadata)));
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#writeQueue.then(operation, operation);
    this.#writeQueue = next.catch(() => undefined);
    return next;
  }
}

export const DEFAULT_SESSION_MAX_COUNT = 100;
export const DEFAULT_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export async function listSessions(limit = 20): Promise<SessionMetadata[]> {
  await pruneSessions().catch(() => undefined);
  const sessions = await loadAllSessionMetadata();
  return sessions
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

export async function pruneSessions(options: {
  maxCount?: number;
  maxAgeMs?: number;
  keepIds?: Iterable<string>;
  now?: number;
} = {}): Promise<string[]> {
  const maxCount = options.maxCount ?? DEFAULT_SESSION_MAX_COUNT;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_SESSION_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  const keep = new Set(options.keepIds ?? []);
  const sessions = await loadAllSessionMetadata();
  sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const removed: string[] = [];
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index]!;
    if (keep.has(session.id)) continue;
    const ageMs = now - Date.parse(session.updatedAt);
    const tooOld = Number.isFinite(ageMs) && ageMs > maxAgeMs;
    const overCount = index >= maxCount;
    if (!tooOld && !overCount) continue;
    await rm(join(dataRoot(), "sessions", session.id), { recursive: true, force: true });
    removed.push(session.id);
  }
  return removed;
}

export async function forkSession(id: string): Promise<SessionMetadata> {
  const { session } = await SessionStore.open(id);
  const store = await SessionStore.create({
    cwd: session.metadata.cwd,
    model: session.metadata.model,
    ...(session.metadata.modelProfile ? { modelProfile: session.metadata.modelProfile } : {}),
    ...(session.metadata.prompt ? { prompt: session.metadata.prompt } : {}),
  });
  const messages = [...session.messages];
  if (session.workers?.length) {
    messages.push({
      role: "user",
      content: "<fork-context>Child-agent jobs and worktrees belong to the source session and were not inherited.</fork-context>",
    });
  }
  await store.saveMessages(messages);
  if (session.state) {
    const { completion: _completion, ...state } = session.state;
    await store.saveRunState({
      ...state,
      status: "idle",
      agentId: createId("agent"),
    });
  }
  await store.close("idle");
  return (await SessionStore.open(store.id)).session.metadata;
}

async function loadAllSessionMetadata(): Promise<SessionMetadata[]> {
  const root = join(dataRoot(), "sessions");
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const sessions: SessionMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      sessions.push(
        decodeMetadata(JSON.parse(await readFile(join(root, entry.name, "session.json"), "utf8"))).value,
      );
    } catch {
      continue;
    }
  }
  return sessions;
}

function dataRoot(): string {
  return process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, "kulmi")
    : join(homedir(), ".local", "share", "kulmi");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function readRequiredJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readOptionalJson(path: string, label: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function decodeFile<T>(
  raw: unknown,
  label: string,
  decode: (value: unknown) => { value: T; migrated: boolean },
): { value: T; migrated: boolean } {
  try {
    return decode(raw);
  } catch (error) {
    throw new Error(`invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
