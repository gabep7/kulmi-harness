import { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import type { AgentMode, AutonomyLevel, PlanStep } from "../core/types.js";
import type { PermissionRequest } from "../tools/types.js";
import type { CompletionSummary, TuiStore, FeedItem } from "./store.js";
import { glyph, theme } from "./theme.js";

export interface TuiAppProps {
  store: TuiStore;
  model: string;
  sessionId: string;
  cwd: string;
  autonomy: AutonomyLevel;
  search: "off" | "free";
  mode?: AgentMode;
  customCommands?: ReadonlyArray<{ name: string; description: string }>;
  onSubmit: (prompt: string) => Promise<void>;
  onSteer?: (message: string) => void;
  onAlwaysAllow?: (request: PermissionRequest) => void;
  onCommand: (command: string, args: string) => Promise<TuiCommandResult>;
  onSwitchSession?: (sessionId: string) => Promise<TuiRuntimeInfo>;
  onCycleAutonomy?: () => Promise<TuiRuntimeInfo>;
  onSwitchModel?: (name: string) => Promise<TuiRuntimeInfo>;
  onCancel: () => void;
  onExit: () => void;
}

export interface TuiSessionOption {
  id: string;
  status: string;
  model: string;
  title: string;
  current: boolean;
}


export interface TuiModelOption {
  name: string;
  model: string;
  active: boolean;
}


export interface TuiRuntimeInfo {
  model: string;
  sessionId: string;
  cwd: string;
  autonomy: AutonomyLevel;
  search: "off" | "free";
  mode: AgentMode;
}

export type TuiCommandResult = string | {
  submit?: string;
  notice?: string;
  mode?: AgentMode;
  sessions?: TuiSessionOption[];
  models?: TuiModelOption[];
} | undefined;

const commands = [
  ["/help", "show commands and keys"],
  ["/goal", "start a goal-oriented task"],
  ["/sessions", "switch sessions"],
  ["/status", "show runtime details"],
  ["/model", "list or switch model profiles"],
  ["/thinking", "expand or collapse reasoning"],
  ["/fork", "fork this session"],
  ["/undo", "revert the previous turn"],
  ["/auth", "change API key credentials"],
  ["/workers", "inspect child agents"],
  ["/steer", "redirect a running worker"],
  ["/cancel", "cancel a worker"],
  ["/retry", "retry a failed worker"],
  ["/integrate", "apply a worker change"],
  ["/quit", "leave kulmi"],
] as const;

export function TuiApp(props: TuiAppProps) {
  const snapshot = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => terminalSize(stdout));
  const [input, setInput] = useState("");
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<TuiSessionOption[] | undefined>();
  const [sessionCursor, setSessionCursor] = useState(0);
  const [models, setModels] = useState<TuiModelOption[] | undefined>();
  const [modelCursor, setModelCursor] = useState(0);
  const [runtime, setRuntime] = useState<TuiRuntimeInfo>({
    model: props.model,
    sessionId: props.sessionId,
    cwd: props.cwd,
    autonomy: props.autonomy,
    search: props.search,
    mode: props.mode ?? "chat",
  });

  useEffect(() => {
    const resize = () => setSize(terminalSize(stdout));
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [stdout]);

  useInput((value, key) => {
    if (snapshot.pendingApproval) {
      const request = snapshot.pendingApproval.request;
      if (value.toLowerCase() === "y") props.store.resolvePermission(true);
      if (value.toLowerCase() === "a" && request.risk !== "high" && props.onAlwaysAllow) {
        props.onAlwaysAllow(request);
        props.store.resolvePermission(true);
      }
      if (value.toLowerCase() === "n" || key.escape || key.return) props.store.resolvePermission(false);
      return;
    }
    if (sessions) {
      if (key.ctrl && value === "c") {
        props.onExit();
        exit();
        return;
      }
      if (busy) return;
      if (key.escape) {
        setSessions(undefined);
        return;
      }
      if (key.upArrow) {
        setSessionCursor((index) => (index - 1 + sessions.length) % sessions.length);
        return;
      }
      if (key.downArrow) {
        setSessionCursor((index) => (index + 1) % sessions.length);
        return;
      }
      if (key.return) {
        const selected = sessions[sessionCursor];
        if (!selected || selected.current) {
          setSessions(undefined);
          return;
        }
        if (!props.onSwitchSession) {
          props.store.addNotice("Session switching is unavailable", true);
          setSessions(undefined);
          return;
        }
        setBusy(true);
        void props.onSwitchSession(selected.id).then((next) => {
          setRuntime(next);
          setSessions(undefined);
        }, (error: unknown) => {
          props.store.addNotice(error instanceof Error ? error.message : String(error), true);
        }).finally(() => setBusy(false));
        return;
      }
      return;
    }
    if (models) {
      if (key.ctrl && value === "c") {
        props.onExit();
        exit();
        return;
      }
      if (busy) return;
      if (key.escape) {
        setModels(undefined);
        return;
      }
      if (key.upArrow) {
        setModelCursor((index) => (index - 1 + models.length) % models.length);
        return;
      }
      if (key.downArrow) {
        setModelCursor((index) => (index + 1) % models.length);
        return;
      }
      if (key.return) {
        const selected = models[modelCursor];
        setModels(undefined);
        if (!selected || selected.active || !props.onSwitchModel) return;
        setBusy(true);
        void props.onSwitchModel(selected.name).then((next) => {
          setRuntime(next);
          props.store.addNotice(`Switched to ${next.model}`);
        }, (error: unknown) => {
          props.store.addNotice(error instanceof Error ? error.message : String(error), true);
        }).finally(() => setBusy(false));
        return;
      }
      return;
    }
    if (key.escape && busy) props.onCancel();
    if (key.ctrl && value === "c") {
      if (busy) props.onCancel();
      else {
        props.onExit();
        exit();
      }
    }
    if (key.ctrl && value === "o") props.store.toggleThinking();
    if (key.shift && key.tab && !busy && props.onCycleAutonomy) {
      setBusy(true);
      void props.onCycleAutonomy().then((next) => {
        setRuntime(next);
        props.store.addNotice(`Autonomy: ${autonomyLabel(next.autonomy)}`);
      }, (error: unknown) => {
        props.store.addNotice(error instanceof Error ? error.message : String(error), true);
      }).finally(() => setBusy(false));
      return;
    }
    if (value === "?" && input.length === 0) setHelp((shown) => !shown);
  });

  const submit = async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    if (busy) {
      if (value.startsWith("/") || !props.onSteer) return;
      setInput("");
      try {
        props.onSteer(value);
        props.store.addNotice(`steered: ${value}`);
      } catch (error) {
        props.store.addNotice(error instanceof Error ? error.message : String(error), true);
      }
      return;
    }
    setInput("");
    if (value.startsWith("/")) {
      const [command = "", ...parts] = value.split(/\s+/);
      if (command === "/quit" || command === "/exit") {
        props.onExit();
        exit();
        return;
      }
      if (command === "/help") {
        setHelp(true);
        return;
      }
      if (command === "/thinking") {
        props.store.toggleThinking();
        return;
      }
      setBusy(true);
      try {
        const result = await props.onCommand(command, parts.join(" "));
        if (typeof result === "string") {
          if (result) props.store.addNotice(result);
        } else if (result) {
          if (result.notice) props.store.addNotice(result.notice);
          if (result.mode) setRuntime((current) => ({ ...current, mode: result.mode! }));
          if (result.sessions) {
            if (result.sessions.length === 0) props.store.addNotice("No saved sessions in this workspace");
            else {
              setSessionCursor(Math.max(0, result.sessions.findIndex((session) => session.current)));
              setSessions(result.sessions);
            }
          }
          if (result.models) {
            setModelCursor(Math.max(0, result.models.findIndex((entry) => entry.active)));
            setModels(result.models);
          }
          if (result.submit) await props.onSubmit(result.submit);
        }
      } catch (error) {
        props.store.addNotice(error instanceof Error ? error.message : String(error), true);
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      await props.onSubmit(value);
    } finally {
      setBusy(false);
    }
  };

  const width = Math.max(40, size.columns - 4);
  const idle = snapshot.transcript.length === 0 && snapshot.live.length === 0 && !snapshot.streaming && !snapshot.reasoning;

  return (
    <Box flexDirection="column">
      <Static items={snapshot.transcript}>
        {(item) => <FeedRow key={item.id} item={item} width={width} />}
      </Static>

      <Box flexDirection="column" paddingX={1}>
        {idle && <Welcome width={width} />}

        {snapshot.live.length > 8 && <Text color={theme.faint}>  +{snapshot.live.length - 8} more running…</Text>}
        {snapshot.live.slice(-8).map((item) => <FeedRow key={item.id} item={item} width={width} />)}

        {snapshot.reasoning && <Thinking text={snapshot.reasoning} expanded={snapshot.expandedThinking} width={width} />}

        {snapshot.streaming && (
          <Box marginTop={1}>
            <Text color={theme.caramel}>{glyph.assistant} </Text>
            <Text color={theme.faint}>responding… {wordCount(snapshot.streaming)} words</Text>
          </Box>
        )}

        {snapshot.plan.length > 0 && <PlanBlock plan={snapshot.plan} />}
        {snapshot.completion && <CompletionBlock completion={snapshot.completion} />}

        {help && <Help onClose={() => setHelp(false)} custom={props.customCommands ?? []} />}
        {!help && !snapshot.pendingApproval && !sessions && !models && input.startsWith("/") && <CommandPalette query={input} columns={size.columns} />}

        {!snapshot.pendingApproval && !sessions && !models && busy && <LoadingStatus />}

        {snapshot.pendingApproval
          ? <Approval request={snapshot.pendingApproval.request} />
          : sessions
            ? <SessionPicker sessions={sessions} cursor={sessionCursor} />
            : models
              ? <ModelPicker models={models} cursor={modelCursor} />
              : <Composer value={input} onChange={setInput} onSubmit={submit} busy={busy} />}

        <Footer runtime={runtime} status={snapshot.status} usage={snapshot.usage} busy={busy} />
      </Box>
    </Box>
  );
}

function Welcome({ width }: { width: number }) {
  return (
    <Box flexDirection="column" marginBottom={1} width={Math.min(width, 72)}>
      <Text color={theme.caramel} bold>{glyph.brand} kulmi</Text>
      <Text color={theme.muted}>Ask for a change, an investigation, or a full implementation. Kulmi plans, works, verifies, and keeps the evidence attached.</Text>
      <Box marginTop={1}><Text color={theme.faint}>Try  </Text><Text color={theme.sand}>inspect this repo and fix the highest-impact issue</Text></Box>
    </Box>
  );
}

function FeedRow({ item, width }: { item: FeedItem; width: number }) {
  if (item.kind === "user") return (
    <Box marginTop={1}>
      <Text color={theme.sand} bold>{glyph.user} </Text><Text color={theme.cream} bold>{item.text.trim()}</Text>
    </Box>
  );
  if (item.kind === "assistant") return (
    <Box marginTop={1} alignItems="flex-start">
      <Text color={theme.caramel}>{glyph.assistant} </Text><MarkdownBlock text={item.text} width={width} />
    </Box>
  );
  if (item.kind === "tool") return (
    <Box paddingLeft={2} flexDirection="column">
      <Box>
        <Text color={item.status === "error" ? theme.rose : item.status === "done" ? theme.sage : theme.caramel}>
          {item.status === "error" ? glyph.error : item.status === "done" ? glyph.success : glyph.active}
          <Text color={theme.muted}> {item.title}</Text>
        </Text>
        {item.detail && <Text color={theme.faint}>  {clampLine(item.detail, Math.max(12, width - item.title.length - 8))}</Text>}
        {item.durationMs !== undefined && <Text color={theme.faint}>  {formatDuration(item.durationMs)}</Text>}
      </Box>
      {item.diff && <Text color={theme.faint}>{item.diff}</Text>}
    </Box>
  );
  if (item.kind === "worker") return (
    <Box paddingLeft={2}>
      <Text color={statusColor(item.status)}>{item.status === "running" ? glyph.active : item.status === "completed" ? glyph.success : glyph.error} </Text>
      <Text color={theme.muted}>worker</Text><Text color={theme.faint}>  {clampLine(item.title, width - 12)}</Text>
    </Box>
  );
  return <Box paddingLeft={2}><Text color={item.kind === "error" ? theme.rose : theme.faint}>{item.kind === "error" ? "×" : "·"} {item.text.trim()}</Text></Box>;
}

function Thinking({ text, expanded, width }: { text: string; expanded: boolean; width: number }) {
  const words = text.trim().split(/\s+/).length;
  return (
    <Box paddingLeft={2} flexDirection="column">
      <Text color={theme.faint}>◌ thinking  {words} words  <Text color={theme.cocoa}>ctrl+o</Text></Text>
      {expanded && <Text color={theme.muted} italic>{tailLines(text, 12).slice(-Math.max(80, width * 12))}</Text>}
    </Box>
  );
}

function PlanBlock({ plan }: { plan: PlanStep[] }) {
  const done = plan.filter((step) => step.status === "completed").length;
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color={theme.sand} bold>plan  <Text color={theme.faint}>{done}/{plan.length}</Text></Text>
      {plan.slice(0, 8).map((step) => (
        <Box key={step.id}>
          <Text color={step.status === "completed" ? theme.sage : step.status === "in_progress" ? theme.caramel : theme.faint}>
            {step.status === "completed" ? glyph.done : step.status === "in_progress" ? glyph.active : glyph.pending}{" "}
          </Text>
          <Text color={step.status === "completed" ? theme.muted : theme.ink} wrap="truncate-end">{step.title}</Text>
        </Box>
      ))}
    </Box>
  );
}

