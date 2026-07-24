// Single source of truth for how a tool call is described and how its result is
// summarized. Both the TUI feed and the headless renderer consume this so the two
// surfaces cannot drift, and so neither one ever falls back to dumping raw JSON
// input or raw tool output into the terminal.

export interface ToolCallDescription {
  label: string;
  detail: string;
}

const MAX_DETAIL = 100;
const MAX_SUMMARY = 72;
const MAX_ERROR = 120;

const TOOL_LABELS: Record<string, string> = {
  read_file: "Read file",
  glob: "Find files",
  grep: "Search code",
  ast_grep: "Search syntax",
  write_file: "Write file",
  edit_file: "Edit file",
  edit_files: "Edit files",
  replace_by_line_range: "Replace lines",
  delete_file: "Delete file",
  shell: "Run command",
  lsp: "Code intel",
  web_search: "Search web",
  fetch_url: "Fetch page",
  browser_qa: "Browser QA",
  attach_image: "Attach image",
  list_conflicts: "List conflicts",
  read_conflict: "Read conflict",
  resolve_conflict: "Resolve conflict",
  commit_changes: "Commit changes",
  create_pull_request: "Open pull request",
  spawn_agent: "Start worker",
  wait_agents: "Wait for workers",
  inspect_agent: "Inspect worker",
  steer_agent: "Steer worker",
  integrate_agent: "Integrate worker",
  cancel_agent: "Cancel worker",
  retry_agent: "Retry worker",
  update_plan: "Update plan",
  inspect_plan: "Inspect plan",
  complete_task: "Complete task",
  report_worker: "Report worker",
  start_task: "Start task",
  read_skill: "Read skill",
  read_rule: "Read rule",
  read_artifact: "Read artifact",
  save_memory: "Save memory",
  read_memory: "Read memory",
  list_memory: "List memory",
  start_process: "Start process",
  process_logs: "Process logs",
  send_process_input: "Send to process",
  stop_process: "Stop process",
  list_processes: "List processes",
};

// Keys worth showing for a tool this module does not know about (including MCP
// bridged tools). Deliberately narrow: an unrecognized shape yields no detail
// rather than a JSON dump.
const GENERIC_DETAIL_KEYS = ["command", "path", "file", "pattern", "query", "url", "name", "job_id", "artifact_id"] as const;

const DETAIL_RULES: Record<string, (input: Record<string, unknown>) => string | undefined> = {
  shell: (input) => text(input.command),
  read_file: (input) => {
    const path = text(input.path);
    if (!path) return undefined;
    const offset = count(input.offset);
    const limit = count(input.limit);
    if (offset === undefined && limit === undefined) return path;
    const start = offset ?? 1;
    return limit === undefined ? `${path}:${start}+` : `${path}:${start}-${start + limit - 1}`;
  },
  grep: (input) => {
    const pattern = text(input.pattern);
    if (!pattern) return undefined;
    const where = [text(input.path), text(input.glob)].filter((part) => part && part !== ".").join(" ");
    return where ? `${pattern}  in ${where}` : pattern;
  },
  glob: (input) => text(input.pattern),
  ast_grep: (input) => text(input.pattern),
  write_file: (input) => text(input.path),
  edit_file: (input) => text(input.path),
  delete_file: (input) => text(input.path),
  read_conflict: (input) => text(input.path),
  resolve_conflict: (input) => text(input.path),
  attach_image: (input) => text(input.path),
  replace_by_line_range: (input) => {
    const path = text(input.path);
    if (!path) return undefined;
    const start = count(input.start_line);
    const end = count(input.end_line);
    return start !== undefined && end !== undefined ? `${path}:${start}-${end}` : path;
  },
  edit_files: (input) => {
    const files = list(input.files).map((file) => text(file.path)).filter((path): path is string => path !== undefined);
    if (files.length === 0) return undefined;
    return files.length > 1 ? `${files[0]}  +${files.length - 1} more` : files[0];
  },
  lsp: (input) => {
    const file = text(input.file);
    const line = count(input.line);
    const target = text(input.symbol) ?? (file && line !== undefined ? `${file}:${line}` : file);
    return [text(input.action), target].filter(Boolean).join("  ") || undefined;
  },
  spawn_agent: (input) =>
    [text(input.agent), text(input.description) ?? text(input.prompt)].filter(Boolean).join("  ") || undefined,
  wait_agents: (input) => {
    const jobs = Array.isArray(input.job_ids) ? input.job_ids.length : 0;
    return jobs > 0 ? `${jobs} workers` : "all workers";
  },
  inspect_agent: (input) => text(input.job_id),
  steer_agent: (input) => text(input.job_id),
  integrate_agent: (input) => text(input.job_id),
  cancel_agent: (input) => text(input.job_id),
  retry_agent: (input) => text(input.job_id),
  start_process: (input) => text(input.name),
  process_logs: (input) => text(input.name),
  send_process_input: (input) => text(input.name),
  stop_process: (input) => text(input.name),
  list_processes: () => undefined,
  save_memory: (input) => text(input.name),
  read_memory: (input) => text(input.name),
  list_memory: (input) => text(input.tag),
  read_skill: (input) => text(input.name),
  read_rule: (input) => text(input.name),
  read_artifact: (input) => text(input.artifact_id),
  web_search: (input) => text(input.query),
  fetch_url: (input) => shortUrl(text(input.url)),
  browser_qa: (input) => shortUrl(text(input.url)),
  commit_changes: (input) => text(input.message),
  create_pull_request: (input) => text(input.title),
  start_task: (input) => text(input.goal),
  update_plan: (input) => {
    const steps = list(input.steps);
    if (steps.length === 0) return undefined;
    const done = steps.filter((step) => step.status === "completed").length;
    return done > 0 ? `${steps.length} steps, ${done} done` : `${steps.length} steps`;
  },
  inspect_plan: () => undefined,
  complete_task: (input) => text(input.status),
  report_worker: (input) => text(input.status),
};

