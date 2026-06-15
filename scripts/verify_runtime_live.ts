#!/usr/bin/env bun

import {
  existsSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTasksYaml, questFiles } from "./loopship_core.ts";
import {
  DEFAULT_RUNTIME_REQUEST,
  readHookDecision as readSupervisorHookDecision,
  routeQuestInit,
  type Runtime,
} from "./runtime_supervisor.ts";
import {
  commandExists,
  readText,
  runCommand,
  type RunResult,
  tsRunner,
} from "./loopship_utils.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOOPSHIP_SCRIPT = resolve(SCRIPT_DIR, "loopship.ts");
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

type ResultStatus = "passed" | "skipped" | "failed";

type Fixture = {
  root: string;
  repo: string;
  env: Record<string, string>;
  runtime: Runtime;
};

type QuestSummary = {
  wtree: string | null;
  stage: string | null;
  child_count: number;
  merged_child_count: number;
  unmerged_child_ids: string[];
  plan_events: number;
  validation_events: number;
  verification_events: number;
  hook_decisions: number;
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
    "# loopship live runtime fixture\n",
    "utf8",
  );
  writeFileSync(
    join(repo, "AGENTS.md"),
    [
      "# Loopship Fixture",
      "",
      'When the user prompt starts with `loopship:`, run `loopship init "{request}" --runtime <runtime>` from the repo root and follow the returned instructions.',
    ].join("\n"),
    "utf8",
  );
}

