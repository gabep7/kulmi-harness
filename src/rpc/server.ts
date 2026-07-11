import { createInterface } from "node:readline";
import { z } from "zod";
import type { AgentMode, AutonomyLevel } from "../core/types.js";
import { loadConfig, type SearchMode } from "../config/config.js";
import { EventBus } from "../core/events.js";
import { SessionController } from "../runtime/controller.js";
import { listSessions, SessionStore } from "../runtime/session-store.js";
import { VERSION } from "../core/version.js";
import { resolveExistingCredential } from "../auth/credentials.js";

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});

const openSchema = z.object({
  cwd: z.string().min(1),
  mode: z.enum(["chat", "task"]).optional(),
  model: z.string().optional(),
  autonomy: z.enum(["read", "low", "medium", "high", "trusted"]).default("medium"),
  sessionId: z.string().optional(),
  webSearch: z.enum(["off", "free"]).optional(),
});
const sessionIdSchema = z.object({ sessionId: z.string() });
const promptSchema = sessionIdSchema.extend({ prompt: z.string().min(1) });
const workerIdSchema = sessionIdSchema.extend({ jobId: z.string().min(1) });
const workerSteerSchema = workerIdSchema.extend({ message: z.string().min(1) });
const permissionResponseSchema = sessionIdSchema.extend({
  requestId: z.string().min(1),
  approved: z.boolean(),
});

interface PendingPermission {
  resolve: (approved: boolean) => void;
}

interface ManagedSession {
  controller: SessionController;
  running: AbortController | undefined;
  pendingPermissions: Map<string, PendingPermission>;
}

