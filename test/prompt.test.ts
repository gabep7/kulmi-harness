import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/agent/prompt.js";

describe("system prompt", () => {
  it("keeps each mode aligned with the tools it receives", () => {
    const chat = prompt("chat");
    const task = prompt("task");
    const worker = prompt("subagent", true);

    expect(chat).toContain("call start_task once");
    expect(chat).toContain("assume they mean the current workspace");
    expect(chat).toContain("asks for improvements/review");
    expect(task).toContain("Finish only through complete_task");
    expect(task).not.toContain("call start_task once");
    expect(task).toContain("Use worker presets sparingly");
    expect(worker).toContain("Worker mode");
    expect(worker).toContain("start_task, update_plan, complete_task, and child-agent tools are unavailable");
    expect(worker).toContain("Finish only through report_worker");
    expect(worker).toContain("This worker is read-only");
  });

  it("is deterministic, compact, and preserves repository instructions", () => {
    const first = prompt("task");
    const second = prompt("task");
    expect(first).toBe(second);
    expect(first).toContain("PROJECT CONTRACT");
    expect(first).toContain("- release: Verify a release");
    expect(Buffer.byteLength(first, "utf8")).toBeLessThan(2_400);
  });
});

function prompt(mode: "chat" | "task" | "subagent", readOnly = false): string {
  return buildSystemPrompt({
    mode,
    readOnly,
    projectInstructions: "PROJECT CONTRACT",
    skillsInventory: "- release: Verify a release",
  });
}
