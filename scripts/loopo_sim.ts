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
const DRIVER_STATE_FILE = join(SIM_DIR, "driver-state.json");
const EVENT_LOG_FILE = join(SIM_DIR, "events.jsonl");
const SESSION_FILE = join(SIM_DIR, "session.json");

type Runtime = "codex" | "gemini" | "copilot";
type SimProfile = "runtime_lifecycle" | "product_quest";

type SimArgs = {
  mode: "hook" | "callback" | "start" | "next" | "status";
  repo: string | null;
  runtime: string | null;
  json: string | null;
  request: string | null;
  flow: string | null;
};

type SimState = {
  callback_count: number;
  plan_round: number;
  landing_round: number;
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

const CHILD_DONE_STATUSES = new Set([
  "child_archived",
  "child_merged",
  "done",
  "merged",
]);

function stepId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const id = (value as Record<string, unknown>).id;
    return typeof id === "string" ? id.trim() : "";
  }
  return "";
}

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

function simEnv(repoRoot: string): Record<string, string> {
  return {
    LOOPO_GLOBAL_BIN: resolve(repoRoot, SIM_DIR, "bin", "loopo"),
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

function loadSimState(repoRoot: string): SimState {
  const parsed = readJson(simPath(repoRoot, DRIVER_STATE_FILE));
  if (!parsed || typeof parsed !== "object") {
    return { callback_count: 0, plan_round: 0, landing_round: 0 };
  }
  return {
    callback_count: Number(parsed.callback_count ?? 0) || 0,
    plan_round: Number(parsed.plan_round ?? 0) || 0,
    landing_round: Number(parsed.landing_round ?? 0) || 0,
  };
}

function saveSimState(repoRoot: string, state: SimState): void {
  writeJson(simPath(repoRoot, DRIVER_STATE_FILE), state);
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

function setupSimulationHooks(repoRoot: string): void {
  const launch = tsRunner(SETUP_RUNTIME_HOOKS_SCRIPT, [
    "--repo",
    repoRoot,
    "--runtime",
    "all",
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

function currentCompactOutput(
  repoRoot: string,
  slug: string,
): Record<string, unknown> {
  const proc = runLoopo(
    repoRoot,
    ["quest", "next", "--slug", slug, "--cwd", repoRoot, "--json", "@-"],
    {},
  );
  if (proc.status !== 0) fail(proc.stderr || proc.stdout);
  return parseJsonText(proc.stdout, "current compact output");
}

function questState(repoRoot: string, slug: string): QuestLikeState {
  const files = questFiles(repoRoot, slug);
  return parseTasksYaml(readText(files.tasks)) as QuestLikeState;
}

function readyTask(state: QuestLikeState) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const done = new Set(
    tasks
      .filter((task) => CHILD_DONE_STATUSES.has(String(task.status ?? "")))
      .map((task) => String(task.id)),
  );
  return (
    tasks.find((task) => {
      const status = String(task.status ?? "child_received");
      if (!["child_received", "pending", "ready"].includes(status)) {
        return false;
      }
      const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
      return deps.every((dep) => done.has(String(dep)));
    }) ?? null
  );
}

function questRequest(repoRoot: string, quest: QuestLikeState): string {
  const session = loadSession(repoRoot);
  const request = String(session?.request ?? quest.prompt ?? "").trim();
  return request || "loopo: build me a python app";
}

function productQuestScope(request: string): string {
  const cleaned = request.replace(/^loopo:\s*/i, "").trim();
  if (/python/i.test(cleaned) && /\bapp\b/i.test(cleaned)) {
    return "Build a small Python app from a vague request";
  }
  return cleaned || "Build an app from a vague request";
}

function buildProductQuestPayload(
  repoRoot: string,
  slug: string,
  quest: QuestLikeState,
  step: string,
  state: SimState,
): Record<string, unknown> {
  const request = questRequest(repoRoot, quest);
  const scope = productQuestScope(request);
  switch (step) {
    case "plan":
      if (state.plan_round === 0) {
        state.plan_round += 1;
        return {
          step: "plan",
          classification: "greenfield_app",
          scope,
          high_impact_unknowns: [
            "delivery surface",
            "state model",
            "success criteria",
          ],
          questions: [
            {
              id: "delivery_surface",
              question: "Should the Python app default to CLI or web?",
              impact:
                "Determines package layout, entrypoints, and verification.",
            },
            {
              id: "state_model",
              question:
                "Should the app assume local file storage or in-memory state?",
              impact: "Changes persistence design and test coverage.",
            },
            {
              id: "success_criteria",
              question:
                "What is the smallest definition of done for the first version?",
              impact: "Bounds scope before decomposition.",
            },
          ],
          af: {
            hidden_assumptions: [
              "The request omits product shape, storage, and acceptance boundaries.",
            ],
          },
          of: {
            procedure: [
              "clarify delivery shape",
              "default unresolved choices",
              "decompose implementation",
              "verify and land",
            ],
          },
          verification_targets: [
            "The first question round resolves the high-impact product choices.",
          ],
          task_graph: { tasks: [] },
        };
      }
      state.plan_round += 1;
      return {
        step: "plan",
        classification: "greenfield_app",
        scope,
        defaulted_unknowns: [
          "Default to a small CLI app with local JSON persistence and pytest coverage.",
        ],
        af: {
          hidden_assumptions: [
            "A CLI-first Python app is the lowest-risk default for a vague app request.",
          ],
        },
        of: {
          procedure: [
            "scaffold project",
            "implement core logic",
            "wire CLI surface",
            "add tests",
            "verify and land",
          ],
        },
        verification_targets: [
          "The Python CLI starts successfully.",
          "Core app behavior is covered by tests.",
          "Parallel child work is reconciled into one landed quest.",
        ],
        task_graph: {
          tasks: [
            {
              id: "t001",
              title: "Scaffold Python project",
              type: "coding",
              acceptance: ["Python project scaffold exists"],
              scope_files: ["pyproject.toml", "app/__init__.py", "app/main.py"],
              spec_refs: ["coding"],
              concurrency_group: "foundation",
            },
            {
              id: "t002",
              title: "Implement app core",
              type: "coding",
              acceptance: ["Core Python app behavior works"],
              dependencies: ["t001"],
              scope_files: ["app/core.py", "app/store.py"],
              spec_refs: ["coding"],
              concurrency_group: "core",
            },
            {
              id: "t003",
              title: "Wire CLI entrypoint",
              type: "coding",
              acceptance: ["CLI entrypoint runs and documents usage"],
              dependencies: ["t001"],
              scope_files: ["app/main.py", "README.md"],
              spec_refs: ["coding"],
              concurrency_group: "cli",
            },
            {
              id: "t004",
              title: "Add test coverage",
              type: "coding",
              acceptance: ["Pytest coverage validates core and CLI flows"],
              dependencies: ["t002", "t003"],
              scope_files: ["tests/test_core.py", "tests/test_cli.py"],
              spec_refs: ["coding"],
              concurrency_group: "tests",
            },
          ],
        },
      };
    case "questions":
      return {
        step: "questions",
        answers: [
          {
            question_id: "delivery_surface",
            answer: "Default to a CLI app for the first simulated version.",
          },
          {
            question_id: "state_model",
            answer:
              "Default to local JSON persistence for deterministic tests.",
          },
          {
            question_id: "success_criteria",
            answer:
              "Scaffold, runnable CLI, core behavior, and pytest coverage are enough for v1.",
          },
        ],
      };
    case "task_graph":
      return { step: "task_graph", approved: true };
    case "executing": {
      const task = readyTask(quest);
      if (!task) fail(`no ready child task for slug ${slug}`);
      return {
        step: "child_result",
        task_id: task.id,
        child_slug: task.child_slug,
        status: "passed",
        merge_commit: `sim-${task.id}-merge`,
        evidence: [
          {
            type: "summary",
            ref: task.scope_files[0] || `${task.id}.txt`,
            summary: `${task.title} simulated successfully`,
          },
        ],
        merge_commit: `sim-${task.id.toLowerCase()}`,
      };
    }
    case "validation":
      return {
        step: "validation",
        status: "passed",
        checks: [
          { name: "simulated-pytest", status: "passed" },
          { name: "simulated-cli-smoke", status: "passed" },
        ],
      };
    case "verification":
      return {
        step: "verification",
        status: "passed",
        acceptance_trace: (Array.isArray(quest.tasks) ? quest.tasks : []).map(
          (task) => ({
            acceptance: task.acceptance || task.title || task.id,
            status: "passed",
          }),
        ),
        risks: [],
      };
    case "system_update":
      return {
        step: "system_update",
        system_update: {
          schema_version: 1,
          updates: [
            {
              doc_id: "architecture",
              summary: "simulated Python app lifecycle completed end to end",
            },
          ],
        },
      };
    case "landing":
      if (state.landing_round === 0) {
        state.landing_round += 1;
        return {
          step: "landing",
          status: "blocked",
          summary: "waiting for simulated final merge",
        };
      }
      state.landing_round += 1;
      return {
        step: "landing",
        status: "landed",
        summary: "simulated Python app landed the quest",
      };
    default:
      fail(`unsupported callback step: ${step || "(empty)"}`);
  }
}

function buildCallbackPayload(
  repoRoot: string,
  reason: CommandReason,
  state: SimState,
): Record<string, unknown> {
  const slug = reasonSlug(repoRoot, reason);
  if (!slug) fail("callback reason is missing slug");
  const quest = questState(repoRoot, slug);
  const step = stepId(reason.step);
  const session = loadSession(repoRoot);
  if (session?.profile === "product_quest") {
    return buildProductQuestPayload(repoRoot, slug, quest, step, state);
  }
  switch (step) {
    case "plan":
      if (state.plan_round === 0) {
        state.plan_round += 1;
        return {
          step: "plan",
          classification: "greenfield_app",
          scope: "runtime simulation environment",
          high_impact_unknowns: ["runtime callback policy"],
          questions: [
            {
              id: "runtime_callback_policy",
              question: "How should hook continuations be simulated?",
              impact:
                "Determines whether the fake runtime auto-drives callbacks.",
            },
          ],
          af: {
            hidden_assumptions: [
              "A deterministic callback driver is enough for integration coverage.",
            ],
          },
          of: { procedure: ["clarify", "decompose", "verify", "land"] },
          verification_targets: ["callback policy is explicit"],
          task_graph: { tasks: [] },
        };
      }
      state.plan_round += 1;
      return {
        step: "plan",
        classification: "greenfield_app",
        scope: "runtime simulation environment",
        defaulted_unknowns: [
          "Callbacks are auto-driven by the fake runtime during tests.",
        ],
        af: {
          hidden_assumptions: [
            "Two child fixtures are enough to cover hook and callback behavior.",
          ],
        },
        of: {
          procedure: [
            "dispatch hook fixture",
            "dispatch callback fixture",
            "verify lifecycle",
            "land",
          ],
        },
        verification_targets: [
          "hook lifecycle reaches archive",
          "callback lifecycle reaches archive",
        ],
        task_graph: {
          tasks: [
            {
              id: "T001",
              title: "Build runtime hook fixture",
              type: "coding",
              acceptance: ["runtime hook fixture works"],
              scope_files: ["hook-fixture.txt"],
              spec_refs: ["coding"],
              concurrency_group: "hook",
            },
            {
              id: "T002",
              title: "Build runtime callback fixture",
              type: "coding",
              acceptance: ["runtime callback fixture works"],
              scope_files: ["callback-fixture.txt"],
              spec_refs: ["coding"],
              concurrency_group: "callback",
            },
          ],
        },
      };
    case "questions":
      return {
        step: "questions",
        answers: [
          {
            question_id: "runtime_callback_policy",
            answer: "Drive callbacks automatically inside the simulation CLI.",
          },
        ],
      };
    case "task_graph":
      return { step: "task_graph", approved: true };
    case "executing": {
      const task = readyTask(quest);
      if (!task) fail(`no ready child task for slug ${slug}`);
      return {
        step: "child_result",
        task_id: task.id,
        child_slug: task.child_slug,
        status: "passed",
        merge_commit: `sim-${task.id}-merge`,
        evidence: [
          {
            type: "summary",
            ref: task.scope_files[0] || `${task.id}.txt`,
          },
        ],
        merge_commit: `sim-${task.id}`,
      };
    }
    case "validation":
      return {
        step: "validation",
        status: "passed",
        checks: [{ name: "simulated-lifecycle", status: "passed" }],
      };
    case "verification":
      return {
        step: "verification",
        status: "passed",
        acceptance_trace: (Array.isArray(quest.tasks) ? quest.tasks : []).map(
          (task) => ({
            acceptance: task.acceptance || task.title || task.id,
            status: "passed",
          }),
        ),
        risks: [],
      };
    case "system_update":
      return {
        step: "system_update",
        system_update: {
          schema_version: 1,
          updates: [
            {
              doc_id: "architecture",
              summary: "runtime simulator completed the full hook lifecycle",
            },
          ],
        },
      };
    case "landing":
      if (state.landing_round === 0) {
        state.landing_round += 1;
        return {
          step: "landing",
          status: "blocked",
          summary: "waiting for simulated final merge",
        };
      }
      state.landing_round += 1;
      return {
        step: "landing",
        status: "landed",
        summary: "simulated runtime landed the quest",
      };
    default:
      fail(`unsupported callback step: ${step || "(empty)"}`);
  }
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
  reason: CommandReason;
  payload: Record<string, unknown>;
  output: Record<string, unknown>;
} {
  const pending =
    Object.keys(raw).length > 0 ? raw : (loadPendingCallback(repoRoot) ?? {});
  const reason = (() => {
    const candidate =
      pending.reason && typeof pending.reason === "object"
        ? (pending.reason as Record<string, unknown>)
        : pending;
    return candidate as CommandReason;
  })();
  const slug = reasonSlug(repoRoot, reason);
  if (!slug) fail("callback requires a pending reason with slug");
  const state = loadSimState(repoRoot);
  const payload = buildCallbackPayload(repoRoot, reason, state);
  const proc = runLoopo(
    repoRoot,
    ["quest", "next", "--slug", slug, "--cwd", repoRoot, "--json", "@-"],
    payload,
  );
  if (proc.status !== 0) {
    throw new Error(proc.stderr || proc.stdout || "loopo quest next failed");
  }
  const output = parseJsonText(proc.stdout, "callback output");
  state.callback_count += 1;
  saveSimState(repoRoot, state);
  clearPendingCallback(repoRoot);
  logEvent(repoRoot, {
    kind: "callback",
    request: reason,
    payload,
    response: output,
  });
  return { reason, payload, output };
}

export function runSimulatedAssistantTurn(
  repoRoot: string,
  reasonText: string,
): {
  reason: CommandReason;
  payload: Record<string, unknown>;
  output: Record<string, unknown>;
} {
  const reason = parseJsonText(reasonText, "hook reason");
  return executeCallback(repoRoot, reason);
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
  const started = routeQuestInit({
    repoRoot,
    env: simEnv(repoRoot),
    runtime,
    request,
    flowId,
  });
  setupSimulationHooks(repoRoot);
  saveSession(repoRoot, {
    schema_version: 1,
    profile: "product_quest",
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
  const current = currentCompactOutput(repoRoot, session.slug);
  process.stdout.write(
    JSON.stringify(
      {
        action: "status",
        repo: repoRoot,
        runtime: session.runtime,
        request: session.request,
        slug: session.slug,
        current_stage: currentStage(repoRoot, session.slug),
        callback_count: loadSimState(repoRoot).callback_count,
        pending_callback: loadPendingCallback(repoRoot),
        current_output: current,
        done: currentStage(repoRoot, session.slug) === "archived",
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
  let callbackInput: Record<string, unknown> | null = null;
  let callbackOutput: Record<string, unknown> | null = null;
  if (hook.reason) {
    const callback = executeCallback(repoRoot, {});
    callbackInput = callback.payload;
    callbackOutput = callback.output;
  }
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
        callback_input: callbackInput,
        callback_output: callbackOutput,
        after_stage: afterStage,
        done: afterStage === "archived",
        callback_count: loadSimState(repoRoot).callback_count,
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
