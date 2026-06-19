import { describe, expect, it } from "vitest";
import { fileTools } from "../src/tools/files.js";
import { readArtifactTool } from "../src/tools/artifacts.js";
import { progressTools } from "../src/tools/progress.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { shellTool } from "../src/tools/shell.js";
import { skillTools } from "../src/tools/skills.js";
import { subagentTools } from "../src/tools/subagents.js";
import { fetchUrlTool, freeWebSearchTool } from "../src/tools/web-search.js";

describe("ToolRegistry", () => {
  it("emits byte-stable canonically ordered provider schemas", () => {
    const first = new ToolRegistry([...progressTools(), ...fileTools()]);
    const second = new ToolRegistry([...fileTools(), ...progressTools()]);
    expect(JSON.stringify(first.providerTools())).toBe(JSON.stringify(second.providerTools()));
    expect(first.providerTools().map((tool) => tool.function.name)).toEqual(
      [...first.names()].sort(),
    );
  });

  it("can expose a stable deferred subset without changing execution tools", () => {
    const registry = new ToolRegistry([...fileTools(), ...progressTools()]);
    const chatTools = registry.providerTools(["start_task"]);
    expect(chatTools.map((tool) => tool.function.name)).toEqual(["start_task"]);
    expect(Buffer.byteLength(JSON.stringify(chatTools), "utf8")).toBeLessThan(700);
    expect(registry.providerTools(["missing", "start_task"]).map((tool) => tool.function.name)).toEqual(["start_task"]);
    expect(registry.names()).toContain("read_file");
  });

  it("keeps the complete built-in tool catalog compact", () => {
    const registry = new ToolRegistry([
      ...fileTools(),
      readArtifactTool,
      shellTool,
      ...progressTools(),
      ...subagentTools(),
      ...skillTools([]),
      freeWebSearchTool({ mode: "free", resultLimit: 5, provider: "auto", searxngUrl: "" }),
      fetchUrlTool(),
    ]);
    expect(registry.names()).toHaveLength(21);
    expect(Buffer.byteLength(JSON.stringify(registry.providerTools()), "utf8")).toBeLessThan(10_000);
    expect(Buffer.byteLength(JSON.stringify(
      registry.providerTools().filter((tool) => tool.function.name !== "start_task"),
    ), "utf8")).toBeLessThan(9_500);
  });
});
