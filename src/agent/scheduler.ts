import type { SubagentApi } from "../tools/types.js";
import { createId } from "../core/ids.js";

export type WorkerMode = "explore" | "review" | "implement";

export interface WorkerJob {
  id: string;
  parentAgentId: string;
  description: string;
  prompt: string;
  mode: WorkerMode;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  result?: string;
  resultArtifactId?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  collectedAt?: string;
  integratedFiles?: string[];
  integratedAt?: string;
  childSessionId?: string;
  worktree?: {
    id: string;
    path: string;
    branch: string;
    baseCommit: string;
  };
  steering?: Array<{ message: string; sentAt: string }>;
}

type WorkerRunner = (job: WorkerJob, signal: AbortSignal) => Promise<string>;
type WorkerIntegrator = (job: WorkerJob) => Promise<string[]>;
type WorkerSteerer = (job: WorkerJob, message: string) => void;
type WorkerResultMaterializer = (job: WorkerJob, result: string) => Promise<{ content: string; artifactId?: string }>;

export class SubagentScheduler implements SubagentApi {
  readonly #jobs = new Map<string, WorkerJob>();
  readonly #promises = new Map<string, Promise<string>>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #semaphore: Semaphore;
  readonly #runWorker: WorkerRunner;
  readonly #integrateWorker: WorkerIntegrator | undefined;
  readonly #onChange: ((jobs: WorkerJob[]) => Promise<void>) | undefined;
  readonly #steerWorker: WorkerSteerer | undefined;
  readonly #materializeResult: WorkerResultMaterializer | undefined;

  constructor(
    maxConcurrency: number,
    runWorker: WorkerRunner,
    integrateWorker?: WorkerIntegrator,
    onChange?: (jobs: WorkerJob[]) => Promise<void>,
    initialJobs: WorkerJob[] = [],
    steerWorker?: WorkerSteerer,
    materializeResult?: WorkerResultMaterializer,
  ) {
    this.#semaphore = new Semaphore(maxConcurrency);
    this.#runWorker = runWorker;
    this.#integrateWorker = integrateWorker;
    this.#onChange = onChange;
    this.#steerWorker = steerWorker;
    this.#materializeResult = materializeResult;
    for (const restored of initialJobs) {
      const job = structuredClone(restored);
      if (job.status === "queued" || job.status === "running") {
        job.status = "failed";
        job.error = "worker outcome is uncertain after session interruption";
        job.finishedAt = new Date().toISOString();
      }
      this.#jobs.set(job.id, job);
    }
  }

  async spawn(input: {
    prompt: string;
    description?: string;
    mode: WorkerMode;
    background: boolean;
    parentAgentId: string;
    signal: AbortSignal;
  }): Promise<string> {
    const id = createId("worker");
    const job: WorkerJob = {
      id,
      parentAgentId: input.parentAgentId,
      description: input.description ?? input.prompt.slice(0, 80),
      prompt: input.prompt,
      mode: input.mode,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    const controller = new AbortController();
    const relayAbort = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", relayAbort, { once: true });
    this.#jobs.set(id, job);
    this.#controllers.set(id, controller);
    await this.persist();

    const promise = this.#execute(job, controller.signal).finally(() => {
      input.signal.removeEventListener("abort", relayAbort);
    });
    this.#promises.set(id, promise);

