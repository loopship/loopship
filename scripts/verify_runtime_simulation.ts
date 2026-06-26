#!/usr/bin/env bun

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTasksYaml, questFiles } from "./loopship_core.ts";
import {
  CONCRETE_REACT_HABIT_TRACKER_REQUEST,
  scenarioPayloadForStep,
  selectSimProductQuestScenario,
} from "./sim_product_quest_scenarios.ts";
import {
  DEFAULT_RUNTIME_REQUEST,
  hookEventName,
  type Runtime,
} from "./runtime_supervisor.ts";
import { readText, runCommand, tsRunner } from "./loopship_utils.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOOPSHIP_SCRIPT = resolve(SCRIPT_DIR, "loopship.ts");

type Fixture = {
  root: string;
  repo: string;
  env: Record<string, string>;
  initialHead: string;
};

type SimulationCase = {
  name: string;
  request: string;
};

const SIMULATION_CASES: SimulationCase[] = [
  {
    name: "concrete-python-cli",
    request: DEFAULT_RUNTIME_REQUEST,
  },
  {
    name: "concrete-react-habit-tracker",
    request: CONCRETE_REACT_HABIT_TRACKER_REQUEST,
  },
];

function fail(message: string): never {
  throw new Error(message);
}

function parseJson(text: string, label: string): Record<string, any> {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, any>;
  } catch {
    fail(`expected JSON for ${label}: ${text}`);
  }
}

function stepId(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const id = (value as Record<string, unknown>).id;
    return typeof id === "string" ? id : "";
  }
  return "";
}

function readJsonl(path: string): Array<Record<string, any>> {
  return readText(path)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => parseJson(line, path));
}

function runTsScript(
  script: string,
  args: string[],
  input: Record<string, unknown> | undefined,
  cwd: string,
  env: Record<string, string>,
) {
  const launch = tsRunner(script, args);
  return runCommand(launch.cmd, launch.args, {
    cwd,
    env,
    input: input ? JSON.stringify(input) : undefined,
    timeoutMs: 60_000,
  });
}

function runLoopship(
  fixture: Fixture,
  args: string[],
  input?: Record<string, unknown>,
) {
  return runTsScript(
    LOOPSHIP_SCRIPT,
    args,
    input,
    existsSync(fixture.repo) ? fixture.repo : fixture.root,
    fixture.env,
  );
}

function gitStdout(
  repo: string,
  args: string[],
  env: Record<string, string>,
): string {
  const proc = runCommand("git", args, {
    cwd: repo,
    env,
    timeoutMs: 15_000,
  });
  if (proc.status !== 0) fail(proc.stderr || proc.stdout);
  return proc.stdout.trim();
}

function createFixture(prefix: string, runtime: Runtime): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repo = join(root, "repo");
  const env = {
    ...process.env,
    HOME: join(root, "home"),
    LOOPSHIP_GLOBAL_BIN: join(root, "bin", "loopship"),
    LOOPSHIP_SCRIPT: LOOPSHIP_SCRIPT,
  };
  const init = runCommand("git", ["init", repo], {
    env,
    timeoutMs: 15_000,
  });
  if (init.status !== 0) fail(init.stderr || init.stdout);
  for (const [key, value] of [
    ["user.email", "loopship-sim@example.invalid"],
    ["user.name", `Loopship ${runtime} Simulator`],
  ] as const) {
    const config = runCommand("git", ["config", key, value], {
      cwd: repo,
      env,
      timeoutMs: 15_000,
    });
    if (config.status !== 0) fail(config.stderr || config.stdout);
  }
  const branch = runCommand("git", ["checkout", "-B", "main"], {
    cwd: repo,
    env,
    timeoutMs: 15_000,
  });
  if (branch.status !== 0) fail(branch.stderr || branch.stdout);
  // Test fixture setup: sim is being run inside an existing repo with HEAD.
  const existingRepoHead = runCommand(
    "git",
    ["commit", "--allow-empty", "-m", "simulation test baseline"],
    {
      cwd: repo,
      env,
      timeoutMs: 15_000,
    },
  );
  if (existingRepoHead.status !== 0) {
    fail(existingRepoHead.stderr || existingRepoHead.stdout);
  }
  return {
    root,
    repo,
    env,
    initialHead: gitStdout(repo, ["rev-parse", "HEAD"], env),
  };
}

function currentStage(fixture: Fixture, wtree: string): string {
  const files = questFiles(fixture.repo, wtree);
  return String(parseTasksYaml(readText(files.tasks)).stage ?? "");
}

