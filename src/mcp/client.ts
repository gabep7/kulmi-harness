import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { McpServerConfig } from "../config/config.js";
import { defineTool, type AnyTool } from "../tools/types.js";
import { VERSION } from "../core/version.js";

export class McpClientPool {
  readonly #clients: Client[] = [];

  async connect(configs: Record<string, McpServerConfig>, cwd: string): Promise<AnyTool[]> {
    const tools: AnyTool[] = [];
    for (const [serverName, config] of Object.entries(configs).sort(([a], [b]) => a.localeCompare(b))) {
      const env = getDefaultEnvironment();
      for (const name of config.env) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
      }
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env,
        cwd,
        stderr: "pipe",
      });
      const client = new Client({ name: "kulmi", version: VERSION });
      try {
        await client.connect(transport);
        this.#clients.push(client);
        let cursor: string | undefined;
        do {
          const listed = await client.listTools(cursor ? { cursor } : undefined);
          for (const remote of listed.tools) {
            const name = `mcp__${sanitize(serverName)}__${sanitize(remote.name)}`;
            const readOnly = remote.annotations?.readOnlyHint === true;
            tools.push(defineTool({
              name,
              description: `[MCP ${serverName}] ${remote.description ?? remote.name}`,
              schema: z.record(z.string(), z.unknown()).default({}),
              providerSchema: remote.inputSchema as Record<string, unknown>,
              readOnly,
              async execute(context, input) {
                const result = await client.callTool(
                  { name: remote.name, arguments: input },
                  undefined,
                  { signal: context.signal, timeout: context.commandTimeoutMs },
                );
                return { content: renderContent(result.content), isError: result.isError === true };
              },
            }));
          }
          cursor = listed.nextCursor;
        } while (cursor);
      } catch (error) {
        await transport.close().catch(() => undefined);
        throw new Error(`MCP server ${serverName} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return tools;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.#clients.map((client) => client.close()));
    this.#clients.length = 0;
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.map((item) => {
    if (item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item) return String(item.text);
    return JSON.stringify(item);
  }).join("\n");
}
