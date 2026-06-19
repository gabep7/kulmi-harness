import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EventBus, EventEnvelope } from "../core/events.js";
import { createId } from "../core/ids.js";
import type { AgentStatus, RunState } from "../core/types.js";
import type { ProviderMessage } from "../provider/types.js";
import { redactKnownSecrets } from "../core/redact.js";
import type { WorkerJob } from "../agent/scheduler.js";

export interface SessionMetadata {
  id: string;
  cwd: string;
  model: string;
  modelProfile?: string;
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  prompt?: string;
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

    await mkdir(path, { recursive: true });
    const store = new SessionStore(path, metadata);
    await store.#writeMetadata();
    await store.saveMessages([]);
    return store;
  }

  static async open(id: string): Promise<{ store: SessionStore; session: LoadedSession }> {
    if (!/^session_[a-f0-9]{16}$/.test(id)) throw new Error(`invalid session ID ${id}`);
    const path = join(dataRoot(), "sessions", id);
    const metadata = JSON.parse(
      await readFile(join(path, "session.json"), "utf8"),
    ) as SessionMetadata;
    const messages = JSON.parse(
      await readFile(join(path, "messages.json"), "utf8"),
    ) as ProviderMessage[];
    let state: RunState | undefined;
    let workers: WorkerJob[] | undefined;
    try {
      const stored = JSON.parse(await readFile(join(path, "state.json"), "utf8")) as Omit<RunState, "modifiedFiles"> & { modifiedFiles: string[] };
      state = {
        ...stored,
        revision: stored.revision ?? 0,
        plan: stored.plan.map((step) => ({
          ...step,
          dependsOn: step.dependsOn ?? [],
          acceptanceCriteria: step.acceptanceCriteria ?? [],
        })),
        verifications: stored.verifications.map((verification) => ({
          ...verification,
          revision: verification.revision ?? -1,
          timedOut: verification.timedOut ?? false,
          truncated: verification.truncated ?? false,
        })),
        modifiedFiles: new Set(stored.modifiedFiles),
      };
    } catch {
      state = undefined;
    }
    try {
      workers = JSON.parse(await readFile(join(path, "workers.json"), "utf8")) as WorkerJob[];
    } catch {
      workers = undefined;
    }
    return {
      store: new SessionStore(path, metadata),
      session: {
        metadata,
        messages,
        ...(state ? { state } : {}),
        ...(workers ? { workers } : {}),
      },
    };
  }

  attach(bus: EventBus): void {
    this.#unsubscribe?.();
    this.#unsubscribe = bus.on((event) => this.appendEvent(event));
  }

  async appendEvent(event: EventEnvelope): Promise<void> {
    await this.#enqueue(() => appendFile(this.#eventsPath, `${JSON.stringify(event)}\n`, "utf8"));
  }

  async saveMessages(messages: ProviderMessage[]): Promise<void> {
    await this.#enqueue(() => writeJsonAtomic(this.#messagesPath, redactKnownSecrets(messages)));
  }

  async saveRunState(state: RunState): Promise<void> {
    await this.#enqueue(() => writeJsonAtomic(this.#statePath, redactKnownSecrets({
      ...state,
      modifiedFiles: [...state.modifiedFiles],
    })));
  }

  async saveWorkerJobs(workers: WorkerJob[]): Promise<void> {
    await this.#enqueue(() => writeJsonAtomic(this.#workersPath, redactKnownSecrets(workers)));
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

  async close(status: AgentStatus): Promise<void> {
    await this.setStatus(status);
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    await this.#writeQueue;
  }

  #writeMetadata(): Promise<void> {
    return this.#enqueue(() => writeJsonAtomic(this.#metadataPath, this.#metadata));
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#writeQueue.then(operation, operation);
    this.#writeQueue = next.catch(() => undefined);
    return next;
  }
}

export async function listSessions(limit = 20): Promise<SessionMetadata[]> {
  const root = join(dataRoot(), "sessions");
  if (!existsSync(root)) return [];
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { withFileTypes: true });
  const sessions: SessionMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      sessions.push(
        JSON.parse(await readFile(join(root, entry.name, "session.json"), "utf8")) as SessionMetadata,
      );
    } catch {
      continue;
    }
  }
  return sessions
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

export async function forkSession(id: string): Promise<SessionMetadata> {
  const { session } = await SessionStore.open(id);
  const store = await SessionStore.create({
    cwd: session.metadata.cwd,
    model: session.metadata.model,
    ...(session.metadata.modelProfile ? { modelProfile: session.metadata.modelProfile } : {}),
    ...(session.metadata.prompt ? { prompt: session.metadata.prompt } : {}),
  });
  await store.saveMessages(session.messages);
  if (session.state) {
    const { completion: _completion, ...state } = session.state;
    await store.saveRunState({
      ...state,
      status: "idle",
      agentId: createId("agent"),
    });
  }
  if (session.workers) await store.saveWorkerJobs(session.workers);
  await store.close("idle");
  return (await SessionStore.open(store.id)).session.metadata;
}

function dataRoot(): string {
  return process.env.XDG_DATA_HOME
    ? join(process.env.XDG_DATA_HOME, "kulmi")
    : join(homedir(), ".local", "share", "kulmi");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