function CompletionBlock({ completion }: { completion: CompletionSummary }) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor={completion.status === "completed" ? theme.sage : theme.rust} paddingX={1} flexDirection="column">
      <Text color={completion.status === "completed" ? theme.sage : theme.rose} bold>{completion.status}</Text>
      <Text color={theme.muted}>{completion.modifiedFiles.length} changed file{completion.modifiedFiles.length === 1 ? "" : "s"}</Text>
      {completion.modifiedFiles.slice(0, 5).map((path) => <Text key={path} color={theme.faint}>· {path}</Text>)}
      {completion.verificationCommands.map((command) => <Text key={command} color={theme.sand}>✓ {command}</Text>)}
    </Box>
  );
}

function Composer({ value, onChange, onSubmit, busy }: { value: string; onChange: (value: string) => void; onSubmit: (value: string) => void; busy: boolean }) {
  return (
    <Box marginTop={busy ? 0 : 1} borderStyle="round" borderColor={busy ? theme.faint : theme.cocoa} paddingX={1}>
      <Text color={busy ? theme.faint : theme.caramel}>{glyph.user} </Text>
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={busy ? "Kulmi is working. Enter to steer, Esc to stop." : "What should we build?"} />
    </Box>
  );
}


const loadingMessage = "thinking";

const loadingFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function useLoadingStatus(active: boolean): { icon: string; message: string } {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((value) => value + 1), 140);
    return () => clearInterval(timer);
  }, [active]);
  return {
    icon: loadingFrames[tick % loadingFrames.length]!,
    message: loadingMessage,
  };
}


