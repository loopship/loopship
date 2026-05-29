#!/usr/bin/env bun

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTasksYaml, questFiles } from "./loopo_core.ts";
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
import { readText, runCommand, tsRunner } from "./loopo_utils.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOOPO_SCRIPT = resolve(SCRIPT_DIR, "loopo.ts");
const SIM_DIR = join(".loopo", "sim-runtime");

type Fixture = {
  root: string;
  repo: string;
  env: Record<string, string>;
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

function runLoopo(
  fixture: Fixture,
  args: string[],
  input?: Record<string, unknown>,
) {
  return runTsScript(
    LOOPO_SCRIPT,
    args,
    input,
    existsSync(fixture.repo) ? fixture.repo : fixture.root,
    fixture.env,
  );
}

function createFixture(prefix: string, runtime: Runtime): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repo = join(root, "repo");
  const env = {
    ...process.env,
    HOME: join(root, "home"),
    LOOPO_GLOBAL_BIN: join(root, "bin", "loopo"),
    LOOPO_SCRIPT: LOOPO_SCRIPT,
  };
  return { root, repo, env };
}

function currentStage(fixture: Fixture, slug: string): string {
  const files = questFiles(fixture.repo, slug);
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
  if (!command || command.cmd !== "loopo") {
    fail(`${label}: guided sim step must include commands.next`);
  }
  const args = Array.isArray(command.args) ? command.args : [];
  const expected = ["sim", "--repo", repo, "--json", "@-"];
  if (JSON.stringify(args) !== JSON.stringify(expected)) {
    fail(`${label}: guided sim commands.next mismatch: ${JSON.stringify(args)}`);
  }
}

function simCommandArgs(step: Record<string, any>, label: string): string[] {
  const args = step.commands?.next?.args;
  if (!Array.isArray(args) || args[0] !== "sim") {
    fail(`${label}: missing runnable sim next command`);
  }
  return args.map(String);
}

function assertLifecycleLog(
  repo: string,
  request: string,
  label: string,
): void {
  const scenario = selectSimProductQuestScenario(request);
  const events = readJsonl(join(repo, SIM_DIR, "events.jsonl"));
  const steps = events.filter((record) => record.kind === "guided_step");
  if (steps.length === 0) {
    fail(`${label}: expected at least one guided simulated step`);
  }

  const requestSteps = steps.map((record) => stepId(record.requested_step));
  const responseSteps = steps.map((record) => stepId(record.response?.step));

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
  if (existsSync(join(repo, SIM_DIR, "pending-callback.json"))) {
    fail(`${label}: pending callback should be cleared after archive`);
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
  slug: string,
  request: string,
  label: string,
): void {
  const scenario = selectSimProductQuestScenario(request);
  const expectedPlan = scenario.resolved_plan ?? scenario.initial_plan;
  const files = questFiles(fixture.repo, slug);
  const state = parseTasksYaml(readText(files.tasks)) as Partial<{
    stage: string;
    tasks: Array<Partial<{ id: string; title: string }>>;
  }>;

  if (String(state.stage ?? "") !== "archived") {
    fail(`${label}: canonical task state did not reach archived`);
  }

  const planEvents = readJsonl(files.plans).filter(
    (record) => record.event === "plan",
  );
  if (planEvents.length === 0) {
    fail(`${label}: expected at least one recorded plan payload`);
  }
  const latestPlanPayload = planEvents.at(-1)?.payload ?? {};
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

  const questionEvents = readJsonl(files.questions).map((record) =>
    String(record.event ?? ""),
  );
  if (scenario.expect_question_round) {
    for (const event of ["question_round", "answers"]) {
      if (!questionEvents.includes(event)) {
        fail(`${label}: expected questions log to include ${event}`);
      }
    }
  } else if (questionEvents.length !== 0) {
    fail(
      `${label}: concrete simulation unexpectedly recorded question events: ${JSON.stringify(questionEvents)}`,
    );
  }
}

function assertSimHookPassthrough(runtime: Runtime): void {
  const fixture = createFixture(`loopo-runtime-sim-hook-${runtime}-`, runtime);
  const label = `${runtime}/hook`;
  try {
    const start = runLoopo(
      fixture,
      [
        "sim",
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
    const hook = runLoopo(
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
          cwd: fixture.repo,
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
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function simulateRuntime(
  runtime: Runtime,
  simulationCase: SimulationCase,
): void {
  const fixture = createFixture(
    `loopo-runtime-sim-${simulationCase.name}-`,
    runtime,
  );
  const label = `${runtime}/${simulationCase.name}`;
  try {
    const start = runLoopo(
      fixture,
      [
        "sim",
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
    let current = parseJson(start.stdout, `${label} sim start`);
    assertGuidedStep(current, fixture.repo, label);
    const slug = String(current.slug ?? "");
    if (!slug) fail(`${label}: missing slug in sim start output`);
    if (String(current.current_stage ?? "") !== "planning") {
      fail(`${label}: sim start must enter planning: ${start.stdout}`);
    }

    let planRound = 0;
    let landingRound = 0;
    let childInitRuntimeChecks = 0;
    for (let guard = 0; guard < 20; guard += 1) {
      if (current.done === true || currentStage(fixture, slug) === "archived") break;
      const requestedStep = stepId(current.step);
      if (!requestedStep) {
        fail(`${label}: missing requested step in guided output`);
      }
      const quest = parseTasksYaml(
        readText(questFiles(fixture.repo, slug).tasks),
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
      const callbackProc = runLoopo(
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
    if (currentStage(fixture, slug) !== "archived") {
      fail(`${label}: simulation did not reach archived`);
    }

    assertLifecycleLog(fixture.repo, simulationCase.request, label);
    assertCanonicalArtifacts(fixture, slug, simulationCase.request, label);
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
  console.log("loopo runtime simulation verification passed");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
