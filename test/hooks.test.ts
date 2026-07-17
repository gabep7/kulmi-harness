import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_HOOK_ENV_BYTES, runToolHooks } from "../src/runtime/hooks.js";

describe("runToolHooks payload bounds", () => {
  const temps: string[] = [];

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("keeps small tool input inline in the environment", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-hooks-small-"));
    temps.push(workspace);
    const result = await runToolHooks(
      {
        toolPre: [{
          command: `printf '%s' "$KULMI_TOOL_INPUT" > input.txt; printf '%s' "\${KULMI_TOOL_INPUT_FILE-}" > file.txt`,
          timeoutSeconds: 5,
        }],
        toolPost: [],
      },
      {
        phase: "tool_pre",
        tool: "write_file",
        callId: "call_small",
        agentId: "agent_1",
        cwd: workspace,
        workspaceRoot: workspace,
        sandbox: { mode: "off", network: false },
        signal: new AbortController().signal,
        input: { path: "a.ts", content: "hello" },
      },
    );

    expect(result.ok).toBe(true);
    expect(await readFile(join(workspace, "input.txt"), "utf8")).toBe("{\"path\":\"a.ts\",\"content\":\"hello\"}");
    expect(await readFile(join(workspace, "file.txt"), "utf8")).toBe("");
  });

  it("spills oversized tool input to a workspace tempfile and bounds the env value", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-hooks-large-"));
    temps.push(workspace);
    const content = "x".repeat(MAX_HOOK_ENV_BYTES + 1_024);
    const result = await runToolHooks(
      {
        toolPre: [{
          command: [
            `printf '%s' "$KULMI_TOOL_INPUT" > env.txt`,
            `printf '%s' "$KULMI_TOOL_INPUT_FILE" > path.txt`,
            `cp "$KULMI_TOOL_INPUT_FILE" payload.json`,
          ].join(" && "),
          timeoutSeconds: 5,
        }],
        toolPost: [],
      },
      {
        phase: "tool_pre",
        tool: "write_file",
        callId: "call_large",
        agentId: "agent_1",
        cwd: workspace,
        workspaceRoot: workspace,
        sandbox: { mode: "off", network: false },
        signal: new AbortController().signal,
        input: { path: "big.ts", content },
      },
    );

    expect(result.ok).toBe(true);
    const envValue = await readFile(join(workspace, "env.txt"), "utf8");
    expect(Buffer.byteLength(envValue, "utf8")).toBeLessThan(MAX_HOOK_ENV_BYTES);
    expect(envValue).toContain("payload spilled");
    const spilledPath = (await readFile(join(workspace, "path.txt"), "utf8")).trim();
    expect(spilledPath).toContain(join(workspace, ".kulmi", "hooks"));
    const payload = JSON.parse(await readFile(join(workspace, "payload.json"), "utf8")) as { content: string };
    expect(payload.content).toBe(content);
    await expect(access(spilledPath)).rejects.toThrow();
  });
});