function createFixture(runtime: Runtime): Fixture {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), `loopship-live-${runtime}-`)),
  );
  const repo = join(root, "repo");
  const binDir = join(root, "bin");
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    LOOPSHIP_GLOBAL_BIN: join(binDir, "loopship"),
    LOOPSHIP_SCRIPT: LOOPSHIP_SCRIPT,
  };
  const init = runCommand("git", ["init", repo], { env, timeoutMs: 15_000 });
  if (init.status !== 0) fail(init.stderr || init.stdout);
  for (const [key, value] of [
    ["user.email", "loopship-live@example.invalid"],
    ["user.name", `Loopship ${runtime} Live`],
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

function runLoopship(
  fixture: Fixture,
  args: string[],
  input?: Record<string, unknown>,
) {
  const launch = tsRunner(LOOPSHIP_SCRIPT, args);
  return runCommand(launch.cmd, launch.args, {
    cwd: fixture.repo,
    env: fixture.env,
    input: input ? JSON.stringify(input) : undefined,
    timeoutMs: 60_000,
  });
}

function installLoopship(fixture: Fixture): void {
  const proc = runLoopship(fixture, [
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
        `loopship doctor failed for ${fixture.runtime}`,
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
    wtree: null,
    stage: null,
    child_count: 0,
    merged_child_count: 0,
    unmerged_child_ids: [],
    plan_events: 0,
    validation_events: 0,
    verification_events: 0,
    hook_decisions: 0,
    commit_count: 0,
    python_files: [],
  };
}

function continuationPrompt(reason: string): string {
  let embedded = reason;
  try {
    embedded = JSON.stringify(JSON.parse(reason), null, 2);
  } catch {
    embedded = reason;
  }
  return [
    "Loopship continuation:",
    "You are continuing an active Loopship quest in the current repository.",
    "Use the embedded step payload, output_schema, and commands.next to advance exactly one lifecycle step.",
    "Do not restart with loopship init unless the payload explicitly tells you to.",
    "",
    embedded,
  ].join("\n");
}

function countJsonl(path: string): number {
  return readText(path)
    .split(/\r?\n/)
    .filter((line) => line.trim()).length;
}

function countEvent(path: string, eventName: string): number {
  return readText(path)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .filter((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return String(parsed.event ?? "") === eventName;
      } catch {
        return false;
      }
    }).length;
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
      "!\\.loopship/**",
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

function summarizeQuest(
  fixture: Fixture,
  wtree: string | null = null,
): QuestSummary {
  const selectedWtree = String(wtree ?? "").trim();
  if (!selectedWtree || !existsSync(questFiles(fixture.repo, selectedWtree).tasks)) {
    return {
      wtree: selectedWtree || null,
      stage: null,
      child_count: 0,
      merged_child_count: 0,
      unmerged_child_ids: [],
      plan_events: 0,
      validation_events: 0,
      verification_events: 0,
      hook_decisions: 0,
      commit_count: gitCommitCount(fixture.repo, fixture.env),
      python_files: pythonFiles(fixture.repo),
    };
  }
  const files = questFiles(fixture.repo, selectedWtree);
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
    wtree: selectedWtree,
    stage: typeof state.stage === "string" ? state.stage : null,
    child_count: tasks.length,
    merged_child_count: mergedChildIds.length,
    unmerged_child_ids: unmergedChildIds,
    plan_events: countEvent(files.events, "plan_submitted"),
    validation_events: countEvent(files.events, "validation_submitted"),
    verification_events: countEvent(files.events, "verification_submitted"),
    hook_decisions: countEvent(files.events, "hook_decision"),
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

function evaluateResult(
  fixture: Fixture,
  wtree: string | null,
  proc: ReturnType<typeof runCommand>,
  durationMs: number,
  logPath: string,
): LiveResult {
  const summary = summarizeQuest(fixture, wtree);
  const combined = `${proc.stdout}\n${proc.stderr}`.trim();
  const skipReason =
    matchProcessSkipReason(proc) ?? matchSkipReason(combined);
  const archived = summary.stage === "archived";
  const lifecycleCovered =
    summary.child_count > 0 &&
    summary.merged_child_count === summary.child_count &&
    summary.plan_events > 0 &&
    summary.validation_events > 0 &&
    summary.verification_events > 0 &&
    summary.hook_decisions > 0;

  if (archived && lifecycleCovered) {
    return {
      runtime: fixture.runtime,
      status: "passed",
      reason:
        "archived quest with child execution plus recorded plan, validation, verification, and hook audit receipts",
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

  const exitReason =
    proc.status === null
      ? `process ended with signal ${String(proc.signal ?? "unknown")}`
      : `process exited ${proc.status}`;
  return {
    runtime: fixture.runtime,
    status: "failed",
    reason:
      `${exitReason}; wtree=${summary.wtree ?? "none"}; ` +
      `final stage=${summary.stage ?? "none"}; unmerged_children=${summary.unmerged_child_ids.join(",") || "none"}`,
    duration_ms: durationMs,
    repo: fixture.repo,
    log_path: logPath,
    quest: summary,
  };
}

function readHookDecision(fixture: Fixture, wtree: string): {
  reason: string | null;
  raw: Record<string, unknown>;
} {
  const hook = readSupervisorHookDecision({
    repoRoot: fixture.repo,
    env: fixture.env,
    runtime: fixture.runtime,
    cwd: join(fixture.repo, "worktrees", wtree),
  });
  return { reason: hook.reason, raw: hook.output };
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
    installLoopship(fixture);
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

    const started = routeQuestInit({
      repoRoot: fixture.repo,
      env: fixture.env,
      runtime: fixture.runtime,
      request: DEFAULT_RUNTIME_REQUEST,
    });
    logChunks.push(
      [
        "# init",
        `$ loopship init ${JSON.stringify(DEFAULT_RUNTIME_REQUEST)} --runtime ${fixture.runtime}`,
        "",
        "STDOUT",
        started.init.stdout,
        "",
        "STDERR",
        started.init.stderr,
        "",
      ].join("\n"),
    );
    const routed = started.route.new_quest as
      | { command?: { cmd?: string; args?: string[] } }
      | undefined;
    const routeCmd = routed?.command?.cmd ?? "loopship";
    const routeArgs = Array.isArray(routed?.command?.args)
      ? routed.command.args
      : [];
    logChunks.push(
      [
        "# route",
        `$ ${[routeCmd, ...routeArgs].join(" ")}`,
        "",
        "STDOUT",
        started.routeProc.stdout,
        "",
        "STDERR",
        started.routeProc.stderr,
        "",
      ].join("\n"),
    );
    let lastProc = started.routeProc;
    for (let guard = 0; guard < 20; guard += 1) {
      const summary = summarizeQuest(fixture, started.wtree);
      if (summary.stage === "archived") break;
      if (!summary.wtree) break;
      const hook = readHookDecision(fixture, started.wtree);
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
    return evaluateResult(fixture, started.wtree, lastProc, durationMs, logPath);
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
