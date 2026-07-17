import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverAgents } from "../src/config/agents.js";

describe("discoverAgents", () => {
  it("skips malformed agent files without throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-agents-"));
    const directory = join(root, ".kulmi", "agents");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "bad.md"), `# Code Reviewer\n\nDoes reviews.\n`);
    await writeFile(
      join(directory, "good.md"),
      `---\nname: good\ndescription: Valid agent\nmode: review\n---\n# Good\n\nReviews carefully.\n`,
    );

    const agents = discoverAgents(root).filter((agent) => agent.path.startsWith(root));
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: "good", description: "Valid agent", mode: "review", source: "project" });
  });
});
