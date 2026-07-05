import { expect } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTasksYaml } from "./loopship_core.ts";
import { runCommand } from "./loopship_utils.ts";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "loopship.ts");
const EMPTY_SYSTEM_CONTEXT = {
  relevant_object_refs: [],
  relevant_assertion_refs: [],
  relevant_resource_refs: [],
  relevant_memory_refs: [],
  durable_implications: [],
};

export type MatrixFixture = {
  root: string;
  repo: string;
  env: Record<string, string>;
};

export type MatrixScenario = {
  id: string;
  prompt: string;
  classification: "greenfield_app" | "feature" | "bugfix" | "refactor" | "general";
  scope: string;
  summary: string;
  defaulted_unknowns?: string[];
  assumptions?: string[];
  constraints?: string[];
  questions?: Array<Record<string, unknown>>;
  preplanAnswers?: Array<Record<string, unknown>>;
  system_context?: Record<string, unknown>;
  verification_targets: string[];
  tasks: Array<Record<string, unknown>>;
};

export type MatrixScenarioResult = {
  id: string;
  prompt: string;
  wtree: string;
  classification: string;
  child_count: number;
  archived: boolean;
  unique_worktrees: boolean;
  unique_branches: boolean;
  merge_commits_recorded: boolean;
  loopship_routed: boolean;
  general_task_present: boolean;
  question_round_used: boolean;
};

function parseJson(stdout: string): any {
  return JSON.parse(stdout);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function runLoopship(
  cwd: string,
  args: string[],
  input?: Record<string, unknown>,
  env: Record<string, string> = {},
) {
  return runCommand("bun", [SCRIPT, ...args], {
    cwd,
    env,
    timeoutMs: 120_000,
    input: input ? JSON.stringify(input) : undefined,
  });
}

function runGit(cwd: string, args: string[], env: Record<string, string>): string {
  const proc = runCommand("git", args, { cwd, env, timeoutMs: 30_000 });
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
  return proc.stdout;
}

export function createFixture(prefix: string): MatrixFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repo = join(root, "repo");
  const env = {
    HOME: join(root, "home"),
    LOOPSHIP_GLOBAL_BIN: join(root, "bin", "loopship"),
    LOOPSHIP_SCRIPT: SCRIPT,
  };
  const initGit = runCommand("git", ["init", repo], { timeoutMs: 15_000 });
  expect(initGit.status, initGit.stderr || initGit.stdout).toBe(0);
  runGit(repo, ["config", "user.email", "loopship-test@example.invalid"], env);
  runGit(repo, ["config", "user.name", "Loopship Matrix"], env);
  writeFileSync(join(repo, "README.md"), "# loopship lifecycle matrix\n", "utf8");
  writeFileSync(join(repo, "src.txt"), "fixture\n", "utf8");
  runGit(repo, ["add", "README.md", "src.txt"], env);
  runGit(repo, ["commit", "-m", "fixture"], env);
  return { root, repo, env };
}

function gitWorktrees(repo: string, env: Record<string, string>): string[] {
  const stdout = runGit(repo, ["worktree", "list", "--porcelain"], env);
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length).trim()));
}

function latestQuestState(fixture: MatrixFixture, wtree: string): any {
  return parseTasksYaml(
    readFileSync(
      join(fixture.repo, "worktrees", wtree, ".loopship", "runtime", "tasks.yaml"),
      "utf8",
    ),
  );
}

function childResultPayload(taskId: string, childWtree: string, worktreePath: string) {
  return {
    task_id: taskId,
    child_wtree: childWtree,
    status: "passed",
    worktree_path: worktreePath,
    merge_commit: `merge-${taskId}`,
    evidence: [{ type: "summary", ref: `${taskId}.txt` }],
  };
}

function scenarioPlanPayload(
  scenario: MatrixScenario,
  mode: "questions" | "task_graph",
): Record<string, unknown> {
  const base = {
    classification: scenario.classification,
    scope: scenario.scope,
    summary: scenario.summary,
    defaulted_unknowns: scenario.defaulted_unknowns ?? [],
    assumptions: scenario.assumptions ?? [],
    constraints: scenario.constraints ?? [],
    system_context: scenario.system_context ?? EMPTY_SYSTEM_CONTEXT,
    verification_targets: scenario.verification_targets,
  };
  if (mode === "questions") {
    return {
      ...base,
      questions: scenario.questions ?? [],
    };
  }
  return {
    ...base,
    task_graph: { tasks: scenario.tasks },
  };
}

