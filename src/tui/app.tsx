import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import type { AgentMode, AutonomyLevel, PlanStep, TokenUsage } from "../core/types.js";
import type { WebCitation } from "../provider/types.js";
import type { PermissionRequest } from "../tools/types.js";
import type { CompletionSummary, TuiStore, FeedItem } from "./store.js";
import { glyph, theme } from "./theme.js";

export interface TuiAppProps {
  store: TuiStore;
  model: string;
  sessionId: string;
  cwd: string;
  contextWindow: number;
  autonomy: AutonomyLevel;
  mode?: AgentMode;
  customCommands?: ReadonlyArray<{ name: string; description: string }>;
  onSubmit: (prompt: string) => Promise<void>;
  onSteer?: (message: string) => void;
  onAlwaysAllow?: (request: PermissionRequest) => void;
  onCommand: (command: string, args: string) => Promise<TuiCommandResult>;
  onSwitchSession?: (sessionId: string) => Promise<TuiRuntimeInfo>;
  onCycleAutonomy?: () => Promise<TuiRuntimeInfo>;
  onSwitchModel?: (name: string) => Promise<TuiRuntimeInfo>;
  onListEfforts?: () => string[];
  onSetEffort?: (effort: string) => string;
  onNewTab?: () => Promise<TuiTabResult>;
  onSelectTab?: (index: number) => Promise<TuiTabResult>;
  onCloseTab?: () => Promise<TuiTabResult | undefined>;
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
  contextWindow: number;
  mode: AgentMode;
}

export interface TuiTabInfo {
  index: number;
  sessionId: string;
  label: string;
  busy: boolean;
  active: boolean;
}

export interface TuiTabResult {
  runtime: TuiRuntimeInfo;
  tabs: TuiTabInfo[];
}

export type TuiCommandResult = string | {
  notice?: string;
  mode?: AgentMode;
  sessions?: TuiSessionOption[];
  models?: TuiModelOption[];
  efforts?: string[];
  submit?: string;
} | undefined;

const commands = [
  ["/help", "show commands and keys"],
  ["/goal", "start a goal-oriented task"],
  ["/sessions", "switch sessions"],
  ["/status", "show runtime details"],
  ["/model", "list or switch model profiles"],
  ["/effort", "list or switch reasoning effort"],
  ["/thinking", "expand or collapse reasoning"],
  ["/fork", "fork this session"],
  ["/undo", "revert the previous turn"],
  ["/compact", "compact the transcript on demand"],
  ["/login", "add or switch a model provider"],
  ["/auth", "change API key credentials"],
  ["/copy", "copy last assistant message"],
  ["/clear", "start a fresh session"],
  ["/name", "name this session"],
  ["/export", "export session as markdown"],
  ["/workers", "inspect child agents"],
  ["/steer", "redirect a running worker"],
  ["/cancel", "cancel a worker"],
  ["/retry", "retry a failed worker"],
  ["/integrate", "apply a worker change"],
  ["/quit", "leave kulmi"],
] as const;
type CommandEntry = { name: string; description: string };

function availableCommands(custom: ReadonlyArray<CommandEntry>): CommandEntry[] {
  const entries = [...commands.map(([name, description]) => ({ name, description })), ...custom];
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.name)) return false;
    seen.add(entry.name);
    return true;
  });
}

