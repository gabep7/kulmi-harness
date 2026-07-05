import { z } from "zod";
import { readRule, type RuleDefinition } from "../config/rules.js";
import { defineTool, type AnyTool } from "./types.js";

export function ruleTools(rules: RuleDefinition[]): AnyTool[] {
  if (rules.length === 0) return [];
  const byName = new Map(rules.map((rule) => [rule.name, rule]));
  return [
    defineTool({
      name: "read_rule",
      description: "Read one project rule by exact name before applying its guidance.",
      schema: z.object({ name: z.string().min(1).max(80) }),
      readOnly: true,
      async execute(_context, input) {
        const rule = byName.get(input.name);
        if (!rule) throw new Error(`unknown rule ${input.name}; available: ${[...byName.keys()].join(", ") || "none"}`);
        return { content: readRule(rule) };
      },
    }),
  ];
}
