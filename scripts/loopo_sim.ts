#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendJsonl, parseTasksYaml, questFiles } from "./loopo_core.ts";
import { DEFAULT_FLOW_ID, flowStep, loadFlowDefinition } from "./loopo_flow.ts";
import {
  readHookDecision as readSupervisorHookDecision,
  routeQuestInit,
} from "./runtime_supervisor.ts";
import {
  expandHome,
  readJson,
  readStdinJson,
  readText,
  runCommand,
  shellQuote,
  tsRunner,
  writeJson,
} from "./loopo_utils.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOOPO_SCRIPT = resolve(SCRIPT_DIR, "loopo.ts");
const SETUP_RUNTIME_HOOKS_SCRIPT = resolve(
  SCRIPT_DIR,
  "setup_runtime_hooks.ts",
);
const SIM_DIR = join(".loopo", "sim-runtime");
const PENDING_CALLBACK_FILE = join(SIM_DIR, "pending-callback.json");
const EVENT_LOG_FILE = join(SIM_DIR, "events.jsonl");
const SESSION_FILE = join(SIM_DIR, "session.json");

type Runtime = "codex" | "gemini" | "copilot";
type SimProfile = "interactive";
type SimMode = "guided" | "hook";

type SimArgs = {
  mode: SimMode;
  legacyMode: string | null;
  repo: string | null;
  runtime: string | null;
  json: string | null;
  request: string | null;
  flow: string | null;
};

type SimSession = {
  schema_version: 1;
  profile: SimProfile;
  repo_root: string;
  runtime: Runtime;
  request: string;
  flow_id: string;
  slug: string;
  started_at: string;
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
    child_slug: string;
    acceptance: string;
  }>;
}>;

const LEGACY_MODES = new Set(["start", "next", "status", "callback"]);

function usage(exitCode = 1): number {
  const text = [
    "Usage:",
    '  loopo sim "loopo: <request>" [--repo <path>] [--runtime <codex|gemini|copilot>] [--flow <id>]',
    "  loopo sim --repo <path> --json <json|@file|@->",
    "  loopo sim hook [--repo <path>] [--runtime <codex|gemini|copilot>] [--json <json|@file|@->]",
  ].join("\n");
  if (exitCode === 0) console.log(text);
  else console.error(text);
  return exitCode;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): SimArgs {
  let mode: SimMode = "guided";
  let legacyMode: string | null = null;
  let repo: string | null = null;
  let runtime: string | null = null;
  let json: string | null = null;
  let flow: string | null = null;
  const requestParts: string[] = [];
  const rest = [...argv];

  if (rest[0] === "hook") {
    mode = "hook";
    rest.shift();
  } else if (rest[0] && LEGACY_MODES.has(rest[0])) {
    legacyMode = rest.shift() ?? null;
    return {
      mode,
      legacyMode,
      repo,
      runtime,
      json,
      request: null,
      flow,
    };
  }

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--repo") repo = rest[++i] ?? null;
    else if (arg?.startsWith("--repo=")) repo = arg.slice("--repo=".length);
    else if (arg === "--runtime") runtime = rest[++i] ?? null;
    else if (arg?.startsWith("--runtime="))
      runtime = arg.slice("--runtime=".length);
    else if (arg === "--json") json = rest[++i] ?? "@-";
    else if (arg?.startsWith("--json=")) json = arg.slice("--json=".length);
    else if (arg === "--flow") flow = rest[++i] ?? null;
    else if (arg?.startsWith("--flow=")) flow = arg.slice("--flow=".length);
    else if (arg === "--help" || arg === "-h") throw new Error("__SIM_HELP__");
    else if (arg?.startsWith("-")) throw new Error(`unknown sim argument: ${arg}`);
    else if (arg !== undefined) requestParts.push(arg);
  }

  return {
    mode,
    legacyMode,
    repo,
    runtime,
    json,
    request: requestParts.join(" ").trim() || null,
    flow,
  };
}