export function TuiApp(props: TuiAppProps) {
  const snapshot = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => terminalSize(stdout));
  const [input, setInput] = useState("");
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const setBusyState = (next: boolean) => {
    busyRef.current = next;
    setBusy(next);
  };
  const [sessions, setSessions] = useState<TuiSessionOption[] | undefined>();
  const [sessionCursor, setSessionCursor] = useState(0);
  const [models, setModels] = useState<TuiModelOption[] | undefined>();
  const [modelCursor, setModelCursor] = useState(0);
  const [efforts, setEfforts] = useState<string[] | undefined>();
  const [effortCursor, setEffortCursor] = useState(0);
  const [commandCursor, setCommandCursor] = useState(0);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const historyDraftRef = useRef("");
  const commandOptions = availableCommands(props.customCommands ?? []);
  const commandMatches = input.startsWith("/")
    ? commandOptions.filter((entry) => entry.name.startsWith(input.split(/\s/)[0] ?? ""))
    : [];

  const rememberInput = (value: string) => {
    const history = historyRef.current;
    historyRef.current = history.at(-1) === value ? history : [...history, value].slice(-100);
    historyIndexRef.current = -1;
    historyDraftRef.current = "";
  };

  const navigateHistory = (direction: -1 | 1) => {
    const history = historyRef.current;
    if (history.length === 0) return;
    if (historyIndexRef.current === -1) historyDraftRef.current = input;
    const current = historyIndexRef.current === -1 ? (direction < 0 ? history.length : -1) : historyIndexRef.current;
    const next = Math.max(-1, Math.min(history.length - 1, current + direction));
    historyIndexRef.current = next;
    setInput(next === -1 ? historyDraftRef.current : history[next] ?? "");
  };
  const handleComposerChange = (value: string) => {
    setInput(value);
    setCommandCursor(0);
    if (historyIndexRef.current !== -1) {
      historyIndexRef.current = -1;
      historyDraftRef.current = "";
    }
  };
  const [runtime, setRuntime] = useState<TuiRuntimeInfo>({
    model: props.model,
    sessionId: props.sessionId,
    cwd: props.cwd,
    autonomy: props.autonomy,
    mode: props.mode ?? "chat",
    contextWindow: props.contextWindow,
  });
  const [tabs, setTabs] = useState<TuiTabInfo[]>([]);

  const applyTabs = (result: TuiTabResult | undefined) => {
    if (!result) return;
    setRuntime(result.runtime);
    setTabs(result.tabs);
  };

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
      if (busyRef.current) return;
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
        setBusyState(true);
        void props.onSwitchSession(selected.id).then((next) => {
          setRuntime(next);
          setSessions(undefined);
        }, (error: unknown) => {
          props.store.addNotice(error instanceof Error ? error.message : String(error), true);
        }).finally(() => setBusyState(false));
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
      if (busyRef.current) return;
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
        if (!selected || !props.onSwitchModel) return;
        const openEffortPicker = () => {
          const options = props.onListEfforts?.() ?? [];
          if (options.length <= 1) return;
          setEffortCursor(0);
          setEfforts(options);
        };
        if (selected.active) {
          openEffortPicker();
          return;
        }
        setBusyState(true);
        void props.onSwitchModel(selected.name).then((next) => {
          setRuntime(next);
          props.store.addNotice(`Switched to ${next.model}`);
          openEffortPicker();
        }, (error: unknown) => {
          props.store.addNotice(error instanceof Error ? error.message : String(error), true);
        }).finally(() => setBusyState(false));
        return;
      }
      return;
    }
    if (efforts) {
      if (key.ctrl && value === "c") {
        props.onExit();
        exit();
        return;
      }
      if (busyRef.current) return;
      if (key.escape) {
        setEfforts(undefined);
        return;
      }
      if (key.upArrow) {
        setEffortCursor((index) => (index - 1 + efforts.length) % efforts.length);
        return;
      }
      if (key.downArrow) {
        setEffortCursor((index) => (index + 1) % efforts.length);
        return;
      }
      if (key.return) {
        const selected = efforts[effortCursor];
        setEfforts(undefined);
        if (!selected || !props.onSetEffort) return;
        try {
          props.store.addNotice(props.onSetEffort(selected));
        } catch (error) {
          props.store.addNotice(error instanceof Error ? error.message : String(error), true);
        }
        return;
      }
      return;
    }
    if (!busyRef.current && !help && !sessions && !models && !efforts && input.startsWith("/")) {
      if (key.upArrow && commandMatches.length > 0) {
        setCommandCursor((index) => (index - 1 + commandMatches.length) % commandMatches.length);
        return;
      }
      if (key.downArrow && commandMatches.length > 0) {
        setCommandCursor((index) => (index + 1) % commandMatches.length);
        return;
      }
      if (key.tab && commandMatches.length > 0) {
        const selected = commandMatches[commandCursor] ?? commandMatches[0];
        if (!selected) return;
        const [, ...args] = input.split(/\s+/);
        setInput(args.length > 0 ? `${selected.name} ${args.join(" ")}` : `${selected.name} `);
        setCommandCursor(0);
        return;
      }
    }
    if (!busyRef.current && !help && !sessions && !models && !efforts && (key.upArrow || key.downArrow)) {
      navigateHistory(key.upArrow ? -1 : 1);
      return;
    }

    if (key.escape) {
      if (help) {
        setHelp(false);
        return;
      }
      if (busyRef.current) props.onCancel();
      return;
    }
    if (key.ctrl && value === "c") {
      if (busyRef.current) props.onCancel();
      else {
        props.onExit();
        exit();
      }
      return;
    }
    if (key.ctrl && value === "o") {
      props.store.toggleThinking();
      return;
    }
    // Tabs. ctrl+t opens one, ctrl+w closes the current one, and alt+<n> jumps
    // directly. Switching never waits on the outgoing tab, so a background run
    // keeps going.
    if (key.ctrl && value === "t" && props.onNewTab) {
      void props.onNewTab().then(applyTabs, (error: unknown) => {
        props.store.addNotice(error instanceof Error ? error.message : String(error), true);
      });
      return;
    }
    if (key.ctrl && value === "w" && props.onCloseTab) {
      void props.onCloseTab().then((result) => {
        if (!result) {
          props.store.addNotice("Last tab: use ctrl+c to exit");
          return;
        }
        applyTabs(result);
      }, (error: unknown) => {
        props.store.addNotice(error instanceof Error ? error.message : String(error), true);
      });
      return;
    }
    if (key.meta && /^[1-9]$/.test(value) && props.onSelectTab) {
      const index = Number.parseInt(value, 10) - 1;
      void props.onSelectTab(index).then(applyTabs, (error: unknown) => {
        props.store.addNotice(error instanceof Error ? error.message : String(error), true);
      });
      return;
    }
    if (key.shift && key.tab && !busyRef.current && props.onCycleAutonomy) {
      setBusyState(true);
      void props.onCycleAutonomy().then((next) => {
        setRuntime(next);
        props.store.addNotice(`Autonomy: ${autonomyLabel(next.autonomy)}`);
      }, (error: unknown) => {
        props.store.addNotice(error instanceof Error ? error.message : String(error), true);
      }).finally(() => setBusyState(false));
      return;
    }
    if (value === "?" && input.length === 0) {
      setHelp((shown) => !shown);
      return;
    }
  });

  const submit = async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    rememberInput(value);
    setCommandCursor(0);
    if (busyRef.current) {
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
      setBusyState(true);
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
          if (result.efforts) {
            if (result.efforts.length === 0) props.store.addNotice("No reasoning effort options for this model");
            else {
              setEffortCursor(0);
              setEfforts(result.efforts);
            }
          }
          if (result.submit) await props.onSubmit(result.submit);
        }
      } catch (error) {
        props.store.addNotice(error instanceof Error ? error.message : String(error), true);
      } finally {
        setBusyState(false);
      }
      return;
    }
    setBusyState(true);
    try {
      await props.onSubmit(value);
    } finally {
      setBusyState(false);
    }
  };

  const width = Math.max(1, size.columns - 4);
  const idle = snapshot.transcript.length === 0 && snapshot.live.length === 0 && !snapshot.streaming && !snapshot.reasoning;

  return (
    <Box flexDirection="column">
      <Static key={snapshot.transcriptVersion} items={snapshot.transcript}>
        {(item) => <FeedRow key={item.id} item={item} width={width} />}
      </Static>

      <Box flexDirection="column" paddingX={1}>
        {idle && <Welcome width={width} />}

        {(() => {
          const tools = snapshot.live.filter((item) => item.kind === "tool");
          const workers = snapshot.live.filter((item): item is Extract<FeedItem, { kind: "worker" }> => item.kind === "worker");
          const runningAgents = workers.filter((item) => item.status === "running").length;
          const liveLimit = Math.max(1, Math.min(12, Math.floor((size.rows - 8) / 2)));
          const visibleWorkers = workers.slice(-liveLimit);
          const toolLimit = Math.max(1, liveLimit - visibleWorkers.length);
          const visibleTools = tools.slice(-toolLimit);
          return (
            <>
              {visibleTools.length > 0 && (
                <Box marginTop={1} flexDirection="column">
                  <Text color={theme.tool} bold>{glyph.tool} tool activity  <Text color={theme.faint}>{tools.length}</Text></Text>
                  {tools.length > visibleTools.length && <Text color={theme.faint}>  +{tools.length - visibleTools.length} more</Text>}
                  {visibleTools.map((item) => <FeedRow key={item.id} item={item} width={width} />)}
                </Box>
              )}
              {workers.length > 0 && (
                <Box marginTop={1} flexDirection="column">
                  <Text color={theme.worker} bold>
                    {glyph.worker} workers  <Text color={theme.faint}>{runningAgents}/{workers.length} running</Text>
                  </Text>
                  {workers.length > visibleWorkers.length && <Text color={theme.faint}>  +{workers.length - visibleWorkers.length} more</Text>}
                  {visibleWorkers.map((item) => <FeedRow key={item.id} item={item} width={width} />)}
                </Box>
              )}
            </>
          );
        })()}
        {snapshot.streaming && (
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.assistant} bold>
              {glyph.assistant} assistant  <Text color={theme.muted}>responding, {wordCount(snapshot.streaming)} words</Text>
            </Text>
            <Box paddingLeft={2}>
              <MarkdownBlock text={snapshot.streaming} width={Math.max(20, width - 2)} />
            </Box>
            {snapshot.citations.length > 0 && <SourcesBlock citations={snapshot.citations} width={width} />}
          </Box>
        )}

        {snapshot.reasoning && <Thinking text={snapshot.reasoning} expanded={snapshot.expandedThinking} width={width} />}

        {showPlan(snapshot.plan) && <PlanBlock plan={snapshot.plan} />}
        {snapshot.completion && <CompletionBlock completion={snapshot.completion} />}

        {help && <Help onClose={() => setHelp(false)} custom={props.customCommands ?? []} />}
        {!help && !snapshot.pendingApproval && !sessions && !models && !efforts && input.startsWith("/") && <CommandPalette entries={commandMatches} cursor={commandCursor} columns={size.columns} />}

        {!snapshot.pendingApproval && !sessions && !models && !efforts && busy && <LoadingStatus />}

        {snapshot.pendingApproval
          ? <Approval request={snapshot.pendingApproval.request} />
          : sessions
            ? <SessionPicker sessions={sessions} cursor={sessionCursor} />
            : models
              ? <ModelPicker models={models} cursor={modelCursor} />
              : efforts
                ? <EffortPicker efforts={efforts} cursor={effortCursor} model={runtime.model} />
                : <Composer value={input} onChange={handleComposerChange} onSubmit={submit} busy={busy} />}
        {tabs.length > 1 && <TabBar tabs={tabs} />}
        <Footer runtime={runtime} status={snapshot.status} busy={busy} agents={snapshot.live.filter((item) => item.kind === "worker").length} usage={snapshot.usage} contextTokens={snapshot.contextTokens} contextWindow={runtime.contextWindow} />
      </Box>
    </Box>
  );
}

