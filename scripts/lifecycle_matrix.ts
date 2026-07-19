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
import {
  startLoopshipTestScheduler,
  type LoopshipTestScheduler,
} from "./loopship_fastflow_test_scheduler.ts";
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

function latestQuestState(
  fixture: MatrixFixture,
  wtree: string,
): ReturnType<typeof parseTasksYaml> {
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
    decomposition_rationale:
      scenario.tasks.length === 1
        ? "The requested scope is cohesive and needs one independently verifiable task."
        : "The requested scope splits into independently verifiable tasks with explicit boundaries.",
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

function runResumeCommand(
  fixture: MatrixFixture,
  wtree: string,
): Record<string, unknown> {
  const resumed = runLoopship(
    fixture.repo,
    ["resume", "--repo", fixture.repo, "--wtree", wtree],
    undefined,
    fixture.env,
  );
  expect(resumed.status, resumed.stderr || resumed.stdout).toBe(0);
  return parseJson(resumed.stdout);
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
  const nonce = String(args.nonce ?? "").trim();
  expect(sessionId).toBeTruthy();
  expect(nonce).toBeTruthy();
  const context = isRecord(value.context) ? value.context : {};
  const request = isRecord(context.request) ? context.request : {};
  return {
    sessionId,
    nonce,
    workspaceRoot: String(args.workspaceRoot ?? "").trim(),
    kind: String(value.kind ?? ""),
    wtree: String(request.wtree ?? request.quest_id ?? "").trim(),
    answerSchema: context.answerSchema,
  };
}

function resumeNativePause(
  fixture: MatrixFixture,
  pause: Record<string, unknown>,
  decision: Record<string, unknown>,
): Record<string, unknown> {
  const payload = {
    sessionId: String(pause.sessionId),
    nonce: String(pause.nonce),
    ...(String(pause.workspaceRoot ?? "").trim()
      ? { workspaceRoot: String(pause.workspaceRoot) }
      : {}),
    response: pause.kind === "supervisor_review"
      ? { decision: "ok" }
      : { answer: decision },
  };
  const proc = runLoopship(
    fixture.repo,
    ["hook", "--repo", fixture.repo, "--json", "@-"],
    payload,
    fixture.env,
  );
  if (proc.status !== 0) {
    throw new Error(
      [
        proc.stderr || proc.stdout || "loopship hook failed",
        `pause=${JSON.stringify(pause)}`,
        `decision=${JSON.stringify(decision)}`,
      ].join("\n"),
    );
  }
  return parseJson(proc.stdout);
}

function settleSupervisorPauses(
  fixture: MatrixFixture,
  value: Record<string, unknown>,
): Record<string, unknown> {
  let current = value;
  while (nativePauseToken(current)?.kind === "supervisor_review") {
    current = resumeNativePause(fixture, nativePauseToken(current)!, {});
  }
  return current;
}

function resumeNativeDecision(
  fixture: MatrixFixture,
  value: Record<string, unknown>,
  decision: Record<string, unknown>,
): Record<string, unknown> {
  const current = settleSupervisorPauses(fixture, value);
  const pause = nativePauseToken(current);
  expect(pause, JSON.stringify(current)).not.toBeNull();
  const answerSchema = isRecord(pause!.answerSchema) ? pause!.answerSchema : {};
  const required = Array.isArray(answerSchema.required)
    ? answerSchema.required.map(String)
    : [];
  for (const field of required) {
    expect(
      Object.prototype.hasOwnProperty.call(decision, field),
      `decision ${JSON.stringify(decision)} does not match ${JSON.stringify(answerSchema)}`,
    ).toBe(true);
  }
  if (answerSchema.additionalProperties === false && isRecord(answerSchema.properties)) {
    for (const field of Object.keys(decision)) {
      expect(
        Object.prototype.hasOwnProperty.call(answerSchema.properties, field),
        `decision ${JSON.stringify(decision)} does not match ${JSON.stringify(answerSchema)}`,
      ).toBe(true);
    }
  }
  return settleSupervisorPauses(
    fixture,
    resumeNativePause(fixture, pause!, decision),
  );
}

type NativeHandoffEvidence = {
  stage: string;
  executionId: string;
  requiredAnswerFields: string[];
};

function expectNativeHandoffAtStage(
  value: Record<string, unknown>,
  stage: string,
  evidence: NativeHandoffEvidence[],
): Record<string, unknown> {
  const pause = nativePauseToken(value);
  expect(pause, JSON.stringify(value)).not.toBeNull();
  expect(pause!.kind, JSON.stringify(value)).toBe("handoff_answer");
  const context = isRecord(value.context) ? value.context : {};
  const request = isRecord(context.request) ? context.request : {};
  expect(request.current_stage, JSON.stringify(value)).toBe(stage);
  const answerSchema = isRecord(pause!.answerSchema) ? pause!.answerSchema : {};
  evidence.push({
    stage,
    executionId: String(pause!.sessionId),
    requiredAnswerFields: Array.isArray(answerSchema.required)
      ? answerSchema.required.map(String)
      : [],
  });
  return pause!;
}

function expectCanonicalStage(
  fixture: MatrixFixture,
  wtree: string,
  stage: string,
) {
  const state = latestQuestState(fixture, wtree);
  expect(state.stage).toBe(stage);
  return state;
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
  const handoffEvidence: NativeHandoffEvidence[] = [];
  let current = settleSupervisorPauses(
    fixture,
    runInitCommand(fixture, scenario.prompt),
  );
  let pause = expectNativeHandoffAtStage(current, "planning", handoffEvidence);
  const wtree = String(pause.wtree ?? "");
  expect(wtree).toBeTruthy();
  let executionId = String(pause.sessionId);

  let questionRoundUsed = false;
  if (scenario.questions?.length) {
    current = resumeNativeDecision(
      fixture,
      current,
      scenarioPlanPayload(scenario, "questions"),
    );
    const firstPlan = nativeWorkflowOutput(current);
    expect(firstPlan, JSON.stringify(current)).not.toBeNull();
    expect(firstPlan!.step).toBe("plan");
    expect(firstPlan!.stage_after).toBe("awaiting_user_answers");
    expectCanonicalStage(fixture, wtree, "awaiting_user_answers");
    questionRoundUsed = true;

    current = settleSupervisorPauses(fixture, runResumeCommand(fixture, wtree));
    pause = expectNativeHandoffAtStage(
      current,
      "awaiting_user_answers",
      handoffEvidence,
    );
    expect(String(pause.sessionId)).not.toBe(executionId);
    executionId = String(pause.sessionId);

    current = resumeNativeDecision(fixture, current, {
      answers: scenario.preplanAnswers ?? [],
    });
    pause = expectNativeHandoffAtStage(current, "planning", handoffEvidence);
    expect(String(pause.sessionId)).toBe(executionId);
    expectCanonicalStage(fixture, wtree, "planning");

    current = resumeNativeDecision(
      fixture,
      current,
      scenarioPlanPayload(scenario, "task_graph"),
    );
    pause = expectNativeHandoffAtStage(current, "plan_review", handoffEvidence);
    expect(String(pause.sessionId)).toBe(executionId);
    expectCanonicalStage(fixture, wtree, "plan_review");
  } else {
    current = resumeNativeDecision(
      fixture,
      current,
      scenarioPlanPayload(scenario, "task_graph"),
    );
    pause = expectNativeHandoffAtStage(current, "plan_review", handoffEvidence);
    expect(String(pause.sessionId)).toBe(executionId);
    expectCanonicalStage(fixture, wtree, "plan_review");
  }

  current = resumeNativeDecision(fixture, current, { approved: true });
  const executing = nativeWorkflowOutput(current);
  expect(executing, JSON.stringify(current)).not.toBeNull();
  expectCanonicalStage(fixture, wtree, "executing");
  const dispatchExecutionId = executionId;
  const executingOutput = executing!;
  expect(executingOutput.step).toBe("executing");
  expect(executingOutput.stage_after).toBe("executing");
  const childDispatch = nestedNativeStepOutput(executingOutput);
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

  current = settleSupervisorPauses(fixture, runResumeCommand(fixture, wtree));
  pause = expectNativeHandoffAtStage(current, "executing", handoffEvidence);
  expect(String(pause.sessionId)).not.toBe(dispatchExecutionId);
  executionId = String(pause.sessionId);

  children.forEach((child, index) => {
    current = resumeNativeDecision(
      fixture,
      current,
      childResultPayload(
        String(child.task_id),
        String(child.child_wtree),
        String(child.worktree_path),
      ),
    );
    const nextStage = index === children.length - 1 ? "validating" : "executing";
    pause = expectNativeHandoffAtStage(current, nextStage, handoffEvidence);
    expect(String(pause.sessionId)).toBe(executionId);
    expectCanonicalStage(fixture, wtree, nextStage);
  });

  current = resumeNativeDecision(fixture, current, {
    status: "passed",
    checks: [{ name: `${scenario.id}-smoke`, status: "passed" }],
  });
  pause = expectNativeHandoffAtStage(
    current,
    "verification_pending",
    handoffEvidence,
  );
  expect(String(pause.sessionId)).toBe(executionId);
  expectCanonicalStage(fixture, wtree, "verification_pending");

  current = resumeNativeDecision(fixture, current, {
    status: "passed",
    acceptance_trace: scenario.tasks.map((task) => ({
      acceptance: String((task.acceptance as string[])[0] ?? task.title ?? "done"),
      status: "passed",
    })),
    risks: [],
  });
  pause = expectNativeHandoffAtStage(
    current,
    "system_update_pending",
    handoffEvidence,
  );
  expect(String(pause.sessionId)).toBe(executionId);
  expectCanonicalStage(fixture, wtree, "system_update_pending");

  current = resumeNativeDecision(fixture, current, {
    system_update: {
      schema_version: 1,
      mode: "no_change",
      summary: `${scenario.id} covered`,
    },
  });
  const landed = nativeWorkflowOutput(current);
  expect(landed, JSON.stringify(current)).not.toBeNull();
  expect(landed!.step).toBe("landing");
  expect(landed!.stage_after).toBe("archived");

  const expectedHandoffStages = scenario.questions?.length
    ? [
        "planning",
        "awaiting_user_answers",
        "planning",
        "plan_review",
        "executing",
        ...children.map((_, index) =>
          index === children.length - 1 ? "validating" : "executing"
        ),
        "verification_pending",
        "system_update_pending",
      ]
    : [
        "planning",
        "plan_review",
        "executing",
        ...children.map((_, index) =>
          index === children.length - 1 ? "validating" : "executing"
        ),
        "verification_pending",
        "system_update_pending",
      ];
  expect(handoffEvidence.map((entry) => entry.stage)).toEqual(expectedHandoffStages);
  expect(new Set(handoffEvidence.map((entry) => entry.executionId)).size).toBe(
    scenario.questions?.length ? 3 : 2,
  );
  expect(handoffEvidence.every((entry) => entry.requiredAnswerFields.length > 0)).toBe(
    true,
  );

  const finalStatePath = join(
    fixture.repo,
    "worktrees",
    wtree,
    ".loopship",
    "runtime",
    "tasks.yaml",
  );
  const landedRuntime = isRecord(landed!.runtime) ? landed!.runtime : {};
  const landedRuntimeTasks = isRecord(landedRuntime.tasks) ? landedRuntime.tasks : {};
  const landedStatePatch = isRecord(landed!.state_patch) ? landed!.state_patch : {};
  const finalState = existsSync(finalStatePath)
    ? latestQuestState(fixture, wtree)
    : { ...landedRuntimeTasks, ...landedStatePatch };
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

export async function runLifecycleScenario(
  scenario: MatrixScenario,
): Promise<MatrixScenarioResult> {
  const fixture = createFixture(`loopship-matrix-${scenario.id}-`);
  let scheduler: LoopshipTestScheduler | null = null;
  try {
    scheduler = await startLoopshipTestScheduler({
      dbPath: join(fixture.root, "scheduler", "native-v1.sqlite"),
      home: fixture.env.HOME!,
    });
    Object.assign(fixture.env, scheduler.env);
    return driveScenario(fixture, scenario);
  } finally {
    await scheduler?.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

export async function runLifecycleMatrix(
  scenarios: MatrixScenario[] = LIFECYCLE_MATRIX,
): Promise<MatrixScenarioResult[]> {
  const results: MatrixScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runLifecycleScenario(scenario));
  }
  return results;
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
