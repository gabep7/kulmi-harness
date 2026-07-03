import { z } from "zod";
import { combineDiffs } from "../core/diff.js";
import { decideCommand } from "../security/policy.js";
import { runShell } from "../runtime/process.js";
import { WorkspaceSnapshot } from "../runtime/workspace-tracker.js";
import { defineTool } from "./types.js";

export const shellTool = defineTool({
  name: "shell",
  description:
    "Run one non-interactive shell command in the workspace. Destructive commands, sudo, remote writes, nested shells, and command substitution are hard-blocked.",
  schema: z.object({
    command: z.string().min(1),
    timeout_seconds: z.number().int().positive().max(1_800).optional(),
  }),
  readOnly: false,
  async execute(context, input) {
    const decision = decideCommand(input.command, context.autonomy, context.workspaceRoot);
    let approvedDenial = false;
    if (!decision.allowed) {
      const approvable = context.autonomy !== "read" && context.permissions && isApprovableDenial(decision.reason);
      const approved = approvable ? await context.permissions!.request({
        tool: "shell",
        risk: decision.risk === "read" || decision.risk === "blocked" ? "high" : decision.risk,
        reason: decision.reason,
        command: input.command,
        input,
      }) : false;
      if (!approved) {
        return { content: JSON.stringify({ blocked: true, risk: decision.risk, reason: decision.reason }), isError: true };
      }
      approvedDenial = true;
    }
    const snapshot = decision.risk === "read" && !approvedDenial
      ? undefined
      : await WorkspaceSnapshot.capture(context.workspaceRoot);
    let result: Awaited<ReturnType<typeof runShell>> | undefined;
    let diff: string | undefined;
    let changedFiles: string[] = [];
    try {
      result = await runShell({
        command: input.command,
        cwd: context.cwd,
        workspaceRoot: context.workspaceRoot,
        sandbox: context.sandbox ?? { mode: "required", network: false },
        signal: context.signal,
        timeoutMs: (input.timeout_seconds ?? context.commandTimeoutMs / 1_000) * 1_000,
        maxOutputBytes: context.maxOutputBytes,
      });
    } finally {
      if (snapshot) {
        const changes = await snapshot.reconcileChanges(context.checkpoint);
        const changed = changes.map((change) => change.path);
        changedFiles = changed;
        diff = combineDiffs(changes.flatMap((change) => change.diff ? [change.diff] : []));
        if (changed.length > 0) {
          for (const path of changed) context.state.modifiedFiles.add(path);
          context.state.revision += 1;
          delete context.state.completion;
        }
      }
    }
    if (!result) throw new Error("command did not produce a result");
    const verificationRecorded = decision.verification && changedFiles.length === 0;
    if (verificationRecorded) {
      context.state.verifications.push({
        command: input.command,
        exitCode: result.exitCode,
        timestamp: new Date().toISOString(),
        revision: context.state.revision,
        timedOut: result.timedOut,
        truncated: result.truncated,
        changedFiles: [...context.state.modifiedFiles].sort(),
      });
    }
    const content = [
      `exit_code: ${result.exitCode}`,
      `duration_ms: ${result.durationMs}`,
      `sandbox: ${result.sandbox}`,
      `timed_out: ${result.timedOut}`,
      `truncated: ${result.truncated}`,
      `changed_files: ${JSON.stringify(changedFiles)}`,
      `verification: ${decision.verification ? verificationRecorded ? "recorded" : "not_recorded_changes_detected" : "not_applicable"}`,
      result.stdout ? `stdout:\n${result.stdout}` : "",
      result.stderr ? `stderr:\n${result.stderr}` : "",
    ].filter(Boolean).join("\n");
    return {
      content,
      isError: result.exitCode !== 0,
      mutated: changedFiles.length > 0,
      ...(diff ? { diff } : {}),
    };
  },
});

function isApprovableDenial(reason: string): boolean {
  return !/(?:cannot safely parse|command substitution|nested shell|environment assignment|operator .* blocked|missing program|empty command)/i.test(reason);
}