function runInitCommand(
  fixture: MatrixFixture,
  prompt: string,
  wtree?: string,
): Record<string, unknown> {
  const args = ["init", prompt, "--runtime", "codex", "--flow", "swe"];
  if (wtree) args.push("--wtree", wtree);
  const init = runLoopship(fixture.repo, args, undefined, fixture.env);
  expect(init.status, init.stderr || init.stdout).toBe(0);
  return parseJson(init.stdout);
}

function nativeWorkflowOutput(value: Record<string, unknown>): Record<string, unknown> | null {
  if (
    value.schemaVersion !== "fastflow/workflow-run-artifact/v1" ||
    value.kind !== "workflow_result"
  ) {
    return null;
  }
  expect(value.ok).toBe(true);
  return isRecord(value.output) ? value.output : {};
}

function nativePauseToken(value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.schemaVersion !== "fastflow/interaction-response/v1") return null;
  const nextCall = isRecord(value.nextCall) ? value.nextCall : {};
  const args = isRecord(nextCall.args) ? nextCall.args : {};
  const sessionId = String(args.sessionId ?? "").trim();
  expect(sessionId).toBeTruthy();
  const context = isRecord(value.context) ? value.context : {};
  const request = isRecord(context.request) ? context.request : {};
  return {
    sessionId,
    nonce: String(args.nonce ?? "").trim(),
    workspaceRoot: String(args.workspaceRoot ?? "").trim(),
    kind: String(value.kind ?? ""),
    wtree: String(request.wtree ?? request.quest_id ?? "").trim(),
  };
}

function resumeNativePause(
  fixture: MatrixFixture,
  pause: Record<string, unknown>,
  decision: Record<string, unknown>,
): Record<string, unknown> {
  const payload = {
    sessionId: String(pause.sessionId),
    ...(String(pause.nonce ?? "").trim() ? { nonce: String(pause.nonce) } : {}),
    ...(String(pause.workspaceRoot ?? "").trim()
      ? { workspaceRoot: String(pause.workspaceRoot) }
      : {}),
    ...(pause.kind === "supervisor_review"
      ? { supervisorDecision: "ok" }
      : { decision }),
  };
  const proc = runLoopship(
    fixture.repo,
    ["hook", "--repo", fixture.repo, "--json", "@-"],
    payload,
    fixture.env,
  );
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
  return parseJson(proc.stdout);
}

function completeNativeStartedStage(input: {
  fixture: MatrixFixture;
  started: Record<string, unknown>;
  decision?: Record<string, unknown>;
}): { output: Record<string, unknown>; wtree: string } {
  const directOutput = nativeWorkflowOutput(input.started);
  if (directOutput) return { output: directOutput, wtree: "" };

  const pause = nativePauseToken(input.started);
  expect(pause, JSON.stringify(input.started)).not.toBeNull();
  if (!input.decision && pause?.kind !== "supervisor_review") {
    throw new Error(`native lifecycle pause requires a decision: ${JSON.stringify(input.started)}`);
  }
  const resumed = resumeNativePause(input.fixture, pause!, input.decision ?? {});
  const output = nativeWorkflowOutput(resumed);
  expect(output, JSON.stringify(resumed)).not.toBeNull();
  return { output: output!, wtree: String(pause!.wtree ?? "") };
}

function runNativeStage(input: {
  fixture: MatrixFixture;
  prompt: string;
  wtree: string;
  decision?: Record<string, unknown>;
}): Record<string, unknown> {
  const started = runInitCommand(input.fixture, input.prompt, input.wtree);
  return completeNativeStartedStage({
    fixture: input.fixture,
    started,
    decision: input.decision,
  }).output;
}

function nestedNativeStepOutput(stageResult: Record<string, unknown>): Record<string, unknown> {
  const stepPayload = isRecord(stageResult.step_payload) ? stageResult.step_payload : {};
  const result = isRecord(stepPayload.result) ? stepPayload.result : {};
  if (isRecord(result.output)) return result.output;
  if (isRecord(stepPayload.output)) return stepPayload.output;
  return stepPayload;
}