// Only rendered with more than one tab, so a single-session terminal keeps the
// same quiet layout it had before tabs existed.
function TabBar({ tabs }: { tabs: TuiTabInfo[] }) {
  return (
    <Box>
      {tabs.map((tab, position) => (
        <Text key={tab.sessionId} color={tab.active ? theme.caramel : theme.faint}>
          {position > 0 ? "  " : ""}
          {tab.active ? glyph.active : tab.busy ? glyph.pending : "○"}
          {` ${tab.index + 1} ${tab.label}`}
        </Text>
      ))}
    </Box>
  );
}

function Welcome({ width }: { width: number }) {
  return (
    <Box flexDirection="column" marginBottom={1} width={Math.min(width, 72)}>
      <Text color={theme.assistant} bold>{glyph.brand} kulmi</Text>
      <Text color={theme.muted}>A focused workspace for changes, investigation, and verification.</Text>
      <Box marginTop={1}><Text color={theme.faint}>Try  </Text><Text color={theme.user}>inspect this repo and fix the highest-impact issue</Text></Box>
    </Box>
  );
}

function FeedRow({ item, width }: { item: FeedItem; width: number }) {
  if (item.kind === "user") return (
    <Box marginTop={1} flexDirection="column" paddingLeft={1}>
      <Text color={theme.user} bold>{glyph.user} you</Text>
      <Box paddingLeft={2}><Text color={theme.cream}>{item.text.trim()}</Text></Box>
    </Box>
  );
  if (item.kind === "assistant") return (
    <Box marginTop={1} flexDirection="column" paddingLeft={1}>
      <Text color={theme.assistant} bold>{glyph.assistant} assistant</Text>
      <Box paddingLeft={2}><MarkdownBlock text={item.text} width={width} /></Box>
      {item.citations && item.citations.length > 0 && <SourcesBlock citations={item.citations} width={width} />}
    </Box>
  );
  if (item.kind === "tool") return (
    <Box
      marginTop={1}
      width={Math.max(20, width)}
      borderStyle="single"
      borderColor={item.status === "error" ? theme.rose : item.status === "done" ? theme.sage : theme.tool}
      paddingX={1}
      flexDirection="column"
    >
      <Box>
        <Text color={item.status === "error" ? theme.rose : item.status === "done" ? theme.sage : theme.tool} bold>
          {item.status === "error" ? glyph.error : item.status === "done" ? glyph.success : glyph.active}{" "}
        </Text>
        <Text color={theme.tool} bold>tool</Text>
        <Text color={theme.cream}>  {item.title}</Text>
        {item.durationMs !== undefined && <Text color={theme.faint}>  {formatDuration(item.durationMs)}</Text>}
      </Box>
      {item.detail && <Text color={theme.muted}>  {clampLine(item.detail, Math.max(16, width - 6))}</Text>}
      {item.summary && <Text color={item.status === "error" ? theme.rose : theme.sage}>  result  {clampLine(item.summary, Math.max(16, width - 14))}</Text>}
      {item.diff && <Text color={theme.faint}>  diff  {item.diff}</Text>}
    </Box>
  );
  if (item.kind === "worker") return (
    <Box
      marginTop={1}
      width={Math.max(20, width)}
      borderStyle="single"
      borderColor={item.status === "running" ? theme.worker : theme.cocoa}
      paddingX={1}
      flexDirection="column"
    >
      <Box>
        <Text color={statusColor(item.status)}>{item.status === "running" ? glyph.active : item.status === "completed" ? glyph.success : glyph.error}{" "}</Text>
        <Text color={theme.worker} bold>worker</Text>
        <Text color={theme.cream}>  {clampLine(item.title, Math.max(16, width - 14))}</Text>
      </Box>
      {item.activity && <Text color={item.status === "running" ? theme.muted : theme.faint}>  {clampLine(item.activity, Math.max(16, width - 6))}</Text>}
    </Box>
  );
  const color = item.kind === "error" ? theme.rose : theme.muted;
  return <Box marginTop={1} paddingLeft={1}><Text color={color}><Text bold>{item.kind}</Text>  {item.text.trim()}</Text></Box>;
}

