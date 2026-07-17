import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverRules } from "../src/config/rules.js";

describe("discoverRules", () => {
  it("skips malformed rule files without throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-rules-"));
    const directory = join(root, ".kulmi", "rules");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "bad.md"), `# Bad Rule Name\n\nThis heading has spaces.\n`);
    await writeFile(
      join(directory, "good.md"),
      `---\nname: good\ndescription: Valid rule\n---\n# Good\n\nApply carefully.\n`,
    );

    const rules = discoverRules(root).filter((rule) => rule.path.startsWith(root));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ name: "good", description: "Valid rule", source: "project" });
  });
});
