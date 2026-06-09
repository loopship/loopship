import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTasksYaml, questFiles } from "./loopo_core.ts";
import { runCommand } from "./loopo_utils.ts";
import { validateV3Input } from "./loopo_schema.ts";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "loopo.ts");
const EMPTY_SYSTEM_CONTEXT = {
  relevant_object_refs: [],
  relevant_assertion_refs: [],
  relevant_resource_refs: [],
  relevant_memory_refs: [],
  durable_implications: [],
};

type Fixture = {
  root: string;
  repo: string;
  env: Record<string, string>;
};

function parseJson(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `failed to parse JSON stdout (${stdout.length} bytes): ${stdout.slice(0, 400)} ... ${stdout.slice(-800)}\n${String(error)}`,
    );
  }
}

function expectValidSchema(
  payload: Record<string, unknown>,
  schemaName: string,
): void {
  expect(validateV3Input(payload, schemaName)).toEqual([]);
}

function expectNoSchemaRefs(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) expectNoSchemaRefs(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  expect(value).not.toHaveProperty("$ref");
  for (const item of Object.values(value)) expectNoSchemaRefs(item);
}

function runLoopo(
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

function runGit(cwd: string, args: string[]): void {
  const proc = runCommand("git", args, { cwd, timeoutMs: 30_000 });
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
}

function gitStdout(cwd: string, args: string[]): string {
  const proc = runCommand("git", args, { cwd, timeoutMs: 30_000 });
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
  return proc.stdout.trim();
}

function expectGitAncestor(cwd: string, ancestor: string, descendant: string): void {
  const proc = runCommand("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    timeoutMs: 30_000,
  });
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
}

function createFixture(prefix: string): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repo = join(root, "repo");
  const env = {
    HOME: join(root, "home"),
    LOOPO_GLOBAL_BIN: join(root, "bin", "loopo"),
    LOOPO_SCRIPT: SCRIPT,
  };
  const initGit = runCommand("git", ["init", repo], { timeoutMs: 15_000 });
  expect(initGit.status, initGit.stderr || initGit.stdout).toBe(0);
  runGit(repo, ["config", "user.email", "loopo-test@example.invalid"]);
  runGit(repo, ["config", "user.name", "Loopo Test"]);
  writeFileSync(join(repo, "README.md"), "# loopo v3 integration\n", "utf8");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "fixture"]);
  return { root, repo, env };
}

