import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, tsRunner, type RunResult } from "./loopship_utils.ts";

export type Runtime = "codex" | "gemini" | "copilot";

export type HookDecision = {
  envelope: Record<string, unknown>;
  output: Record<string, unknown>;
  reason: string | null;
  proc: RunResult;
};

export type InitRouteResult = {
  init: RunResult;
  route: Record<string, unknown>;
  routeProc: RunResult;
  createInput: Record<string, unknown> | null;
  createOutput: Record<string, unknown>;
  wtree: string;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOOPSHIP_SCRIPT = resolve(SCRIPT_DIR, "loopship.ts");
export const DEFAULT_RUNTIME_REQUEST =
  "loopship: build a tiny python cli named greet using argparse. Accept a required --name flag, print exactly 'hello, <name>!', add one pytest test, keep files minimal, and finish the full lifecycle without asking questions unless a safety-critical ambiguity blocks progress.";

function fail(message: string): never {
  throw new Error(message);
}

export function parseJsonObject(
  text: string,
  label: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch {
    fail(`expected JSON for ${label}: ${text}`);
  }
}

export function hookEventName(runtime: Runtime): string {
  return runtime === "gemini" ? "AfterAgent" : "Stop";
}

export function runLoopshipCommand(
  repoRoot: string,
  env: Record<string, string | undefined>,
  args: string[],
  input?: Record<string, unknown>,
  timeoutMs = 60_000,
): RunResult {
  const launch = tsRunner(LOOPSHIP_SCRIPT, args);
  return runCommand(launch.cmd, launch.args, {
    cwd: repoRoot,
    env,
    input: input ? JSON.stringify(input) : undefined,
    timeoutMs,
  });
}

export function normalizeHookEnvelope(
  raw: Record<string, unknown>,
  runtime: Runtime,
  repoRoot: string,
): Record<string, unknown> {
  if (raw.command === "hook") return raw;
  return {
    version: "2",
    request_id: `hook-${Date.now().toString(36)}`,
    command: "hook",
    context: {
      runtime,
      cwd: repoRoot,
    },
    metadata: {},
    payload: raw,
  };
}

export function nativeInitWtree(
  route: Record<string, unknown>,
  repoRoot: string,
): string | null {
  const nextCall =
    route.nextCall && typeof route.nextCall === "object" && !Array.isArray(route.nextCall)
      ? (route.nextCall as Record<string, unknown>)
      : {};
  const args =
    nextCall.args && typeof nextCall.args === "object" && !Array.isArray(nextCall.args)
      ? (nextCall.args as Record<string, unknown>)
      : {};
  const workspaceRoot = String(args.workspaceRoot ?? "").trim();
  if (!workspaceRoot) return null;
  const workspace = resolve(workspaceRoot);
  if (dirname(workspace) !== resolve(repoRoot, "worktrees")) {
    throw new Error(`native init returned a non-canonical worktree: ${workspace}`);
  }
  return basename(workspace);
}

export function readHookDecision(params: {
  repoRoot: string;
  env: Record<string, string | undefined>;
  runtime: Runtime;
  raw?: Record<string, unknown>;
  cwd?: string;
  timeoutMs?: number;
}): HookDecision {
  const raw =
    params.raw ?? {
      hook_event_name: hookEventName(params.runtime),
      cwd: params.cwd ?? params.repoRoot,
    };
  const envelope = normalizeHookEnvelope(raw, params.runtime, params.repoRoot);
  const proc = runLoopshipCommand(
    params.repoRoot,
    params.env,
    ["hook", "--json", "@-"],
    envelope,
    params.timeoutMs,
  );
  if (proc.status !== 0) {
    fail(proc.stderr || proc.stdout || "loopship hook failed");
  }
  const output = parseJsonObject(proc.stdout || "{}", "hook output");
  const reason =
    typeof output.reason === "string" && output.reason.trim()
      ? output.reason.trim()
      : null;
  return { envelope, output, reason, proc };
}

export function routeQuestInit(params: {
  repoRoot: string;
  env: Record<string, string | undefined>;
  runtime: Runtime;
  request: string;
  flowId?: string | null;
  wtree?: string | null;
  timeoutMs?: number;
}): InitRouteResult {
  const initArgs = [
    "init",
    params.request,
    "--runtime",
    params.runtime,
  ];
  const flowId = String(params.flowId ?? "").trim();
  if (flowId) {
    initArgs.push("--flow", flowId);
  }
  const requestedWtree = String(params.wtree ?? "").trim();
  if (requestedWtree) {
    initArgs.push("--wtree", requestedWtree);
  }
  const init = runLoopshipCommand(
    params.repoRoot,
    params.env,
    initArgs,
    undefined,
    params.timeoutMs,
  );
  if (init.status !== 0) {
    fail(init.stderr || init.stdout || "loopship init failed");
  }
  const route = parseJsonObject(init.stdout, "init output");
  const newQuest =
    route.new_quest && typeof route.new_quest === "object"
      ? (route.new_quest as Record<string, unknown>)
      : {};
  const nativeWtree = nativeInitWtree(route, params.repoRoot);
  const wtree = String(newQuest.suggested_wtree ?? nativeWtree ?? "").trim();
  if (!wtree) fail(`missing wtree in init output: ${init.stdout}`);

  if (!Object.keys(newQuest).length) {
    return {
      init,
      route,
      routeProc: init,
      createInput: null,
      createOutput: route,
      wtree,
    };
  }

  const createInput =
    newQuest.input && typeof newQuest.input === "object"
      ? (newQuest.input as Record<string, unknown>)
      : null;
  const command =
    newQuest.command && typeof newQuest.command === "object"
      ? (newQuest.command as Record<string, unknown>)
      : {};
  const cmd = command.cmd;
  const args = command.args;
  if (
    typeof cmd !== "string" ||
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string")
  ) {
    fail("loopship init did not emit a runnable new_quest.command");
  }
  const routeCmd =
    cmd === "loopship" &&
    typeof params.env.LOOPSHIP_GLOBAL_BIN === "string" &&
    params.env.LOOPSHIP_GLOBAL_BIN.trim()
      ? resolve(params.env.LOOPSHIP_GLOBAL_BIN)
      : cmd;

  const routeProc = runCommand(routeCmd, args, {
    cwd: params.repoRoot,
    env: params.env,
    timeoutMs: params.timeoutMs ?? 60_000,
  });
  if (routeProc.status !== 0) {
    fail(routeProc.stderr || routeProc.stdout || "new_quest.command failed");
  }

  return {
    init,
    route,
    routeProc,
    createInput,
    createOutput: parseJsonObject(routeProc.stdout, "route output"),
    wtree,
  };
}
