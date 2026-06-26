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
import { parseTasksYaml, questFiles } from "./loopship_core.ts";
import { validateV3Input } from "./loopship_schema.ts";
import { readText, runCommand } from "./loopship_utils.ts";

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

function expectValidSchema(
  payload: Record<string, unknown>,
  schemaName: string,
): void {
  expect(validateV3Input(payload, schemaName)).toEqual([]);
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
    timeoutMs: 60_000,
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

function next(
  fixture: MatrixFixture,
  wtree: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const proc = runLoopship(
    fixture.repo,
    [
      "resume",
      "--wtree",
      wtree,
      "--json",
      "@-",
      "--full",
    ],
    payload,
    fixture.env,
  );
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
  return parseJson(proc.stdout);
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
    readFileSync(questFiles(fixture.repo, wtree).tasks, "utf8"),
  );
}

function childResultPayload(taskId: string, childWtree: string, worktreePath: string) {
  return {
    step: "child_result",
    task_id: taskId,
    child_wtree: childWtree,
    status: "passed",
    worktree_path: worktreePath,
    merge_commit: `merge-${taskId}`,
    evidence: [{ type: "summary", ref: `${taskId}.txt` }],
  };
}

function routeAndCreateQuest(
  fixture: MatrixFixture,
  prompt: string,
): { wtree: string; route: any; created: Record<string, unknown> } {
  const init = runLoopship(
    fixture.repo,
    ["init", prompt, "--runtime", "codex"],
    undefined,
    fixture.env,
  );
  expect(init.status, init.stderr || init.stdout).toBe(0);
  const route = parseJson(init.stdout);
  expectValidSchema(route, "init-output");
  expect(route.new_quest.command.cmd).toBe("loopship");
  expect(route.new_quest.command.args).toEqual(
    expect.arrayContaining(["resume"]),
  );
  const wtree = String(route.new_quest.suggested_wtree);
  const created = next(fixture, wtree, route.new_quest.input);
  expectValidSchema(created, "step-output");
  return { wtree, route, created };
}

function driveScenario(
  fixture: MatrixFixture,
  scenario: MatrixScenario,
): MatrixScenarioResult {
  const { wtree, created } = routeAndCreateQuest(fixture, scenario.prompt);
  expect(created.step).toBe("plan");

  let questionRoundUsed = false;
  if (scenario.questions?.length) {
    const awaiting = next(fixture, wtree, {
      step: "plan",
      classification: scenario.classification,
      scope: scenario.scope,
      summary: scenario.summary,
      questions: scenario.questions,
      system_context: scenario.system_context ?? EMPTY_SYSTEM_CONTEXT,
      verification_targets: scenario.verification_targets,
      task_graph: { tasks: [] },
    });
    expectValidSchema(awaiting, "step-output");
    expect(awaiting.step).toBe("questions");
    questionRoundUsed = true;
    const backToPlanning = next(fixture, wtree, {
      step: "questions",
      answers: scenario.preplanAnswers ?? [],
    });
    expectValidSchema(backToPlanning, "step-output");
    expect(backToPlanning.step).toBe("plan");
  }

  const planned = next(fixture, wtree, {
    step: "plan",
    classification: scenario.classification,
    scope: scenario.scope,
    summary: scenario.summary,
    defaulted_unknowns: scenario.defaulted_unknowns ?? [],
    assumptions: scenario.assumptions ?? [],
    constraints: scenario.constraints ?? [],
    system_context: scenario.system_context ?? EMPTY_SYSTEM_CONTEXT,
    verification_targets: scenario.verification_targets,
    task_graph: { tasks: scenario.tasks },
  });
  expectValidSchema(planned, "step-output");
  expect(planned.step).toBe("task_graph");

  const executing = next(fixture, wtree, {
    step: "task_graph",
    approved: true,
  });
  expectValidSchema(executing, "child-dispatch-output");
  expect(executing.step).toBe("executing");
  const children = Array.isArray((executing as any).children)
    ? ((executing as any).children as any[])
    : [];
  expect(children.length).toBe(scenario.tasks.length);

  const worktrees = gitWorktrees(fixture.repo, fixture.env);
  const childWorktrees = children.map((child) => resolve(String(child.worktree_path)));
  const childBranches = children.map((child) => String(child.branch_ref));
  for (const child of children) {
    expect(child.commands.init.cmd).toBe("loopship");
    expect(child.commands.init.args).toEqual(
      expect.arrayContaining([
        "init",
        "--wtree",
        child.child_wtree,
        "--runtime",
        "codex",
      ]),
    );
    expect(existsSync(String(child.worktree_path))).toBe(true);
    expect(worktrees).toContain(resolve(String(child.worktree_path)));
  }

  for (const child of children) {
    next(
      fixture,
      wtree,
      childResultPayload(
        String(child.task_id),
        String(child.child_wtree),
        String(child.worktree_path),
      ),
    );
  }

  const validated = next(fixture, wtree, {
    step: "validation",
    status: "passed",
    checks: [{ name: `${scenario.id}-smoke`, status: "passed" }],
  });
  expectValidSchema(validated, "step-output");
  expect(validated.step).toBe("verification");

  const verified = next(fixture, wtree, {
    step: "verification",
    status: "passed",
    acceptance_trace: scenario.tasks.map((task) => ({
      acceptance: String((task.acceptance as string[])[0] ?? task.title ?? "done"),
      status: "passed",
    })),
    risks: [],
  });
  expectValidSchema(verified, "step-output");
  expect(verified.step).toBe("system_update");

  const landing = next(fixture, wtree, {
    step: "system_update",
    system_update: {
      schema_version: 1,
      mode: "no_change",
      summary: `${scenario.id} covered`,
    },
  });
  expectValidSchema(landing, "step-output");
  expect(landing.step).toBe("landing");

  const archived = next(fixture, wtree, {
    step: "landing",
    status: "landed",
    summary: `${scenario.id} complete`,
  });
  expectValidSchema(archived, "archive-output");
  expect(archived.step).toBe("archived");

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
    loopship_routed: children.every(
      (child) =>
        child.commands.init.cmd === "loopship" &&
        child.commands.next.cmd === "loopship",
    ),
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

export function runLifecycleMatrix(): MatrixScenarioResult[] {
  return LIFECYCLE_MATRIX.map((scenario) => {
    const fixture = createFixture(`loopship-matrix-${scenario.id}-`);
    try {
      return driveScenario(fixture, scenario);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
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
  return existsSync(path) ? readText(path) : "";
}