function assertRuntimeHookShape(
  runtime: Runtime,
  payload: Record<string, any>,
  label: string,
) {
  if (runtime === "gemini") {
    if (payload.decision !== "deny" || payload.suppressOutput !== true) {
      fail(
        `${label}: gemini hook output must deny with suppressOutput: ${JSON.stringify(payload)}`,
      );
    }
    return;
  }
  if (payload.decision !== "block") {
    fail(
      `${label}: ${runtime} hook output must block: ${JSON.stringify(payload)}`,
    );
  }
  if (runtime === "copilot" && !payload.hookSpecificOutput) {
    fail(`${label}: copilot hook output must include hookSpecificOutput`);
  }
}

function assertGuidedStep(
  step: Record<string, any>,
  repo: string,
  label: string,
): void {
  if ("hook_output" in step || "reason_payload" in step) {
    fail(`${label}: guided sim must not expose hook internals`);
  }
  if ("current_output" in step) {
    fail(`${label}: guided sim must expose the current step directly`);
  }
  const command = step.commands?.next;
  if (!command || command.cmd !== "loopship") {
    fail(`${label}: guided sim step must include commands.next`);
  }
  const args = Array.isArray(command.args) ? command.args : [];
  const expected = [
    "sim",
    "step",
    "--wtree",
    String(step.wtree ?? ""),
    "--json",
    "@-",
  ];
  if (JSON.stringify(args) !== JSON.stringify(expected)) {
    fail(`${label}: guided sim commands.next mismatch: ${JSON.stringify(args)}`);
  }
}

function assertNoFixtureFiles(repo: string, label: string): void {
  for (const name of ["callback-fixture.txt", "hook-fixture.txt"]) {
    if (existsSync(join(repo, name))) {
      fail(`${label}: sim must not create ${name}`);
    }
  }
}

function assertNoSimRuntimeArtifacts(repo: string, label: string): void {
  if (existsSync(join(repo, ".loopship", "sim-runtime"))) {
    fail(`${label}: sim must not create .loopship/sim-runtime`);
  }
}

function assertHeadUnchanged(fixture: Fixture, label: string): void {
  const currentHead = gitStdout(fixture.repo, ["rev-parse", "HEAD"], fixture.env);
  if (currentHead !== fixture.initialHead) {
    fail(`${label}: sim start must not create commits or move HEAD`);
  }
}

function simCommandArgs(step: Record<string, any>, label: string): string[] {
  const args = step.commands?.next?.args;
  if (!Array.isArray(args) || args[0] !== "sim") {
    fail(`${label}: missing runnable sim next command`);
  }
  return args.map(String);
}

function assertLifecycleProgress(
  request: string,
  label: string,
  requestSteps: string[],
  responseSteps: string[],
): void {
  const scenario = selectSimProductQuestScenario(request);
  if (requestSteps.length === 0 || responseSteps.length === 0) {
    fail(`${label}: expected at least one guided simulated step`);
  }
  const requiredRequestSteps = scenario.expect_question_round
    ? [
        "plan",
        "questions",
        "plan",
        "task_graph",
        "executing",
        "validation",
        "verification",
        "system_update",
        "landing",
      ]
    : [
        "plan",
        "task_graph",
        "executing",
        "validation",
        "verification",
        "system_update",
        "landing",
      ];
  const requiredResponseSteps = scenario.expect_question_round
    ? [
        "questions",
        "plan",
        "task_graph",
        "executing",
        "validation",
        "verification",
        "system_update",
        "landing",
        "archived",
      ]
    : [
        "task_graph",
        "executing",
        "validation",
        "verification",
        "system_update",
        "landing",
        "archived",
      ];

  for (const step of requiredRequestSteps) {
    if (!requestSteps.includes(step)) {
      fail(`${label}: simulation never requested lifecycle step ${step}`);
    }
  }
  for (const step of requiredResponseSteps) {
    if (!responseSteps.includes(step)) {
      fail(
        `${label}: simulation never reached lifecycle response step ${step}`,
      );
    }
  }
  if (!scenario.expect_question_round) {
    for (const step of ["questions", "plan"]) {
      if (responseSteps.includes(step)) {
        fail(`${label}: concrete simulation unexpectedly emitted ${step}`);
      }
    }
  }
}

