import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkills, readSkill, skillsPromptInventory } from "../src/config/skills.js";
import { skillTools } from "../src/tools/skills.js";

describe("local skills", () => {
  it("discovers stable metadata and loads content on demand", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-skills-"));
    const directory = join(root, ".kulmi", "skills", "release");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `---\nname: release\ndescription: Verify and package a release\n---\n# Release\n\nRun checks first.\n`);

    const skills = discoverSkills(root).filter((skill) => skill.path.startsWith(root));
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "release", description: "Verify and package a release", source: "project" });
    expect(readSkill(skills[0]!)).toContain("Run checks first");
    expect(skillsPromptInventory(skills)).toBe("- release: Verify and package a release");
  });

  it("ignores skill files escaping through symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-skills-"));
    await mkdir(join(root, ".kulmi", "skills", "linked"), { recursive: true });
    const outside = join(root, "outside.md");
    await writeFile(outside, "# Outside\n");
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, join(root, ".kulmi", "skills", "linked", "SKILL.md"));
    expect(discoverSkills(root).filter((skill) => skill.path.startsWith(root))).toEqual([]);
  });

  it("skips malformed skill files without throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "kulmi-skills-"));
    const badDir = join(root, ".kulmi", "skills", "bad-skill");
    const goodDir = join(root, ".kulmi", "skills", "good");
    await mkdir(badDir, { recursive: true });
    await mkdir(goodDir, { recursive: true });
    await writeFile(join(badDir, "SKILL.md"), `# Bad Skill Name\n\nThis heading has spaces.\n`);
    await writeFile(
      join(goodDir, "SKILL.md"),
      `---\nname: good\ndescription: Valid skill\n---\n# Good\n\nDo the thing.\n`,
    );

    const skills = discoverSkills(root).filter((skill) => skill.path.startsWith(root));
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "good", description: "Valid skill", source: "project" });
  });

  it("does not expose a read tool when no skills exist", () => {
    expect(skillTools([])).toEqual([]);
  });
});
