import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// The MCP SDK costs roughly 20MB of resident memory. The controller must only
// import it when the user actually configured servers, and the empty-list
// short circuit must still satisfy the McpConnection contract used at the
// registry and dispose call sites.
describe("controller MCP laziness", () => {
  it("does not import the MCP client at module scope", async () => {
    const source = await readFile(resolve("src/runtime/controller.ts"), "utf8");
    const staticImport = /^import\s+\{[^}]*connectMcpServers[^}]*\}\s+from\s+"\.\.\/mcp\/client\.js"/m;
    expect(source).not.toMatch(staticImport);
    expect(source).toMatch(/await import\("\.\.\/mcp\/client\.js"\)/);
  });

  it("imports the controller for well under the cost of eager SDK loading", async () => {
    // Measured in a clean child process against the built output. Eagerly
    // importing the MCP SDK put this near 100MB; the ceiling here is a
    // regression alarm, not a precise target.
    const script = [
      'const mod = await import("./dist/runtime/controller.js");',
      'const after = process.memoryUsage().rss;',
      'if (typeof mod.SessionController !== "function") throw new Error("controller export missing");',
      'process.stdout.write(String(Math.round(after / 1048576)));',
    ].join("\n");
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script], { cwd: resolve(".") });
    const rssMb = Number.parseInt(stdout.trim(), 10);
    expect(Number.isFinite(rssMb)).toBe(true);
    expect(rssMb).toBeLessThan(90);
  });

  it("keeps the empty connection compatible with the McpConnection contract", async () => {
    const source = await readFile(resolve("src/runtime/controller.ts"), "utf8");
    expect(source).toMatch(/configs\.length === 0/);
    // tools/errors are spread into the registry and dispose() is awaited on
    // teardown, so all three members must exist.
    expect(source).toMatch(/tools: \[\], errors: \[\], async dispose\(\)/);
  });
});