function assertChildInitRuntime(
  callback: Record<string, unknown>,
  runtime: Runtime,
  label: string,
): number {
  const children = Array.isArray(callback.children) ? callback.children : [];
  let checked = 0;
  for (const child of children) {
    const childRecord =
      child && typeof child === "object"
        ? (child as Record<string, unknown>)
        : {};
    const commands =
      childRecord.commands && typeof childRecord.commands === "object"
        ? (childRecord.commands as Record<string, unknown>)
        : {};
    const init =
      commands.init && typeof commands.init === "object"
        ? (commands.init as Record<string, unknown>)
        : {};
    const initArgs = Array.isArray(init.args) ? init.args : [];
    const runtimeFlag = initArgs.indexOf("--runtime");
    if (runtimeFlag < 0 || initArgs[runtimeFlag + 1] !== runtime) {
      fail(
        `${label}: child init command must preserve runtime ${runtime}: ${JSON.stringify(initArgs)}`,
      );
    }
    checked += 1;
  }
  return checked;
}

function assertCanonicalArtifacts(
  fixture: Fixture,
  wtree: string,
  request: string,
  label: string,
): void {
  const scenario = selectSimProductQuestScenario(request);
  const expectedPlan = scenario.resolved_plan ?? scenario.initial_plan;
  const files = questFiles(fixture.repo, wtree);
  const state = parseTasksYaml(readText(files.tasks)) as Partial<{
    stage: string;
    tasks: Array<Partial<{ id: string; title: string }>>;
  }>;

  if (String(state.stage ?? "") !== "archived") {
    fail(`${label}: canonical task state did not reach archived`);
  }

  const planEvents = readJsonl(files.events).filter(
    (record) => record.event === "plan_submitted",
  );
  if (planEvents.length === 0) {
    fail(`${label}: expected at least one recorded plan payload`);
  }
  const latestPlanPayload = state.plan_detail ?? {};
  if (String(latestPlanPayload.scope ?? "") !== expectedPlan.scope) {
    fail(
      `${label}: final plan scope mismatch: ${JSON.stringify(latestPlanPayload.scope)}`,
    );
  }
  if (String(latestPlanPayload.summary ?? "") !== expectedPlan.summary) {
    fail(
      `${label}: final plan summary mismatch: ${JSON.stringify(latestPlanPayload.summary)}`,
    );
  }

  const taskState = Array.isArray(state.tasks) ? state.tasks : [];
  if (taskState.length !== expectedPlan.tasks.length) {
    fail(
      `${label}: expected ${expectedPlan.tasks.length} canonical tasks, found ${taskState.length}`,
    );
  }
  const expectedTaskTitles = expectedPlan.tasks.map((task) =>
    String(task.title ?? ""),
  );
  const actualTaskTitles = taskState.map((task) => String(task.title ?? ""));
  if (JSON.stringify(actualTaskTitles) !== JSON.stringify(expectedTaskTitles)) {
    fail(
      `${label}: canonical task titles diverged: ${JSON.stringify(actualTaskTitles)}`,
    );
  }

  const questionEvents = readJsonl(files.events)
    .map((record) => String(record.event ?? ""))
    .filter((event) => ["question_round", "answers_submitted"].includes(event));
  if (scenario.expect_question_round) {
    for (const event of ["question_round", "answers_submitted"]) {
      if (!questionEvents.includes(event)) {
        fail(`${label}: expected questions log to include ${event}`);
      }
    }
    if (!Array.isArray(state.question_rounds) || state.question_rounds.length === 0) {
      fail(`${label}: expected tasks.yaml to retain question rounds`);
    }
  } else if (questionEvents.length !== 0) {
    fail(
      `${label}: concrete simulation unexpectedly recorded question events: ${JSON.stringify(questionEvents)}`,
    );
  }
}

