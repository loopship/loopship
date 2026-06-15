#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTasksYaml, questFiles } from "./loopship_core.ts";
import {
  DEFAULT_FLOW_ID,
  flowStep,
  loadFlowDefinition,
} from "./loopship_workflow_runner.ts";
import {
  readHookDecision as readSupervisorHookDecision,
} from "./runtime_supervisor.ts";
import {
  expandHome,
  readJson,
  readStdinJson,
  readText,
  runCommand,
  tsRunner,
} from "./loopship_utils.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOOPSHIP_SCRIPT = resolve(SCRIPT_DIR, "loopship.ts");
const SETUP_RUNTIME_HOOKS_SCRIPT = resolve(
  SCRIPT_DIR,
  "setup_runtime_hooks.ts",
);

type Runtime = "codex" | "gemini" | "copilot";
type SimCommand = "init" | "quest_next" | "hook";

type SimArgs = {
  command: SimCommand;
  repo: string | null;
  runtime: string | null;
  json: string | null;
  request: string | null;
  flow: string | null;
  wtree: string | null;
  full: boolean;
  rest: string[];
};

type QuestLikeState = Partial<{
  stage: string;
  prompt: string;
  flow_id: string;
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    dependencies: string[];
    scope_files: string[];
    child_wtree: string;
    acceptance: string;
  }>;
}>;

function usage(exitCode = 1): number {
  const text = [
    "Usage:",
    '  loopship sim init "loopship: <request>" [--repo <path>] [--runtime <codex|gemini|copilot>] [--flow <id>] [--wtree <name>]',
    "  loopship sim quest next --wtree <name> [--repo <path>] --json <json|@file|@->",
    "  loopship sim hook [--repo <path>] [--runtime <codex|gemini|copilot>] [--json <json|@file|@->]",
  ].join("\n");
  if (exitCode === 0) console.log(text);
  else console.error(text);
  return exitCode;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): SimArgs {
  let repo: string | null = null;
  let runtime: string | null = null;
  let json: string | null = null;
  let flow: string | null = null;
  let wtree: string | null = null;
  let full = false;
  const requestParts: string[] = [];
  const rest: string[] = [];
  const command = argv[0];
  let simCommand: SimCommand;
  let body: string[];

  if (command === "init") {
    simCommand = "init";
    body = argv.slice(1);
  } else if (command === "quest") {
    const subcommand = argv[1];
    if (subcommand === "next") {
      simCommand = "quest_next";
      body = argv.slice(2);
    } else {
      throw new Error(`unknown sim quest command: ${subcommand ?? ""}`.trim());
    }
  } else if (command === "hook") {
    simCommand = "hook";
    body = argv.slice(1);
  } else if (command === "--help" || command === "-h") {
    throw new Error("__SIM_HELP__");
  } else {
    throw new Error(`unknown sim command: ${command ?? ""}`.trim());
  }

  for (let i = 0; i < body.length; i += 1) {
    const arg = body[i];
    if (arg === "--repo") repo = body[++i] ?? null;
    else if (arg?.startsWith("--repo=")) repo = arg.slice("--repo=".length);
    else if (arg === "--cwd" || arg?.startsWith("--cwd=")) {
      throw new Error("loopship sim no longer accepts --cwd; use --repo or run from the repo root");
    } else if (arg === "--wtree") wtree = body[++i] ?? null;
    else if (arg?.startsWith("--wtree=")) wtree = arg.slice("--wtree=".length);
    else if (arg === "--runtime") runtime = body[++i] ?? null;
    else if (arg?.startsWith("--runtime="))
      runtime = arg.slice("--runtime=".length);
    else if (arg === "--json") json = body[++i] ?? "@-";
    else if (arg?.startsWith("--json=")) json = arg.slice("--json=".length);
    else if (arg === "--flow") flow = body[++i] ?? null;
    else if (arg?.startsWith("--flow=")) flow = arg.slice("--flow=".length);
    else if (arg === "--full") full = true;
    else if (arg === "--help" || arg === "-h") throw new Error("__SIM_HELP__");
    else if (arg?.startsWith("-")) throw new Error(`unknown sim argument: ${arg}`);
    else if (arg !== undefined && simCommand === "init") requestParts.push(arg);
    else if (arg !== undefined) rest.push(arg);
  }

  return {
    command: simCommand,
    repo,
    runtime,
    json,
    request: requestParts.join(" ").trim() || null,
    flow,
    wtree,
    full,
    rest,
  };
}