export async function runRpcServer(defaultCwd: string): Promise<void> {
  const sessions = new Map<string, ManagedSession>();
  const openingSessionIds = new Set<string>();
  let outputQueue = Promise.resolve();
  const send = (message: unknown) => {
    outputQueue = outputQueue.then(() => new Promise<void>((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
    }));
    return outputQueue;
  };
  const notify = (method: string, params: unknown) => send({ jsonrpc: "2.0", method, params });
  const respond = (id: string | number, result: unknown) => send({ jsonrpc: "2.0", id, result });
  const fail = (id: string | number, code: number, message: string, data?: unknown) =>
    send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  const open = async (raw: unknown) => {
    const params = openSchema.parse({ cwd: defaultCwd, ...(isRecord(raw) ? raw : {}) });
    const requestedSessionId = params.sessionId;
    if (requestedSessionId) {
      if (sessions.has(requestedSessionId) || openingSessionIds.has(requestedSessionId)) {
        throw sessionAlreadyOpen(requestedSessionId);
      }
      openingSessionIds.add(requestedSessionId);
    }

    let unownedController: SessionController | undefined;
    try {
      const saved = requestedSessionId ? (await SessionStore.open(requestedSessionId)).session : undefined;
      const savedProfile = saved?.metadata.modelProfile ?? (saved
        ? Object.entries(loadConfig(params.cwd).models)
          .find(([, profile]) => profile.model === saved.metadata.model)?.[0]
        : undefined);
      const requestedModel = params.model ?? savedProfile;
      const credential = await resolveExistingCredential({
        cwd: params.cwd,
        ...(requestedModel ? { requestedModel } : {}),
      });
      const events = new EventBus();
      const pendingPermissions = new Map<string, PendingPermission>();
      const controller = unownedController = await SessionController.create({
        cwd: params.cwd,
        mode: (params.mode ?? saved?.state?.mode ?? "task") as AgentMode,
        autonomy: params.autonomy as AutonomyLevel,
        events,
        requestPermission: (_request, requestId) => new Promise<boolean>((resolve) => {
          pendingPermissions.set(requestId, { resolve });
        }),
        ...(params.model || credential?.model ? { model: params.model ?? credential!.model } : {}),
        ...(requestedSessionId ? { resumeSessionId: requestedSessionId } : {}),
        ...(params.webSearch ? { webSearch: params.webSearch as SearchMode } : {}),
      });

      const sessionId = controller.sessionId;
      const collidesWithOpeningRequest = openingSessionIds.has(sessionId) && sessionId !== requestedSessionId;
      if (sessions.has(sessionId) || collidesWithOpeningRequest) {
        throw sessionAlreadyOpen(sessionId);
      }

      const result = {
        sessionId,
        model: controller.model,
        modelProfile: controller.modelProfile,
        cwd: controller.workspaceRoot,
        autonomy: controller.autonomy,
        messages: controller.messages,
        mode: controller.mode,
        search: controller.searchMode,
        sandbox: controller.sandbox,
        undoMessageHistory: controller.undoMessageHistory,
        state: {
          ...controller.state,
          modifiedFiles: [...controller.state.modifiedFiles],
        },
        workers: controller.workers(),
      };
      events.on((envelope) => notify("event", { sessionId, envelope }).then(() => undefined));
      sessions.set(sessionId, { controller, running: undefined, pendingPermissions });
      unownedController = undefined;
      return result;
    } catch (error) {
      if (unownedController) {
        try {
          await unownedController.close();
        } catch {
          // Preserve the original, stable RPC error after attempting to release all controller resources.
        }
      }
      throw error;
    } finally {
      if (requestedSessionId) openingSessionIds.delete(requestedSessionId);
    }
  };

  const handle = async (request: z.infer<typeof requestSchema>) => {
    try {
      switch (request.method) {
        case "initialize":
          await respond(request.id, {
            protocolVersion: 1,
            server: { name: "kulmi", version: VERSION },
            capabilities: {
              models: ["mimo-v2.5-pro", "mimo-v2.5"],
              searchModes: ["off", "free"],
              streamingEvents: true,
              cancellation: true,
              undo: true,
              workers: true,
              permissions: true,
            },
          });
          return;
        case "sessions.list": {
          const limit = z.object({ limit: z.number().int().min(1).max(200).default(50) })
            .parse(isRecord(request.params) ? request.params : {});
          await respond(request.id, await listSessions(limit.limit));
          return;
        }
        case "session.open":
          await respond(request.id, await open(request.params));
          return;
        case "session.prompt": {
          const params = promptSchema.parse(request.params);
          const managed = sessions.get(params.sessionId);
          if (!managed) throw new RpcError(-32001, `session ${params.sessionId} is not open`);
          if (managed.running) throw new RpcError(-32002, "session is already running");
          const abort = new AbortController();
          managed.running = abort;
          await respond(request.id, { accepted: true });
          managed.controller.run(params.prompt, abort.signal).then(
            (result) => notify("run.completed", { sessionId: params.sessionId, status: result.status, text: result.text }),
            (error: unknown) => notify("run.failed", {
              sessionId: params.sessionId,
              message: error instanceof Error ? error.message : String(error),
            }),
          ).finally(() => { managed.running = undefined; }).catch(() => undefined);
          return;
        }
        case "session.cancel": {
          const params = sessionIdSchema.parse(request.params);
          const managed = sessions.get(params.sessionId);
          managed?.running?.abort(new Error("cancelled by client"));
          await respond(request.id, { cancelled: managed?.running !== undefined });
          return;
        }
        case "session.undo": {
          const params = sessionIdSchema.parse(request.params);
          const managed = sessions.get(params.sessionId);
          if (!managed) throw new RpcError(-32001, `session ${params.sessionId} is not open`);
          if (managed.running) throw new RpcError(-32002, "cannot undo while the session is running");
          const undone = await managed.controller.undo();
          await respond(request.id, {
            ...undone,
            state: {
              ...undone.state,
              modifiedFiles: [...undone.state.modifiedFiles],
            },
          });
          return;
        }
        case "workers.list": {
          const params = sessionIdSchema.parse(request.params);
          const managed = sessions.get(params.sessionId);
          if (!managed) throw new RpcError(-32001, `session ${params.sessionId} is not open`);
          await respond(request.id, managed.controller.workers());
          return;
        }
        case "worker.inspect": {
          const params = workerIdSchema.parse(request.params);
          const managed = sessions.get(params.sessionId);
          if (!managed) throw new RpcError(-32001, `session ${params.sessionId} is not open`);
          const job = managed.controller.workers().find((worker) => worker.id === params.jobId);
          if (!job) throw new RpcError(-32004, `unknown worker ${params.jobId}`);
          await respond(request.id, job);
          return;
        }
        case "worker.steer": {
          const params = workerSteerSchema.parse(request.params);
          const managed = sessions.get(params.sessionId);
          if (!managed) throw new RpcError(-32001, `session ${params.sessionId} is not open`);
          await respond(request.id, { result: await managed.controller.steerWorker(params.jobId, params.message) });
          return;
        }
        case "worker.cancel": {
          const params = workerIdSchema.parse(request.params);
          const managed = sessions.get(params.sessionId);
          if (!managed) throw new RpcError(-32001, `session ${params.sessionId} is not open`);
          await respond(request.id, { result: await managed.controller.cancelWorker(params.jobId) });
          return;
        }
        case "worker.retry": {
          const params = workerIdSchema.parse(request.params);
          const managed = sessions.get(params.sessionId);
          if (!managed) throw new RpcError(-32001, `session ${params.sessionId} is not open`);
          const abort = new AbortController();
          await respond(request.id, { result: await managed.controller.retryWorker(params.jobId, abort.signal) });
          return;
        }
        case "worker.integrate": {
          const params = workerIdSchema.parse(request.params);
          const managed = sessions.get(params.sessionId);
          if (!managed) throw new RpcError(-32001, `session ${params.sessionId} is not open`);
          await respond(request.id, { result: await managed.controller.integrateWorker(params.jobId) });
          return;
        }
        case "permission.respond": {
          const params = permissionResponseSchema.parse(request.params);
          const managed = sessions.get(params.sessionId);
          if (!managed) throw new RpcError(-32001, `session ${params.sessionId} is not open`);
          const pending = managed.pendingPermissions.get(params.requestId);
          if (!pending) throw new RpcError(-32005, `unknown permission ${params.requestId}`);
          managed.pendingPermissions.delete(params.requestId);
          pending.resolve(params.approved);
          await respond(request.id, { resolved: true });
          return;
        }
        case "session.close": {
          const params = sessionIdSchema.parse(request.params);
          const managed = sessions.get(params.sessionId);
          if (managed) {
            managed.running?.abort(new Error("session closed by client"));
            for (const pending of managed.pendingPermissions.values()) pending.resolve(false);
            managed.pendingPermissions.clear();
            await managed.controller.close();
            sessions.delete(params.sessionId);
          }
          await respond(request.id, { closed: managed !== undefined });
          return;
        }
        default:
          throw new RpcError(-32601, `unknown method ${request.method}`);
      }
    } catch (error) {
      if (error instanceof RpcError) await fail(request.id, error.code, error.message);
      else if (error instanceof z.ZodError) await fail(request.id, -32602, "invalid params", z.flattenError(error));
      else await fail(request.id, -32603, error instanceof Error ? error.message : String(error));
    }
  };

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      await send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    const request = requestSchema.safeParse(parsed);
    if (!request.success) {
      await send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
      continue;
    }
    handle(request.data).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
  await Promise.all([...sessions.values()].map(async (managed) => {
    managed.running?.abort(new Error("RPC client disconnected"));
    await managed.controller.close();
  }));
  await outputQueue;
}

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function sessionAlreadyOpen(sessionId: string): RpcError {
  return new RpcError(-32006, `session ${sessionId} is already open or opening`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
