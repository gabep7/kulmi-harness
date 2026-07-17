import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HooksConfig, SandboxConfig } from "../config/config.js";
import { runShell } from "./process.js";
import type { ToolResult } from "../tools/types.js";

/** Soft cap so hook env stays well under ARG_MAX even with sandbox env overhead. */
export const MAX_HOOK_ENV_BYTES = 48 * 1024;

export interface HookInput {
  phase: "tool_pre" | "tool_post";
  tool: string;
  callId: string;
  agentId: string;
  cwd: string;
  workspaceRoot: string;
  sandbox?: SandboxConfig;
  signal: AbortSignal;
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

  const tempFiles: string[] = [];
  try {
    const toolInput = await packHookPayload(
      "KULMI_TOOL_INPUT",
      JSON.stringify(input.input),
      input,
      tempFiles,
    );
    const toolResult = input.result
      ? await packHookPayload(
        "KULMI_TOOL_RESULT",
        JSON.stringify({ content: input.result.content, isError: input.result.isError ?? false }),
        input,
        tempFiles,
      )
      : undefined;

    const outputs: string[] = [];
    for (const hook of hooks) {
      const env: NodeJS.ProcessEnv = {
        KULMI_HOOK_PHASE: input.phase,
        KULMI_HOOK_TOOL: input.tool,
        KULMI_HOOK_CALL_ID: input.callId,
        KULMI_HOOK_AGENT_ID: input.agentId,
        KULMI_WORKSPACE_ROOT: input.workspaceRoot,
        ...toolInput,
        ...(toolResult ?? {}),
      };
      try {
        const result = await runShell({
          command: hook.command,
          cwd: input.cwd,
          workspaceRoot: input.workspaceRoot,
          ...(input.sandbox ? { sandbox: input.sandbox } : {}),
          env,
          signal: input.signal,
          timeoutMs: hook.timeoutSeconds * 1_000,
          maxOutputBytes: 64 * 1024,
        });
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        if (result.exitCode !== 0 || result.timedOut) {
          const failure = result.timedOut
            ? `hook timed out after ${hook.timeoutSeconds} seconds`
            : `hook exited with code ${result.exitCode}`;
          outputs.push(`${hook.command}\n${[failure, output].filter(Boolean).join("\n")}`);
          return { ok: false, output: outputs.join("\n\n") };
        }
        if (output) outputs.push(`${hook.command}\n${output}`);
      } catch (error) {
        const output = error instanceof Error ? error.message : String(error);
        outputs.push(`${hook.command}\n${output}`);
        return { ok: false, output: outputs.join("\n\n") };
      }
    }
    return { ok: true, output: outputs.join("\n\n") };
  } finally {
    await Promise.all(tempFiles.map((path) => unlink(path).catch(() => undefined)));
  }
}

async function packHookPayload(
  envName: string,
  serialized: string,
  input: HookInput,
  tempFiles: string[],
): Promise<NodeJS.ProcessEnv> {
  if (Buffer.byteLength(serialized, "utf8") <= MAX_HOOK_ENV_BYTES) {
    return { [envName]: serialized };
  }

  const safeCallId = input.callId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "hook";
  const dir = join(input.workspaceRoot, ".kulmi", "hooks");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${safeCallId}-${envName.toLowerCase()}.json`);
  await writeFile(path, serialized, { encoding: "utf8", mode: 0o600 });
  tempFiles.push(path);
  return {
    [envName]: `[payload spilled to ${envName}_FILE; ${Buffer.byteLength(serialized, "utf8")} bytes]`,
    [`${envName}_FILE`]: path,
  };
}
