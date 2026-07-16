import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { connectMcpServers, type McpConnection } from "../src/mcp/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/types.js";

const exec = promisify(execFile);
const fixture = resolve("test/fixtures/mcp-echo-server.ts");
const connections: McpConnection[] = [];

function fixtureServer(name: string, marker: string) {
  return { name, command: process.execPath, args: ["--import", "tsx", fixture, marker] };
}

async function connectFixture(name: string, marker: string): Promise<McpConnection> {
  const connection = await connectMcpServers([fixtureServer(name, marker)], { cwd: process.cwd() });
  connections.push(connection);
  return connection;
}

function toolContext(): ToolContext {
  return { signal: new AbortController().signal } as ToolContext;
}

async function markerAlive(marker: string): Promise<boolean> {
  try {
    await exec("pgrep", ["-f", marker]);
    return true;
  } catch {
    return false;
  }
}

afterAll(async () => {
  await Promise.all(connections.map((connection) => connection.dispose()));
});

describe("mcp client", () => {
  it("bridges fixture tools and round-trips calls", { timeout: 30_000 }, async () => {
    const connection = await connectFixture("echo", randomUUID());

    expect(connection.errors).toEqual([]);
    expect(connection.tools.map((tool) => tool.name).sort()).toEqual(["mcp_echo_add", "mcp_echo_echo"]);

    const echo = connection.tools.find((tool) => tool.name === "mcp_echo_echo")!;
    expect(echo.description).toBe("[echo] Echo back the provided text.");
    expect(echo.readOnly).toBe(true);
    expect(echo.inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
    });

    const add = connection.tools.find((tool) => tool.name === "mcp_echo_add")!;
    expect(add.description).toBe("[echo] Add two numbers.");
    expect(add.readOnly).toBe(false);

    const echoed = await echo.execute(toolContext(), { text: "hello mcp" });
    expect(echoed.content).toBe("echo: hello mcp");
    expect(echoed.isError).toBeUndefined();

    const sum = await add.execute(toolContext(), { a: 2, b: 3 });
    expect(sum.content).toBe("5");

    const registry = new ToolRegistry(connection.tools);
    const provided = registry.providerTools().find((tool) => tool.function.name === "mcp_echo_echo")!;
    expect(provided.function.parameters).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
    });
  });

  it("collects failures per server without throwing and still connects the rest", { timeout: 30_000 }, async () => {
    const connection = await connectMcpServers(
      [
        { name: "missing", command: "/definitely/not/a/real/command" },
        fixtureServer("echo", randomUUID()),
      ],
      { cwd: process.cwd(), timeoutMs: 20_000 },
    );
    connections.push(connection);

    expect(connection.errors).toHaveLength(1);
    expect(connection.errors[0]).toContain("mcp server missing");
    expect(connection.tools.map((tool) => tool.name).sort()).toEqual(["mcp_echo_add", "mcp_echo_echo"]);
  });

  it("dispose terminates the child and is safe to call twice", { timeout: 30_000 }, async () => {
    const marker = randomUUID();
    const connection = await connectFixture("echo", marker);
    expect(await markerAlive(marker)).toBe(true);

    await connection.dispose();
    // Real delay by necessity: the child dies asynchronously at the OS level
    // after transport close, and no in-process event signals its exit here.
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
      alive = await markerAlive(marker);
      if (alive) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 100);
        await promise;
      }
    }
    expect(alive).toBe(false);

    await expect(connection.dispose()).resolves.toBeUndefined();
  });
});
