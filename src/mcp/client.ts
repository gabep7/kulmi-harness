import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { AnyTool } from "../tools/types.js";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
}

export interface McpConnection {
  tools: AnyTool[];
  errors: string[];
  dispose(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TOOL_NAME_LENGTH = 64;

const looseInputSchema = z.record(z.string(), z.unknown());

interface McpContentPart {
  type: string;
  text?: string;
  mimeType?: string;
  uri?: string;
  data?: string;
  resource?: { uri?: string };
}

interface ListedMcpTool {
  name: string;
  description?: string | undefined;
  inputSchema: { type: "object"; [key: string]: unknown };
  annotations?: { readOnlyHint?: boolean | undefined } | undefined;
}

export async function connectMcpServers(
  configs: McpServerConfig[],
  options: { cwd: string; timeoutMs?: number },
): Promise<McpConnection> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clients: Client[] = [];
  const tools: AnyTool[] = [];
  const errors: string[] = [];
  await Promise.all(configs.map(async (config) => {
    try {
      const connected = await connectServer(config, options.cwd, timeoutMs);
      clients.push(connected.client);
      tools.push(...connected.tools);
    } catch (error) {
      errors.push(`mcp server ${config.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  let disposed: Promise<void> | undefined;
  return {
    tools,
    errors,
    dispose(): Promise<void> {
      disposed ??= Promise.allSettled(clients.map((client) => client.close())).then(() => undefined);
      return disposed;
    },
  };
}

async function connectServer(
  config: McpServerConfig,
  cwd: string,
  timeoutMs: number,
): Promise<{ client: Client; tools: AnyTool[] }> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...getDefaultEnvironment(), ...config.env },
    cwd,
    stderr: "ignore",
  });
  const client = new Client({ name: "kulmi", version: "1.0.0" });
  await client.connect(transport, { timeout: timeoutMs });
  try {
    const listed = await client.listTools(undefined, { timeout: timeoutMs });
    const tools = listed.tools.map((tool) => bridgeTool(config.name, tool, client, timeoutMs));
    return { client, tools };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

function bridgeTool(server: string, tool: ListedMcpTool, client: Client, timeoutMs: number): AnyTool {
  const description = tool.description ? `[${server}] ${tool.description}` : `[${server}]`;
  return {
    name: `mcp_${server}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME_LENGTH),
    description,
    schema: looseInputSchema,
    inputSchema: tool.inputSchema,
    readOnly: tool.annotations?.readOnlyHint ?? false,
    async execute(context, input) {
      const result = await client.callTool(
        { name: tool.name, arguments: input },
        undefined,
        { signal: context.signal, timeout: timeoutMs },
      );
      const content = renderContent(result.content as McpContentPart[] | undefined);
      if (result.isError) return { content: content || "tool call failed", isError: true };
      return { content };
    },
  };
}

function renderContent(parts: McpContentPart[] | undefined): string {
  if (!parts || parts.length === 0) return "";
  const rendered: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      rendered.push(part.text ?? "");
    } else if (part.type === "image" || part.type === "audio") {
      rendered.push(`[${part.type} content, ${part.mimeType ?? "unknown type"}, ${part.data?.length ?? 0} base64 chars]`);
    } else if (part.type === "resource") {
      rendered.push(`[embedded resource ${part.resource?.uri ?? "unknown"}]`);
    } else if (part.type === "resource_link") {
      rendered.push(`[resource link ${part.uri ?? "unknown"}]`);
    } else {
      rendered.push(`[unsupported ${part.type} content]`);
    }
  }
  return rendered.join("\n");
}
