import { describe, expect, it } from "vitest";
import { describeToolCall, summarizeToolResult, toolLabel } from "../src/core/tool-summary.js";

describe("describeToolCall detail rules", () => {
  it("shows the command for shell", () => {
    expect(describeToolCall("shell", { command: "npm test -- --run" })).toEqual({
      label: "Run command",
      detail: "npm test -- --run",
    });
  });

  it("adds the requested line range to read_file", () => {
    expect(describeToolCall("read_file", { path: "src/cache.ts" }).detail).toBe("src/cache.ts");
    expect(describeToolCall("read_file", { path: "src/cache.ts", offset: 20, limit: 40 }).detail).toBe("src/cache.ts:20-59");
    expect(describeToolCall("read_file", { path: "src/cache.ts", offset: 20 }).detail).toBe("src/cache.ts:20+");
  });

  it("shows both the pattern and the searched path for grep", () => {
    expect(describeToolCall("grep", { pattern: "toolDetail", path: "src", glob: "*.ts" }).detail)
      .toBe("toolDetail in src *.ts");
    expect(describeToolCall("grep", { pattern: "toolDetail", path: "." }).detail).toBe("toolDetail");
  });

  it("shows the pattern for glob and ast_grep", () => {
    expect(describeToolCall("glob", { pattern: "src/**/*.tsx", path: "." }).detail).toBe("src/**/*.tsx");
    expect(describeToolCall("ast_grep", { pattern: "console.log($$$)" })).toEqual({
      label: "Search syntax",
      detail: "console.log($$$)",
    });
  });

  it("shows paths for single-file mutations", () => {
    expect(describeToolCall("edit_file", { path: "src/a.ts", old_text: "a", new_text: "b" }).detail).toBe("src/a.ts");
    expect(describeToolCall("write_file", { path: "src/a.ts", content: "secret file body" }).detail).toBe("src/a.ts");
    expect(describeToolCall("delete_file", { path: "src/a.ts" }).detail).toBe("src/a.ts");
    expect(describeToolCall("replace_by_line_range", { path: "src/a.ts", start_line: 4, end_line: 9 })).toEqual({
      label: "Replace lines",
      detail: "src/a.ts:4-9",
    });
  });

  it("counts the extra files for edit_files instead of rendering nothing", () => {
    expect(describeToolCall("edit_files", { files: [{ path: "src/a.ts" }] }).detail).toBe("src/a.ts");
    expect(describeToolCall("edit_files", { files: [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/c.ts" }] }).detail)
      .toBe("src/a.ts +2 more");
  });

  it("shows the lsp action with its symbol or file position", () => {
    expect(describeToolCall("lsp", { action: "symbols", symbol: "TuiStore" }).detail).toBe("symbols TuiStore");
    expect(describeToolCall("lsp", { action: "references", file: "src/tui/store.ts", line: 42, column: 3 }).detail)
      .toBe("references src/tui/store.ts:42");
  });

  it("shows the preset and a prompt excerpt for spawn_agent", () => {
    expect(describeToolCall("spawn_agent", { agent: "reviewer", prompt: "Review\nthe new formatter" }).detail)
      .toBe("reviewer Review the new formatter");
    expect(describeToolCall("spawn_agent", { agent: "tester", description: "cover the formatter" }).detail)
      .toBe("tester cover the formatter");
  });

  it("shows the process name for process tools", () => {
    expect(describeToolCall("start_process", { name: "web", command: "npm run dev" })).toEqual({
      label: "Start process",
      detail: "web",
    });
    expect(describeToolCall("process_logs", { name: "web", lines: 50 }).detail).toBe("web");
    expect(describeToolCall("stop_process", { name: "web" }).detail).toBe("web");
  });

  it("shows the query for web_search and host plus path for fetch_url", () => {
    expect(describeToolCall("web_search", { query: "ink testing library" }).detail).toBe("ink testing library");
    expect(describeToolCall("fetch_url", { url: "https://example.com/docs/api?token=x" }).detail).toBe("example.com/docs/api");
    expect(describeToolCall("fetch_url", { url: "https://example.com/" }).detail).toBe("example.com");
  });

  it("summarizes update_plan as step counts and never as raw json", () => {
    const detail = describeToolCall("update_plan", {
      steps: [
        { id: "1", title: "read", status: "completed" },
        { id: "2", title: "implement", status: "completed" },
        { id: "3", title: "verify", status: "in_progress" },
        { id: "4", title: "commit", status: "pending" },
        { id: "5", title: "ship", status: "pending" },
      ],
    }).detail;
    expect(detail).toBe("5 steps, 2 done");
    expect(detail).not.toContain("{");
  });

  it("shows the reported status for complete_task", () => {
    expect(describeToolCall("complete_task", { status: "blocked", summary: "no key" }).detail).toBe("blocked");
  });

  it("gives bridged mcp tools a readable label without guessing the server boundary", () => {
    expect(toolLabel("mcp_filesystem_read_file")).toBe("mcp: filesystem read file");
    expect(describeToolCall("mcp_echo_echo", { text: "hi" }).label).toBe("mcp: echo echo");
  });

  // config.ts allows `_` in mcp server names, so `mcp_my_server_read_file` could be
  // server `my_server` tool `read_file` or server `my` tool `server_read_file`. The
  // flat name cannot say which, so the label keeps every word rather than inventing
  // a server called `my`.
  it("never mislabels an mcp server whose name contains an underscore", () => {
    expect(toolLabel("mcp_my_server_read_file")).toBe("mcp: my server read file");
    expect(toolLabel("mcp_my_server_read_file")).not.toBe("my: server read file");
  });

  it("keeps a bare mcp prefix intact rather than emitting a dangling label", () => {
    expect(toolLabel("mcp_")).toBe("Mcp");
  });

  it("capitalizes unmapped tool labels so rows stay consistent", () => {
    expect(toolLabel("some_new_tool")).toBe("Some new tool");
  });

  it("returns empty detail for an unknown tool with an unknown input shape", () => {
    const detail = describeToolCall("some_new_tool", { steps: [{ id: "1", title: "x" }], nested: { a: 1 } }).detail;
    expect(detail).toBe("");
  });

  it("returns empty detail for non-object input", () => {
    expect(describeToolCall("inspect_plan", {}).detail).toBe("");
    expect(describeToolCall("shell", undefined).detail).toBe("");
    expect(describeToolCall("shell", "npm test").detail).toBe("");
  });

  it("caps long details", () => {
    const detail = describeToolCall("shell", { command: "echo ".repeat(80) }).detail;
    expect(detail.length).toBeLessThanOrEqual(100);
    expect(detail.endsWith("…")).toBe(true);
  });
});

describe("summarizeToolResult", () => {
  const shellOutput = (overrides: Record<string, string> = {}) =>
    [
      `exit_code: ${overrides.exit_code ?? "0"}`,
      "duration_ms: 12",
      "sandbox: none",
      `timed_out: ${overrides.timed_out ?? "false"}`,
      `truncated: ${overrides.truncated ?? "false"}`,
      "changed_files: []",
      "verification: not_applicable",
      "stdout:\nall good",
    ].join("\n");

  it("reports the shell exit code, timeout, and truncation", () => {
    expect(summarizeToolResult("shell", shellOutput(), false)).toBe("exit 0");
    expect(summarizeToolResult("shell", shellOutput({ exit_code: "1" }), true)).toBe("exit 1");
    expect(summarizeToolResult("shell", shellOutput({ exit_code: "124", timed_out: "true", truncated: "true" }), true))
      .toBe("exit 124, timed out, truncated");
  });

  it("never leaks shell stdout into the summary", () => {
    expect(summarizeToolResult("shell", shellOutput(), false)).not.toContain("all good");
  });

  it("reports a diffstat for single-file edits", () => {
    expect(summarizeToolResult("edit_file", JSON.stringify({ path: "a.ts", replacements: 1, additions: 34, deletions: 2 }), false))
      .toBe("+34 -2");
    expect(summarizeToolResult("edit_file", JSON.stringify({ path: "a.ts", replacements: 3, additions: 3, deletions: 3 }), false))
      .toBe("+3 -3, 3 replacements");
    expect(summarizeToolResult("write_file", JSON.stringify({ path: "a.ts", bytes: 90, additions: 9, deletions: 0 }), false))
      .toBe("+9 -0");
    expect(summarizeToolResult("edit_file", JSON.stringify({ path: "a.ts", unchanged: true }), false)).toBe("unchanged");
    expect(summarizeToolResult("delete_file", JSON.stringify({ path: "a.ts", deleted: true }), false)).toBe("deleted");
  });

  it("reports file count and totals for the batch edit form", () => {
    const output = JSON.stringify({
      files: [
        { path: "a.ts", unchanged: false, replacements: 1, additions: 4, deletions: 1 },
        { path: "b.ts", unchanged: false, replacements: 2, additions: 6, deletions: 3 },
      ],
      changed_files: 2,
    });
    expect(summarizeToolResult("edit_files", output, false)).toBe("2 files, +10 -4");
  });

  it("reports line counts for read_file", () => {
    expect(summarizeToolResult("read_file", "1\tconst a = 1;\n\n[1 of 240 lines, sha256:abc123]", false)).toBe("1 of 240 lines");
    expect(summarizeToolResult("read_file", "…\n\n[structural summary; 80 of 801 lines shown; sha256:abc]", false))
      .toBe("80 of 801 lines");
  });

  it("reports match and file counts for grep", () => {
    const output = ["./src/a.ts:1:hit", "./src/a.ts:9:hit", "./src/b.ts:3:hit"].join("\n");
    expect(summarizeToolResult("grep", output, false)).toBe("3 matches in 2 files");
    expect(summarizeToolResult("grep", `${output}\n[truncated]`, false)).toBe("3 matches in 2 files, truncated");
    expect(summarizeToolResult("grep", "no matches", false)).toBe("no matches");
  });

  it("reports file counts for glob", () => {
    expect(summarizeToolResult("glob", "src/a.ts\nsrc/b.ts", false)).toBe("2 files");
    expect(summarizeToolResult("glob", "src/a.ts", false)).toBe("1 file");
    expect(summarizeToolResult("glob", "no matches", false)).toBe("no matches");
  });

  it("reports plan and completion status", () => {
    expect(summarizeToolResult("update_plan", JSON.stringify({ accepted: true, step_count: 5, completed: 2 }), false))
      .toBe("5 steps, 2 done");
    expect(summarizeToolResult("complete_task", JSON.stringify({ accepted: true, status: "completed" }), false))
      .toBe("completed");
  });

  it("collapses and truncates error output", () => {
    expect(summarizeToolResult("read_file", "ENOENT\nmissing final file", true)).toBe("ENOENT missing final file");
    const long = summarizeToolResult("some_new_tool", "x".repeat(400), true);
    expect(long.length).toBe(120);
    expect(long.endsWith("…")).toBe(true);
  });

  it("returns an empty summary for unrecognized successful output", () => {
    expect(summarizeToolResult("some_new_tool", "whatever the server said", false)).toBe("");
    expect(summarizeToolResult("lsp", "src/a.ts:1:1", false)).toBe("");
  });
});