function next(
  fixture: Fixture,
  wtree: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const proc = runLoopo(
    fixture.repo,
    [
      "quest",
      "next",
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

function compactCurrent(
  fixture: Fixture,
  wtree: string,
): Record<string, unknown> {
  const proc = runLoopo(
    fixture.repo,
    ["quest", "next", "--wtree", wtree, "--json", "@-"],
    {},
    fixture.env,
  );
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
  return parseJson(proc.stdout);
}

describe("loopo v3 child wtree integration", () => {
  it("documents the v3 command flow in public usage", () => {
    const fixture = createFixture("loopo-v3-help-");
    try {
      const usage = runLoopo(fixture.repo, [], undefined, fixture.env);
      expect(usage.status).toBe(1);
      const publicInitLines = usage.stdout
        .split("\n")
        .filter((line) => line.trim().startsWith("loopo init "));
      expect(publicInitLines).toEqual([
        '  loopo init "loopo: <request>" --runtime <codex|gemini|copilot|all> [--flow swe] [--wtree <name>]',
      ]);
      const publicHookLines = usage.stdout
        .split("\n")
        .filter((line) => line.trim().startsWith("loopo hook "));
      expect(publicHookLines).toEqual([
        "  loopo hook --runtime <codex|gemini|copilot>",
      ]);
      expect(usage.stdout).toContain("loopo quest next --wtree <name>");
      expect(usage.stdout).toContain("loopo sim init");
      expect(usage.stdout).toContain("loopo sim quest next");
      expect(usage.stdout).toContain("loopo sim hook");
      expect(usage.stdout).not.toContain("quest help");
      expect(usage.stdout).not.toContain("sim quest help");
      expect(usage.stdout).not.toContain("loopo spec");

      const removedHelp = runLoopo(
        fixture.repo,
        ["quest", "help"],
        undefined,
        fixture.env,
      );
      expect(removedHelp.status).toBe(1);
      expect(removedHelp.stdout).toContain("Usage:");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it(
    "runs the bin-coordinated parent and child result flow",
    () => {
      const fixture = createFixture("loopo-v3-child-");
      try {
      const init = runLoopo(
        fixture.repo,
        [
          "init",
          "loopo: build calculator",
          "--runtime",
          "codex",
        ],
        undefined,
        fixture.env,
      );
      expect(init.status, init.stderr || init.stdout).toBe(0);
      const route = parseJson(init.stdout);
      expectValidSchema(route, "init-output");
      expect(route.kind).toBe("init_route");
      expect(route.flow_id).toBe("swe");
      expect(route.schema_path).toBe(
        "schemas/steps/init-output.yaml",
      );
      const wtree = String(route.new_quest.suggested_wtree);
      expect((route.new_quest.command.args as string[])).not.toContain("@-");
      expect((route.new_quest.command.args as string[])).toEqual(
        expect.arrayContaining([
          "--json",
          JSON.stringify({
            step: "select_quest",
            action: "create_quest",
            wtree: wtree,
            flow_id: "swe",
            request: "loopo: build calculator",
          }),
        ]),
      );

      const created = next(fixture, wtree, {
        step: "select_quest",
        action: "create_quest",
        wtree: wtree,
        request: "loopo: build calculator",
      });
      expectValidSchema(created, "step-output");
      expect(created.step).toBe("plan");
      expect(created.flow_id).toBe("swe");
      expect((created.context as any).step).toMatchObject({
        schema_version: 1,
        id: "plan",
        handler: "plan",
        input_step: "plan",
        input_schema: {
          $id: "schemas/steps/step-output.yaml",
          type: "object",
        },
        output_schema: {
          $id: "schemas/steps/plan-input.yaml",
          type: "object",
        },
        result_schema_path: "schemas/steps/step-output.yaml",
        summary:
          "Submit a decision-complete plan payload with explicit system context. Ask or default every high-impact unknown.",
      });
      expect((created.context as any).step).not.toHaveProperty("spec_refs");
      expect((created.context as any).step.instructions).toContain(
        "# Loopo Plan Step",
      );
      expect((created.context as any).step.instructions).toContain(
        "## Defaulting Rules",
      );
      expect((created.context as any).step.instructions).toContain(
        "request_user_input",
      );
      expect((created.context as any).step.instructions).toContain(
        "Follow the instructions above, then construct one JSON payload matching output_schema and send it to commands.next.",
      );
      expect(created).not.toHaveProperty("session_id");
      expect(created).not.toHaveProperty("expected_update");

      const compact = compactCurrent(fixture, wtree);
      expectValidSchema(compact, "step-output");
      expect(compact).toMatchObject({
        step: {
          id: "plan",
        },
      });
      const compactStep = compact.step as Record<string, string>;
      expect(compactStep).not.toHaveProperty("summary");
      expect(compactStep.instructions).toContain("# Loopo Plan Step");
      expect(compactStep.instructions).toContain(
        "Follow the instructions above, then construct one JSON payload matching output_schema and send it to commands.next.",
      );
      const compactCallbackSchema = compact.output_schema as Record<
        string,
        any
      >;
      expect(compactCallbackSchema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "schemas/steps/plan-input.yaml",
        type: "object",
      });
      expect(compactCallbackSchema.required).toEqual(
        expect.arrayContaining([
          "step",
          "classification",
          "scope",
          "system_context",
          "verification_targets",
          "task_graph",
        ]),
      );
      expect(compactCallbackSchema.properties?.questions?.items).toMatchObject({
        type: "object",
        required: ["id", "question"],
      });
      expectNoSchemaRefs(compactCallbackSchema);
      expect(compact).not.toHaveProperty("schema_version");
      expect(compact).not.toHaveProperty("kind");
      expect(compact).not.toHaveProperty("schema_path");
      expect(compact).not.toHaveProperty("input_schema");
      expect(compact).not.toHaveProperty("wtree");
      expect(compact).not.toHaveProperty("flow_id");
      expect(compact).not.toHaveProperty("flow_version");
      expect(compact).not.toHaveProperty("state");
      expect(compact).not.toHaveProperty("summary");
      expect(compact).not.toHaveProperty("quest_id");
      expect(compact).not.toHaveProperty("context");
      expect(compact).not.toHaveProperty("docs");
      expect(compact).not.toHaveProperty("allowed_transitions");
      expect(compact).not.toHaveProperty("requirements");
      expect(compact).not.toHaveProperty("note");
      expect(((compact.commands as any).next as any).args).toContain("next");
      expect((compact.commands as any).next).not.toHaveProperty("display");

      const unknownField = runLoopo(
        fixture.repo,
        [
          "quest",
          "next",
          "--wtree",
          wtree,
          "--json",
          "@-",
        ],
        {
          step: "plan",
          classification: "general",
          scope: "calculator",
          system_context: EMPTY_SYSTEM_CONTEXT,
          verification_targets: [],
          task_graph: { tasks: [] },
          extra: true,
        },
        fixture.env,
      );
      expect(unknownField.status).toBe(1);
      expect(String(parseJson(unknownField.stdout).error)).toContain(
        "schema validation",
      );

      const blockedProc = runLoopo(
        fixture.repo,
        [
          "quest",
          "next",
          "--wtree",
          wtree,
          "--json",
          "@-",
        ],
        {
          step: "plan",
          classification: "greenfield_app",
          scope: "calculator",
          high_impact_unknowns: ["target user"],
          system_context: EMPTY_SYSTEM_CONTEXT,
          verification_targets: [],
          task_graph: { tasks: [] },
        },
        fixture.env,
      );
      expect(blockedProc.status).toBe(1);
      const blocked = parseJson(blockedProc.stdout);
      expectValidSchema(blocked, "error-output");
      expect(blocked.kind).toBe("error");
      expect(String(blocked.error)).toContain("high-impact");

      const vagueInit = runLoopo(
        fixture.repo,
        [
          "init",
          "loopo: create a fullstack app",
          "--runtime",
          "codex",
        ],
        undefined,
        fixture.env,
      );
      expect(vagueInit.status, vagueInit.stderr || vagueInit.stdout).toBe(0);
      const vagueRoute = parseJson(vagueInit.stdout);
      const vagueWtree = String(vagueRoute.new_quest.suggested_wtree);
      const vagueCreated = next(fixture, vagueWtree, {
        step: "select_quest",
        action: "create_quest",
        wtree: vagueWtree,
        request: "loopo: create a fullstack app",
      });
      expectValidSchema(vagueCreated, "step-output");
      expect(vagueCreated.step).toBe("plan");

      const vagueBlockedProc = runLoopo(
        fixture.repo,
        [
          "quest",
          "next",
          "--wtree",
          vagueWtree,
          "--json",
          "@-",
        ],
        {
          step: "plan",
          classification: "greenfield_app",
          scope: "Fullstack Todo App with React and Express",
          summary: "Implement a React and Express todo app",
          system_context: EMPTY_SYSTEM_CONTEXT,
          verification_targets: ["todo CRUD works"],
          task_graph: {
            tasks: [
              {
                id: "T001",
                title: "Implement todo app",
                type: "coding",
                acceptance: ["todo app works"],
              },
            ],
          },
        },
        fixture.env,
      );
      expect(vagueBlockedProc.status).toBe(1);
      const vagueBlocked = parseJson(vagueBlockedProc.stdout);
      expectValidSchema(vagueBlocked, "error-output");
      expect(vagueBlocked.kind).toBe("error");
      expect(String(vagueBlocked.error)).toContain("clarification round");

      const serialInit = runLoopo(
        fixture.repo,
        [
          "init",
          "loopo: build a task tracker",
          "--runtime",
          "codex",
        ],
        undefined,
        fixture.env,
      );
      expect(serialInit.status, serialInit.stderr || serialInit.stdout).toBe(0);
      const serialRoute = parseJson(serialInit.stdout);
      const serialWtree = String(serialRoute.new_quest.suggested_wtree);
      const serialCreated = next(fixture, serialWtree, {
        step: "select_quest",
        action: "create_quest",
        wtree: serialWtree,
        request: "loopo: build a task tracker",
      });
      expectValidSchema(serialCreated, "step-output");
      expect(serialCreated.step).toBe("plan");

      const serialPlanned = next(fixture, serialWtree, {
        step: "plan",
        classification: "greenfield_app",
        scope: "task tracker",
        defaulted_unknowns: ["local single-user scope"],
        system_context: EMPTY_SYSTEM_CONTEXT,
        verification_targets: ["dependent tasks dispatch in order"],
        task_graph: {
          tasks: [
            {
              id: "scaffold_and_auth",
              title: "Scaffold and auth",
              type: "coding",
              acceptance: ["scaffold exists"],
            },
            {
              id: "implement_dashboard",
              title: "Implement dashboard",
              depends_on: ["scaffold_and_auth"],
              type: "coding",
              acceptance: ["dashboard works"],
            },
          ],
        },
      });
      expectValidSchema(serialPlanned, "step-output");
      expect(serialPlanned.step).toBe("task_graph");

      const serialExecuting = next(fixture, serialWtree, {
        step: "task_graph",
        approved: true,
      });
      expectValidSchema(serialExecuting, "child-dispatch-output");
      expect(
        (serialExecuting.children as any[]).map((child) => child.task_id),
      ).toEqual(["scaffold-and-auth"]);

      const serialNext = next(fixture, serialWtree, {
        step: "child_result",
        task_id: "scaffold-and-auth",
        child_wtree: `${serialWtree}-scaffold-and-auth`,
        status: "passed",
        evidence: [{ type: "summary", ref: "scaffold.txt" }],
        merge_commit: "serial123",
      });
      expectValidSchema(serialNext, "child-dispatch-output");
      expect((serialNext.children as any[]).map((child) => child.task_id)).toEqual(
        ["implement-dashboard"],
      );

      const planned = next(fixture, wtree, {
        step: "plan",
        classification: "greenfield_app",
        scope: "calculator",
        high_impact_unknowns: ["target user"],
        defaulted_unknowns: ["standard end-user calculator"],
        system_context: EMPTY_SYSTEM_CONTEXT,
        verification_targets: ["calculator arithmetic works"],
        task_graph: {
          tasks: [
            {
              id: "T001",
              title: "Build calculator",
              type: "coding",
              acceptance: ["calculator works"],
              scope_files: ["index.html"],
              spec_refs: ["coding"],
              context_refs: ["README.md"],
              concurrency_group: "ui",
            },
          ],
        },
      });
      expectValidSchema(planned, "step-output");
      expect(planned.step).toBe("task_graph");

      const executing = next(fixture, wtree, {
        step: "task_graph",
        approved: true,
      });
      expectValidSchema(executing, "child-dispatch-output");
      expect(executing.step).toBe("executing");
      expect(executing.state).toBe("task_graph_ready");
      expect((executing.children as any[])[0].child_wtree).toBe(`${wtree}-t001`);
      const dispatchedMergeTarget = String(
        (executing.children as any[])[0].merge_target,
      );

      const validating = next(fixture, wtree, {
        step: "child_result",
        task_id: "T001",
        child_wtree: `${wtree}-t001`,
        status: "passed",
        evidence: [{ type: "summary", ref: "index.html" }],
        merge_commit: "abc123",
      });
      expectValidSchema(validating, "step-output");
      expect(validating.step).toBe("validation");
      const stateAfterChildResult = parseTasksYaml(
        readFileSync(questFiles(fixture.repo, wtree).tasks, "utf8"),
      );
      expect(stateAfterChildResult.quest_id).toBe(wtree);
      expect((stateAfterChildResult.tasks as any[])[0].merge_target).toBe(
        dispatchedMergeTarget,
      );

      const invalidValidation = runLoopo(
        fixture.repo,
        [
          "quest",
          "next",
          "--wtree",
          wtree,
          "--json",
          "@-",
        ],
        {
          step: "validation",
          status: "passed",
        },
        fixture.env,
      );
      expect(invalidValidation.status).toBe(1);
      expect(parseJson(invalidValidation.stdout).error).toContain(
        "schema validation",
      );

      const verified = next(fixture, wtree, {
        step: "validation",
        status: "passed",
        checks: [{ name: "smoke", status: "passed" }],
      });
      expectValidSchema(verified, "step-output");
      expect(verified.step).toBe("verification");

      const systemUpdate = next(fixture, wtree, {
        step: "verification",
        status: "passed",
        acceptance_trace: [
          { acceptance: "calculator works", status: "passed" },
        ],
        risks: [],
      });
      expectValidSchema(systemUpdate, "step-output");
      expect(systemUpdate.step).toBe("system_update");

      const compactSystemUpdate = compactCurrent(fixture, wtree);
      expectValidSchema(compactSystemUpdate, "step-output");
      expect((compactSystemUpdate.step as any).id).toBe("system_update");
      const systemUpdateSchema = compactSystemUpdate.output_schema as Record<
        string,
        any
      >;
      expect(systemUpdateSchema).toMatchObject({
        schema_path: "schemas/steps/system-update-input.yaml",
      });
      expect(systemUpdateSchema).not.toHaveProperty("$id");

      const invalidSystemUpdate = runLoopo(
        fixture.repo,
        [
          "quest",
          "next",
          "--wtree",
          wtree,
          "--json",
          "@-",
        ],
        {
          step: "system_update",
          system_update: {
            updates: [{ doc_id: "architecture", summary: "calculator built" }],
          },
        },
        fixture.env,
      );
      expect(invalidSystemUpdate.status).toBe(1);
      expect(parseJson(invalidSystemUpdate.stdout).error).toContain(
        "schema validation",
      );

      const landing = next(fixture, wtree, {
        step: "system_update",
        system_update: {
          schema_version: 1,
          mode: "no_change",
          summary: "calculator built",
        },
      });
      expectValidSchema(landing, "step-output");
      expect(landing.step).toBe("landing");

      mkdirSync(join(fixture.repo, "worktrees"), { recursive: true });
      writeFileSync(
        join(fixture.repo, "worktrees", "leaked.txt"),
        "should not be tracked\n",
        "utf8",
      );
      runGit(fixture.repo, ["add", "worktrees/leaked.txt"]);
      const leakedLanding = runLoopo(
        fixture.repo,
        [
          "quest",
          "next",
          "--wtree",
          wtree,
          "--json",
          "@-",
        ],
        {
          step: "landing",
          status: "landed",
          summary: "done",
        },
        fixture.env,
      );
      expect(leakedLanding.status).toBe(1);
      expect(parseJson(leakedLanding.stdout).error).toContain(
        "tracked files remain under worktrees/",
      );
      runGit(fixture.repo, ["reset", "HEAD", "--", "worktrees/leaked.txt"]);
      rmSync(join(fixture.repo, "worktrees", "leaked.txt"), { force: true });

      const archived = next(fixture, wtree, {
        step: "landing",
        status: "landed",
        summary: "done",
      });
      expectValidSchema(archived, "archive-output");
      expect(archived.step).toBe("archived");
      expect((archived.context as any).step.instructions).toContain(
        "output_schema is null",
      );
      expect((archived.context as any).step.instructions).not.toContain(
        "construct one JSON payload matching output_schema",
      );
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("allows decomposition after answered clarification for vague greenfield prompts", () => {
    const fixture = createFixture("loopo-v3-vague-greenfield-");
    try {
      const init = runLoopo(
        fixture.repo,
        [
          "init",
          "loopo: a fullstack app",
          "--runtime",
          "codex",
        ],
        undefined,
        fixture.env,
      );
      expect(init.status, init.stderr || init.stdout).toBe(0);
      const route = parseJson(init.stdout);
      const wtree = String(route.new_quest.suggested_wtree);

      const created = next(fixture, wtree, {
        step: "select_quest",
        action: "create_quest",
        wtree: wtree,
        request: "loopo: a fullstack app",
      });
      expectValidSchema(created, "step-output");
      expect(created.step).toBe("plan");
      expect(((created.commands as any).next as any).args).toEqual(
        expect.arrayContaining(["--wtree", wtree]),
      );

      const awaitingAnswers = next(fixture, wtree, {
        step: "plan",
        classification: "greenfield_app",
        scope: "Generic fullstack application as requested by the user.",
        summary:
          "The request is generic, so clarification is required before decomposition.",
        system_context: EMPTY_SYSTEM_CONTEXT,
        verification_targets: [],
        questions: [
          {
            id: "app_purpose",
            question: "What is the primary purpose of the app?",
            impact: "high",
            default: "Task tracker",
          },
        ],
        task_graph: { tasks: [] },
      });
      expectValidSchema(awaitingAnswers, "step-output");
      expect(awaitingAnswers.step).toBe("questions");
      expect(awaitingAnswers.state).toBe("awaiting_user_answers");

      const backToPlanning = next(fixture, wtree, {
        step: "questions",
        answers: [
          {
            question_id: "app_purpose",
            answer: "Build a task tracker for small teams.",
          },
        ],
      });
      expectValidSchema(backToPlanning, "step-output");
      expect(backToPlanning.step).toBe("plan");
      expect(backToPlanning.state).toBe("planning");
      const answeredState = parseTasksYaml(
        readFileSync(questFiles(fixture.repo, wtree).tasks, "utf8"),
      ) as any;
      expect(answeredState.answers).toBeUndefined();
      expect(answeredState.question_rounds[0].questions[0]).toMatchObject({
        id: "app_purpose",
        status: "answered",
        answer: "Build a task tracker for small teams.",
        accepted_default: false,
      });

      const decomposed = next(fixture, wtree, {
        step: "plan",
        classification: "greenfield_app",
        scope:
          "Build a full-stack task tracker for small teams with a React frontend, an Express backend, and SQLite persistence.",
        summary: "Implement the MVP task tracker in one bounded child task.",
        defaulted_unknowns: ["No auth for MVP", "Simple list UI"],
        assumptions: ["All team members share the same permissions."],
        constraints: ["Use React, Express, and SQLite."],
        system_context: EMPTY_SYSTEM_CONTEXT,
        verification_targets: ["Production build succeeds"],
        task_graph: {
          tasks: [
            {
              id: "T001",
              title: "Build the MVP task tracker",
              type: "coding",
              acceptance: ["Production build succeeds"],
            },
          ],
        },
      });
      expectValidSchema(decomposed, "step-output");
      expect(decomposed.step).toBe("task_graph");
      expect(decomposed.state).toBe("plan_review");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("treats execute-child quests as leaf workers after task graph approval", () => {
    const fixture = createFixture("loopo-v3-child-worker-");
    try {
      const init = runLoopo(
        fixture.repo,
        [
          "init",
          "loopo: execute child task build-mvp-task-tracker: Build the MVP full-stack task tracker application",
          "--wtree",
          "a-fullstack-app-build-mvp-task-tracker",
          "--runtime",
          "codex",
        ],
        undefined,
        fixture.env,
      );
      expect(init.status, init.stderr || init.stdout).toBe(0);

      const created = next(fixture, "a-fullstack-app-build-mvp-task-tracker", {
        step: "select_quest",
        action: "create_quest",
        wtree: "a-fullstack-app-build-mvp-task-tracker",
        request:
          "loopo: execute child task build-mvp-task-tracker: Build the MVP full-stack task tracker application",
      });
      expectValidSchema(created, "step-output");
      expect(created.step).toBe("plan");
      expect(((created.commands as any).next as any).args).toEqual(
        expect.arrayContaining([
          "--wtree",
          "a-fullstack-app-build-mvp-task-tracker",
        ]),
      );

      const planned = next(fixture, "a-fullstack-app-build-mvp-task-tracker", {
        step: "plan",
        classification: "feature",
        scope:
          "Implement the assigned MVP task tracker in this dedicated child worktree.",
        summary:
          "Execute the assigned child task locally without delegating to another child quest.",
        defaulted_unknowns: ["No auth for MVP", "Simple list UI"],
        assumptions: ["Task requirements are inherited from the parent quest."],
        constraints: ["Work must stay within the assigned child worktree."],
        system_context: EMPTY_SYSTEM_CONTEXT,
        verification_targets: ["Production build succeeds"],
        task_graph: {
          tasks: [
            {
              id: "T001",
              title: "Implement the assigned MVP task tracker",
              type: "coding",
              acceptance: ["Production build succeeds"],
            },
          ],
        },
      });
      expectValidSchema(planned, "step-output");
      expect(planned.step).toBe("task_graph");

      const childState = parseTasksYaml(
        readFileSync(
          questFiles(fixture.repo, "a-fullstack-app-build-mvp-task-tracker").tasks,
          "utf8",
        ),
      );
      const childTask = (childState.tasks ?? [])[0] as any;
      expect(childTask.status).toBe("pending");
      expect(childTask.worktree_path).toBe(
        join(
          fixture.repo,
          "worktrees",
          "a-fullstack-app-build-mvp-task-tracker",
        ),
      );
      expect(childTask.child_wtree).toBe("");
      expect(childTask.merge_lease_id).toBe("");
      expect(childTask.system_impact_ref).toBe("");

      const validation = next(fixture, "a-fullstack-app-build-mvp-task-tracker", {
        step: "task_graph",
        approved: true,
      });
      expectValidSchema(validation, "step-output");
      expect(validation.step).toBe("validation");
      expect(validation.state).toBe("validating");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it(
    "covers detours, partial child dispatch, and retry transitions",
    () => {
      const fixture = createFixture("loopo-v3-lifecycle-");
      try {
      const init = runLoopo(
        fixture.repo,
        [
          "init",
          "loopo: build lifecycle tester",
          "--runtime",
          "codex",
        ],
        undefined,
        fixture.env,
      );
      expect(init.status, init.stderr || init.stdout).toBe(0);
      const route = parseJson(init.stdout);
      const wtree = String(route.new_quest.suggested_wtree);

      const created = next(fixture, wtree, {
        step: "select_quest",
        action: "create_quest",
        wtree: wtree,
        request: "loopo: build lifecycle tester",
      });
      expectValidSchema(created, "step-output");
      expect(created.step).toBe("plan");

      const awaitingAnswers = next(fixture, wtree, {
        step: "plan",
        classification: "greenfield_app",
        scope: "lifecycle tester",
        high_impact_unknowns: ["target workflow"],
        questions: [
          {
            id: "target_workflow",
            question: "Which workflow should the tester cover?",
            impact: "Determines acceptance scope",
          },
        ],
        system_context: EMPTY_SYSTEM_CONTEXT,
        verification_targets: ["selected workflow is covered"],
        task_graph: { tasks: [] },
      });
      expectValidSchema(awaitingAnswers, "step-output");
      expect(awaitingAnswers.step).toBe("questions");
      expect(awaitingAnswers.state).toBe("awaiting_user_answers");
      expect((awaitingAnswers.context as any).step.instructions).toContain(
        "Do not auto-answer unresolved",
      );
      expect((awaitingAnswers.context as any).step.instructions).toContain(
        "human-provided answers",
      );

      const backToPlanning = next(fixture, wtree, {
        step: "questions",
        answers: [
          {
            question_id: "target_workflow",
            answer: "Cover root and child lifecycle transitions.",
          },
        ],
      });
      expectValidSchema(backToPlanning, "step-output");
      expect(backToPlanning.step).toBe("plan");
      expect(backToPlanning.state).toBe("planning");
      const answeredState = parseTasksYaml(
        readFileSync(questFiles(fixture.repo, wtree).tasks, "utf8"),
      ) as any;
      expect(answeredState.answers).toBeUndefined();
      expect(answeredState.question_rounds[0].questions[0]).toMatchObject({
        id: "target_workflow",
        status: "answered",
        answer: "Cover root and child lifecycle transitions.",
        accepted_default: false,
      });

      const reviewed = next(fixture, wtree, {
        step: "plan",
        classification: "greenfield_app",
        scope: "lifecycle tester",
        defaulted_unknowns: ["CLI-only verification"],
        system_context: EMPTY_SYSTEM_CONTEXT,
        verification_targets: ["both child lifecycle tasks pass"],
        task_graph: {
          tasks: [
            {
              id: "T001",
              title: "Build root lifecycle fixture",
              type: "coding",
              acceptance: ["root lifecycle fixture works"],
              scope_files: ["root-fixture.txt"],
              spec_refs: ["coding"],
              concurrency_group: "root",
            },
            {
              id: "T002",
              title: "Build child lifecycle fixture",
              type: "coding",
              acceptance: ["child lifecycle fixture works"],
              scope_files: ["child-fixture.txt"],
              spec_refs: ["coding"],
              concurrency_group: "child",
            },
          ],
        },
      });
      expectValidSchema(reviewed, "step-output");
      expect(reviewed.step).toBe("task_graph");

      const rejected = next(fixture, wtree, {
        step: "task_graph",
        approved: false,
        replan_reason: "tighten acceptance before dispatch",
      });
      expectValidSchema(rejected, "step-output");
      expect(rejected.step).toBe("plan");
      expect(rejected.state).toBe("planning");

      const planned = next(fixture, wtree, {
        step: "plan",
        classification: "greenfield_app",
        scope: "lifecycle tester",
        defaulted_unknowns: ["CLI-only verification"],
        system_context: EMPTY_SYSTEM_CONTEXT,
        verification_targets: ["both fixtures are represented in evidence"],
        task_graph: {
          tasks: [
            {
              id: "T001",
              title: "Build root lifecycle fixture",
              type: "coding",
              acceptance: ["root lifecycle fixture works"],
              scope_files: ["root-fixture.txt"],
              spec_refs: ["coding"],
              concurrency_group: "root",
            },
            {
              id: "T002",
              title: "Build child lifecycle fixture",
              type: "coding",
              acceptance: ["child lifecycle fixture works"],
              scope_files: ["child-fixture.txt"],
              spec_refs: ["coding"],
              concurrency_group: "child",
            },
          ],
        },
      });
      expectValidSchema(planned, "step-output");
      expect(planned.step).toBe("task_graph");

      const executing = next(fixture, wtree, {
        step: "task_graph",
        approved: true,
      });
      expectValidSchema(executing, "child-dispatch-output");
      const children = executing.children as any[];
      expect(children.map((child) => child.task_id)).toEqual(["t001", "t002"]);
      expect(children[0].commands.init.args).toEqual(
        expect.arrayContaining([
          "--wtree",
          `${wtree}-t001`,
          "--runtime",
          "codex",
          "--flow",
          "swe",
        ]),
      );
      expect(children[1].commands.init.args).toEqual(
        expect.arrayContaining([
          "--wtree",
          `${wtree}-t002`,
          "--runtime",
          "codex",
          "--flow",
          "swe",
        ]),
      );

      const partial = next(fixture, wtree, {
        step: "child_result",
        task_id: "t001",
        child_wtree: `${wtree}-t001`,
        status: "passed",
        evidence: [{ type: "summary", ref: "root-fixture.txt" }],
        merge_commit: "partial123",
      });
      expectValidSchema(partial, "child-dispatch-output");
      expect(partial.step).toBe("executing");
      expect((partial.children as any[]).map((child) => child.task_id)).toEqual(
        ["t002"],
      );

      const validating = next(fixture, wtree, {
        step: "child_result",
        task_id: "t002",
        child_wtree: `${wtree}-t002`,
        status: "passed",
        evidence: [{ type: "summary", ref: "child-fixture.txt" }],
        merge_commit: "valid123",
      });
      expectValidSchema(validating, "step-output");
      expect(validating.step).toBe("validation");

      const verification = next(fixture, wtree, {
        step: "validation",
        status: "passed",
        checks: [{ name: "lifecycle", status: "passed" }],
      });
      expectValidSchema(verification, "step-output");
      expect(verification.step).toBe("verification");

      const retryValidation = next(fixture, wtree, {
        step: "verification",
        status: "failed",
        acceptance_trace: [
          { acceptance: "root lifecycle fixture works", status: "passed" },
          { acceptance: "child lifecycle fixture works", status: "failed" },
        ],
        risks: [{ risk: "child evidence incomplete", severity: "medium" }],
      });
      expectValidSchema(retryValidation, "step-output");
      expect(retryValidation.step).toBe("validation");
      expect(retryValidation.state).toBe("validating");

      const verified = next(fixture, wtree, {
        step: "validation",
        status: "passed",
        checks: [{ name: "lifecycle retry", status: "passed" }],
      });
      expectValidSchema(verified, "step-output");
      expect(verified.step).toBe("verification");

      const systemUpdate = next(fixture, wtree, {
        step: "verification",
        status: "passed",
        acceptance_trace: [
          { acceptance: "root lifecycle fixture works", status: "passed" },
          { acceptance: "child lifecycle fixture works", status: "passed" },
        ],
        risks: [],
      });
      expectValidSchema(systemUpdate, "step-output");
      expect(systemUpdate.step).toBe("system_update");

      const landing = next(fixture, wtree, {
        step: "system_update",
        system_update: {
          schema_version: 1,
          mode: "no_change",
          summary: "lifecycle covered",
        },
      });
      expectValidSchema(landing, "step-output");
      expect(landing.step).toBe("landing");

      const blocked = next(fixture, wtree, {
        step: "landing",
        status: "blocked",
        summary: "waiting for final merge",
      });
      expectValidSchema(blocked, "step-output");
      expect(blocked.step).toBe("landing");
      expect(blocked.state).toBe("landing_ready");

      const archived = next(fixture, wtree, {
        step: "landing",
        status: "landed",
        summary: "done",
      });
      expectValidSchema(archived, "archive-output");
        expect(archived.step).toBe("archived");
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("rejects passing a child result while the matching child quest is unresolved", () => {
    const fixture = createFixture("loopo-v3-child-guard-");
    try {
      const init = runLoopo(
        fixture.repo,
        [
          "init",
          "loopo: build guarded child flow",
          "--runtime",
          "codex",
        ],
        undefined,
        fixture.env,
      );
      expect(init.status, init.stderr || init.stdout).toBe(0);
      const route = parseJson(init.stdout);
      const wtree = String(route.new_quest.suggested_wtree);

      next(fixture, wtree, {
        step: "select_quest",
        action: "create_quest",
        wtree: wtree,
        request: "loopo: build guarded child flow",
      });

      next(fixture, wtree, {
        step: "plan",
        classification: "feature",
        scope: "guarded child flow",
        system_context: EMPTY_SYSTEM_CONTEXT,
        verification_targets: ["child must finish before parent can pass"],
        task_graph: {
          tasks: [
            {
              id: "T001",
              title: "Run guarded child task",
              type: "coding",
              acceptance: ["guard works"],
            },
          ],
        },
      });

      const executing = next(fixture, wtree, {
        step: "task_graph",
        approved: true,
      });
      const child = (executing.children as any[])[0];

      const childInit = runLoopo(
        fixture.repo,
        child.commands.init.args,
        undefined,
        fixture.env,
      );
      expect(childInit.status, childInit.stderr || childInit.stdout).toBe(0);
      const childRoute = parseJson(childInit.stdout);
      expect(String(childRoute.new_quest.suggested_wtree)).toBe(child.child_wtree);
      expect(child.commands.init.args).toEqual(
        expect.arrayContaining(["--runtime", "codex"]),
      );

      next(fixture, child.child_wtree, childRoute.new_quest.input);

      const premature = runLoopo(
        fixture.repo,
        [
          "quest",
          "next",
          "--wtree",
          wtree,
          "--json",
          "@-",
        ],
        {
          step: "child_result",
          task_id: "t001",
          child_wtree: child.child_wtree,
          status: "passed",
          merge_commit: "guard123",
          evidence: [{ type: "summary", ref: "guard.txt" }],
        },
        fixture.env,
      );
      expect(premature.status).toBe(1);
      expect(String(parseJson(premature.stdout).error)).toContain(
        "cannot pass until child quest",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects landing while the coordinator worktree is dirty", () => {
    const fixture = createFixture("loopo-v3-landing-guard-");
    try {
      const init = runLoopo(
        fixture.repo,
        [
          "init",
          "loopo: build landing guard",
          "--runtime",
          "codex",
        ],
        undefined,
        fixture.env,
      );
      expect(init.status, init.stderr || init.stdout).toBe(0);
      const route = parseJson(init.stdout);
      const wtree = String(route.new_quest.suggested_wtree);

      next(fixture, wtree, {
        step: "select_quest",
        action: "create_quest",
        wtree: wtree,
        request: "loopo: build landing guard",
      });

      next(fixture, wtree, {
        step: "plan",
        classification: "feature",
        scope: "landing guard",
        system_context: EMPTY_SYSTEM_CONTEXT,
        verification_targets: ["landing checks coordinator cleanliness"],
        task_graph: {
          tasks: [
            {
              id: "T001",
              title: "Complete one guarded task",
              type: "coding",
              acceptance: ["done"],
            },
          ],
        },
      });

      next(fixture, wtree, {
        step: "task_graph",
        approved: true,
      });

      next(fixture, wtree, {
        step: "child_result",
        task_id: "t001",
        child_wtree: `${wtree}-t001`,
        status: "passed",
        merge_commit: "landing123",
        evidence: [{ type: "summary", ref: "done.txt" }],
      });

      next(fixture, wtree, {
        step: "validation",
        status: "passed",
        checks: [{ name: "guard", status: "passed" }],
      });

      next(fixture, wtree, {
        step: "verification",
        status: "passed",
        acceptance_trace: [{ acceptance: "done", status: "passed" }],
        risks: [],
      });

      next(fixture, wtree, {
        step: "system_update",
        system_update: {
          schema_version: 1,
          mode: "no_change",
          summary: "landing guard",
        },
      });

      writeFileSync(
        join(fixture.repo, "worktrees", wtree, "DIRTY.txt"),
        "dirty\n",
        "utf8",
      );

      const landing = runLoopo(
        fixture.repo,
        [
          "quest",
          "next",
          "--wtree",
          wtree,
          "--json",
          "@-",
        ],
        {
          step: "landing",
          status: "landed",
          summary: "done",
        },
        fixture.env,
      );
      expect(landing.status).toBe(1);
      expect(String(parseJson(landing.stdout).error)).toContain(
        "coordinator worktree has uncommitted changes",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it(
    "merges child branches during child landing and lands the parent branch into main",
    () => {
      const fixture = createFixture("loopo-v3-git-landing-");
      try {
      const init = runLoopo(
        fixture.repo,
        [
          "init",
          "loopo: build landed workflow",
          "--runtime",
          "codex",
        ],
        undefined,
        fixture.env,
      );
      expect(init.status, init.stderr || init.stdout).toBe(0);
      const route = parseJson(init.stdout);
      const wtree = String(route.new_quest.suggested_wtree);

      next(fixture, wtree, {
        step: "select_quest",
        action: "create_quest",
        wtree: wtree,
        request: "loopo: build landed workflow",
      });

      next(fixture, wtree, {
        step: "plan",
        classification: "feature",
        scope: "landed workflow",
        summary:
          "Use two independent child tasks so the second child must merge into an already-advanced parent branch.",
        system_context: EMPTY_SYSTEM_CONTEXT,
        verification_targets: [
          "Both child slices merge into the parent branch.",
          "The parent branch lands into main.",
        ],
        task_graph: {
          tasks: [
            {
              id: "T001",
              title: "Build alpha slice",
              type: "coding",
              acceptance: ["alpha slice merged"],
              scope_files: ["alpha.txt"],
              concurrency_group: "alpha",
            },
            {
              id: "T002",
              title: "Build beta slice",
              type: "coding",
              acceptance: ["beta slice merged"],
              scope_files: ["beta.txt"],
              concurrency_group: "beta",
            },
          ],
        },
      });

      const executing = next(fixture, wtree, {
        step: "task_graph",
        approved: true,
      });
      const children = executing.children as any[];
      expect(children).toHaveLength(2);

      const parentWorktree = join(fixture.repo, "worktrees", wtree);

      const runChildLifecycle = (
        child: any,
        fileName: string,
        title: string,
      ): Record<string, unknown> => {
        const childInit = runLoopo(
          fixture.repo,
          child.commands.init.args,
          undefined,
          fixture.env,
        );
        expect(childInit.status, childInit.stderr || childInit.stdout).toBe(0);
        const childRoute = parseJson(childInit.stdout);
        const childWtree = String(childRoute.new_quest.suggested_wtree);
        expect(childWtree).toBe(String(child.child_wtree));

        next(fixture, childWtree, childRoute.new_quest.input);

        next(fixture, childWtree, {
          step: "plan",
          classification: "feature",
          scope: `${title} implementation`,
          summary: `Implement ${title} directly in the child branch and land it through the landing step.`,
          defaulted_unknowns: ["No further delegation."],
          assumptions: ["The parent quest already assigned the file boundary."],
          constraints: ["Stay within this child worktree."],
          system_context: EMPTY_SYSTEM_CONTEXT,
          verification_targets: [`${fileName} is committed and merged.`],
          task_graph: {
            tasks: [
              {
                id: "T001",
                title,
                type: "coding",
                acceptance: [`${fileName} is committed and merged.`],
              },
            ],
          },
        });

        const childWorktree = String(child.worktree_path);
        writeFileSync(join(childWorktree, fileName), `${title}\n`, "utf8");
        runGit(childWorktree, ["add", fileName]);
        runGit(childWorktree, ["commit", "-m", `feat: add ${fileName}`]);
        const childHead = gitStdout(childWorktree, ["rev-parse", "HEAD"]);

        const validation = next(fixture, childWtree, {
          step: "task_graph",
          approved: true,
        });
        expectValidSchema(validation, "step-output");
        expect(validation.step).toBe("validation");

        next(fixture, childWtree, {
          step: "validation",
          status: "passed",
          checks: [{ name: `${fileName}-smoke`, status: "passed" }],
        });

        next(fixture, childWtree, {
          step: "verification",
          status: "passed",
          acceptance_trace: [
            { acceptance: `${fileName} is committed and merged.`, status: "passed" },
          ],
          risks: [],
        });

        next(fixture, childWtree, {
          step: "system_update",
          system_update: {
            schema_version: 1,
            mode: "no_change",
            summary: `${fileName} landed`,
          },
        });

        const archived = next(fixture, childWtree, {
          step: "landing",
          status: "landed",
          summary: `${fileName} landed into parent`,
        });
        expectValidSchema(archived, "archive-output");
        expect(archived.step).toBe("archived");
        expect((archived as any).landing.target_branch).toBe(wtree);
        expect((archived as any).landing.target_worktree).toBe(parentWorktree);
        expect(existsSync(join(parentWorktree, fileName))).toBe(true);
        if (String((archived as any).landing.strategy) === "fast-forward") {
          expect(String((archived as any).landing.landed_commit)).toBe(childHead);
        } else {
          const ancestry = runCommand(
            "git",
            ["merge-base", "--is-ancestor", childHead, "HEAD"],
            { cwd: parentWorktree, timeoutMs: 30_000 },
          );
          expect(ancestry.status, ancestry.stderr || ancestry.stdout).toBe(0);
        }
        return archived;
      };

      const alphaArchived = runChildLifecycle(children[0], "alpha.txt", "Build alpha slice");
      expect(["fast-forward", "merge-commit"]).toContain(
        (alphaArchived as any).landing.strategy,
      );

      next(fixture, wtree, {
        step: "child_result",
        task_id: String(children[0].task_id),
        child_wtree: String(children[0].child_wtree),
        status: "passed",
        merge_commit: String((alphaArchived as any).landing.landed_commit),
        evidence: [{ type: "summary", ref: "alpha.txt" }],
      });

      const betaArchived = runChildLifecycle(children[1], "beta.txt", "Build beta slice");
      expect(["fast-forward", "merge-commit"]).toContain(
        (betaArchived as any).landing.strategy,
      );

      const validating = next(fixture, wtree, {
        step: "child_result",
        task_id: String(children[1].task_id),
        child_wtree: String(children[1].child_wtree),
        status: "passed",
        merge_commit: String((betaArchived as any).landing.landed_commit),
        evidence: [{ type: "summary", ref: "beta.txt" }],
      });
      expectValidSchema(validating, "step-output");
      expect(validating.step).toBe("validation");

      expect(existsSync(join(parentWorktree, "alpha.txt"))).toBe(true);
      expect(existsSync(join(parentWorktree, "beta.txt"))).toBe(true);

      next(fixture, wtree, {
        step: "validation",
        status: "passed",
        checks: [{ name: "parent-merge-smoke", status: "passed" }],
      });

      next(fixture, wtree, {
        step: "verification",
        status: "passed",
        acceptance_trace: [
          { acceptance: "alpha slice merged", status: "passed" },
          { acceptance: "beta slice merged", status: "passed" },
        ],
        risks: [],
      });

      next(fixture, wtree, {
        step: "system_update",
        system_update: {
          schema_version: 1,
          mode: "no_change",
          summary: "parent branch ready for main",
        },
      });

      const rootArchived = next(fixture, wtree, {
        step: "landing",
        status: "landed",
        summary: "parent branch landed into main",
      });
      expectValidSchema(rootArchived, "archive-output");
      expect(rootArchived.step).toBe("archived");
      expect((rootArchived as any).landing.target_branch).toBe("main");
      expect((rootArchived as any).landing.strategy).toBe("fast-forward");

      const mainHead = gitStdout(fixture.repo, ["rev-parse", "main"]);
      const landedCommit = String((rootArchived as any).landing.landed_commit);
      expectGitAncestor(fixture.repo, landedCommit, mainHead);
      expect(existsSync(join(fixture.repo, "alpha.txt"))).toBe(true);
      expect(existsSync(join(fixture.repo, "beta.txt"))).toBe(true);

      const rootState = parseTasksYaml(
        readFileSync(
          questFiles(fixture.repo, wtree).tasks,
          "utf8",
        ),
      ) as any;
      expect(rootState.landed_commit).toBe(landedCommit);
      expect(rootState.landing_target_branch).toBe("main");
      expect(rootState.landing_strategy).toBe("fast-forward");
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
