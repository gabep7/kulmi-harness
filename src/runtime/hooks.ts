import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { disposeChildEnvironment, safeChildEnvironment } from "../security/environment.js";
import type { HooksConfig } from "../config/config.js";
import type { ToolResult } from "../tools/types.js";

const execFileAsync = promisify(execFile);

export interface HookInput {
  phase: "tool_pre" | "tool_post";
  tool: string;
  callId: string;
  agentId: string;
  cwd: string;
  workspaceRoot: string;
  input: unknown;
  result?: ToolResult;
}

export interface HookRunResult {
  ok: boolean;
  output: string;
}

export async function runToolHooks(config: HooksConfig, input: HookInput): Promise<HookRunResult> {
  const hooks = (input.phase === "tool_pre" ? config.toolPre : config.toolPost)
    .filter((hook) => !hook.tool || hook.tool === input.tool);
  if (hooks.length === 0) return { ok: true, output: "" };
  const outputs: string[] = [];
  for (const hook of hooks) {
    const env = safeChildEnvironment({
      KULMI_HOOK_PHASE: input.phase,
      KULMI_HOOK_TOOL: input.tool,
      KULMI_HOOK_CALL_ID: input.callId,
      KULMI_HOOK_AGENT_ID: input.agentId,
      KULMI_WORKSPACE_ROOT: input.workspaceRoot,
      KULMI_TOOL_INPUT: JSON.stringify(input.input),
      ...(input.result ? { KULMI_TOOL_RESULT: JSON.stringify({ content: input.result.content, isError: input.result.isError ?? false }) } : {}),
    });
    try {
      const { stdout, stderr } = await execFileAsync("/bin/bash", ["--noprofile", "--norc", "-c", hook.command], {
        cwd: input.cwd,
        env,
        timeout: hook.timeoutSeconds * 1_000,
        maxBuffer: 64 * 1024,
      });
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      if (output) outputs.push(`${hook.command}\n${output}`);
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error);
      outputs.push(`${hook.command}\n${output}`);
      return { ok: false, output: outputs.join("\n\n") };
    } finally {
      disposeChildEnvironment(env);
    }
  }
  return { ok: true, output: outputs.join("\n\n") };
}