function driveScenario(
  fixture: MatrixFixture,
  scenario: MatrixScenario,
): MatrixScenarioResult {
  const initial = runInitCommand(fixture, scenario.prompt);
  const firstPlan = completeNativeStartedStage({
    fixture,
    started: initial,
    decision: scenarioPlanPayload(
      scenario,
      scenario.questions?.length ? "questions" : "task_graph",
    ),
  });
  let wtree = firstPlan.wtree;
  expect(wtree).toBeTruthy();
  expect(firstPlan.output.step).toBe("plan");

  let questionRoundUsed = false;
  if (scenario.questions?.length) {
    expect(firstPlan.output.stage_after).toBe("awaiting_user_answers");
    questionRoundUsed = true;

    const answered = runNativeStage({
      fixture,
      prompt: scenario.prompt,
      wtree,
      decision: { answers: scenario.preplanAnswers ?? [] },
    });
    expect(answered.step).toBe("questions");
    expect(answered.stage_after).toBe("planning");

    const planned = runNativeStage({
      fixture,
      prompt: scenario.prompt,
      wtree,
      decision: scenarioPlanPayload(scenario, "task_graph"),
    });
    expect(planned.step).toBe("plan");
    expect(planned.stage_after).toBe("plan_review");
  } else {
    expect(firstPlan.output.stage_after).toBe("plan_review");
  }

  const approved = runNativeStage({
    fixture,
    prompt: scenario.prompt,
    wtree,
    decision: { approved: true },
  });
  expect(approved.step).toBe("task_graph");
  expect(approved.stage_after).toBe("task_graph_ready");

  const executing = runNativeStage({
    fixture,
    prompt: scenario.prompt,
    wtree,
  });
  expect(executing.step).toBe("executing");
  expect(executing.stage_after).toBe("executing");
  const childDispatch = nestedNativeStepOutput(executing);
  expect(childDispatch.schema_version).toBe("loopship.child.prepare/v1");
  const children = Array.isArray(childDispatch.children)
    ? (childDispatch.children as Record<string, unknown>[])
    : [];
  expect(children.length).toBe(scenario.tasks.length);

  const worktrees = gitWorktrees(fixture.repo, fixture.env);
  const childWorktrees = children.map((child) => resolve(String(child.worktree_path)));
  const childBranches = children.map((child) => String(child.branch_ref));
  for (const child of children) {
    const actions = isRecord(child.actions) ? child.actions : {};
    const initAction = isRecord(actions.init) ? actions.init : {};
    expect(initAction.cmd).toBe("loopship");
    const parentContextRef = join(
      fixture.repo,
      "worktrees",
      wtree,
      ".loopship",
      "runtime",
      "tasks.yaml",
    );
    expect(child.parent_context_ref).toBe(parentContextRef);
    expect(initAction.args).toEqual(
      expect.arrayContaining([
        "init",
        "--wtree",
        child.child_wtree,
        "--runtime",
        "codex",
      ]),
    );
    expect(String(initAction.args)).toContain(parentContextRef);
    expect(existsSync(String(child.worktree_path))).toBe(true);
    expect(worktrees).toContain(resolve(String(child.worktree_path)));
  }

  children.forEach((child, index) => {
    const childResult = runNativeStage({
      fixture,
      prompt: scenario.prompt,
      wtree,
      decision: childResultPayload(
        String(child.task_id),
        String(child.child_wtree),
        String(child.worktree_path),
      ),
    });
    expect(childResult.step).toBe("child_result");
    expect(childResult.stage_after).toBe(
      index === children.length - 1 ? "validating" : "executing",
    );
  });

  const validated = runNativeStage({
    fixture,
    prompt: scenario.prompt,
    wtree,
    decision: {
      status: "passed",
      checks: [{ name: `${scenario.id}-smoke`, status: "passed" }],
    },
  });
  expect(validated.step).toBe("validation");
  expect(validated.stage_after).toBe("verification_pending");

  const verified = runNativeStage({
    fixture,
    prompt: scenario.prompt,
    wtree,
    decision: {
      status: "passed",
      acceptance_trace: scenario.tasks.map((task) => ({
        acceptance: String((task.acceptance as string[])[0] ?? task.title ?? "done"),
        status: "passed",
      })),
      risks: [],
    },
  });
  expect(verified.step).toBe("verification");
  expect(verified.stage_after).toBe("system_update_pending");

  const updated = runNativeStage({
    fixture,
    prompt: scenario.prompt,
    wtree,
    decision: {
      system_update: {
        schema_version: 1,
        mode: "no_change",
        summary: `${scenario.id} covered`,
      },
    },
  });
  expect(updated.step).toBe("system_update");
  expect(updated.stage_after).toBe("landing_ready");

  const landed = runNativeStage({
    fixture,
    prompt: scenario.prompt,
    wtree,
    decision: {
      status: "landed",
      summary: `${scenario.id} complete`,
    },
  });
  expect(landed.step).toBe("landing");
  expect(landed.stage_after).toBe("archived");

  const finalState = latestQuestState(fixture, wtree);
  const finalTasks = Array.isArray(finalState.tasks) ? finalState.tasks : [];
  return {
    id: scenario.id,
    prompt: scenario.prompt,
    wtree,
    classification: scenario.classification,
    child_count: children.length,
    archived: String(finalState.stage) === "archived",
    unique_worktrees: new Set(childWorktrees).size === childWorktrees.length,
    unique_branches: new Set(childBranches).size === childBranches.length,
    merge_commits_recorded: finalTasks.every(
      (task: any) => typeof task.merge_commit === "string" && task.merge_commit.trim(),
    ),
    loopship_routed: children.every((child) => {
      const actions = isRecord(child.actions) ? child.actions : {};
      const initAction = isRecord(actions.init) ? actions.init : {};
      return initAction.cmd === "loopship";
    }),
    general_task_present: scenario.tasks.some((task) => String(task.type) === "general"),
    question_round_used: questionRoundUsed,
  };
}