function assertSimHookPassthrough(runtime: Runtime): void {
  const fixture = createFixture(`loopship-runtime-sim-hook-${runtime}-`, runtime);
  const label = `${runtime}/hook`;
  try {
    const start = runLoopship(
      fixture,
      [
        "sim",
        "init",
        DEFAULT_RUNTIME_REQUEST,
        "--repo",
        fixture.repo,
        "--runtime",
        runtime,
        "--flow",
        "swe",
      ],
      undefined,
    );
    if (start.status !== 0) fail(start.stderr || start.stdout);
    const started = parseJson(start.stdout, `${label} sim start`);
    const wtree = String(started.wtree ?? "");
    if (!wtree) fail(`${label}: missing wtree in sim start output`);
    assertNoFixtureFiles(fixture.repo, label);
    assertHeadUnchanged(fixture, label);
    const hook = runLoopship(
      fixture,
      [
        "sim",
        "hook",
        "--repo",
        fixture.repo,
        "--runtime",
        runtime,
        "--json",
        JSON.stringify({
          hook_event_name: hookEventName(runtime),
          cwd: join(fixture.repo, "worktrees", wtree),
        }),
      ],
      undefined,
    );
    if (hook.status !== 0) fail(hook.stderr || hook.stdout);
    const output = parseJson(hook.stdout, `${label} sim hook`);
    assertRuntimeHookShape(runtime, output, label);
    if (typeof output.reason !== "string" || !output.reason.trim()) {
      fail(`${label}: sim hook must expose hook reason payload`);
    }
    assertNoSimRuntimeArtifacts(fixture.repo, label);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function simulateRuntime(
  runtime: Runtime,
  simulationCase: SimulationCase,
): void {
  const fixture = createFixture(
    `loopship-runtime-sim-${simulationCase.name}-`,
    runtime,
  );
  const label = `${runtime}/${simulationCase.name}`;
  try {
    const start = runLoopship(
      fixture,
      [
        "sim",
        "init",
        simulationCase.request,
        "--repo",
        fixture.repo,
        "--runtime",
        runtime,
        "--flow",
        "swe",
      ],
      undefined,
    );
    if (start.status !== 0) {
      fail(start.stderr || start.stdout || `${label}: sim start failed`);
    }
    assertNoFixtureFiles(fixture.repo, label);
    assertHeadUnchanged(fixture, label);
    let current = parseJson(start.stdout, `${label} sim start`);
    assertGuidedStep(current, fixture.repo, label);
    const wtree = String(current.wtree ?? "");
    if (!wtree) fail(`${label}: missing wtree in sim start output`);
    if (String(current.current_stage ?? "") !== "planning") {
      fail(`${label}: sim start must enter planning: ${start.stdout}`);
    }

    let planRound = 0;
    let landingRound = 0;
    let childInitRuntimeChecks = 0;
    const requestedSteps: string[] = [];
    const responseSteps: string[] = [];
    for (let guard = 0; guard < 20; guard += 1) {
      if (current.done === true || currentStage(fixture, wtree) === "archived") break;
      const requestedStep = stepId(current.step);
      if (!requestedStep) {
        fail(`${label}: missing requested step in guided output`);
      }
      requestedSteps.push(requestedStep);
      const quest = parseTasksYaml(
        readText(questFiles(fixture.repo, wtree).tasks),
      ) as Record<string, any>;
      const callbackInput = scenarioPayloadForStep({
        request: simulationCase.request,
        step: requestedStep,
        quest,
        planRound,
        landingRound,
      });
      if (requestedStep === "plan") planRound += 1;
      if (requestedStep === "landing") landingRound += 1;
      const callbackProc = runLoopship(
        fixture,
        simCommandArgs(current, label),
        callbackInput,
      );
      if (callbackProc.status !== 0) {
        fail(
          callbackProc.stderr ||
            callbackProc.stdout ||
            `${label}: guided sim continuation failed`,
        );
      }
      current = parseJson(callbackProc.stdout, `${label} guided sim output`);
      assertGuidedStep(current, fixture.repo, label);
      responseSteps.push(stepId(current.step));
      childInitRuntimeChecks += assertChildInitRuntime(current, runtime, label);
      if (!stepId((current as Record<string, unknown>).step)) {
        fail(
          `${label}: guided sim returned malformed output: ${JSON.stringify(current)}`,
        );
      }
    }
    if (childInitRuntimeChecks === 0) {
      fail(`${label}: simulation never exposed child init commands`);
    }

    if (current.current_stage !== "archived" || current.done !== true) {
      fail(
        `${label}: simulation must report archived: ${JSON.stringify(current)}`,
      );
    }
    if (currentStage(fixture, wtree) !== "archived") {
      fail(`${label}: simulation did not reach archived`);
    }

    assertLifecycleProgress(
      simulationCase.request,
      label,
      requestedSteps,
      responseSteps,
    );
    assertNoSimRuntimeArtifacts(fixture.repo, label);
    assertCanonicalArtifacts(fixture, wtree, simulationCase.request, label);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function main(): number {
  for (const runtime of ["codex", "gemini", "copilot"] as const) {
    assertSimHookPassthrough(runtime);
    for (const simulationCase of SIMULATION_CASES) {
      simulateRuntime(runtime, simulationCase);
    }
  }
  console.log("loopship runtime simulation verification passed");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
