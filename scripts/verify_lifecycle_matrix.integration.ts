import { describe, expect, it } from "bun:test";
import {
  LIFECYCLE_MATRIX,
  lifecycleMatrixMarkdown,
  runLifecycleScenario,
  type MatrixScenarioResult,
  summarizeLifecycleMatrix,
} from "./lifecycle_matrix.ts";

describe("loopship lifecycle matrix", () => {
  const results: MatrixScenarioResult[] = [];
  const executeMatrix = process.env.LOOPSHIP_EXECUTE_LIFECYCLE_MATRIX === "1";

  for (const scenario of LIFECYCLE_MATRIX) {
    const runCase = executeMatrix ? it : it.skip;
    runCase(
      `machine-checks ${scenario.id}`,
      () => {
        const result = runLifecycleScenario(scenario);
        results.push(result);

        expect(result.archived).toBe(true);
        expect(result.unique_worktrees).toBe(true);
        expect(result.unique_branches).toBe(true);
        expect(result.merge_commits_recorded).toBe(true);
        expect(result.loopship_routed).toBe(true);

        if (scenario.id === "bugfix") {
          expect(result.classification).toBe("bugfix");
        }
        if (scenario.id === "repair") {
          expect(result.classification).toBe("refactor");
        }
        if (scenario.id === "open-research") {
          expect(result.general_task_present).toBe(true);
        }
        if (scenario.id === "feature-parallel") {
          expect(result.child_count).toBe(2);
        }
        if (scenario.id === "vague-greenfield") {
          expect(result.question_round_used).toBe(true);
        }
      },
      420_000,
    );
  }

  const summaryCase = executeMatrix ? it : it.skip;
  summaryCase("summarizes the lifecycle matrix", () => {
    expect(results.length).toBe(LIFECYCLE_MATRIX.length);

    const summary = summarizeLifecycleMatrix(results);

    expect(summary.passed).toBe(summary.total);
    expect(summary.all_archived).toBe(true);
    expect(summary.all_loopship_routed).toBe(true);
    expect(summary.all_merge_commits_recorded).toBe(true);

    const markdown = lifecycleMatrixMarkdown(results);
    expect(markdown).toContain("| bugfix |");
    expect(markdown).toContain("| open-research |");
    expect(markdown).toContain("| vague-greenfield |");
  });

  it("validates the plan-only lifecycle matrix shape", () => {
    const planned = LIFECYCLE_MATRIX.map((scenario) => ({
      id: scenario.id,
      prompt: scenario.prompt,
      wtree: scenario.id,
      classification: scenario.classification,
      child_count: scenario.tasks.length,
      archived: true,
      unique_worktrees: true,
      unique_branches: true,
      merge_commits_recorded: true,
      loopship_routed: true,
      general_task_present: scenario.tasks.some(
        (task) => String(task.type) === "general",
      ),
      question_round_used: Array.isArray(scenario.questions),
    }));
    const markdown = lifecycleMatrixMarkdown(planned);
    expect(markdown).toContain("| bugfix |");
    expect(markdown).toContain("| open-research |");
    expect(markdown).toContain("| feature-parallel |");
    expect(markdown).toContain("| vague-greenfield |");
    expect(planned.find((scenario) => scenario.id === "feature-parallel")).toMatchObject({
      child_count: 2,
    });
  });
});
