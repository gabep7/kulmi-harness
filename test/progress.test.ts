import { describe, expect, it } from "vitest";
import type { PlanStep } from "../src/core/types.js";
import { validatePlan } from "../src/tools/progress.js";

describe("plan validation", () => {
  it("accepts an evidence-backed dependency DAG", () => {
    expect(() => validatePlan([
      step("inspect", "completed", [], "repo mapped"),
      step("implement", "in_progress", ["inspect"]),
      step("review", "pending", ["implement"]),
    ])).not.toThrow();
  });

  it("rejects cycles and premature work", () => {
    expect(() => validatePlan([
      step("a", "pending", ["b"]),
      step("b", "pending", ["a"]),
    ])).toThrow("cycle");
    expect(() => validatePlan([
      step("a", "pending", []),
      step("b", "in_progress", ["a"]),
    ])).toThrow("before dependency a completes");
  });
});

function step(
  id: string,
  status: PlanStep["status"],
  dependsOn: string[],
  evidence?: string,
): PlanStep {
  return {
    id,
    title: id,
    status,
    dependsOn,
    acceptanceCriteria: [],
    ...(evidence ? { evidence } : {}),
  };
}