export const LIFECYCLE_MATRIX: MatrixScenario[] = [
  {
    id: "bugfix",
    prompt: "loopship: fix a failing React test in this repo",
    classification: "bugfix",
    scope: "Fix the failing React test and preserve existing behavior.",
    summary: "Reproduce the failing test, apply the smallest fix, and confirm the regression is closed.",
    assumptions: ["The failure is isolated to one UI behavior."],
    constraints: ["Keep the fix minimal and regression-bounded."],
    system_context: EMPTY_SYSTEM_CONTEXT,
    verification_targets: ["The failing React test passes without breaking adjacent behavior."],
    tasks: [
      {
        id: "T001",
        title: "Fix the failing React test",
        type: "coding",
        acceptance: ["The failing React test passes."],
        scope_files: ["src/components", "src/tests"],
      },
    ],
  },
  {
    id: "repair",
    prompt: "loopship: repair a broken build after a dependency upgrade",
    classification: "refactor",
    scope: "Repair the broken build caused by a dependency upgrade.",
    summary: "Restore a clean build by adjusting compatibility issues introduced by the upgrade.",
    assumptions: ["The project should keep the upgraded dependency version."],
    constraints: ["Repair behavior without broad refactors."],
    system_context: EMPTY_SYSTEM_CONTEXT,
    verification_targets: ["The production build succeeds after the repair."],
    tasks: [
      {
        id: "T001",
        title: "Repair the build after the dependency upgrade",
        type: "coding",
        acceptance: ["The production build succeeds."],
        scope_files: ["package.json", "build config", "source compatibility fixes"],
      },
    ],
  },
  {
    id: "general-coding-parallel",
    prompt: "loopship: implement a small general coding task with two independent subtasks",
    classification: "general",
    scope: "Implement two independent coding subtasks with disjoint file scope.",
    summary: "Decompose the general coding request into two independent parallel-ready children.",
    defaulted_unknowns: ["Use two disjoint file slices for the subtasks."],
    constraints: ["The subtasks must be independently mergeable."],
    system_context: EMPTY_SYSTEM_CONTEXT,
    verification_targets: ["Both independent subtasks finish and merge cleanly."],
    tasks: [
      {
        id: "T001",
        title: "Implement the first independent coding slice",
        type: "coding",
        acceptance: ["First slice completes."],
        scope_files: ["src/alpha.ts"],
        concurrency_group: "alpha",
      },
      {
        id: "T002",
        title: "Implement the second independent coding slice",
        type: "coding",
        acceptance: ["Second slice completes."],
        scope_files: ["src/beta.ts"],
        concurrency_group: "beta",
      },
    ],
  },
  {
    id: "open-research",
    prompt: "loopship: research the best storage approach for this feature and produce a recommendation",
    classification: "general",
    scope: "Research storage options and produce a recommendation with tradeoffs.",
    summary: "Treat the request as a non-coding research task and return a bounded recommendation.",
    defaulted_unknowns: ["Assume local-first constraints unless contradicted."],
    constraints: ["No implementation work is required for the research pass."],
    system_context: EMPTY_SYSTEM_CONTEXT,
    verification_targets: ["The recommendation covers tradeoffs and a clear winner."],
    tasks: [
      {
        id: "T001",
        title: "Research storage options and recommend one",
        type: "general",
        acceptance: ["A recommendation with tradeoffs is produced."],
        scope_files: ["decision memo"],
      },
    ],
  },
  {
    id: "feature-parallel",
    prompt: "loopship: build a small feature that intentionally decomposes into frontend and backend child tasks",
    classification: "feature",
    scope: "Deliver a small feature with explicit frontend and backend slices.",
    summary: "Split the feature into two merge-safe child tasks for frontend and backend.",
    assumptions: ["Frontend and backend work can proceed independently."],
    constraints: ["Keep file ownership disjoint between UI and API."],
    system_context: EMPTY_SYSTEM_CONTEXT,
    verification_targets: ["Both frontend and backend slices complete and merge."],
    tasks: [
      {
        id: "T001",
        title: "Build the frontend slice",
        type: "coding",
        acceptance: ["Frontend slice is complete."],
        scope_files: ["client/**"],
        concurrency_group: "frontend",
      },
      {
        id: "T002",
        title: "Build the backend slice",
        type: "coding",
        acceptance: ["Backend slice is complete."],
        scope_files: ["server/**"],
        concurrency_group: "backend",
      },
    ],
  },
  {
    id: "vague-greenfield",
    prompt: "loopship: a fullstack app",
    classification: "greenfield_app",
    scope: "Generic greenfield product request that requires clarification before decomposition.",
    summary: "Ask one clarification round, then constrain the app to a single MVP implementation child.",
    questions: [
      {
        id: "app_purpose",
        question: "What is the primary purpose of the app?",
        impact: "high",
        default: "Task tracker",
        options: [
          {
            label: "Task tracker",
            description: "Small-team task tracking with CRUD workflows.",
          },
          {
            label: "Dashboard",
            description: "Operational dashboard with summary views.",
          },
        ],
      },
    ],
    preplanAnswers: [
      {
        question_id: "app_purpose",
        answer: "Build a task tracker for small teams.",
      },
    ],
    defaulted_unknowns: ["No auth for MVP", "Simple list UI"],
    assumptions: ["All users share the same permissions in the MVP."],
    constraints: ["Use React, Express, and SQLite."],
    system_context: EMPTY_SYSTEM_CONTEXT,
    verification_targets: ["The MVP app builds successfully."],
    tasks: [
      {
        id: "T001",
        title: "Build the MVP task tracker",
        type: "coding",
        acceptance: ["The MVP app builds successfully."],
        scope_files: ["client/**", "server/**"],
      },
    ],
  },
];

