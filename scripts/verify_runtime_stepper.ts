#!/usr/bin/env bun

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTasksYaml, questFiles } from "./loopship_core.ts";
import { scenarioPayloadForStep } from "./stepper_product_quest_scenarios.ts";
import { readText, runCommand } from "./loopship_utils.ts";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "loopship.ts");
let commandEnv: Record<string, string> | undefined;
let commandCwd: string | undefined;

function fail(message: string): never {
  throw new Error(message);
}

function parseJson(text: string): Record<string, any> {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("expected object");
    }
    return parsed;
  } catch {
    fail(`expected JSON object, got: ${text}`);
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

function runStepper(args: string[]) {
  return runCommand("bun", [SCRIPT, "stepper", ...args], {
    cwd: commandCwd,
    env: commandEnv,
    timeoutMs: 120_000,
  });
}

function runStepperWithInput(args: string[], input: Record<string, unknown>) {
  return runCommand("bun", [SCRIPT, "stepper", ...args], {
    cwd: commandCwd,
    env: commandEnv,
    input: JSON.stringify(input),
    timeoutMs: 120_000,
  });
}

function assertGuidedStep(step: Record<string, any>, repo: string): void {
  if ("hook_output" in step || "reason_payload" in step) {
    fail(`guided stepper must not expose hook internals: ${JSON.stringify(step)}`);
  }
  if ("current_output" in step) {
    fail(`guided stepper must expose the current step directly: ${JSON.stringify(step)}`);
  }
  if ("commands" in step) {
    fail(`guided stepper must not expose commands.next: ${JSON.stringify(step)}`);
  }
  const continuation = step.continuation;
  if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) {
    fail(`guided stepper step must include continuation: ${JSON.stringify(step)}`);
  }
  const command = (continuation as Record<string, any>).command;
  if (!command || command.cmd !== "loopship") {
    fail(`guided stepper continuation must include loopship command: ${JSON.stringify(step)}`);
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
    fail(`guided stepper continuation command mismatch: ${JSON.stringify(args)}`);
  }
}

function stepperArgsFromStep(step: Record<string, any>): string[] {
  const args = step.continuation?.command?.args;
  if (!Array.isArray(args) || args[0] !== "stepper") {
    fail(`missing runnable stepper continuation command: ${JSON.stringify(step.continuation)}`);
  }
  return args.slice(1).map(String);
}

function fastflowSessions(repoRoot: string, wtree: string): Record<string, any> {
  const parsed = JSON.parse(readText(questFiles(repoRoot, wtree).hook_state));
  const sessions = parsed?.fastflow_sessions;
  return sessions && typeof sessions === "object" && !Array.isArray(sessions)
    ? sessions
    : {};
}

function assertFastflowSession(
  repoRoot: string,
  wtree: string,
  stepId: string,
  expected: boolean,
): void {
  const key = `step:${stepId}`;
  const session = fastflowSessions(repoRoot, wtree)[key];
  if (expected) {
    if (!session?.session_id || session.workflow_ref !== "loopship.workflow.service.flows.swe") {
      fail(`missing native Fastflow session ${key}: ${JSON.stringify(session)}`);
    }
  } else if (session) {
    fail(`native Fastflow session ${key} should have been consumed: ${JSON.stringify(session)}`);
  }
}

function assertOldStepperCommandsAreUnknown(): void {
  const cases = [
    ["loopship: old top-level start"],
    ["--repo", "/tmp/loopship-stepper-old", "--json", "{}"],
    ["start", "--request", "loopship: old path"],
    ["next", "--repo", "/tmp/loopship-stepper-old"],
    ["callback", "--repo", "/tmp/loopship-stepper-old", "--json", "{}"],
    ["status", "--repo", "/tmp/loopship-stepper-old"],
    ["quest", "help"],
  ];
  for (const args of cases) {
    const oldCommand = runStepper(args);
    if (oldCommand.status === 0) {
      fail(`old stepper command unexpectedly succeeded: ${oldCommand.stdout}`);
    }
    const combined = `${oldCommand.stderr}\n${oldCommand.stdout}`;
    const expectedError =
      `unknown stepper command: ${args[0]}`;
    if (!combined.includes(expectedError)) {
      fail(`old stepper command must hard-fail as unknown: ${combined}`);
    }
  }
}

