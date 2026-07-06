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

interface ManagedSession {
  controller: SessionController;
  running: AbortController | undefined;
}

export async function runRpcServer(defaultCwd: string): Promise<void> {
  const sessions = new Map<string, ManagedSession>();
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
    const saved = params.sessionId ? (await SessionStore.open(params.sessionId)).session : undefined;
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
    const controller = await SessionController.create({
      cwd: params.cwd,
      mode: (params.mode ?? saved?.state?.mode ?? "task") as AgentMode,
      autonomy: params.autonomy as AutonomyLevel,
      events,
      ...(params.model || credential?.model ? { model: params.model ?? credential!.model } : {}),
      ...(params.sessionId ? { resumeSessionId: params.sessionId } : {}),
      ...(params.webSearch ? { webSearch: params.webSearch as SearchMode } : {}),
    });
    events.on((envelope) => notify("event", { sessionId: controller.sessionId, envelope }).then(() => undefined));
    sessions.set(controller.sessionId, { controller, running: undefined });
    return {
      sessionId: controller.sessionId,
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
        case "session.close": {
          const params = sessionIdSchema.parse(request.params);
          const managed = sessions.get(params.sessionId);
          if (managed) {
            managed.running?.abort(new Error("session closed by client"));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