const SUMMARY_RULES: Record<string, (output: string) => string | undefined> = {
  shell: (output) => {
    const exit = /^exit_code: (-?\d+)$/m.exec(output);
    if (!exit) return undefined;
    const parts = [`exit ${exit[1]}`];
    if (/^timed_out: true$/m.test(output)) parts.push("timed out");
    if (/^truncated: true$/m.test(output)) parts.push("truncated");
    return parts.join(", ");
  },
  read_file: (output) => {
    const footer = /(\d+) of (\d+) lines/.exec(output.slice(-320));
    return footer ? `${footer[1]} of ${footer[2]} lines` : undefined;
  },
  grep: (output) => {
    if (output.startsWith("no matches")) return "no matches";
    const files = new Set<string>();
    let matches = 0;
    for (const line of output.split("\n")) {
      const hit = /^(.+?):\d+:/.exec(line);
      if (!hit) continue;
      matches += 1;
      files.add(hit[1] as string);
    }
    if (matches === 0) return undefined;
    const summary = `${plural(matches, "match", "matches")} in ${plural(files.size, "file")}`;
    return output.includes("\n[truncated]") ? `${summary}, truncated` : summary;
  },
  glob: (output) => {
    if (output.startsWith("no matches")) return "no matches";
    const files = output.split("\n").filter((line) => line.length > 0 && !line.startsWith("[truncated")).length;
    return files > 0 ? plural(files, "file") : undefined;
  },
  write_file: (output) => diffstat(parseObject(output)),
  edit_file: (output) => diffstat(parseObject(output)),
  replace_by_line_range: (output) => diffstat(parseObject(output)),
  delete_file: (output) => diffstat(parseObject(output)),
  edit_files: (output) => {
    const parsed = parseObject(output);
    if (!parsed) return undefined;
    if (parsed.unchanged === true) return "unchanged";
    const files = list(parsed.files);
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      additions += count(file.additions) ?? 0;
      deletions += count(file.deletions) ?? 0;
    }
    const changed = count(parsed.changed_files) ?? files.filter((file) => file.unchanged !== true).length;
    if (changed === 0 && files.length === 0) return undefined;
    return `${plural(changed, "file")}, +${additions} -${deletions}`;
  },
  update_plan: (output) => {
    const parsed = parseObject(output);
    const steps = count(parsed?.step_count);
    if (steps === undefined) return undefined;
    return `${plural(steps, "step")}, ${count(parsed?.completed) ?? 0} done`;
  },
  complete_task: (output) => text(parseObject(output)?.status),
  report_worker: (output) => text(parseObject(output)?.status),
};

export function describeToolCall(tool: string, input: unknown): ToolCallDescription {
  return { label: toolLabel(tool), detail: toolDetail(tool, input) };
}

export function summarizeToolResult(tool: string, output: string, isError: boolean): string {
  const summary = SUMMARY_RULES[tool]?.(output);
  if (summary) return clamp(summary, MAX_SUMMARY);
  return isError ? clamp(output, MAX_ERROR) : "";
}

export function toolLabel(tool: string): string {
  const known = TOOL_LABELS[tool];
  if (known) return known;
  const bridged = /^mcp_([^_]+)_(.+)$/.exec(tool);
  if (bridged) return `${bridged[1]}: ${(bridged[2] as string).replaceAll("_", " ")}`;
  const words = tool.replaceAll("_", " ").trim();
  return words ? `${words[0]?.toUpperCase()}${words.slice(1)}` : tool;
}

function toolDetail(tool: string, input: unknown): string {
  const fields = asRecord(input);
  if (!fields) return "";
  const rule = DETAIL_RULES[tool];
  const detail = rule ? rule(fields) : genericDetail(fields);
  return detail ? clamp(detail, MAX_DETAIL) : "";
}

function genericDetail(fields: Record<string, unknown>): string | undefined {
  for (const key of GENERIC_DETAIL_KEYS) {
    const value = text(fields[key]);
    if (value) return value;
  }
  return undefined;
}

function diffstat(fields: Record<string, unknown> | undefined): string | undefined {
  if (!fields) return undefined;
  if (fields.deleted === true) return "deleted";
  if (fields.unchanged === true) return "unchanged";
  const additions = count(fields.additions);
  const deletions = count(fields.deletions);
  if (additions === undefined && deletions === undefined) return undefined;
  const replacements = count(fields.replacements) ?? 0;
  const stat = `+${additions ?? 0} -${deletions ?? 0}`;
  return replacements > 1 ? `${stat}, ${replacements} replacements` : stat;
}

function shortUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value.replace(/^https?:\/\//, "");
  }
}

function parseObject(output: string): Record<string, unknown> | undefined {
  const trimmed = output.trimStart();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function list(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    return record ? [record] : [];
  });
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function plural(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function clamp(value: string, limit: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}
