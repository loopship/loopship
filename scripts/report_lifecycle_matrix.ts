#!/usr/bin/env bun

import {
  LIFECYCLE_MATRIX,
  type MatrixScenario,
  lifecycleMatrixMarkdown,
  runLifecycleMatrix,
  summarizeLifecycleMatrix,
} from "./lifecycle_matrix.ts";

function selectedMatrix(): MatrixScenario[] {
  const selected = String(process.env.LOOPSHIP_LIFECYCLE_CASES ?? "").trim();
  if (!selected) return LIFECYCLE_MATRIX;
  const ids = selected
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const byId = new Map(LIFECYCLE_MATRIX.map((scenario) => [scenario.id, scenario]));
  return ids.map((id) => {
    const scenario = byId.get(id);
    if (!scenario) {
      throw new Error(`unknown lifecycle matrix case: ${id}`);
    }
    return scenario;
  });
}

if (process.env.LOOPSHIP_EXECUTE_LIFECYCLE_MATRIX === "1") {
  const scenarios = selectedMatrix();
  const results = await runLifecycleMatrix(scenarios);
  const summary = summarizeLifecycleMatrix(results);

  process.stdout.write(lifecycleMatrixMarkdown(results));

  if (summary.passed !== summary.total) {
    process.exitCode = 1;
  }
} else {
  process.stdout.write([
    "# Lifecycle Matrix Report",
    "",
    "- Mode: plan-only",
    "- Execute with `LOOPSHIP_EXECUTE_LIFECYCLE_MATRIX=1 bun run scripts/report_lifecycle_matrix.ts`.",
    "- Routine verification uses focused native lifecycle coverage to keep runtime bounded.",
    "",
    "| Case | Classification | Planned Children | Notes |",
    "| --- | --- | --- | --- |",
    ...LIFECYCLE_MATRIX.map((scenario) => {
      const notes = [
        scenario.tasks.some((task) => String(task.type) === "general") ? "general-task" : "",
        scenario.questions?.length ? "clarification-round" : "",
      ].filter(Boolean).join(", ");
      return `| ${scenario.id} | ${scenario.classification} | ${scenario.tasks.length} | ${notes} |`;
    }),
    "",
  ].join("\n"));
}