function LoadingStatus() {
  const loading = useLoadingStatus(true);
  return (
    <Box marginTop={1} paddingLeft={1}>
      <Text color={theme.caramel}>{loading.icon} </Text>
      <Text color={theme.muted}>{loading.message}</Text>
    </Box>
  );
}

function Approval({ request }: { request: PermissionRequest }) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor={theme.rust} paddingX={1} flexDirection="column">
      <Text color={theme.rose} bold>approval required  <Text color={theme.muted}>{request.risk} risk</Text></Text>
      <Text color={theme.ink}>{request.reason}</Text>
      {request.command && <Text color={theme.sand}>$ {request.command}</Text>}
      <Text color={theme.muted}><Text color={theme.sage}>y</Text> allow once   {request.risk !== "high" && <><Text color={theme.sage}>a</Text> allow always   </>}<Text color={theme.rose}>n</Text> deny</Text>
    </Box>
  );
}

function SessionPicker({ sessions, cursor }: { sessions: TuiSessionOption[]; cursor: number }) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor={theme.cocoa} paddingX={1} flexDirection="column">
      <Text color={theme.cream} bold>sessions</Text>
      {sessions.map((session, index) => (
        <Text key={session.id} color={index === cursor ? theme.sand : theme.muted} bold={index === cursor}>
          {index === cursor ? "›" : " "} {session.id.replace("session_", "").slice(0, 8)}  {session.status.padEnd(9)}  {clampLine(session.title, 56)}{session.current ? "  current" : ""}
        </Text>
      ))}
      <Text color={theme.faint}>↑↓ select  ·  enter open  ·  esc close</Text>
    </Box>
  );
}

