import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// The MCP SDK costs roughly 20MB of resident memory, so the controller loads it
// on demand. These tests pin both branches of that decision: no servers must
// stay cheap, and configured servers must still produce working tools.
describe("controller MCP laziness", () => {
  it("does not import the MCP client at module scope", async () => {
    const source = await readFile(resolve("src/runtime/controller.ts"), "utf8");
    const staticImport = /^import\s+\{[^}]*connectMcpServers[^}]*\}\s+from\s+"\.\.\/mcp\/client\.js"/m;
    expect(source).not.toMatch(staticImport);
    expect(source).toMatch(/await import\("\.\.\/mcp\/client\.js"\)/);
  });

  it("imports the controller for well under the cost of eager SDK loading", async () => {
    // Measured in a clean child process against the built output. Eagerly
    // importing the MCP SDK put this near 100MB; the ceiling is a regression
    // alarm, not a precise target.
    const script = [
      'const mod = await import("./dist/runtime/controller.js");',
      'if (typeof mod.SessionController !== "function") throw new Error("controller export missing");',
      'process.stdout.write(String(Math.round(process.memoryUsage().rss / 1048576)));',
    ].join("\n");
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script], { cwd: resolve(".") });
    const rssMb = Number.parseInt(stdout.trim(), 10);
    expect(Number.isFinite(rssMb)).toBe(true);
    expect(rssMb).toBeLessThan(90);
  });

  it("still registers working tools when servers are configured", { timeout: 60_000 }, async () => {
    // The lazy wrapper only pays off if the non-empty branch still connects.
    // Exercised against the real client and echo fixture, since a mocked
    // connection would not prove the dynamic import resolves.
    const { connectMcpServers } = await import("../src/mcp/client.js");
    const connection = await connectMcpServers(
      [{ name: "lazycheck", command: process.execPath, args: ["--import", "tsx", resolve("test/fixtures/mcp-echo-server.ts"), "lazycheck"] }],
      { cwd: resolve(".") },
    );
    try {
      expect(connection.errors).toEqual([]);
      const echo = connection.tools.find((tool) => tool.name === "mcp_lazycheck_echo");
      expect(echo).toBeDefined();
      if (!echo) throw new Error("echo tool missing");
      const result = await echo.execute(
        { signal: new AbortController().signal } as Parameters<typeof echo.execute>[0],
        { text: "lazy-ok" },
      );
      expect(result.content).toBe("echo: lazy-ok");
    } finally {
      await connection.dispose();
    }
  });
});