function prepareExistingGitRepoFixture(repo: string): void {
  const init = runCommand("git", ["init", repo], { timeoutMs: 15_000 });
  if (init.status !== 0) fail(init.stderr || init.stdout);
  for (const [key, value] of [
    ["user.email", "loopship-stepper@example.invalid"],
    ["user.name", "Loopship Stepper Fixture"],
  ] as const) {
    const config = runCommand("git", ["config", key, value], {
      cwd: repo,
      timeoutMs: 15_000,
    });
    if (config.status !== 0) fail(config.stderr || config.stdout);
  }
  const branch = runCommand("git", ["checkout", "-B", "main"], {
    cwd: repo,
    timeoutMs: 15_000,
  });
  if (branch.status !== 0) fail(branch.stderr || branch.stdout);
  // Test fixture setup: stepper is being run inside an existing repo with HEAD.
  const existingRepoHead = runCommand(
    "git",
    ["commit", "--allow-empty", "-m", "stepper test baseline"],
    {
      cwd: repo,
      timeoutMs: 15_000,
    },
  );
  if (existingRepoHead.status !== 0) {
    fail(existingRepoHead.stderr || existingRepoHead.stdout);
  }
}

function main(): number {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopship-stepper-")));
  const repo = join(root, "repo");
  const request = "loopship: a fullstack app";
  commandEnv = {
    ...process.env,
    HOME: join(root, "home"),
    LOOPSHIP_GLOBAL_BIN: join(root, "bin", "loopship"),
    LOOPSHIP_SCRIPT: SCRIPT,
  };
  try {
    assertOldStepperCommandsAreUnknown();
    prepareExistingGitRepoFixture(repo);
    commandCwd = repo;

    const start = runStepper([
      "init",
      request,
      "--repo",
      repo,
      "--runtime",
      "codex",
      "--flow",
      "swe",
    ]);
    if (start.status !== 0) fail(start.stderr || start.stdout);
    if (existsSync(join(repo, ".loopship", "stepper-runtime"))) {
      fail("guided stepper must not create .loopship/stepper-runtime");
    }
    let current = parseJson(start.stdout);
    assertGuidedStep(current, repo);
    if (current.wtree !== "a-fullstack-app") {
      fail(`unexpected wtree from guided stepper start: ${start.stdout}`);
    }
    if (current.current_stage !== "planning") {
      fail(`guided stepper start must create a planning quest: ${start.stdout}`);
    }
    assertFastflowSession(repo, String(current.wtree), "plan", true);

    const requestedStep = stepId(current.task);
    if (requestedStep !== "plan") {
      fail(`guided stepper must start at plan: ${JSON.stringify(current)}`);
    }
    const quest = parseTasksYaml(readText(questFiles(repo, current.wtree).tasks));
    const callbackInput = scenarioPayloadForStep({
      request,
      step: requestedStep,
      quest,
      planRound: 0,
      landingRound: 0,
    });
    const continued = runStepperWithInput(stepperArgsFromStep(current), callbackInput);
    if (continued.status !== 0) fail(continued.stderr || continued.stdout);
    current = parseJson(continued.stdout);
    assertGuidedStep(current, repo);
    if (stepId(current.task) !== "questions") {
      fail(`guided stepper first continuation must emit questions: ${JSON.stringify(current)}`);
    }
    if (current.current_stage !== "awaiting_user_answers" || current.done === true) {
      fail(`guided stepper first continuation stage mismatch: ${JSON.stringify(current)}`);
    }
    assertFastflowSession(repo, String(current.wtree), "plan", false);
    assertFastflowSession(repo, String(current.wtree), "questions", true);

    console.log("loopship runtime stepper verification passed");
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
