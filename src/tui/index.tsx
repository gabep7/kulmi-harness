import { render } from "ink";
import { TuiApp, type TuiCommandResult, type TuiRuntimeInfo } from "./app.js";
import { TuiStore } from "./store.js";
import { EventBus } from "../core/events.js";
import type { AutonomyLevel } from "../core/types.js";
import type { SearchMode } from "../config/config.js";
import { SessionController } from "../runtime/controller.js";
import { forkSession, listSessions } from "../runtime/session-store.js";
import { findWorkspaceRoot } from "../config/config.js";
import { discoverCommands, expandCommand } from "../config/commands.js";
import { runCredentialOnboarding } from "./onboarding.js";
import { acceptCredential } from "../auth/credentials.js";
import { allowlistEntryFor, saveAllowlistEntry } from "../security/allowlist.js";

export interface RunTuiOptions {
  cwd: string;
  model?: string;
  autonomy: AutonomyLevel;
  webSearch?: SearchMode;
  resumeSessionId?: string;
  approvalMode: "never" | "on-request";
}

const autonomyCycle: AutonomyLevel[] = ["read", "low", "medium", "high", "trusted"];

export async function runTui(options: RunTuiOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("interactive TUI requires a terminal");
  const store = new TuiStore();
  let events = new EventBus();
  let controller = await createController(options, store, events, options.resumeSessionId, options.model);
  store.seedMessages(controller.messages);
  store.seedRunState(controller.state);
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
        return `${controller.modelProfile}  ·  ${controller.autonomy}  ·  ${controller.sessionId}\nsandbox ${controller.sandbox.mode}, network ${controller.sandbox.network ? "on" : "off"}  ·  undo history ${controller.undoMessageHistory}\n${controller.workspaceRoot}`;
      case "/fork": {
        const forked = await forkSession(args || controller.sessionId);
        return `Forked as ${forked.id}. Resume with kulmi --session-id ${forked.id}`;
      }
      case "/undo": {
        const undone = await controller.undo();
        store.replaceSession(undone.messages, undone.state);
        return {
          notice: `Undid ${undone.checkpointId}: ${undone.files.length} file${undone.files.length === 1 ? "" : "s"} restored, message history ${undone.messageHistory === "truncate" ? "removed" : "kept"}`,
          mode: undone.state.mode,
        };
      }
      case "/compact": {
        await controller.compact(args.trim() || undefined);
        return args.trim() ? "Compacted with custom instructions" : "Compacted the transcript on demand";
      }
      case "/login": {
        const choice = await runCredentialOnboarding(controller.workspaceRoot);
        const accepted = await acceptCredential({ choice, cwd: controller.workspaceRoot });
        return accepted.stored
          ? `Connected to ${choice.model} via ${choice.providerPreset ?? choice.protocol}. Key saved in macOS Keychain.`
          : `Connected to ${choice.model}. Key active for this session (Keychain unavailable).`;
      }
      case "/copy": {
        const messages = controller.messages;
        const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.content);
        if (!lastAssistant) return "No assistant message to copy";
        const text = typeof lastAssistant.content === "string" ? lastAssistant.content : "";
        if (!text) return "No text to copy";
        try {
          const { execFileSync } = await import("node:child_process");
          if (process.platform === "darwin") execFileSync("pbcopy", { input: text });
          else if (process.env.WAYLAND_DISPLAY) execFileSync("wl-copy", { input: text });
          else execFileSync("xclip", ["-selection", "clipboard"], { input: text });
          return "Copied to clipboard";
        } catch {
          return "Clipboard not available — copy manually";
        }
      }
      case "/clear": {
        // Close current controller, start fresh
        await controller.close();
        events = new EventBus();
        controller = await createController(options, store, events, undefined, options.model);
        store.seedMessages(controller.messages);
        store.seedRunState(controller.state);
        store.attach(events);
        return "Started a fresh session";
      }
      case "/name": {
        if (!args) return controller.state.sessionName ?? "No name set (use /name <name> to set one)";
        return await controller.setSessionName(args.trim());
      }
      case "/export": {
        const messages = controller.messages;
        const lines: string[] = [];
        for (const msg of messages) {
          if (msg.role === "user") {
            lines.push(`## User\n\n${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}\n`);
          } else if (msg.role === "assistant") {
            const text = typeof msg.content === "string" ? msg.content : "";
            if (text) lines.push(`## Assistant\n\n${text}\n`);
          } else if (msg.role === "tool") {
            const preview = msg.content.slice(0, 200);
            lines.push(`<details><summary>Tool: ${msg.name ?? "unknown"}</summary>\n\n\`\`\`\n${preview}\n\`\`\`\n</details>\n`);
          }
        }
        const markdown = `# Kulmi Session\n\n${lines.join("\n")}\n`;
        const filename = args.trim() || `kulmi-session-${controller.sessionId.slice(0, 8)}.md`;
        const { writeFileSync } = await import("node:fs");
        writeFileSync(filename, markdown, "utf8");
        return `Exported to ${filename}`;
      }
      case "/auth":
        return "Exit Kulmi and run `kulmi auth` to change credentials safely.";
      case "/model": {
        if (!args) {
          const profiles = controller.listModels();
          if (profiles.length <= 1) return profiles.length === 0 ? "No model profiles configured" : `Only ${profiles[0]?.name} is configured`;
          return { models: profiles };
        }
        return await controller.setModel(args.trim());
      }
      case "/effort": {
        const efforts = controller.listReasoningEfforts();
        if (!args) {
          if (efforts.length === 0) return "No reasoning effort options configured for this model";
          return { efforts };
        }
        return controller.setReasoningEffort(args.trim());
      }
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
        await controller.setMode("task");
        return args
          ? { submit: args, mode: "task" }
          : { notice: "Entered goal mode. Send your goal as a prompt.", mode: "task" };
      }
      default: {
        const custom = discoverCommands(controller.workspaceRoot).find((definition) => `/${definition.name}` === name);
        if (custom) return { submit: expandCommand(custom.template, args) };
        return `Unknown command ${name}. Type /help.`;
      }
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
    store.replaceSession(controller.messages, controller.state);
    await previous.close();
    return runtimeInfo(controller);
  };
  const cycleAutonomy = async (): Promise<TuiRuntimeInfo> => {
    const current = autonomyCycle.indexOf(controller.autonomy);
    const next = autonomyCycle[(current + 1) % autonomyCycle.length] ?? "medium";
    controller.setAutonomy(next);
    return runtimeInfo(controller);
  };

  const switchModel = async (name: string): Promise<TuiRuntimeInfo> => {
    await controller.setModel(name);
    return runtimeInfo(controller);
  };

  const close = () => { closing = true; };

  process.stdout.write("\u001B]0;kulmi\u0007");
  instance = render(
    <TuiApp
      store={store}
      model={controller.modelProfile}
      sessionId={controller.sessionId}
      contextWindow={controller.contextWindow}
      cwd={controller.workspaceRoot}
      autonomy={controller.autonomy}
      mode={controller.mode}
      customCommands={discoverCommands(controller.workspaceRoot).map((definition) => ({ name: `/${definition.name}`, description: definition.preview }))}
      onSubmit={submit}
      onCommand={command}
      onSwitchSession={switchSession}
      onCycleAutonomy={cycleAutonomy}
      onCancel={() => activeAbort?.abort(new Error("stopped by user"))}
      onExit={close}
      onSteer={(message) => controller.steer(message)}
      onSwitchModel={switchModel}
      onListEfforts={() => controller.listReasoningEfforts()}
      onSetEffort={(effort) => controller.setReasoningEffort(effort)}
      onAlwaysAllow={(request) => {
        const entry = allowlistEntryFor(controller.workspaceRoot, request);
        if (!entry) return;
        void saveAllowlistEntry(entry).catch((error: unknown) => {
          store.addNotice(error instanceof Error ? error.message : String(error), true);
        });
      }}
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
    model: controller.modelProfile,
    sessionId: controller.sessionId,
    cwd: controller.workspaceRoot,
    contextWindow: controller.contextWindow,
    autonomy: controller.autonomy,
    mode: controller.mode,
  };
}
