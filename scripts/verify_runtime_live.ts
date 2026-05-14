#!/usr/bin/env bun

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findLatestQuest,
  loadState,
  parseTasksYaml,
  questFiles,
} from "./loopo_core.ts";
import {
  commandExists,
  readText,
  runCommand,
  type RunResult,
  tsRunner,
} from "./loopo_utils.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOOPO_SCRIPT = resolve(SCRIPT_DIR, "loopo.ts");
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const USER_REQUEST =
  "loopo: build a tiny python cli named greet using argparse. Accept a required --name flag, print exactly 'hello, <name>!', add one pytest test, keep files minimal, and finish the full lifecycle without asking questions unless a safety-critical ambiguity blocks progress.";

type Runtime = "codex" | "gemini" | "copilot";
type ResultStatus = "passed" | "skipped" | "failed";

type Fixture = {
  root: string;
  repo: string;
  env: Record<string, string>;
  runtime: Runtime;
};

type QuestSummary = {
  primary_slug: string | null;
  latest_slug: string | null;
  stage: string | null;
  child_count: number;
  merged_child_count: number;
  unmerged_child_ids: string[];
  plans: number;
  validations: number;
  reviews: number;
  handoffs: number;
  commit_count: number;
  python_files: string[];
};

type LiveResult = {
  runtime: Runtime;
  status: ResultStatus;
  reason: string;
  duration_ms: number;
  repo: string;
  log_path: string;
  quest: QuestSummary;
};

type ProcessLike = {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

function fail(message: string): never {
  throw new Error(message);
}

function usage(): number {
  console.log(
    "Usage: bun verify_runtime_live.ts [--runtime <codex|gemini|copilot|all>] [--timeout-ms <ms>] [--keep-fixtures]",
  );
  return 0;
}

function parseArgs(argv: string[]): {
  runtimes: Runtime[];
  timeoutMs: number;
  keepFixtures: boolean;
} {
  let requested: Runtime[] = [];
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let keepFixtures = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--runtime") {
      const value = argv[++i] ?? "all";
      if (value === "all") {
        requested = ["codex", "gemini", "copilot"];
      } else if (
        value === "codex" ||
        value === "gemini" ||
        value === "copilot"
      ) {
        requested.push(value);
      } else {
        throw new Error(`unsupported runtime: ${value}`);
      }
    } else if (arg === "--timeout-ms") {
      timeoutMs = Number(argv[++i] ?? "");
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("--timeout-ms must be a positive number");
      }
    } else if (arg === "--keep-fixtures") {
      keepFixtures = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return {
    runtimes: requested.length ? requested : ["codex", "gemini", "copilot"],
    timeoutMs,
    keepFixtures,
  };
}

function writeFixtureFiles(repo: string): void {
  writeFileSync(
    join(repo, "README.md"),
    "# loopo live runtime fixture\n",
    "utf8",
  );
  writeFileSync(
    join(repo, "AGENTS.md"),
    [
      "# Loopo Fixture",
      "",
      'When the user prompt starts with `loopo:`, run `loopo init "{request}" --cwd <cwd> --runtime <runtime>` and follow the returned instructions.',
    ].join("\n"),
    "utf8",
  );
}

function createFixture(runtime: Runtime): Fixture {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), `loopo-live-${runtime}-`)),
  );
  const repo = join(root, "repo");
  const binDir = join(root, "bin");
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    LOOPO_GLOBAL_BIN: join(binDir, "loopo"),
    LOOPO_SCRIPT: LOOPO_SCRIPT,
  };
  const init = runCommand("git", ["init", repo], { env, timeoutMs: 15_000 });
  if (init.status !== 0) fail(init.stderr || init.stdout);
  for (const [key, value] of [
    ["user.email", "loopo-live@example.invalid"],
    ["user.name", `Loopo ${runtime} Live`],
  ] as const) {
    const proc = runCommand("git", ["config", key, value], {
      cwd: repo,
      env,
      timeoutMs: 15_000,
    });
    if (proc.status !== 0) fail(proc.stderr || proc.stdout);
  }
  writeFixtureFiles(repo);
  const add = runCommand("git", ["add", "README.md", "AGENTS.md"], {
    cwd: repo,
    env,
    timeoutMs: 15_000,
  });
  if (add.status !== 0) fail(add.stderr || add.stdout);
  const commit = runCommand("git", ["commit", "-m", "fixture"], {
    cwd: repo,
    env,
    timeoutMs: 15_000,
  });
  if (commit.status !== 0) fail(commit.stderr || commit.stdout);
  return { root, repo, env, runtime };
}

