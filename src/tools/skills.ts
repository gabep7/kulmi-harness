import { z } from "zod";
import { readSkill, type SkillDefinition } from "../config/skills.js";
import { defineTool, type AnyTool } from "./types.js";

export function skillTools(skills: SkillDefinition[]): AnyTool[] {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return [
    defineTool({
      name: "read_skill",
      description: "Read one local skill by exact name before applying its workflow.",
      schema: z.object({ name: z.string().min(1).max(80) }),
      readOnly: true,
      async execute(_context, input) {
        const skill = byName.get(input.name);
        if (!skill) throw new Error(`unknown skill ${input.name}; available: ${[...byName.keys()].join(", ") || "none"}`);
        return { content: readSkill(skill) };
      },
    }),
  ];
}