function legacyModeError(mode: string): string {
  return [
    `loopo sim ${mode} has been replaced by the guided sim flow.`,
    'Start with: loopo sim "loopo: <request>" --flow swe --runtime codex',
    "Continue with the returned commands.next, usually: loopo sim --repo <repo> --json @-",
    "Use loopo sim hook only for explicit runtime hook passthrough testing.",
  ].join("\n");
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
  if (!raw) fail("guided sim start requires a request");
  return /^loopo:/i.test(raw) ? raw : `loopo: ${raw}`;
}

function resolveFlowId(value: string | null | undefined): string {
  const flowId = String(value ?? DEFAULT_FLOW_ID).trim() || DEFAULT_FLOW_ID;
  loadFlowDefinition(flowId);
  return flowId;
}

function defaultRepoRoot(explicit: string | null): string {
  if (explicit) return resolve(expandHome(explicit));
  return join(mkdtempSync(join(tmpdir(), "loopo-sim-")), "repo");
}

function simBinPath(repoRoot: string): string {
  return resolve(repoRoot, SIM_DIR, "bin", "loopo");
}

function simEnv(repoRoot: string): Record<string, string> {
  return {
    PATH: `${dirname(simBinPath(repoRoot))}:${process.env.PATH ?? ""}`,
    LOOPO_GLOBAL_BIN: simBinPath(repoRoot),
    LOOPO_SCRIPT: LOOPO_SCRIPT,
  };
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

function ensureSimDir(repoRoot: string): string {
  const path = resolve(repoRoot, SIM_DIR);
  mkdirSync(path, { recursive: true });
  return path;
}

function simPath(repoRoot: string, relativePath: string): string {
  ensureSimDir(repoRoot);
  return resolve(repoRoot, relativePath);
}

function loadSession(repoRoot: string): SimSession | null {
  const parsed = readJson(simPath(repoRoot, SESSION_FILE));
  if (!parsed || typeof parsed !== "object") return null;
  return parsed as SimSession;
}

function saveSession(repoRoot: string, session: SimSession): void {
  writeJson(simPath(repoRoot, SESSION_FILE), session);
}

function logEvent(repoRoot: string, record: Record<string, unknown>): void {
  appendJsonl(simPath(repoRoot, EVENT_LOG_FILE), record);
}

function clearPendingCallback(repoRoot: string): void {
  rmSync(simPath(repoRoot, PENDING_CALLBACK_FILE), { force: true });
}

function savePendingCallback(
  repoRoot: string,
  record: Record<string, unknown>,
): void {
  writeJson(simPath(repoRoot, PENDING_CALLBACK_FILE), record);
}

function resetSimulationArtifacts(repoRoot: string): void {
  clearPendingCallback(repoRoot);
  writeFileSync(simPath(repoRoot, EVENT_LOG_FILE), "", "utf8");
}

function ensureFixtureRepo(repoRoot: string, runtime: Runtime): void {
  mkdirSync(repoRoot, { recursive: true });
  const env = simEnv(repoRoot);
  const createdRepo = !existsSync(join(repoRoot, ".git"));
  if (createdRepo) {
    const init = runCommand("git", ["init", repoRoot], {
      env,
      timeoutMs: 15_000,
    });
    if (init.status !== 0) fail(init.stderr || init.stdout);
    for (const [key, value] of [
      ["user.email", "loopo-sim@example.invalid"],
      ["user.name", `Loopo ${runtime} Simulator`],
    ] as const) {
      const proc = runCommand("git", ["config", key, value], {
        cwd: repoRoot,
        env,
        timeoutMs: 15_000,
      });
      if (proc.status !== 0) fail(proc.stderr || proc.stdout);
    }
  }
  const seeds: Array<[string, string]> = [
    ["README.md", "# loopo simulated quest\n"],
    ["hook-fixture.txt", "hook fixture\n"],
    ["callback-fixture.txt", "callback fixture\n"],
  ];
  let wroteSeed = false;
  for (const [name, body] of seeds) {
    const path = join(repoRoot, name);
    if (existsSync(path)) continue;
    writeFileSync(path, body, "utf8");
    wroteSeed = true;
  }
  if (createdRepo && wroteSeed) {
    const add = runCommand(
      "git",
      ["add", "README.md", "hook-fixture.txt", "callback-fixture.txt"],
      {
        cwd: repoRoot,
        env,
        timeoutMs: 15_000,
      },
    );
    if (add.status !== 0) fail(add.stderr || add.stdout);
    const commit = runCommand("git", ["commit", "-m", "simulation fixture"], {
      cwd: repoRoot,
      env,
      timeoutMs: 15_000,
    });
    if (commit.status !== 0) fail(commit.stderr || commit.stdout);
  }
}

function setupSimulationHooks(repoRoot: string, runtime: Runtime): void {
  const launch = tsRunner(SETUP_RUNTIME_HOOKS_SCRIPT, [
    "--repo",
    repoRoot,
    "--runtime",
    runtime,
    "--hook-script",
    resolve(SCRIPT_DIR, "loopo_sim.ts"),
  ]);
  const proc = runCommand(launch.cmd, launch.args, {
    cwd: repoRoot,
    env: simEnv(repoRoot),
    timeoutMs: 60_000,
  });
  if (proc.status !== 0) fail(proc.stderr || proc.stdout);
}

function runLoopo(
  repoRoot: string,
  args: string[],
  input?: Record<string, unknown>,
) {
  const launch = tsRunner(LOOPO_SCRIPT, args);
  return runCommand(launch.cmd, launch.args, {
    cwd: repoRoot,
    env: simEnv(repoRoot),
    timeoutMs: 60_000,
    input: input ? JSON.stringify(input) : undefined,
  });
}

function questState(repoRoot: string, slug: string): QuestLikeState {
  const files = questFiles(repoRoot, slug);
  return parseTasksYaml(readText(files.tasks)) as QuestLikeState;
}

function currentFlowStepId(repoRoot: string, session: SimSession): string {
  const state = questState(repoRoot, session.slug);
  const flowId =
    String(state.flow_id ?? session.flow_id).trim() || session.flow_id;
  return flowStep(loadFlowDefinition(flowId), String(state.stage ?? "")).id;
}

function simCommand(args: string[]): Record<string, unknown> {
  return {
    cmd: "loopo",
    args,
    display: ["loopo", ...args.map(shellQuote)].join(" "),
  };
}

function simNextCommand(repoRoot: string): Record<string, unknown> {
  return simCommand(["sim", "--repo", repoRoot, "--json", "@-"]);
}

function withGuidedEnvelope(input: {
  repoRoot: string;
  session: SimSession;
  output: Record<string, unknown>;
}): Record<string, unknown> {
  const state = questState(input.repoRoot, input.session.slug);
  const stage = String(state.stage ?? "");
  const flowId =
    String(state.flow_id ?? input.session.flow_id).trim() ||
    input.session.flow_id;
  const originalCommands =
    input.output.commands &&
    typeof input.output.commands === "object" &&
    !Array.isArray(input.output.commands)
      ? (input.output.commands as Record<string, unknown>)
      : {};
  return {
    repo: input.repoRoot,
    runtime: input.session.runtime,
    request: input.session.request,
    flow_id: flowId,
    slug: input.session.slug,
    current_stage: stage,
    done: stage === "archived",
    ...input.output,
    commands: {
      ...originalCommands,
      next: simNextCommand(input.repoRoot),
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
    env: simEnv(repoRoot),
    runtime,
    raw,
  });
  const envelope = hook.envelope;
  const output = hook.output;
  const reason = hook.reason
    ? (parseJsonText(hook.reason, "hook reason") as Record<string, unknown>)
    : null;
  if (reason) {
    savePendingCallback(repoRoot, {
      runtime,
      envelope,
      hook_output: output,
      reason,
    });
  } else {
    clearPendingCallback(repoRoot);
  }
  logEvent(repoRoot, {
    kind: "hook",
    runtime,
    envelope,
    hook_output: output,
  });
  return { envelope, output, reason };
}

function runHookMode(args: SimArgs): number {
  const raw = readJsonArg(args.json);
  const repoRoot = resolveRepoRoot(args.repo, raw);
  const runtime = resolveRuntime(args.runtime);
  const result = executeHook(repoRoot, runtime, raw);
  process.stdout.write(JSON.stringify(result.output, null, 2));
  return 0;
}

function runGuidedStart(args: SimArgs): number {
  if (!args.request) {
    throw new Error(
      'guided sim start requires a request, for example: loopo sim "loopo: build the app" --flow swe --runtime codex',
    );
  }
  const repoRoot = defaultRepoRoot(args.repo);
  const runtime = resolveRuntime(args.runtime);
  const request = normalizeRequestText(args.request);
  const flowId = resolveFlowId(args.flow);
  ensureFixtureRepo(repoRoot, runtime);
  setupSimulationHooks(repoRoot, runtime);
  resetSimulationArtifacts(repoRoot);
  const started = routeQuestInit({
    repoRoot,
    env: simEnv(repoRoot),
    runtime,
    request,
    flowId,
  });
  const session: SimSession = {
    schema_version: 1,
    profile: "interactive",
    repo_root: repoRoot,
    runtime,
    request,
    flow_id: flowId,
    slug: started.slug,
    started_at: new Date().toISOString(),
  };
  saveSession(repoRoot, session);
  logEvent(repoRoot, {
    kind: "start",
    runtime,
    request,
    flow_id: flowId,
    slug: started.slug,
  });
  process.stdout.write(
    JSON.stringify(
      withGuidedEnvelope({
        repoRoot,
        session,
        output: started.createOutput,
      }),
      null,
      2,
    ),
  );
  return 0;
}

function runGuidedContinuation(args: SimArgs): number {
  if (!args.json) {
    throw new Error("guided sim continuation requires --json <json|@file|@->");
  }
  const payload = readJsonArg(args.json);
  if (Object.keys(payload).length === 0) {
    throw new Error("guided sim continuation requires a non-empty JSON payload");
  }
  const repoRoot = resolveRepoRoot(args.repo, payload);
  const session = loadSession(repoRoot);
  if (!session) {
    throw new Error(`missing simulation session in ${simPath(repoRoot, SESSION_FILE)}`);
  }
  const requestedStep = currentFlowStepId(repoRoot, session);
  const proc = runLoopo(
    repoRoot,
    ["quest", "next", "--slug", session.slug, "--cwd", repoRoot, "--json", "@-"],
    payload,
  );
  if (proc.status !== 0) {
    throw new Error(proc.stderr || proc.stdout || "loopo quest next failed");
  }
  const output = parseJsonText(proc.stdout, "guided sim output");
  logEvent(repoRoot, {
    kind: "guided_step",
    runtime: session.runtime,
    requested_step: requestedStep,
    payload,
    response: output,
  });
  process.stdout.write(
    JSON.stringify(
      withGuidedEnvelope({
        repoRoot,
        session,
        output,
      }),
      null,
      2,
    ),
  );
  return 0;
}

function runGuidedMode(args: SimArgs): number {
  if (args.request) return runGuidedStart(args);
  return runGuidedContinuation(args);
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
      error.message.startsWith("unknown sim argument:")
    ) {
      console.error(error.message);
      return usage(1);
    }
    throw error;
  }
  if (args.legacyMode) {
    console.error(legacyModeError(args.legacyMode));
    return 1;
  }
  if (args.mode === "hook") return runHookMode(args);
  return runGuidedMode(args);
}

if (import.meta.main) {
  try {
    process.exit(runSimCli(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
