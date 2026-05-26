#!/usr/bin/env bun

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTasksYaml, questFiles } from "./loopo_core.ts";
import {
  DEFAULT_RUNTIME_REQUEST,
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
) {
  if (runtime === "gemini") {
    if (payload.decision !== "deny" || payload.suppressOutput !== true) {
      fail(
        `gemini hook output must deny with suppressOutput: ${JSON.stringify(payload)}`,
      );
    }
    return;
  }
  if (payload.decision !== "block") {
    fail(`${runtime} hook output must block: ${JSON.stringify(payload)}`);
  }
  if (runtime === "copilot" && !payload.hookSpecificOutput) {
    fail(`copilot hook output must include hookSpecificOutput`);
  }
}

function assertLifecycleLog(repo: string): void {
  const events = readJsonl(join(repo, SIM_DIR, "events.jsonl"));
  const callbacks = events.filter((record) => record.kind === "callback");
  const hookEvents = events.filter((record) => record.kind === "hook");
  if (callbacks.length === 0) {
    fail("expected at least one simulated callback turn");
  }
  if (hookEvents.length !== callbacks.length) {
    fail(
      `hook/callback turn count mismatch: ${hookEvents.length} vs ${callbacks.length}`,
    );
  }
  const requestSteps = callbacks.map((record) => stepId(record.request?.step));
  const responseSteps = callbacks.map((record) =>
    stepId(record.response?.step),
  );
  for (const step of [
    "plan",
    "questions",
    "task_graph",
    "executing",
    "validation",
    "verification",
    "system_update",
    "landing",
  ]) {
    if (!requestSteps.includes(step)) {
      fail(`simulation never requested lifecycle step ${step}`);
    }
  }
  for (const step of [
    "questions",
    "plan",
    "task_graph",
    "executing",
    "validation",
    "verification",
    "system_update",
    "landing",
    "archived",
  ]) {
    if (!responseSteps.includes(step)) {
      fail(`simulation never reached lifecycle response step ${step}`);
    }
  }
  if (existsSync(join(repo, SIM_DIR, "pending-callback.json"))) {
    fail("pending callback should be cleared after the lifecycle archives");
  }
}

function simulateRuntime(runtime: Runtime): void {
  const fixture = createFixture("loopo-runtime-sim-", runtime);
  try {
    const start = runLoopo(
      fixture,
      [
        "sim",
        "start",
        "--repo",
        fixture.repo,
        "--request",
        DEFAULT_RUNTIME_REQUEST,
        "--runtime",
        runtime,
      ],
      undefined,
    );
    if (start.status !== 0) {
      fail(start.stderr || start.stdout || `${runtime} sim start failed`);
    }
    const started = parseJson(start.stdout, `${runtime} sim start`);
    const slug = String(started.slug ?? "");
    if (!slug) fail(`missing slug in ${runtime} sim start output`);
    if (String(started.current_stage ?? "") !== "planning") {
      fail(`${runtime} sim start must enter planning: ${start.stdout}`);
    }

    let firstHook = true;
    for (let guard = 0; guard < 20; guard += 1) {
      if (currentStage(fixture, slug) === "archived") break;
      const next = runLoopo(
        fixture,
        ["sim", "next", "--repo", fixture.repo],
        undefined,
      );
      if (next.status !== 0) {
        fail(next.stderr || next.stdout || `${runtime} sim next failed`);
      }
      const stepped = parseJson(next.stdout, `${runtime} sim next`);
      const hook = stepped.hook_output;
      if (firstHook && hook && typeof hook === "object") {
        assertRuntimeHookShape(runtime, hook as Record<string, any>);
        firstHook = false;
      }
      const callback = stepped.callback_output;
      if (!hook || typeof hook !== "object" || !("reason" in hook)) {
        fail(
          `${runtime} sim next returned malformed hook output: ${next.stdout}`,
        );
      }
      if (stepped.done !== true && !(hook as Record<string, unknown>).reason) {
        fail(
          `${runtime} hook returned no continuation before archive: ${JSON.stringify(hook)}`,
        );
      }
      if (callback && !stepId((callback as Record<string, unknown>).step)) {
        fail(
          `${runtime} callback returned malformed output: ${JSON.stringify(callback)}`,
        );
      }
      if (stepped.done === true) break;
    }

    const status = runLoopo(fixture, ["sim", "status", "--repo", fixture.repo]);
    if (status.status !== 0) {
      fail(status.stderr || status.stdout || `${runtime} sim status failed`);
    }
    const current = parseJson(status.stdout, `${runtime} sim status`);
    if (current.current_stage !== "archived" || current.done !== true) {
      fail(`${runtime} simulation status must report archived: ${status.stdout}`);
    }
    if (currentStage(fixture, slug) !== "archived") {
      fail(`${runtime} simulation did not reach archived`);
    }
    assertLifecycleLog(fixture.repo);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function main(): number {
  for (const runtime of ["codex", "gemini", "copilot"] as const) {
    simulateRuntime(runtime);
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