function runLoopo(
  fixture: Fixture,
  args: string[],
  input?: Record<string, unknown>,
) {
  const launch = tsRunner(LOOPO_SCRIPT, args);
  return runCommand(launch.cmd, launch.args, {
    cwd: fixture.repo,
    env: fixture.env,
    input: input ? JSON.stringify(input) : undefined,
    timeoutMs: 60_000,
  });
}

function installLoopo(fixture: Fixture): void {
  const proc = runLoopo(fixture, [
    "doctor",
    "--repo",
    fixture.repo,
    "--runtime",
    fixture.runtime,
    "--fix",
  ]);
  if (proc.status !== 0) {
    fail(
      proc.stderr ||
        proc.stdout ||
        `loopo doctor failed for ${fixture.runtime}`,
    );
  }
}

function runCommandWithHardTimeout(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    input?: string;
    timeoutMs?: number;
  } = {},
): RunResult {
  if (!commandExists("python3")) {
    return runCommand(cmd, args, opts);
  }

  const payload = {
    argv: [cmd, ...args],
    cwd: opts.cwd ?? null,
    env: opts.env ?? {},
    input: opts.input ?? "",
    timeout_ms: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const wrapper = `
import json, os, signal, subprocess, sys

payload = json.loads(sys.stdin.read())
env = os.environ.copy()
env.update(payload.get("env") or {})

try:
    proc = subprocess.Popen(
        payload["argv"],
        cwd=payload.get("cwd") or None,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
except FileNotFoundError as exc:
    print(json.dumps({
        "status": 127,
        "stdout": "",
        "stderr": str(exc),
        "signal": None,
        "timed_out": False,
        "error_message": str(exc),
    }))
    sys.exit(0)

try:
    stdout, stderr = proc.communicate(
        payload.get("input") or "",
        timeout=max(payload.get("timeout_ms", 0), 1) / 1000.0,
    )
    result = {
        "status": proc.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "signal": None,
        "timed_out": False,
    }
except subprocess.TimeoutExpired:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    stdout, stderr = proc.communicate()
    result = {
        "status": None,
        "stdout": stdout or "",
        "stderr": stderr or "",
        "signal": "SIGKILL",
        "timed_out": True,
        "error_message": "timed out",
    }

print(json.dumps(result))
  `.trim();

  const proc = runCommand("python3", ["-c", wrapper], {
    input: JSON.stringify(payload),
    timeoutMs: (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 30_000,
  });
  if (proc.status !== 0) {
    return proc;
  }

  try {
    const parsed = JSON.parse(proc.stdout) as Record<string, unknown>;
    const timedOut = parsed.timed_out === true;
    const errorMessage =
      typeof parsed.error_message === "string" ? parsed.error_message : "";
    return {
      status:
        typeof parsed.status === "number" ? (parsed.status as number) : null,
      stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
      stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
      signal:
        typeof parsed.signal === "string"
          ? (parsed.signal as NodeJS.Signals)
          : null,
      error: timedOut
        ? Object.assign(new Error(errorMessage || "timed out"), {
            code: "ETIMEDOUT",
          })
        : undefined,
    };
  } catch {
    return {
      status: proc.status,
      stdout: proc.stdout,
      stderr: proc.stderr,
      error: proc.error,
      signal: proc.signal,
    };
  }
}

function livePrompt(runtime: Runtime): string {
  return [
    "Loopo runtime contract:",
    `- You are using the ${runtime} CLI in a repository that uses Loopo v3.`,
    '- When the user request begins with `loopo:`, first run `loopo init "{request}" --cwd <cwd> --runtime <runtime>` from the repo root.',
    "- After init, advance exactly one lifecycle step using the returned payload and commands.next, then stop.",
    "- Do not try to complete the whole quest in one long CLI session; the harness will continue the quest by reinvoking you.",
    "- Do not bypass Loopo by implementing the work directly unless Loopo itself tells you to.",
    "- Make low-risk defaults only when no clarification round is needed.",
    "- If Loopo emits a clarification round, stop after asking it and wait for a human answer instead of auto-accepting defaults after asking.",
    "",
    "User request:",
    USER_REQUEST,
  ].join("\n");
}

export function cliInvocation(
  fixture: Fixture,
  prompt: string,
): { cmd: string; args: string[] } {
  if (fixture.runtime === "codex") {
    return {
      cmd: "codex",
      args: [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--color",
        "never",
        "-C",
        fixture.repo,
        prompt,
      ],
    };
  }
  if (fixture.runtime === "gemini") {
    return {
      cmd: "gemini",
      args: [
        "--prompt",
        prompt,
        "--skip-trust",
        "--yolo",
        "--output-format",
        "text",
      ],
    };
  }
  return {
    cmd: "copilot",
    args: [
      "-p",
      prompt,
      "--allow-all-tools",
      "--allow-all-paths",
      "--no-color",
      "--stream",
      "off",
    ],
  };
}

export function emptyQuestSummary(): QuestSummary {
  return {
    primary_slug: null,
    latest_slug: null,
    stage: null,
    child_count: 0,
    merged_child_count: 0,
    unmerged_child_ids: [],
    plans: 0,
    validations: 0,
    reviews: 0,
    handoffs: 0,
    commit_count: 0,
    python_files: [],
  };
}

function hookEventName(runtime: Runtime): string {
  return runtime === "gemini" ? "AfterAgent" : "Stop";
}

function continuationPrompt(reason: string): string {
  let embedded = reason;
  try {
    embedded = JSON.stringify(JSON.parse(reason), null, 2);
  } catch {
    embedded = reason;
  }
  return [
    "Loopo continuation:",
    "You are continuing an active Loopo quest in the current repository.",
    "Use the embedded step payload, callback_schema, and commands.next to advance exactly one lifecycle step.",
    "Do not restart with loopo init unless the payload explicitly tells you to.",
    "",
    embedded,
  ].join("\n");
}

function countJsonl(path: string): number {
  return readText(path)
    .split(/\r?\n/)
    .filter((line) => line.trim()).length;
}

function questMtime(repo: string, slug: string): number {
  const files = questFiles(repo, slug);
  return existsSync(files.tasks) ? statSync(files.tasks).mtimeMs : 0;
}

function auxiliaryQuestSlug(slug: string): boolean {
  return slug.startsWith("execute-child-task-");
}

function selectPrimaryQuestSlug(fixture: Fixture): {
  primarySlug: string | null;
  latestSlug: string | null;
} {
  const state = loadState(fixture.repo);
  const activeSlug = state.active_quest_slug;
  if (activeSlug && existsSync(questFiles(fixture.repo, activeSlug).tasks)) {
    const latest = findLatestQuest(fixture.repo);
    return {
      primarySlug: activeSlug,
      latestSlug: latest?.files.slug ?? activeSlug,
    };
  }

  const questsDir = join(fixture.repo, ".loopo", "quests");
  if (!existsSync(questsDir)) {
    return { primarySlug: null, latestSlug: null };
  }

  const slugs = readdirSync(questsDir).filter((slug) =>
    existsSync(questFiles(fixture.repo, slug).tasks),
  );
  const sorted = [...slugs].sort(
    (left, right) =>
      questMtime(fixture.repo, right) - questMtime(fixture.repo, left),
  );
  const latestSlug = sorted[0] ?? null;
  const rootSlug =
    sorted.find((slug) => !auxiliaryQuestSlug(slug)) ?? latestSlug;
  return { primarySlug: rootSlug, latestSlug };
}

function pythonFiles(repo: string): string[] {
  if (!commandExists("rg")) return [];
  const proc = runCommand(
    "rg",
    [
      "--files",
      "--glob",
      "!worktrees/**",
      "--glob",
      "!\\.loopo/**",
      "--glob",
      "*.py",
    ],
    { cwd: repo, timeoutMs: 10_000 },
  );
  if (proc.status !== 0) return [];
  return proc.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function gitCommitCount(repo: string, env: Record<string, string>): number {
  const proc = runCommand("git", ["rev-list", "--count", "HEAD"], {
    cwd: repo,
    env,
    timeoutMs: 10_000,
  });
  if (proc.status !== 0) return 0;
  const count = Number(proc.stdout.trim());
  return Number.isFinite(count) ? count : 0;
}

function summarizeQuest(fixture: Fixture): QuestSummary {
  const { primarySlug, latestSlug } = selectPrimaryQuestSlug(fixture);
  if (!primarySlug) {
    return {
      primary_slug: null,
      latest_slug: latestSlug,
      stage: null,
      child_count: 0,
      merged_child_count: 0,
      unmerged_child_ids: [],
      plans: 0,
      validations: 0,
      reviews: 0,
      handoffs: 0,
      commit_count: gitCommitCount(fixture.repo, fixture.env),
      python_files: pythonFiles(fixture.repo),
    };
  }
  const files = questFiles(fixture.repo, primarySlug);
  const state = parseTasksYaml(readText(files.tasks));
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const mergedChildIds = tasks
    .filter(
      (task) =>
        typeof task?.merge_commit === "string" &&
        task.merge_commit.trim() &&
        typeof task?.status === "string" &&
        (task.status === "child_archived" || task.status === "done"),
    )
    .map((task) => String(task.id));
  const unmergedChildIds = tasks
    .filter(
      (task) =>
        !(
          typeof task?.merge_commit === "string" &&
          task.merge_commit.trim() &&
          typeof task?.status === "string" &&
          (task.status === "child_archived" || task.status === "done")
        ),
    )
    .map((task) => String(task.id));
  return {
    primary_slug: primarySlug,
    latest_slug: latestSlug,
    stage: typeof state.stage === "string" ? state.stage : null,
    child_count: tasks.length,
    merged_child_count: mergedChildIds.length,
    unmerged_child_ids: unmergedChildIds,
    plans: countJsonl(files.plans),
    validations: countJsonl(files.validation),
    reviews: countJsonl(files.review),
    handoffs: countJsonl(files.handoffs),
    commit_count: gitCommitCount(fixture.repo, fixture.env),
    python_files: pythonFiles(fixture.repo),
  };
}

export function matchSkipReason(text: string): string | null {
  const patterns = [
    {
      label: "quota_or_rate_limit",
      re: /\b(quota|rate limit|429|resource[_ ]exhausted|too many requests|usage limit|limit exceeded)\b/i,
    },
    {
      label: "authentication_required",
      re: /\b(login|log in|sign in|authenticate|authentication|unauthorized|forbidden|not logged in|not signed in)\b/i,
    },
    {
      label: "runtime_unhealthy",
      re: /\b(unhealthy|service unavailable|temporarily unavailable|overloaded|capacity|internal server error|upstream error|engine is unavailable)\b/i,
    },
  ];
  for (const pattern of patterns) {
    if (pattern.re.test(text)) return pattern.label;
  }
  return null;
}

export function matchProcessSkipReason(proc: ProcessLike): string | null {
  const error = proc.error as (NodeJS.ErrnoException & Error) | undefined;
  if (error?.code === "ETIMEDOUT") return "runtime_timeout";
  if (proc.signal === "SIGKILL" && /\btimed out\b/i.test(error?.message ?? "")) {
    return "runtime_timeout";
  }
  if (proc.status === null && proc.signal === "SIGTERM" && error?.message) {
    if (/\b(timeout|timed out)\b/i.test(error.message)) {
      return "runtime_timeout";
    }
  }
  return null;
}

function matchFailureReason(text: string): string | null {
  const patterns = [
    {
      label: "model_not_supported",
      re: /\b(model_not_supported|requested model is not supported)\b/i,
    },
  ];
  for (const pattern of patterns) {
    if (pattern.re.test(text)) return pattern.label;
  }
  return null;
}

function evaluateResult(
  fixture: Fixture,
  proc: ReturnType<typeof runCommand>,
  durationMs: number,
  logPath: string,
): LiveResult {
  const summary = summarizeQuest(fixture);
  const combined = `${proc.stdout}\n${proc.stderr}`.trim();
  const skipReason =
    matchProcessSkipReason(proc) ?? matchSkipReason(combined);
  const archived = summary.stage === "archived";
  const lifecycleCovered =
    summary.child_count > 0 &&
    summary.merged_child_count === summary.child_count &&
    summary.plans > 0 &&
    summary.validations > 0 &&
    summary.reviews > 0 &&
    summary.handoffs > 0;

  if (archived && lifecycleCovered) {
    return {
      runtime: fixture.runtime,
      status: "passed",
      reason:
        "archived quest with child execution plus plan, review, validation, and landing receipts",
      duration_ms: durationMs,
      repo: fixture.repo,
      log_path: logPath,
      quest: summary,
    };
  }

  if (skipReason) {
    return {
      runtime: fixture.runtime,
      status: "skipped",
      reason: skipReason,
      duration_ms: durationMs,
      repo: fixture.repo,
      log_path: logPath,
      quest: summary,
    };
  }

  const failureReason = matchFailureReason(combined);
  if (failureReason) {
    return {
      runtime: fixture.runtime,
      status: "failed",
      reason: failureReason,
      duration_ms: durationMs,
      repo: fixture.repo,
      log_path: logPath,
      quest: summary,
    };
  }

  const exitReason =
    proc.status === null
      ? `process ended with signal ${String(proc.signal ?? "unknown")}`
      : `process exited ${proc.status}`;
  return {
    runtime: fixture.runtime,
    status: "failed",
    reason:
      `${exitReason}; primary=${summary.primary_slug ?? "none"}; latest=${summary.latest_slug ?? "none"}; ` +
      `final stage=${summary.stage ?? "none"}; unmerged_children=${summary.unmerged_child_ids.join(",") || "none"}`,
    duration_ms: durationMs,
    repo: fixture.repo,
    log_path: logPath,
    quest: summary,
  };
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readHookDecision(fixture: Fixture): {
  reason: string | null;
  raw: Record<string, unknown>;
} {
  const proc = runLoopo(fixture, ["hook", "--runtime", fixture.runtime], {
    cwd: fixture.repo,
    hook_event_name: hookEventName(fixture.runtime),
  });
  if (proc.status !== 0) {
    fail(
      proc.stderr || proc.stdout || `loopo hook failed for ${fixture.runtime}`,
    );
  }
  const payload = parseJson(proc.stdout || "{}") ?? {};
  const reason =
    typeof payload.reason === "string" && payload.reason.trim()
      ? payload.reason.trim()
      : null;
  return { reason, raw: payload };
}

export function runLiveRuntime(
  runtime: Runtime,
  timeoutMs: number,
  _keepFixtures: boolean,
): LiveResult {
  if (!commandExists(runtime)) {
    return {
      runtime,
      status: "skipped",
      reason: `${runtime}_command_unavailable`,
      duration_ms: 0,
      repo: "",
      log_path: "",
      quest: emptyQuestSummary(),
    };
  }

  const fixture = createFixture(runtime);
  try {
    installLoopo(fixture);
    const logChunks: string[] = [];
    const startedAt = Date.now();
    const runCliTurn = (prompt: string, label: string) => {
      const invocation = cliInvocation(fixture, prompt);
      const proc = runCommandWithHardTimeout(invocation.cmd, invocation.args, {
        cwd: fixture.repo,
        env: fixture.env,
        timeoutMs,
      });
      logChunks.push(
        [
          `# ${label}`,
          `$ ${[invocation.cmd, ...invocation.args].join(" ")}`,
          "",
          "STDOUT",
          proc.stdout,
          "",
          "STDERR",
          proc.stderr,
          "",
        ].join("\n"),
      );
      return proc;
    };

    let lastProc = runCliTurn(livePrompt(runtime), "initial");
    for (let guard = 0; guard < 20; guard += 1) {
      const summary = summarizeQuest(fixture);
      if (summary.stage === "archived") break;
      if (!summary.primary_slug) break;
      const hook = readHookDecision(fixture);
      logChunks.push(
        [`# hook-${guard + 1}`, JSON.stringify(hook.raw, null, 2), ""].join(
          "\n",
        ),
      );
      if (!hook.reason) break;
      lastProc = runCliTurn(
        continuationPrompt(hook.reason),
        `continuation-${guard + 1}`,
      );
      const skipReason =
        matchProcessSkipReason(lastProc) ??
        matchSkipReason(`${lastProc.stdout}\n${lastProc.stderr}`);
      if (skipReason) break;
    }

    const durationMs = Date.now() - startedAt;
    const logPath = join(fixture.root, `${runtime}.log`);
    writeFileSync(logPath, logChunks.join("\n"), "utf8");
    return evaluateResult(fixture, lastProc, durationMs, logPath);
  } catch (error) {
    return {
      runtime,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      duration_ms: 0,
      repo: fixture.repo,
      log_path: join(fixture.root, `${runtime}.log`),
      quest: summarizeQuest(fixture),
    };
  }
}

export function exitCodeForResults(results: LiveResult[]): number {
  const failed = results.filter((result) => result.status === "failed").length;
  return failed === 0 ? 0 : 1;
}

export function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const results = args.runtimes.map((runtime) =>
    runLiveRuntime(runtime, args.timeoutMs, args.keepFixtures),
  );
  console.log(JSON.stringify(results, null, 2));
  return exitCodeForResults(results);
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
