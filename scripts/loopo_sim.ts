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
import {
  appendJsonl,
  findLatestQuest,
  parseTasksYaml,
  questFiles,
} from "./loopo_core.ts";
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

type SimArgs = {
  mode: "hook" | "callback" | "start" | "next" | "status";
  repo: string | null;
  runtime: string | null;
  json: string | null;
  request: string | null;
  flow: string | null;
};

type CommandReason = {
  loopo?: boolean;
  command?: string;
  slug?: string;
  step?: string;
  state?: string;
  [key: string]: unknown;
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

function reasonSlug(repoRoot: string, reason: CommandReason): string {
  const explicit = String(reason.slug ?? "").trim();
  if (explicit) return explicit;
  const latest = findLatestQuest(repoRoot);
  return latest?.files.slug ?? "";
}

function usage(exitCode = 1): number {
  if (exitCode === 0) {
    console.log(
      "Usage: loopo sim <start|next|status|hook|callback> [--repo <path>] [--runtime <codex|gemini|copilot>] [--request <text>] [--flow <id>] [--json <json|@file|@->]",
    );
  } else {
    console.error(
      "Usage: loopo sim <start|next|status|hook|callback> [--repo <path>] [--runtime <codex|gemini|copilot>] [--request <text>] [--flow <id>] [--json <json|@file|@->]",
    );
  }
  return exitCode;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): SimArgs {
  let mode: SimArgs["mode"] = "hook";
  let repo: string | null = null;
  let runtime: string | null = null;
  let json: string | null = null;
  let request: string | null = null;
  let flow: string | null = null;
  const rest = [...argv];
  if (
    rest[0] &&
    ["hook", "callback", "start", "next", "status"].includes(rest[0])
  ) {
    mode = rest.shift() as SimArgs["mode"];
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
    else if (arg === "--request") request = rest[++i] ?? null;
    else if (arg?.startsWith("--request="))
      request = arg.slice("--request=".length);
    else if (arg === "--flow") flow = rest[++i] ?? null;
    else if (arg?.startsWith("--flow=")) flow = arg.slice("--flow=".length);
    else if (arg === "--help" || arg === "-h") throw new Error("__SIM_HELP__");
    else throw new Error(`unknown sim argument: ${arg}`);
  }
  return { mode, repo, runtime, json, request, flow };
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

function normalizeRequestText(request: string | null): string {
  const raw = String(request ?? "build me a python app").trim();
  return /^loopo:/i.test(raw) ? raw : `loopo: ${raw}`;
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

function loadPendingCallback(repoRoot: string): Record<string, unknown> | null {
  const pending = readJson(simPath(repoRoot, PENDING_CALLBACK_FILE));
  return pending && typeof pending === "object"
    ? (pending as Record<string, unknown>)
    : null;
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

function currentStage(repoRoot: string, slug: string): string {
  return String(questState(repoRoot, slug).stage ?? "");
}

function questState(repoRoot: string, slug: string): QuestLikeState {
  const files = questFiles(repoRoot, slug);
  return parseTasksYaml(readText(files.tasks)) as QuestLikeState;
}

function callbackSlug(
  repoRoot: string,
  pending: Record<string, unknown> | null,
  payload: Record<string, unknown>,
): string {
  const payloadSlug = String(payload.slug ?? "").trim();
  if (payloadSlug) return payloadSlug;
  const pendingReason =
    pending?.reason && typeof pending.reason === "object"
      ? (pending.reason as CommandReason)
      : null;
  const pendingSlug = pendingReason ? reasonSlug(repoRoot, pendingReason) : "";
  if (pendingSlug) return pendingSlug;
  const sessionSlug = String(loadSession(repoRoot)?.slug ?? "").trim();
  if (sessionSlug) return sessionSlug;
  const latest = findLatestQuest(repoRoot);
  return latest?.files.slug ?? "";
}

function executeHook(
  repoRoot: string,
  runtime: Runtime,
  raw: Record<string, unknown>,
): {
  envelope: Record<string, unknown>;
  output: Record<string, unknown>;
  reason: CommandReason | null;
} {
  const hook = readSupervisorHookDecision({
    repoRoot,
    env: simEnv(repoRoot),
    runtime,
    raw,
  });
  const envelope = hook.envelope;
  const output = hook.output;
  const reasonText = hook.reason ?? "";
  if (reasonText) {
    const reason = parseJsonText(reasonText, "hook reason") as CommandReason;
    savePendingCallback(repoRoot, {
      runtime,
      envelope,
      hook_output: output,
      reason,
    });
    logEvent(repoRoot, {
      kind: "hook",
      runtime,
      envelope,
      hook_output: output,
    });
    return { envelope, output, reason };
  } else {
    clearPendingCallback(repoRoot);
  }
  logEvent(repoRoot, {
    kind: "hook",
    runtime,
    envelope,
    hook_output: output,
  });
  return { envelope, output, reason: null };
}

function executeCallback(
  repoRoot: string,
  raw: Record<string, unknown>,
): {
  reason: CommandReason | null;
  payload: Record<string, unknown>;
  output: Record<string, unknown>;
} {
  if (Object.keys(raw).length === 0) {
    fail(
      "callback requires an explicit quest-next payload via --json or stdin",
    );
  }
  const pending = loadPendingCallback(repoRoot);
  const reason =
    pending?.reason && typeof pending.reason === "object"
      ? (pending.reason as CommandReason)
      : null;
  const slug = callbackSlug(repoRoot, pending, raw);
  if (!slug) fail("callback requires a quest slug or a pending hook reason");
  const payload = raw;
  const proc = runLoopo(
    repoRoot,
    ["quest", "next", "--slug", slug, "--cwd", repoRoot, "--json", "@-"],
    payload,
  );
  if (proc.status !== 0) {
    throw new Error(proc.stderr || proc.stdout || "loopo quest next failed");
  }
  const output = parseJsonText(proc.stdout, "callback output");
  clearPendingCallback(repoRoot);
  logEvent(repoRoot, {
    kind: "callback",
    request: reason,
    payload,
    response: output,
  });
  return { reason, payload, output };
}

function runHookMode(args: SimArgs): number {
  const raw = readJsonArg(args.json);
  const repoRoot = resolveRepoRoot(args.repo, raw);
  const runtime = resolveRuntime(args.runtime);
  const result = executeHook(repoRoot, runtime, raw);
  process.stdout.write(JSON.stringify(result.output, null, 2));
  return 0;
}

function runCallbackMode(args: SimArgs): number {
  const raw = readJsonArg(args.json);
  const repoRoot = resolveRepoRoot(args.repo, raw);
  const result = executeCallback(repoRoot, raw);
  process.stdout.write(JSON.stringify(result.output, null, 2));
  return 0;
}

function runStartMode(args: SimArgs): number {
  const repoRoot = defaultRepoRoot(args.repo);
  const runtime = resolveRuntime(args.runtime);
  const request = normalizeRequestText(args.request);
  const flowId = String(args.flow ?? "swe").trim() || "swe";
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
  saveSession(repoRoot, {
    schema_version: 1,
    profile: "interactive",
    repo_root: repoRoot,
    runtime,
    request,
    flow_id: flowId,
    slug: started.slug,
    started_at: new Date().toISOString(),
  });
  process.stdout.write(
    JSON.stringify(
      {
        action: "start",
        repo: repoRoot,
        runtime,
        request,
        flow_id: flowId,
        slug: started.slug,
        current_stage: currentStage(repoRoot, started.slug),
        init_route: started.route,
        create_input: started.createInput,
        create_output: started.createOutput,
        current_output: started.createOutput,
        files: {
          session_json: simPath(repoRoot, SESSION_FILE),
          events_jsonl: simPath(repoRoot, EVENT_LOG_FILE),
        },
      },
      null,
      2,
    ),
  );
  return 0;
}

function runStatusMode(args: SimArgs): number {
  const repoRoot = resolveRepoRoot(args.repo, null);
  const session = loadSession(repoRoot);
  if (!session)
    fail(`missing simulation session in ${simPath(repoRoot, SESSION_FILE)}`);
  const stage = currentStage(repoRoot, session.slug);
  process.stdout.write(
    JSON.stringify(
      {
        action: "status",
        repo: repoRoot,
        runtime: session.runtime,
        request: session.request,
        slug: session.slug,
        current_stage: stage,
        pending_callback: loadPendingCallback(repoRoot),
        done: stage === "archived",
      },
      null,
      2,
    ),
  );
  return 0;
}

function runNextMode(args: SimArgs): number {
  const repoRoot = resolveRepoRoot(args.repo, null);
  const session = loadSession(repoRoot);
  if (!session)
    fail(`missing simulation session in ${simPath(repoRoot, SESSION_FILE)}`);
  const beforeStage = currentStage(repoRoot, session.slug);
  const hookInput = {
    hook_event_name: session.runtime === "gemini" ? "AfterAgent" : "Stop",
    cwd: repoRoot,
  };
  const hook = executeHook(repoRoot, session.runtime, hookInput);
  const afterStage = currentStage(repoRoot, session.slug);
  process.stdout.write(
    JSON.stringify(
      {
        action: "next",
        repo: repoRoot,
        runtime: session.runtime,
        request: session.request,
        slug: session.slug,
        before_stage: beforeStage,
        hook_input: hookInput,
        hook_output: hook.output,
        reason_payload: hook.reason,
        requires_input: Boolean(hook.reason),
        after_stage: afterStage,
        done: afterStage === "archived",
      },
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
      error.message.startsWith("unknown sim argument:")
    ) {
      console.error(error.message);
      return usage(1);
    }
    throw error;
  }
  if (args.mode === "start") return runStartMode(args);
  if (args.mode === "next") return runNextMode(args);
  if (args.mode === "status") return runStatusMode(args);
  if (args.mode === "callback") return runCallbackMode(args);
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
