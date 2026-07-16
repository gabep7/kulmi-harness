import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import {
  MEMORY_NAME_PATTERN,
  discoverMemory,
  formatMemoryLine,
  projectMemoryDirectory,
  readMemory,
} from "../config/memory.js";
import { createTextDiff } from "../core/diff.js";
import { writeAtomic } from "./files.js";
import { defineTool, type AnyTool } from "./types.js";

export function memoryTools(): AnyTool[] {
  return [readMemoryTool, listMemoryTool, saveMemoryTool];
}

const readMemoryTool = defineTool({
  name: "read_memory",
  description: "Read one memory file by exact name to retrieve its full content.",
  schema: z.object({ name: z.string().min(1).max(80) }),
  readOnly: true,
  async execute(context, input) {
    const memories = discoverMemory(context.workspaceRoot);
    const memory = memories.find((entry) => entry.name === input.name);
    if (!memory) {
      const available = memories.map((entry) => entry.name).join(", ") || "none";
      throw new Error(`unknown memory ${input.name}; available: ${available}`);
    }
    return { content: readMemory(memory) };
  },
});

const listMemoryTool = defineTool({
  name: "list_memory",
  description: "List all available memory files with their names, tags, importance, and previews. Use this to find relevant memories before reading them.",
  schema: z.object({
    tag: z.string().min(1).optional(),
  }),
  readOnly: true,
  async execute(context, input) {
    const memories = discoverMemory(context.workspaceRoot);
    if (memories.length === 0) return { content: "No memory files were found." };
    if (input.tag) {
      const tag = input.tag.trim().toLowerCase();
      const matching = memories.filter((memory) => memory.tags.includes(tag));
      if (matching.length === 0) return { content: `No memories tagged '${tag}'.` };
      return { content: matching.map(formatMemoryLine).join("\n") };
    }
    return { content: memories.map(formatMemoryLine).join("\n") };
  },
});

const saveMemoryTool = defineTool({
  name: "save_memory",
  description:
    "Save a durable project memory to .kulmi/memory/<name>.md so future sessions retain it. Use for decisions, preferences, and architectural facts worth remembering. Overwrites an existing memory with the same name.",
  schema: z.object({
    name: z.string().regex(MEMORY_NAME_PATTERN, "must start alphanumeric and use only letters, digits, dots, dashes, underscores"),
    content: z.string().min(1).max(32_000),
    tags: z.array(z.string().min(1).max(40)).max(10).optional(),
    importance: z.enum(["low", "normal", "high"]).optional(),
  }),
  readOnly: false,
  async execute(context, input) {
    const path = join(projectMemoryDirectory(context.workspaceRoot), `${input.name}.md`);
    const rel = relative(context.workspaceRoot, path);
    const next = serializeMemory(input);
    let previous = "";
    let existed = false;
    try {
      previous = await readFile(path, "utf8");
      existed = true;
    } catch {
      existed = false;
    }
    if (existed && previous === next) {
      return {
        content: JSON.stringify({ name: input.name, path: rel, unchanged: true }),
        mutated: false,
      };
    }
    await context.checkpoint.capture(path);
    await writeAtomic(path, next);
    const diff = createTextDiff(rel, previous, next);
    return {
      content: JSON.stringify({
        name: input.name,
        path: rel,
        bytes: Buffer.byteLength(next),
        overwrote: existed,
      }),
      ...(diff ? { diff: diff.text } : {}),
    };
  },
});

function serializeMemory(input: {
  name: string;
  content: string;
  tags?: string[] | undefined;
  importance?: "low" | "normal" | "high" | undefined;
}): string {
  const lines = ["---", `name: ${input.name}`];
  const tags = (input.tags ?? [])
    .map((tag) => tag.replace(/[,\n]/g, " ").trim().toLowerCase())
    .filter((tag) => tag.length > 0);
  if (tags.length > 0) lines.push(`tags: ${tags.join(", ")}`);
  if (input.importance && input.importance !== "normal") lines.push(`importance: ${input.importance}`);
  lines.push("---", "", input.content.trim(), "");
  return lines.join("\n");
}
