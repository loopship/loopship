#!/usr/bin/env bun

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTasksYaml, questFiles } from "./loopship_core.ts";
import { scenarioPayloadForStep } from "./stepper_product_quest_scenarios.ts";
import { DEFAULT_RUNTIME_REQUEST, type Runtime } from "./runtime_supervisor.ts";
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

const SIMULATION_CASE: SimulationCase = {
  name: "concrete-python-cli",
  request: DEFAULT_RUNTIME_REQUEST,
};

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
    ["user.email", "loopship-stepper@example.invalid"],
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
  // Test fixture setup: stepper is being run inside an existing repo with HEAD.
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

function assertGuidedStep(
  step: Record<string, any>,
  repo: string,
  label: string,
): void {
  if ("hook_output" in step || "reason_payload" in step) {
    fail(`${label}: guided stepper must not expose hook internals`);
  }
  if ("current_output" in step) {
    fail(`${label}: guided stepper must expose the current step directly`);
  }
  if ("commands" in step) {
    fail(`${label}: guided stepper must not expose commands.next`);
  }
  const continuation = step.continuation;
  if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) {
    fail(`${label}: guided stepper step must include continuation`);
  }
  const command = (continuation as Record<string, any>).command;
  if (!command || command.cmd !== "loopship") {
    fail(`${label}: guided stepper continuation must include loopship command`);
  }
  const args = Array.isArray(command.args) ? command.args : [];
  const expected = [
    "stepper",
    "step",
    "--wtree",
    String(step.wtree ?? ""),
    "--json",
    "@-",
  ];
  if (JSON.stringify(args) !== JSON.stringify(expected)) {
    fail(`${label}: guided stepper continuation command mismatch: ${JSON.stringify(args)}`);
  }
}

function assertNoFixtureFiles(repo: string, label: string): void {
  for (const name of ["callback-fixture.txt", "hook-fixture.txt"]) {
    if (existsSync(join(repo, name))) {
      fail(`${label}: stepper must not create ${name}`);
    }
  }
}

function assertNoStepperRuntimeArtifacts(repo: string, label: string): void {
  if (existsSync(join(repo, ".loopship", "stepper-runtime"))) {
    fail(`${label}: stepper must not create .loopship/stepper-runtime`);
  }
}

function assertHeadUnchanged(fixture: Fixture, label: string): void {
  const currentHead = gitStdout(fixture.repo, ["rev-parse", "HEAD"], fixture.env);
  if (currentHead !== fixture.initialHead) {
    fail(`${label}: stepper start must not create commits or move HEAD`);
  }
}

function stepperCommandArgs(step: Record<string, any>, label: string): string[] {
  const args = step.continuation?.command?.args;
  if (!Array.isArray(args) || args[0] !== "stepper") {
    fail(`${label}: missing runnable stepper continuation command`);
  }
  return args.map(String);
}

function simulateRuntime(
  runtime: Runtime,
  simulationCase: SimulationCase,
): void {
  const fixture = createFixture(
    `loopship-runtime-stepper-${simulationCase.name}-`,
    runtime,
  );
  const label = `${runtime}/${simulationCase.name}`;
  try {
    const start = runLoopship(
      fixture,
      [
        "stepper",
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
      fail(start.stderr || start.stdout || `${label}: stepper start failed`);
    }
    assertNoFixtureFiles(fixture.repo, label);
    assertHeadUnchanged(fixture, label);
    let current = parseJson(start.stdout, `${label} stepper start`);
    assertGuidedStep(current, fixture.repo, label);
    const wtree = String(current.wtree ?? "");
    if (!wtree) fail(`${label}: missing wtree in stepper start output`);
    if (String(current.current_stage ?? "") !== "planning") {
      fail(`${label}: stepper start must enter planning: ${start.stdout}`);
    }

    const requestedStep = stepId(current.task);
    if (requestedStep !== "plan") {
      fail(`${label}: simulation must start at plan`);
    }
    const quest = parseTasksYaml(
      readText(questFiles(fixture.repo, wtree).tasks),
    ) as Record<string, any>;
    const callbackInput = scenarioPayloadForStep({
      request: simulationCase.request,
      step: requestedStep,
      quest,
      planRound: 0,
      landingRound: 0,
    });
    const callbackProc = runLoopship(
      fixture,
      stepperCommandArgs(current, label),
      callbackInput,
    );
    if (callbackProc.status !== 0) {
      fail(
        callbackProc.stderr ||
          callbackProc.stdout ||
          `${label}: guided stepper continuation failed`,
      );
    }
    current = parseJson(callbackProc.stdout, `${label} guided stepper output`);
    assertGuidedStep(current, fixture.repo, label);
    if (stepId(current.task) !== "task_graph") {
      fail(`${label}: concrete simulation must continue to task_graph`);
    }
    if (String(current.current_stage ?? "") !== "plan_review") {
      fail(`${label}: concrete simulation stage mismatch: ${JSON.stringify(current)}`);
    }
    assertNoStepperRuntimeArtifacts(fixture.repo, label);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function main(): number {
  simulateRuntime("codex", SIMULATION_CASE);
  console.log("loopship runtime simulation verification passed");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
