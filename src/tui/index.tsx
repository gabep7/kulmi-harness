import { render } from "ink";
import { TuiApp, type TuiCommandResult, type TuiRuntimeInfo } from "./app.js";
import { TuiStore } from "./store.js";
import { EventBus } from "../core/events.js";
import type { AutonomyLevel } from "../core/types.js";
import type { SearchMode } from "../config/config.js";
import { SessionController } from "../runtime/controller.js";
import { forkSession, listSessions } from "../runtime/session-store.js";
import { findWorkspaceRoot } from "../config/config.js";

export interface RunTuiOptions {
  cwd: string;
  model?: string;
  autonomy: AutonomyLevel;
  webSearch?: SearchMode;
  resumeSessionId?: string;
  approvalMode: "never" | "on-request";
}

export async function runTui(options: RunTuiOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("interactive TUI requires a terminal");
  const store = new TuiStore();
  let events = new EventBus();
  let controller = await createController(options, store, events, options.resumeSessionId, options.model);
  store.seedMessages(controller.messages);
  store.attach(events);
  let activeAbort: AbortController | undefined;
  let closing = false;
  let instance: ReturnType<typeof render> | undefined;

  const submit = async (prompt: string) => {
    store.echoUserMessage(prompt);
    activeAbort = new AbortController();
    try {
      await controller.run(prompt, activeAbort.signal);
    } catch (error) {
      if (!activeAbort.signal.aborted) store.addNotice(error instanceof Error ? error.message : String(error), true);
    } finally {
      activeAbort = undefined;
    }
  };
  const command = async (name: string, args: string): Promise<TuiCommandResult> => {
    switch (name) {
      case "/sessions": {
        const sessions = (await listSessions(20))
          .filter((session) => findWorkspaceRoot(session.cwd) === controller.workspaceRoot)
          .slice(0, 8)
          .map((session) => ({
            id: session.id,
            status: session.status,
            model: session.modelProfile ?? session.model,
            title: session.prompt ?? session.cwd,
            current: session.id === controller.sessionId,
          }));
        return { sessions };
      }
      case "/status":
        return `${controller.model}  ·  ${controller.autonomy}  ·  ${controller.sessionId}\n${controller.workspaceRoot}`;
      case "/fork": {
        const forked = await forkSession(args || controller.sessionId);
        return `Forked as ${forked.id}. Resume with kulmi --session-id ${forked.id}`;
      }
      case "/auth":
        return "Exit Kulmi and run `kulmi auth` to change credentials safely.";
      case "/workers": {
        const workers = controller.workers();
        return workers.map((worker) => `${worker.id}  ${worker.status.padEnd(9)}  ${worker.description}`).join("\n") || "No workers in this session";
      }
      case "/steer": {
        const [jobId, ...message] = args.split(/\s+/);
        if (!jobId || message.length === 0) throw new Error("usage: /steer <worker-id> <message>");
        await controller.steerWorker(jobId, message.join(" "));
        return `Steering sent to ${jobId}`;
      }
      case "/cancel":
        if (!args) throw new Error("usage: /cancel <worker-id>");
        await controller.cancelWorker(args);
        return `Cancelled ${args}`;
      case "/retry": {
        if (!args) throw new Error("usage: /retry <worker-id>");
        const retryAbort = new AbortController();
        const result = JSON.parse(await controller.retryWorker(args, retryAbort.signal)) as { job_id: string };
        return `Retry started as ${result.job_id}`;
      }
      case "/integrate":
        if (!args) throw new Error("usage: /integrate <worker-id>");
        await controller.integrateWorker(args);
        return `Integrated ${args}`;
      case "/goal": {
        controller.setMode("task");
        return args
          ? { submit: args, mode: "task" }
          : { notice: "Entered goal mode. Send your goal as a prompt.", mode: "task" };
      }
      default:
        return `Unknown command ${name}. Type /help.`;
    }
  };
  const switchSession = async (sessionId: string): Promise<TuiRuntimeInfo> => {
    if (sessionId === controller.sessionId) return runtimeInfo(controller);
    const nextEvents = new EventBus();
    const next = await createController(options, store, nextEvents, sessionId);
    const previous = controller;
    controller = next;
    events = nextEvents;
    store.attach(events);
    instance?.clear();
    store.replaceSession(controller.messages);
    await previous.close();
    return runtimeInfo(controller);
  };
  const close = () => { closing = true; };

  process.stdout.write("\u001B]0;kulmi\u0007");
  instance = render(
    <TuiApp
      store={store}
      model={controller.model}
      sessionId={controller.sessionId}
      cwd={controller.workspaceRoot}
      autonomy={controller.autonomy}
      search={controller.searchMode}
      mode={controller.mode}
      onSubmit={submit}
      onCommand={command}
      onSwitchSession={switchSession}
      onCancel={() => activeAbort?.abort(new Error("stopped by user"))}
      onExit={close}
    />,
    { exitOnCtrlC: false, patchConsole: false, maxFps: 30 },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    activeAbort?.abort(new Error("session closed"));
    store.close();
    if (!closing) activeAbort?.abort();
    await controller.close();
  }
}

async function createController(
  options: RunTuiOptions,
  store: TuiStore,
  events: EventBus,
  resumeSessionId?: string,
  model?: string,
): Promise<SessionController> {
  return SessionController.create({
    cwd: options.cwd,
    mode: "chat",
    autonomy: options.autonomy,
    events,
    ...(model ? { model } : {}),
    ...(options.webSearch ? { webSearch: options.webSearch } : {}),
    ...(resumeSessionId ? { resumeSessionId } : {}),
    ...(options.approvalMode === "on-request" ? { requestPermission: (request) => store.requestPermission(request) } : {}),
  });
}

function runtimeInfo(controller: SessionController): TuiRuntimeInfo {
  return {
    model: controller.model,
    sessionId: controller.sessionId,
    cwd: controller.workspaceRoot,
    autonomy: controller.autonomy,
    search: controller.searchMode,
    mode: controller.mode,
  };
}
