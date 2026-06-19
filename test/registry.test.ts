import { describe, expect, it } from "vitest";
import { fileTools } from "../src/tools/files.js";
import { progressTools } from "../src/tools/progress.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { defineTool } from "../src/tools/types.js";
import { z } from "zod";

describe("ToolRegistry", () => {
  it("emits byte-stable canonically ordered provider schemas", () => {
    const first = new ToolRegistry([...progressTools(), ...fileTools()]);
    const second = new ToolRegistry([...fileTools(), ...progressTools()]);
    expect(JSON.stringify(first.providerTools())).toBe(JSON.stringify(second.providerTools()));
    expect(first.providerTools().map((tool) => tool.function.name)).toEqual(
      [...first.names()].sort(),
    );
  });

  it("preserves a remote MCP JSON schema for the model", () => {
    const registry = new ToolRegistry([defineTool({
      name: "mcp__fff__fffind",
      description: "fuzzy file search",
      schema: z.record(z.string(), z.unknown()),
      providerSchema: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer" } },
        required: ["query"],
      },
      readOnly: true,
      async execute() { return { content: "[]" }; },
    })]);
    expect(registry.providerTools()[0]?.function.parameters).toEqual({
      properties: { limit: { type: "integer" }, query: { type: "string" } },
      required: ["query"],
      type: "object",
    });
  });
});
