import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

describe("process crash recovery", () => {
  it("repairs an interrupted non-idempotent tool call without replaying it", async () => {
    const data = await mkdtemp(join(tmpdir(), "kulmi-crash-data-"));
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-crash-workspace-"));
    const marker = join(data, "mutation-started");
    const output = join(data, "recovery-request.json");
    const fixture = resolve("test/fixtures/interrupted-tool-process.ts");
    const env = { ...process.env, XDG_DATA_HOME: data };
    const child = spawn(process.execPath, ["--import", "tsx", fixture, "crash", workspace, marker, output], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    await waitForFile(marker, child, () => stderr);
    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));

    await exec(process.execPath, ["--import", "tsx", fixture, "resume", workspace, marker, output], {
      cwd: process.cwd(),
      env,
    });
    const messages = JSON.parse(await readFile(output, "utf8")) as Array<Record<string, unknown>>;
    const repaired = messages.find((message) => message.role === "tool" && message.tool_call_id === "call_mutate");
    expect(repaired?.content).toContain("outcome is uncertain");
    expect(messages.filter((message) => message.role === "tool" && message.tool_call_id === "call_mutate")).toHaveLength(1);
    expect(await readFile(marker, "utf8")).toBe("started\n");
  }, 15_000);
});

async function waitForFile(path: string, child: ReturnType<typeof spawn>, stderr: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      if (child.exitCode !== null) throw new Error(`fixture exited before mutation: ${stderr()}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  child.kill("SIGKILL");
  throw new Error(`timed out waiting for interrupted mutation: ${stderr()}`);
}