function ModelPicker({ models, cursor }: { models: TuiModelOption[]; cursor: number }) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor={theme.cocoa} paddingX={1} flexDirection="column">
      <Text color={theme.cream} bold>models</Text>
      {models.map((entry, index) => (
        <Text key={entry.name} color={index === cursor ? theme.sand : theme.muted} bold={index === cursor}>
          {index === cursor ? "›" : " "} {entry.name.padEnd(22)} {entry.model}{entry.active ? "  current" : ""}
        </Text>
      ))}
      <Text color={theme.faint}>up/down select  enter switch  esc close</Text>
    </Box>
  );
}

function Help({ onClose, custom }: { onClose: () => void; custom: ReadonlyArray<{ name: string; description: string }> }) {
  useInput((input, key) => { if (input === "?" || key.escape) onClose(); });
  const customShown = custom.filter((entry) => !commands.some(([builtin]) => builtin === entry.name));
  return (
    <Box marginTop={1} borderStyle="round" borderColor={theme.cocoa} paddingX={1} flexDirection="column">
      <Text color={theme.cream} bold>commands</Text>
      <Box flexDirection="row" flexWrap="wrap">
        {commands.map(([command, detail]) => <Box key={command} width={32}><Text color={theme.sand}>{command.padEnd(12)}</Text><Text color={theme.muted}>{detail}</Text></Box>)}
      </Box>
      {customShown.length > 0 && <Text color={theme.cream} bold>custom commands</Text>}
      {customShown.length > 0 && (
        <Box flexDirection="row" flexWrap="wrap">
          {customShown.map((entry) => <Box key={entry.name} width={32}><Text color={theme.sand}>{entry.name.padEnd(12)}</Text><Text color={theme.muted}>{entry.description}</Text></Box>)}
        </Box>
      )}
      <Text color={theme.faint}>esc stop  ·  ctrl+o thinking  ·  shift+tab autonomy  ·  ctrl+c exit  ·  ? close</Text>
    </Box>
  );
}