function resolveRuntime(
  value: string | null | undefined,
  fallback: Runtime = "codex",
): Runtime {
  if (!value) return fallback;
  if (value === "codex" || value === "gemini" || value === "copilot") {
    return value;
  }
  throw new Error(`unsupported runtime: ${value}`);
}

function normalizeRequestText(request: string): string {
  const raw = request.trim();
  if (!raw) fail("sim init requires a request");
  return /^loopship:/i.test(raw) ? raw : `loopship: ${raw}`;
}

function resolveFlowId(value: string | null | undefined): string {
  const flowId = String(value ?? DEFAULT_FLOW_ID).trim() || DEFAULT_FLOW_ID;
  loadFlowDefinition(flowId);
  return flowId;
}

function defaultRepoRoot(repo: string | null): string {
  if (repo) return resolve(expandHome(repo));
  return resolve(process.cwd());
}

function parseJsonText(text: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readJsonArg(json: string | null): Record<string, unknown> {
  if (!json || json === "@-") {
    const parsed = readStdinJson();
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  }
  if (json.startsWith("@")) {
    return (readJson(resolve(expandHome(json.slice(1)))) ?? {}) as Record<
      string,
      unknown
    >;
  }
  return parseJsonText(json, "json argument");
}

function resolveRepoRoot(
  explicit: string | null,
  payload: Record<string, unknown> | null,
): string {
  const raw =
    explicit ??
    (typeof payload?.repo === "string" ? payload.repo : null) ??
    (typeof payload?.cwd === "string" ? payload.cwd : null) ??
    (typeof payload?.context === "object" &&
    payload.context &&
    typeof (payload.context as Record<string, unknown>).cwd === "string"
      ? ((payload.context as Record<string, unknown>).cwd as string)
      : null) ??
    process.cwd();
  return resolve(expandHome(raw));
}

function setupSimulationHooks(repoRoot: string, runtime: Runtime): void {
  const launch = tsRunner(SETUP_RUNTIME_HOOKS_SCRIPT, [
    "--repo",
    repoRoot,
    "--runtime",
    runtime,
    "--hook-script",
    resolve(SCRIPT_DIR, "loopship_sim.ts"),
  ]);
  const proc = runCommand(launch.cmd, launch.args, {
    cwd: repoRoot,
    timeoutMs: 60_000,
  });
  if (proc.status !== 0) fail(proc.stderr || proc.stdout);
}

function runLoopship(
  repoRoot: string,
  args: string[],
  input?: Record<string, unknown>,
) {
  const launch = tsRunner(LOOPSHIP_SCRIPT, args);
  return runCommand(launch.cmd, launch.args, {
    cwd: repoRoot,
    env: { LOOPSHIP_COMPACT_INIT_SCHEMA: "1" },
    timeoutMs: 60_000,
    input: input ? JSON.stringify(input) : undefined,
  });
}

function questState(repoRoot: string, wtree: string): QuestLikeState {
  const files = questFiles(repoRoot, wtree);
  return parseTasksYaml(readText(files.tasks)) as QuestLikeState;
}

function currentFlowStepId(repoRoot: string, wtree: string): string {
  const state = questState(repoRoot, wtree);
  const flowId = String(state.flow_id ?? DEFAULT_FLOW_ID).trim() || DEFAULT_FLOW_ID;
  return flowStep(loadFlowDefinition(flowId), String(state.stage ?? "")).id;
}

function inferSimulationRuntime(repoRoot: string): Runtime {
  if (existsSync(resolve(repoRoot, ".codex", "hooks.json"))) return "codex";
  if (existsSync(resolve(repoRoot, ".gemini", "settings.json"))) return "gemini";
  if (existsSync(resolve(repoRoot, ".github", "hooks", "loopship.json"))) {
    return "copilot";
  }
  return "codex";
}

function simCommand(args: string[]): Record<string, unknown> {
  return { cmd: "loopship", args };
}

function simNextCommand(repoRoot: string, wtree: string): Record<string, unknown> {
  return simCommand([
    "sim",
    "quest",
    "next",
    "--wtree",
    wtree,
    "--json",
    "@-",
  ]);
}

function withGuidedEnvelope(input: {
  repoRoot: string;
  wtree: string;
  runtime: Runtime;
  output: Record<string, unknown>;
}): Record<string, unknown> {
  const state = questState(input.repoRoot, input.wtree);
  const outputStep =
    typeof input.output.step === "string"
      ? input.output.step
      : input.output.step &&
          typeof input.output.step === "object" &&
          !Array.isArray(input.output.step)
        ? String((input.output.step as Record<string, unknown>).id ?? "")
        : "";
  const outputStage = String(input.output.state ?? "");
  const stage =
    outputStep === "archived" ? "archived" : outputStage || String(state.stage ?? "");
  const flowId = String(state.flow_id ?? DEFAULT_FLOW_ID).trim() || DEFAULT_FLOW_ID;
  const originalCommands =
    input.output.commands &&
    typeof input.output.commands === "object" &&
    !Array.isArray(input.output.commands)
      ? (input.output.commands as Record<string, unknown>)
      : {};
  return {
    repo: input.repoRoot,
    runtime: input.runtime,
    request: String(state.prompt ?? ""),
    flow_id: flowId,
    wtree: input.wtree,
    current_stage: stage,
    done: stage === "archived" || outputStep === "archived",
    ...input.output,
    commands: {
      ...originalCommands,
      next: simNextCommand(input.repoRoot, input.wtree),
    },
  };
}

function executeHook(
  repoRoot: string,
  runtime: Runtime,
  raw: Record<string, unknown>,
): {
  envelope: Record<string, unknown>;
  output: Record<string, unknown>;
  reason: Record<string, unknown> | null;
} {
  const hook = readSupervisorHookDecision({
    repoRoot,
    env: process.env,
    runtime,
    raw,
  });
  const envelope = hook.envelope;
  const output = hook.output;
  const reason = hook.reason
    ? (parseJsonText(hook.reason, "hook reason") as Record<string, unknown>)
    : null;
  return { envelope, output, reason };
}

function routeSimQuestInit(input: {
  repoRoot: string;
  runtime: Runtime;
  request: string;
  flowId: string;
  wtree: string | null;
}): { wtree: string; createOutput: Record<string, unknown> } {
  const initArgs = [
    "init",
    input.request,
    "--repo",
    input.repoRoot,
    "--runtime",
    input.runtime,
    "--flow",
    input.flowId,
  ];
  if (input.wtree) initArgs.push("--wtree", input.wtree);
  const init = runLoopship(input.repoRoot, initArgs);
  if (init.status !== 0) fail(init.stderr || init.stdout || "loopship init failed");
  const route = parseJsonText(init.stdout, "init output");
  const newQuest =
    route.new_quest && typeof route.new_quest === "object"
      ? (route.new_quest as Record<string, unknown>)
      : {};
  const wtree = String(newQuest.suggested_wtree ?? "").trim();
  if (!wtree) fail(`missing wtree in init output: ${init.stdout}`);
  const createInput =
    newQuest.input && typeof newQuest.input === "object"
      ? (newQuest.input as Record<string, unknown>)
      : null;
  if (!createInput) fail("loopship init did not emit a create_quest input");
  const routeProc = runLoopship(
    input.repoRoot,
    [
      "quest",
      "next",
      "--wtree",
      wtree,
      "--json",
      "@-",
    ],
    createInput,
  );
  if (routeProc.status !== 0) {
    fail(routeProc.stderr || routeProc.stdout || "new_quest.command failed");
  }
  return {
    wtree,
    createOutput: parseJsonText(routeProc.stdout, "route output"),
  };
}

function runHookMode(args: SimArgs): number {
  const raw = readJsonArg(args.json);
  const repoRoot = resolveRepoRoot(args.repo, raw);
  const runtime = resolveRuntime(args.runtime);
  const result = executeHook(repoRoot, runtime, raw);
  process.stdout.write(JSON.stringify(result.output, null, 2));
  return 0;
}

function runSimInit(args: SimArgs): number {
  if (!args.request) {
    throw new Error(
      'sim init requires a request, for example: loopship sim init "loopship: build the app" --flow swe --runtime codex',
    );
  }
  const repoRoot = defaultRepoRoot(args.repo);
  const runtime = resolveRuntime(args.runtime);
  const request = normalizeRequestText(args.request);
  const flowId = resolveFlowId(args.flow);
  setupSimulationHooks(repoRoot, runtime);
  const started = routeSimQuestInit({
    repoRoot,
    runtime,
    request,
    flowId,
    wtree: args.wtree,
  });
  process.stdout.write(
    JSON.stringify(
      withGuidedEnvelope({
        repoRoot,
        wtree: started.wtree,
        runtime,
        output: started.createOutput,
      }),
      null,
      2,
    ),
  );
  return 0;
}

function runSimQuestNext(args: SimArgs): number {
  if (!args.json) {
    throw new Error("sim quest next requires --json <json|@file|@->");
  }
  const wtree = String(args.wtree ?? "").trim();
  if (!wtree) {
    throw new Error("sim quest next requires --wtree <name>");
  }
  const payload = readJsonArg(args.json);
  if (Object.keys(payload).length === 0) {
    throw new Error("sim quest next requires a non-empty JSON payload");
  }
  const repoRoot = resolveRepoRoot(args.repo, payload);
  if (!existsSync(questFiles(repoRoot, wtree).tasks)) {
    throw new Error(`missing quest state for simulated quest: ${wtree}`);
  }
  currentFlowStepId(repoRoot, wtree);
  const questArgs = [
    "quest",
    "next",
    "--wtree",
    wtree,
    "--json",
    "@-",
  ];
  if (args.full) questArgs.push("--full");
  const proc = runLoopship(
    repoRoot,
    questArgs,
    payload,
  );
  if (proc.status !== 0) {
    throw new Error(proc.stderr || proc.stdout || "loopship quest next failed");
  }
  const output = parseJsonText(proc.stdout, "guided sim output");
  const runtime = resolveRuntime(args.runtime, inferSimulationRuntime(repoRoot));
  process.stdout.write(
    JSON.stringify(
      withGuidedEnvelope({
        repoRoot,
        wtree,
        runtime,
        output,
      }),
      null,
      2,
    ),
  );
  return 0;
}

export function runSimCli(argv: string[]): number {
  let args: SimArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof Error && error.message === "__SIM_HELP__") {
      return usage(0);
    }
    if (
      error instanceof Error &&
      (error.message.startsWith("unknown sim argument:") ||
        error.message.startsWith("unknown sim command:") ||
        error.message.startsWith("unknown sim quest command:"))
    ) {
      console.error(error.message);
      return usage(1);
    }
    throw error;
  }
  if (args.command === "init") return runSimInit(args);
  if (args.command === "quest_next") return runSimQuestNext(args);
  return runHookMode(args);
}

if (import.meta.main) {
  try {
    process.exit(runSimCli(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