export function runLifecycleScenario(
  scenario: MatrixScenario,
): MatrixScenarioResult {
  const fixture = createFixture(`loopship-matrix-${scenario.id}-`);
  try {
    return driveScenario(fixture, scenario);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

export function runLifecycleMatrix(
  scenarios: MatrixScenario[] = LIFECYCLE_MATRIX,
): MatrixScenarioResult[] {
  return scenarios.map((scenario) => runLifecycleScenario(scenario));
}

export function summarizeLifecycleMatrix(results: MatrixScenarioResult[]): {
  passed: number;
  total: number;
  all_archived: boolean;
  all_loopship_routed: boolean;
  all_merge_commits_recorded: boolean;
} {
  return {
    passed: results.filter(
      (result) =>
        result.archived &&
        result.unique_worktrees &&
        result.unique_branches &&
        result.merge_commits_recorded &&
        result.loopship_routed,
    ).length,
    total: results.length,
    all_archived: results.every((result) => result.archived),
    all_loopship_routed: results.every((result) => result.loopship_routed),
    all_merge_commits_recorded: results.every(
      (result) => result.merge_commits_recorded,
    ),
  };
}

export function lifecycleMatrixMarkdown(results: MatrixScenarioResult[]): string {
  const summary = summarizeLifecycleMatrix(results);
  const lines = [
    "# Lifecycle Matrix Report",
    "",
    `- Cases passed: ${summary.passed}/${summary.total}`,
    `- All archived: ${summary.all_archived ? "yes" : "no"}`,
    `- All loopship-routed: ${summary.all_loopship_routed ? "yes" : "no"}`,
    `- All merge commits recorded: ${summary.all_merge_commits_recorded ? "yes" : "no"}`,
    "",
    "| Case | Classification | Children | Archived | Unique Worktrees | Unique Branches | Merge Commits | Loopship Routed | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    const notes = [
      result.general_task_present ? "general-task" : "",
      result.question_round_used ? "clarification-round" : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `| ${result.id} | ${result.classification} | ${result.child_count} | ${result.archived ? "yes" : "no"} | ${result.unique_worktrees ? "yes" : "no"} | ${result.unique_branches ? "yes" : "no"} | ${result.merge_commits_recorded ? "yes" : "no"} | ${result.loopship_routed ? "yes" : "no"} | ${notes} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function readQuestPlans(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