function CommandPalette({ query, columns }: { query: string; columns: number }) {
  const matches = commands.filter(([command]) => command.startsWith(query.split(/\s/)[0] ?? ""));
  if (matches.length === 0) return null;
  const twoColumns = columns >= 72;
  return (
    <Box marginTop={1} flexDirection="row" flexWrap="wrap">
      {matches.map(([command, detail]) => (
        <Box key={command} width={twoColumns ? "50%" : "100%"}>
          <Text><Text color={theme.sand}>{command.padEnd(12)}</Text><Text color={theme.faint}>{detail}</Text></Text>
        </Box>
      ))}
      <Box width="100%"><Text color={theme.cocoa}>type to filter</Text></Box>
    </Box>
  );
}

function MarkdownBlock({ text, width }: { text: string; width: number }) {
  const source = text.trim().split("\n");
  let code = false;
  return (
    <Box flexDirection="column" width={Math.max(20, width)}>
      {source.map((raw, index) => {
        const fence = raw.match(/^```\s*([\w-]*)/);
        if (fence) {
          code = !code;
          return code && fence[1]
            ? <Text key={index} color={theme.faint}>code · {fence[1]}</Text>
            : null;
        }
        if (code) return <Text key={index} color={theme.cream} backgroundColor={theme.panel}>  {raw || " "}</Text>;
        const heading = raw.match(/^#{1,6}\s+(.+)/);
        if (heading) return <Text key={index} color={theme.cream} bold><InlineMarkdown text={heading[1]!} /></Text>;
        const task = raw.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)/);
        if (task) return <Text key={index} color={theme.ink}><Text color={task[1]?.toLowerCase() === "x" ? theme.sage : theme.faint}>{task[1]?.toLowerCase() === "x" ? "✓" : "○"} </Text><InlineMarkdown text={task[2]!} /></Text>;
        const bullet = raw.match(/^\s*[-*]\s+(.+)/);
        if (bullet) return <Text key={index} color={theme.ink}><Text color={theme.caramel}>• </Text><InlineMarkdown text={bullet[1]!} /></Text>;
        const ordered = raw.match(/^\s*(\d+)[.)]\s+(.+)/);
        if (ordered) return <Text key={index} color={theme.ink}><Text color={theme.caramel}>{ordered[1]}. </Text><InlineMarkdown text={ordered[2]!} /></Text>;
        const quote = raw.match(/^>\s?(.*)/);
        if (quote) return <Text key={index} color={theme.muted}>│ <InlineMarkdown text={quote[1]!} /></Text>;
        if (/^\s*[-*_]{3,}\s*$/.test(raw)) return <Text key={index} color={theme.faint}>{"─".repeat(Math.min(48, width))}</Text>;
        if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(raw)) {
          return <Text key={index} color={theme.faint}>{"─".repeat(Math.min(48, width))}</Text>;
        }
        if (raw.includes("|") && /^\s*\|?.+\|.+\|?\s*$/.test(raw)) {
          return <Text key={index} color={theme.sand}>{raw.replace(/^\s*\|?|\|?\s*$/g, "").split("|").map((cell) => cell.trim()).join("  ·  ")}</Text>;
        }
        return <Text key={index} color={theme.ink}><InlineMarkdown text={raw} /></Text>;
      })}
    </Box>
  );
}

function Footer({ runtime, status, usage, busy }: { runtime: TuiRuntimeInfo; status: string; usage: ReturnType<TuiStore["getSnapshot"]>["usage"]; busy: boolean }) {
  const cacheInput = usage.cacheHitTokens + usage.cacheMissTokens;
  const cacheRate = cacheInput > 0 ? Math.round(usage.cacheHitTokens / cacheInput * 100) : 0;
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text color={theme.faint} wrap="truncate-end">{glyph.brand} kulmi  ·  <Text color={statusColor(status)}>{status}</Text>  ·  {runtime.mode === "task" ? "goal" : "chat"}  ·  {busy ? "esc stop" : "? help"}  ·  {autonomyLabel(runtime.autonomy)}  ·  search {runtime.search}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text color={theme.faint} wrap="truncate-end">{runtime.model}  ·  {runtime.sessionId.replace("session_", "").slice(0, 8)}</Text>
        <Text color={theme.faint}>{compactNumber(usage.totalTokens)} processed  ·  <Text color={theme.ink}>{compactNumber(usage.cacheMissTokens)} fresh</Text>  ·  <Text color={usage.cacheHitTokens > 0 ? theme.sage : theme.muted}>{compactNumber(usage.cacheHitTokens)} cached ({cacheRate}%)</Text>  ·  {compactNumber(usage.completionTokens)} out</Text>
      </Box>
    </Box>
  );
}

function terminalSize(stdout: NodeJS.WriteStream): { columns: number; rows: number } {
  return { columns: Math.max(60, stdout.columns ?? 100), rows: Math.max(20, stdout.rows ?? 30) };
}

function InlineMarkdown({ text }: { text: string }) {
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|(?<!\*)\*[^*]+\*(?!\*)|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  const parts = text.split(pattern).filter(Boolean);
  return <>{parts.map((part, index) => {
    if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
      return <Text key={index} bold color={theme.cream}>{part.slice(2, -2)}</Text>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <Text key={index} color={theme.sand} backgroundColor={theme.panel}> {part.slice(1, -1)} </Text>;
    }
    if (part.startsWith("~~") && part.endsWith("~~")) {
      return <Text key={index} strikethrough color={theme.muted}>{part.slice(2, -2)}</Text>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <Text key={index} italic>{part.slice(1, -1)}</Text>;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) return <Text key={index} color={theme.sand} underline>{link[1]} <Text color={theme.faint}>{link[2]}</Text></Text>;
    return <Text key={index}>{part}</Text>;
  })}</>;
}

function tailLines(text: string, limit: number): string {
  const lines = text.replace(/\n{3,}/g, "\n\n").split("\n");
  return lines.length <= limit ? text.trimEnd() : lines.slice(-limit).join("\n");
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function clampLine(text: string, width: number): string {
  const value = text.trim().replace(/\s+/g, " ");
  const limit = Math.max(12, width);
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function statusColor(status: string): string {
  if (status === "running") return theme.caramel;
  if (status === "completed") return theme.sage;
  if (status === "failed" || status === "cancelled" || status === "blocked") return theme.rose;
  return theme.faint;
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(1)}s`;
}

function compactNumber(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function autonomyLabel(value: AutonomyLevel): string {
  if (value === "read") return "inspect";
  if (value === "low") return "edit";
  if (value === "medium") return "local dev";
  if (value === "high") return "extended";
  return "trusted";
}
