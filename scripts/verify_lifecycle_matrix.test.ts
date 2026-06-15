import { describe, expect, it } from "bun:test";
import {
  lifecycleMatrixMarkdown,
  runLifecycleMatrix,
  summarizeLifecycleMatrix,
} from "./lifecycle_matrix.ts";

describe("loopship lifecycle matrix", () => {
  it(
    "machine-checks the tasks.md lifecycle matrix scenarios",
    () => {
      const results = runLifecycleMatrix();
      const summary = summarizeLifecycleMatrix(results);

    expect(summary.passed).toBe(summary.total);
    expect(summary.all_archived).toBe(true);
    expect(summary.all_loopship_routed).toBe(true);
    expect(summary.all_merge_commits_recorded).toBe(true);

    const bugfix = results.find((result) => result.id === "bugfix");
    expect(bugfix?.classification).toBe("bugfix");

    const repair = results.find((result) => result.id === "repair");
    expect(repair?.classification).toBe("refactor");

    const research = results.find((result) => result.id === "open-research");
    expect(research?.general_task_present).toBe(true);

    const featureParallel = results.find(
      (result) => result.id === "feature-parallel",
    );
    expect(featureParallel?.child_count).toBe(2);
    expect(featureParallel?.unique_worktrees).toBe(true);
    expect(featureParallel?.unique_branches).toBe(true);

    const greenfield = results.find((result) => result.id === "vague-greenfield");
    expect(greenfield?.question_round_used).toBe(true);

    const markdown = lifecycleMatrixMarkdown(results);
    expect(markdown).toContain("| bugfix |");
    expect(markdown).toContain("| open-research |");
      expect(markdown).toContain("| vague-greenfield |");
    },
    120_000,
  );
});