    if (input.background) {
      void promise.catch(() => undefined);
      return JSON.stringify({ job_id: id, status: "queued", description: job.description });
    }
    const result = await promise;
    job.collectedAt = new Date().toISOString();
    await this.persist();
    return result;
  }

  async wait(jobIds: string[], signal: AbortSignal): Promise<string> {
    const ids = jobIds.length > 0 ? jobIds : [...this.#jobs.keys()];
    const jobs = ids.map((id) => {
      const promise = this.#promises.get(id);
      const existing = this.#jobs.get(id);
      if (!existing) throw new Error(`unknown worker ${id}`);
      const settled = promise ? abortable(promise.catch(() => ""), signal) : Promise.resolve("");
      return settled.then(async () => {
        const job = this.#jobs.get(id);
        if (job) job.collectedAt = new Date().toISOString();
        await this.persist();
        return job;
      });
    });
    const results = await Promise.all(jobs);
    return JSON.stringify(results, null, 2);
  }

  inspect(jobId: string): string {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`unknown worker ${jobId}`);
    return JSON.stringify(job, null, 2);
  }

  async integrate(jobId: string): Promise<string> {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`unknown worker ${jobId}`);
    if (job.mode !== "implement") throw new Error(`worker ${jobId} is read-only and has nothing to integrate`);
    if (job.status !== "completed") throw new Error(`worker ${jobId} is ${job.status}, not completed`);
    if (job.integratedAt) return this.inspect(jobId);
    if (!this.#integrateWorker) throw new Error("worker integration is unavailable");
    job.integratedFiles = await this.#integrateWorker(job);
    job.integratedAt = new Date().toISOString();
    job.collectedAt ??= new Date().toISOString();
    await this.persist();
    return this.inspect(jobId);
  }

  async cancel(jobId: string): Promise<string> {
    const job = this.#jobs.get(jobId);
    const controller = this.#controllers.get(jobId);
    if (!job) throw new Error(`unknown worker ${jobId}`);
    if (!controller) return this.inspect(jobId);
    controller.abort(new Error(`worker ${jobId} cancelled`));
    try {
      await this.#promises.get(jobId);
    } catch {
      // State is recorded by #execute.
    }
    job.collectedAt ??= new Date().toISOString();
    await this.persist();
    return this.inspect(jobId);
  }

  async retry(jobId: string, signal: AbortSignal): Promise<string> {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`unknown worker ${jobId}`);
    if (job.status !== "failed" && job.status !== "cancelled") {
      throw new Error(`worker ${jobId} is ${job.status}; only failed or cancelled workers can be retried`);
    }
    job.collectedAt ??= new Date().toISOString();
    await this.persist();
    return this.spawn({
      prompt: job.prompt,
      description: `retry: ${job.description}`.slice(0, 120),
      mode: job.mode,
      background: true,
      parentAgentId: job.parentAgentId,
      signal,
    });
  }

  async reclaimJobWorktree(
    jobId: string,
    dispose: (job: WorkerJob, worktree: NonNullable<WorkerJob["worktree"]>) => Promise<void>,
  ): Promise<void> {
    const job = this.#jobs.get(jobId);
    if (!job?.worktree) return;
    const worktree = job.worktree;
    delete job.worktree;
    await dispose(job, worktree);
    await this.persist();
  }

  async reclaimTerminalWorktrees(
    dispose: (job: WorkerJob, worktree: NonNullable<WorkerJob["worktree"]>) => Promise<void>,
  ): Promise<void> {
    let changed = false;
    for (const job of this.#jobs.values()) {
      if (!job.worktree) continue;
      if (job.status === "queued" || job.status === "running") continue;
      if (job.mode === "implement" && job.status === "completed" && !job.integratedAt) continue;
      const worktree = job.worktree;
      delete job.worktree;
      changed = true;
      await dispose(job, worktree);
    }
    if (changed) await this.persist();
  }

  async steer(jobId: string, message: string): Promise<string> {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`unknown worker ${jobId}`);
    if (job.status !== "running") throw new Error(`worker ${jobId} is ${job.status}, not running`);
    if (!this.#steerWorker) throw new Error("worker steering is unavailable");
    const value = message.trim();
    if (!value) throw new Error("steering message cannot be empty");
    this.#steerWorker(job, value);
    (job.steering ??= []).push({ message: value, sentAt: new Date().toISOString() });
    await this.persist();
    return this.inspect(jobId);
  }

  pending(): string[] {
    return [...this.#jobs.values()]
      .filter((job) =>
        job.status === "queued" ||
        job.status === "running" ||
        (job.status === "completed" && !job.collectedAt) ||
        ((job.status === "failed" || job.status === "cancelled") && !job.collectedAt) ||
        (job.mode === "implement" && job.status === "completed" && !job.integratedAt)
      )
      .map((job) => job.id);
  }

  async cancelAll(reason = "parent session closed"): Promise<void> {
    for (const [id, controller] of this.#controllers) {
      const job = this.#jobs.get(id);
      if (job?.status === "queued" || job?.status === "running") {
        controller.abort(new Error(reason));
      }
    }
    await Promise.allSettled(this.#promises.values());
    await this.persist();
  }

  jobs(): WorkerJob[] {
    return [...this.#jobs.values()].map((job) => structuredClone(job));
  }

  async persist(): Promise<void> {
    await this.#onChange?.(this.jobs());
  }

  async #execute(job: WorkerJob, signal: AbortSignal): Promise<string> {
    let release: (() => void) | undefined;
    try {
      release = await this.#semaphore.acquire(signal);
      job.status = "running";
      job.startedAt = new Date().toISOString();
      await this.persist();
      const result = await this.#runWorker(job, signal);
      const materialized = this.#materializeResult
        ? await this.#materializeResult(job, result)
        : { content: result };
      job.status = "completed";
      job.result = materialized.content;
      if (materialized.artifactId) job.resultArtifactId = materialized.artifactId;
      else delete job.resultArtifactId;
      job.finishedAt = new Date().toISOString();
      await this.persist();
      return JSON.stringify(job, null, 2);
    } catch (error) {
      job.status = signal.aborted ? "cancelled" : "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = new Date().toISOString();
      await this.persist();
      throw error;
    } finally {
      release?.();
    }
  }
}

class Semaphore {
  #available: number;
  readonly #waiting: Array<() => void> = [];

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1) throw new Error("subagent concurrency must be positive");
    this.#available = size;
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason ?? new Error("worker cancelled while queued");
    if (this.#available > 0) {
      this.#available -= 1;
      return () => this.#release();
    }
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = this.#waiting.indexOf(wake);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(signal.reason ?? new Error("worker cancelled while queued"));
      };
      this.#waiting.push(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
    return () => this.#release();
  }

  #release(): void {
    const wake = this.#waiting.shift();
    if (wake) wake();
    else this.#available += 1;
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("wait cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