function SourcesBlock({ citations, width }: { citations: ReadonlyArray<WebCitation>; width: number }) {
  return (
    <Box paddingLeft={2} flexDirection="column">
      <Text color={theme.sand} bold>sources</Text>
      {citations.map((citation) => {
        const title = citation.title.trim() || citation.siteName?.trim() || citation.url;
        return (
          <Text key={citation.url} color={theme.muted}>
            · {clampLine(title, Math.max(16, width - 18))}  <Text color={theme.faint}>{clampLine(citation.url, Math.max(16, width - 18))}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function Thinking({ text, expanded, width }: { text: string; expanded: boolean; width: number }) {
  const words = text.trim().split(/\s+/).length;
  return (
    <Box paddingLeft={2} flexDirection="column">
      <Text color={theme.sand} bold>◌ reasoning  <Text color={theme.faint}>{words} words  ctrl+o</Text></Text>
      {expanded && <Text color={theme.muted} italic>{tailLines(text, 12).slice(-Math.max(80, width * 12))}</Text>}
    </Box>
  );
}

// A one-step plan that is already finished restates what the answer above
// just said. A single step still in progress is useful, so keep that.
function showPlan(plan: PlanStep[]): boolean {
  if (plan.length === 0) return false;
  if (plan.length > 1) return true;
  return plan[0]?.status !== "completed";
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
  // The framed box earns its space only when files changed: that is when the
  // file list and verification matter. A read-only answer collapses to one
  // line, since the assistant message above already carried the content.
  const readOnlyRun = completion.status === "completed" && completion.modifiedFiles.length === 0;
  if (readOnlyRun) {
    const check = completion.verificationCommands[0];
    return (
      <Box marginTop={1}>
        <Text color={theme.sage}>{glyph.success} </Text>
        <Text color={theme.faint}>{check ? `done  ·  ${check}` : "done"}</Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1} borderStyle="round" borderColor={completion.status === "completed" ? theme.sage : theme.rust} paddingX={1} flexDirection="column">
      <Text color={completion.status === "completed" ? theme.sage : theme.rose} bold>{completion.status}</Text>
      <Text color={theme.muted}>{completion.modifiedFiles.length} changed file{completion.modifiedFiles.length === 1 ? "" : "s"}</Text>
      {completion.summary && <Text color={theme.ink}>{completion.summary}</Text>}
      {completion.modifiedFiles.slice(0, 5).map((path) => <Text key={path} color={theme.faint}>· {path}</Text>)}
      {completion.verificationCommands.map((command) => <Text key={command} color={theme.sand}>✓ {command}</Text>)}
    </Box>
  );
}

function Composer({ value, onChange, onSubmit, busy }: { value: string; onChange: (value: string) => void; onSubmit: (value: string) => void; busy: boolean }) {
  const [cursor, setCursor] = useState(value.length);
  const cursorRef = useRef(value.length);
  const previousValue = useRef(value);
  const internalChange = useRef(false);
  const placeholder = busy ? "Kulmi is working. Enter to steer, Esc to stop." : "What should we build?";

  const moveCursor = (next: number, limit = value.length) => {
    const bounded = Math.max(0, Math.min(limit, next));
    cursorRef.current = bounded;
    setCursor(bounded);
  };

  useEffect(() => {
    if (previousValue.current !== value) {
      if (!internalChange.current) moveCursor(value.length);
      internalChange.current = false;
      previousValue.current = value;
    }
  }, [value]);

  useInput((input, key) => {
    if (key.upArrow || key.downArrow || key.tab || key.escape) return;
    if (key.return) {
      if (value) onSubmit(value);
      return;
    }
    if (key.leftArrow) {
      moveCursor(cursorRef.current - 1);
      return;
    }
    if (key.rightArrow) {
      moveCursor(cursorRef.current + 1);
      return;
    }
    if (key.ctrl || key.meta) {
      if (input === "a") moveCursor(0);
      else if (input === "e") moveCursor(value.length);
      else if (input === "w" && cursorRef.current > 0) {
        const end = cursorRef.current;
        let start = end;
        while (start > 0 && /\s/.test(value[start - 1] ?? "")) start -= 1;
        while (start > 0 && !/\s/.test(value[start - 1] ?? "")) start -= 1;
        internalChange.current = true;
        moveCursor(start);
        onChange(value.slice(0, start) + value.slice(end));
      }
      return;
    }
    if (key.backspace) {
      const start = cursorRef.current;
      if (start === 0) return;
      internalChange.current = true;
      moveCursor(start - 1);
      onChange(value.slice(0, start - 1) + value.slice(start));
      return;
    }
    if (key.delete) {
      const start = cursorRef.current;
      if (start >= value.length) return;
      internalChange.current = true;
      onChange(value.slice(0, start) + value.slice(start + 1));
      return;
    }
    if (!input || (input === "?" && value.length === 0)) return;
    const start = cursorRef.current;
    internalChange.current = true;
    moveCursor(start + input.length, value.length + input.length);
    onChange(value.slice(0, start) + input + value.slice(start));
  });

  return (
    <Box marginTop={busy ? 0 : 1} borderStyle="round" borderColor={busy ? theme.faint : theme.cocoa} paddingX={1}>
      <Text color={busy ? theme.faint : theme.user}>{glyph.user} </Text>
      {value.length === 0
        ? <Text color={theme.faint}>{placeholder}</Text>
        : <Text><Text>{value.slice(0, cursor)}</Text><Text inverse>{value[cursor] ?? " "}</Text><Text>{value.slice(cursor + 1)}</Text></Text>}
    </Box>
  );
}

const loadingMessage = "thinking";

const loadingFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function useLoadingStatus(active: boolean): { icon: string; message: string } {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((value) => value + 1), 80);
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
      <Text color={theme.faint}>↑↓ select  ·  enter switch  ·  esc close</Text>
    </Box>
  );
}

function EffortPicker({ efforts, cursor, model }: { efforts: string[]; cursor: number; model: string }) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor={theme.cocoa} paddingX={1} flexDirection="column">
      <Text color={theme.cream} bold>reasoning effort  <Text color={theme.faint}>{model}</Text></Text>
      {efforts.map((effort, index) => (
        <Text key={effort} color={index === cursor ? theme.sand : theme.muted} bold={index === cursor}>
          {index === cursor ? "›" : " "} {effort}
        </Text>
      ))}
      <Text color={theme.faint}>↑↓ select  ·  enter apply  ·  esc skip</Text>
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
      <Text color={theme.faint}>ctrl+t new tab  ·  alt+1..9 switch tab  ·  ctrl+w close tab</Text>
    </Box>
  );
}

function CommandPalette({ entries, cursor, columns }: { entries: ReadonlyArray<CommandEntry>; cursor: number; columns: number }) {
  if (entries.length === 0) return null;
  const twoColumns = columns >= 72;
  return (
    <Box marginTop={1} flexDirection="row" flexWrap="wrap">
      {entries.map((entry, index) => (
        <Box key={entry.name} width={twoColumns ? "50%" : "100%"}>
          <Text color={index === cursor ? theme.cream : theme.muted} bold={index === cursor}>
            {index === cursor ? "› " : "  "}<Text color={theme.sand}>{entry.name.padEnd(12)}</Text><Text color={theme.faint}>{entry.description}</Text>
          </Text>
        </Box>
      ))}
      <Box width="100%"><Text color={theme.cocoa}>↑↓ select  ·  tab complete  ·  enter run</Text></Box>
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

function Footer({ runtime, status, busy, agents, usage, contextTokens, contextWindow }: { runtime: TuiRuntimeInfo; status: string; busy: boolean; agents: number; usage: TokenUsage; contextTokens: number; contextWindow: number }) {
  const fillRatio = contextWindow > 0 ? Math.min(1, contextTokens / contextWindow) : 0;
  const fillPercent = Math.round(fillRatio * 100);
  const barWidth = 20;
  const filled = Math.round(fillRatio * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  const barColor = fillRatio >= 0.9 ? "red" : fillRatio >= 0.78 ? "yellow" : theme.faint;
  const cacheInput = usage.cacheHitTokens + usage.cacheMissTokens;
  const cachePercent = cacheInput > 0 ? Math.round(usage.cacheHitTokens / cacheInput * 100) : 0;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.faint} wrap="truncate-end">
          {runtime.model}  ·  <Text color={statusColor(status)}>{status}</Text>  ·  {runtime.mode === "task" ? "goal" : "chat"}  ·  {autonomyLabel(runtime.autonomy)}
          {agents > 0 ? `  ·  ${agents} agent${agents === 1 ? "" : "s"}` : ""}
          {"  ·  "}{busy ? "esc stop" : "? help"}
        </Text>
      </Box>
      {usage.totalTokens > 0 && (
        <Box>
          <Text color={theme.faint}>{usage.totalTokens.toLocaleString()} tokens  ·  {cachePercent}% cache</Text>
        </Box>
      )}
      {contextTokens > 0 && (
        <Box>
          <Text color={barColor}>{bar}</Text>
          <Text color={theme.faint}>  {fillPercent}% context{fillRatio >= 0.78 ? " (compacting soon)" : ""}</Text>
        </Box>
      )}
    </Box>
  );
}

function terminalSize(stdout: NodeJS.WriteStream): { columns: number; rows: number } {
  const columns = typeof stdout.columns === "number" && stdout.columns > 0 ? stdout.columns : 80;
  const rows = typeof stdout.rows === "number" && stdout.rows > 0 ? stdout.rows : 30;
  return { columns, rows };
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


function autonomyLabel(value: AutonomyLevel): string {
  if (value === "read") return "inspect";
  if (value === "low") return "edit";
  if (value === "medium") return "local dev";
  if (value === "high") return "extended";
  return "trusted";
}
