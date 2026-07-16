import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverCommands, expandCommand } from "../src/config/commands.js";

const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("custom slash commands", () => {
  it("discovers project and user commands with project precedence", async () => {
    const { workspace, userCommands, projectCommands } = await fixture();
    await writeFile(join(userCommands, "deploy.md"), "# Deploy\nDeploy the app: $ARGUMENTS", "utf8");
    await writeFile(join(userCommands, "review.md"), "user review body", "utf8");
    await writeFile(join(projectCommands, "review.md"), "project review body", "utf8");

    const commands = discoverCommands(workspace);
    expect(commands.map((command) => command.name)).toEqual(["deploy", "review"]);
    const deploy = commands.find((command) => command.name === "deploy");
    expect(deploy).toMatchObject({ source: "user", preview: "Deploy" });
    const review = commands.find((command) => command.name === "review");
    expect(review).toMatchObject({ source: "project", template: "project review body" });
  });

  it("skips files with invalid names, wrong extensions, and symlinks", async () => {
    const { workspace, projectCommands } = await fixture();
    await writeFile(join(projectCommands, "good.md"), "good", "utf8");
    await writeFile(join(projectCommands, "bad name.md"), "space in name", "utf8");
    await writeFile(join(projectCommands, "-leading.md"), "leading dash", "utf8");
    await writeFile(join(projectCommands, `${"x".repeat(33)}.md`), "too long", "utf8");
    await writeFile(join(projectCommands, "notes.txt"), "not markdown", "utf8");
    await writeFile(join(workspace, "outside.md"), "outside root", "utf8");
    await symlink(join(workspace, "outside.md"), join(projectCommands, "linked.md"));

    const commands = discoverCommands(workspace);
    expect(commands.map((command) => command.name)).toEqual(["good"]);
  });

  it("returns nothing when no command directories exist", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kulmi-commands-empty-"));
    process.env.HOME = await mkdtemp(join(tmpdir(), "kulmi-commands-home-"));
    expect(discoverCommands(workspace)).toEqual([]);
  });

  it("expands every $ARGUMENTS occurrence and supports empty arguments", () => {
    expect(expandCommand("Review $ARGUMENTS now. Repeat: $ARGUMENTS", "src/app.ts")).toBe(
      "Review src/app.ts now. Repeat: src/app.ts",
    );
    expect(expandCommand("Run the checks. $ARGUMENTS", "")).toBe("Run the checks. ");
    expect(expandCommand("No placeholder here", "ignored")).toBe("No placeholder here");
    expect(expandCommand("Pay $ARGUMENTS", "$100 & $$")).toBe("Pay $100 & $$");
  });
});

async function fixture(): Promise<{ workspace: string; userCommands: string; projectCommands: string }> {
  const workspace = await mkdtemp(join(tmpdir(), "kulmi-commands-workspace-"));
  const home = await mkdtemp(join(tmpdir(), "kulmi-commands-home-"));
  process.env.HOME = home;
  const userCommands = join(home, ".config", "kulmi", "commands");
  const projectCommands = join(workspace, ".kulmi", "commands");
  await mkdir(userCommands, { recursive: true });
  await mkdir(projectCommands, { recursive: true });
  return { workspace, userCommands, projectCommands };
}
