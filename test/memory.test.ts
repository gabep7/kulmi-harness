import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverMemory, memoryPromptInventory, readMemory } from "../src/config/memory.js";
import { memoryTools } from "../src/tools/memory.js";
import type { ToolContext } from "../src/tools/types.js";

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, ".kulmi", "memory"), { recursive: true });
  return root;
}

function makeContext(root: string, captured: string[] = []): ToolContext {
  return {
    workspaceRoot: root,
    checkpoint: {
      capture: async (path: string) => {
        captured.push(path);
      },
    },
  } as unknown as ToolContext;
}

describe("memory discovery", () => {
  it("discovers project memory files with frontmatter metadata", async () => {
    const root = await makeRoot("kulmi-memory-");
    await writeFile(join(root, ".kulmi", "memory", "architecture.md"), `---
name: architecture
tags: Stack, API
importance: high
---
# Architecture

The project uses Postgres and Redis.
`);
    await writeFile(join(root, ".kulmi", "memory", "style.md"), `---
name: style
importance: low
---
Prefer short functions.
`);

    const memories = discoverMemory(root);
    expect(memories.map((memory) => memory.name)).toEqual(["architecture", "style"]);
    expect(memories[0]).toMatchObject({
      name: "architecture",
      importance: "high",
      tags: ["stack", "api"],
      source: "project",
    });
    expect(memories[0]?.preview).toContain("Postgres");
    expect(memoryPromptInventory(memories)).toContain("★ architecture");
    expect(readMemory(memories[0]!)).toContain("Postgres and Redis");
  });

  it("slugifies heading names and skips unusable files instead of failing discovery", async () => {
    const root = await makeRoot("kulmi-memory-bad-");
    await writeFile(join(root, ".kulmi", "memory", "notes.md"), `# My Project Notes

Deployment happens from CI only.
`);
    await writeFile(join(root, ".kulmi", "memory", "oversized.md"), `big\n${"x".repeat(200_000)}`);
    await writeFile(join(root, ".kulmi", "memory", "unusable.md"), `---
name: "///"
---
`);
    await writeFile(join(root, ".kulmi", "memory", "$$$.md"), "No usable name anywhere.\n");
    await writeFile(join(root, ".kulmi", "memory", "good.md"), "A durable fact.\n");

    const memories = discoverMemory(root);
    expect(memories.map((memory) => memory.name)).toEqual(["good", "My-Project-Notes", "unusable"]);
  });

  it("prefers .kulmi memory over .agents memory with the same name", async () => {
    const root = await makeRoot("kulmi-memory-precedence-");
    await mkdir(join(root, ".agents", "memory"), { recursive: true });
    await writeFile(join(root, ".agents", "memory", "db.md"), `---
name: db
---
Old: MySQL.
`);
    await writeFile(join(root, ".kulmi", "memory", "db.md"), `---
name: db
---
Current: Postgres.
`);

    const memories = discoverMemory(root);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.preview).toContain("Postgres");
  });

  it("caps the prompt inventory and points to list_memory", async () => {
    const root = await makeRoot("kulmi-memory-cap-");
    for (let index = 0; index < 45; index += 1) {
      await writeFile(join(root, ".kulmi", "memory", `note-${String(index).padStart(2, "0")}.md`), `Fact ${index}.\n`);
    }
    const inventory = memoryPromptInventory(discoverMemory(root));
    expect(inventory.split("\n")).toHaveLength(41);
    expect(inventory).toContain("…and 5 more; use list_memory to see all.");
  });
});

describe("memory tools", () => {
  it("exposes read_memory, list_memory, and save_memory", async () => {
    const root = await makeRoot("kulmi-memory-tools-");
    await writeFile(join(root, ".kulmi", "memory", "auth.md"), `---
name: auth
tags: Security
importance: high
---
JWT cookies only.
`);
    const tools = memoryTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["list_memory", "read_memory", "save_memory"]);
    expect(tools.find((tool) => tool.name === "save_memory")?.readOnly).toBe(false);

    const context = makeContext(root);
    const read = tools.find((tool) => tool.name === "read_memory")!;
    const list = tools.find((tool) => tool.name === "list_memory")!;

    const full = await read.execute(context, { name: "auth" });
    expect(full.content).toContain("JWT cookies only");

    const listed = await list.execute(context, { tag: "SECURITY" });
    expect(listed.content).toContain("auth");
    expect(listed.content).toContain("JWT cookies only");

    const missing = await list.execute(context, { tag: "unknown" });
    expect(missing.content).toContain("No memories tagged");
  });

  it("saves a memory that later sessions can discover and read back", async () => {
    const root = await makeRoot("kulmi-memory-save-");
    const captured: string[] = [];
    const context = makeContext(root, captured);
    const tools = memoryTools();
    const save = tools.find((tool) => tool.name === "save_memory")!;
    const read = tools.find((tool) => tool.name === "read_memory")!;

    const result = await save.execute(context, {
      name: "release-process",
      content: "Releases are tagged from master after npm run check.",
      tags: ["Release", "CI"],
      importance: "high",
    });
    expect(JSON.parse(result.content)).toMatchObject({
      name: "release-process",
      path: join(".kulmi", "memory", "release-process.md"),
      overwrote: false,
    });
    expect(result.diff).toContain("release-process");
    expect(captured).toHaveLength(1);

    const saved = await readFile(join(root, ".kulmi", "memory", "release-process.md"), "utf8");
    expect(saved).toContain("tags: release, ci");
    expect(saved).toContain("importance: high");

    const memories = discoverMemory(root);
    expect(memories[0]).toMatchObject({ name: "release-process", importance: "high", tags: ["release", "ci"] });
    const full = await read.execute(context, { name: "release-process" });
    expect(full.content).toContain("npm run check");
  });

  it("treats an identical save as a no-op without a checkpoint", async () => {
    const root = await makeRoot("kulmi-memory-noop-");
    const captured: string[] = [];
    const context = makeContext(root, captured);
    const save = memoryTools().find((tool) => tool.name === "save_memory")!;
    const input = { name: "fact", content: "The API is versioned." };

    await save.execute(context, input);
    expect(captured).toHaveLength(1);

    const repeat = await save.execute(context, input);
    expect(JSON.parse(repeat.content)).toMatchObject({ unchanged: true });
    expect(repeat.mutated).toBe(false);
    expect(captured).toHaveLength(1);
  });
});
