import { existsSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { readJson, writeJson } from "./loopship_utils.ts";

export type FastflowResumeHandle = {
  sessionId: string;
  nonce?: string;
  workspaceRoot: string;
  executionName?: string;
  progressMode?: string;
  kind?: string;
};

export type HookRouteState = {
  schema_version: 1;
  runtime: string;
  thread_id?: string;
  wtree: string;
  workspace_root: string;
  fastflow: FastflowResumeHandle;
  updated_at: string;
  [key: string]: unknown;
};

const THREAD_ENV_BY_RUNTIME: Record<string, string[]> = {
  codex: ["CODEX_THREAD_ID"],
  gemini: ["GEMINI_SESSION_ID"],
  claude: ["CLAUDE_CODE_SESSION_ID"],
  augment: ["AUGMENT_CONVERSATION_ID"],
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validWtree(value: string): boolean {
  return Boolean(value && value !== "." && value !== ".." && !/[\\/]/.test(value));
}

function worktreeDirectory(repoRoot: string, wtree: string): string | null {
  if (!validWtree(wtree)) return null;
  const worktreesRoot = resolve(repoRoot, "worktrees");
  const candidate = resolve(worktreesRoot, wtree);
  if (!existsSync(worktreesRoot) || !existsSync(candidate)) return null;
  try {
    const realRoot = realpathSync(worktreesRoot);
    if (realRoot !== resolve(realpathSync(repoRoot), "worktrees")) return null;
    const realCandidate = realpathSync(candidate);
    const path = relative(realRoot, realCandidate);
    return path === wtree ? realCandidate : null;
  } catch {
    return null;
  }
}

function statePath(repoRoot: string, wtree: string): string | null {
  const workspace = worktreeDirectory(repoRoot, wtree);
  return workspace
    ? resolve(workspace, ".loopship", "runtime", "hook-state.json")
    : null;
}

function readState(path: string): HookRouteState | null {
  const value = readJson(path) as Record<string, unknown> | null;
  if (!value) return null;
  const fastflow = objectValue(value.fastflow);
  const state: HookRouteState = {
    ...value,
    schema_version: 1,
    runtime: stringValue(value.runtime),
    wtree: stringValue(value.wtree),
    workspace_root: stringValue(value.workspace_root),
    fastflow: {
      sessionId: stringValue(fastflow.sessionId),
      workspaceRoot: stringValue(fastflow.workspaceRoot),
      ...(stringValue(fastflow.nonce) ? { nonce: stringValue(fastflow.nonce) } : {}),
      ...(stringValue(fastflow.executionName)
        ? { executionName: stringValue(fastflow.executionName) }
        : {}),
      ...(stringValue(fastflow.progressMode)
        ? { progressMode: stringValue(fastflow.progressMode) }
        : {}),
      ...(stringValue(fastflow.kind) ? { kind: stringValue(fastflow.kind) } : {}),
    },
    updated_at: stringValue(value.updated_at),
    ...(stringValue(value.thread_id) ? { thread_id: stringValue(value.thread_id) } : {}),
  };
  return state.runtime && state.wtree && state.workspace_root && state.fastflow.sessionId
    ? state
    : null;
}

function workspaceWtree(repoRoot: string, workspaceRoot: string): string | null {
  const worktreesRoot = resolve(repoRoot, "worktrees");
  if (!existsSync(worktreesRoot) || !existsSync(workspaceRoot)) return null;
  let path = "";
  try {
    path = relative(realpathSync(worktreesRoot), realpathSync(workspaceRoot));
  } catch {
    return null;
  }
  if (!path || path.startsWith("..") || isAbsolute(path)) return null;
  const [wtree, ...rest] = path.split(/[\\/]/);
  return validWtree(wtree ?? "") && rest.length === 0 && worktreeDirectory(repoRoot, wtree!)
    ? wtree!
    : null;
}

function validRouteWorkspace(repoRoot: string, state: HookRouteState): boolean {
  const expected = worktreeDirectory(repoRoot, state.wtree);
  return (
    Boolean(expected) &&
    resolve(state.workspace_root) === expected &&
    resolve(state.fastflow.workspaceRoot) === expected
  );
}

function fastflowResumeHandle(
  result: Record<string, unknown>,
  workspaceRoot?: string,
): FastflowResumeHandle | null {
  const nextCall = objectValue(result.nextCall);
  const args = objectValue(nextCall.args);
  const sessionId = stringValue(args.sessionId);
  const resolvedWorkspace = stringValue(args.workspaceRoot) || stringValue(workspaceRoot);
  if (!sessionId || !resolvedWorkspace) return null;
  return {
    sessionId,
    workspaceRoot: resolve(resolvedWorkspace),
    ...(stringValue(args.nonce) ? { nonce: stringValue(args.nonce) } : {}),
    ...(stringValue(args.executionName)
      ? { executionName: stringValue(args.executionName) }
      : {}),
    ...(stringValue(args.progressMode) ? { progressMode: stringValue(args.progressMode) } : {}),
    ...(stringValue(result.kind) ? { kind: stringValue(result.kind) } : {}),
  };
}

export function runtimeHookPayload(value: Record<string, unknown>): boolean {
  return Boolean(
    stringValue(value.hook_event_name) ||
      stringValue(value.hookEventName) ||
      stringValue(value.event_name) ||
      stringValue(value.eventName) ||
      stringValue(value.stopReason) ||
      stringValue(value.stop_reason) ||
      stringValue(value.terminationReason) ||
      (stringValue(value.cwd) && (value.timestamp !== undefined || value.source !== undefined)),
  );
}

export function runtimeHookThreadId(value: Record<string, unknown>): string {
  return (
    stringValue(value.session_id) ||
    stringValue(value.sessionId) ||
    stringValue(value.thread_id) ||
    stringValue(value.threadId) ||
    stringValue(value.conversationId) ||
    stringValue(value.conversation_id)
  );
}

export function runtimeThreadIdFromEnv(
  runtime: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const key of THREAD_ENV_BY_RUNTIME[runtime] ?? []) {
    const value = stringValue(env[key]);
    if (value) return value;
  }
  return stringValue(env.LOOPSHIP_THREAD_ID);
}

export function runtimeIdentityFromEnv(
  runtime: string,
  env: NodeJS.ProcessEnv = process.env,
): { runtime: string; threadId: string } | null {
  if (runtime !== "all") {
    const threadId = runtimeThreadIdFromEnv(runtime, env);
    return threadId ? { runtime, threadId } : null;
  }
  for (const [candidate, keys] of Object.entries(THREAD_ENV_BY_RUNTIME)) {
    for (const key of keys) {
      const threadId = stringValue(env[key]);
      if (threadId) return { runtime: candidate, threadId };
    }
  }
  return null;
}

export function recordHookRoute(input: {
  repoRoot: string;
  runtime: string;
  threadId?: string;
  workspaceRoot: string;
  result: Record<string, unknown>;
}): HookRouteState | null {
  const handle = fastflowResumeHandle(input.result, input.workspaceRoot);
  if (!handle) return null;
  const wtree = workspaceWtree(input.repoRoot, handle.workspaceRoot);
  const path = wtree ? statePath(input.repoRoot, wtree) : null;
  if (!wtree || !path) return null;
  const workspaceRoot = worktreeDirectory(input.repoRoot, wtree);
  if (!workspaceRoot) return null;
  handle.workspaceRoot = workspaceRoot;
  const current = (readJson(path) ?? {}) as Record<string, unknown>;
  const state: HookRouteState = {
    ...current,
    schema_version: 1,
    runtime: input.runtime,
    wtree,
    workspace_root: workspaceRoot,
    fastflow: handle,
    updated_at: new Date().toISOString(),
    ...(stringValue(input.threadId) ? { thread_id: stringValue(input.threadId) } : {}),
  };
  if (!stringValue(input.threadId)) delete state.thread_id;
  writeJson(path, state);
  return state;
}

export function resolveHookRoute(input: {
  repoRoot: string;
  runtime: string;
  threadId: string;
  wtree?: string;
  allowTransfer?: boolean;
}): HookRouteState | null {
  const explicit = stringValue(input.wtree);
  if (explicit) {
    const path = statePath(input.repoRoot, explicit);
    const state = path ? readState(path) : null;
    if (!state || !validRouteWorkspace(input.repoRoot, state)) return null;
    if (!state.thread_id) {
      state.runtime = input.runtime;
      state.thread_id = input.threadId;
      state.updated_at = new Date().toISOString();
      writeJson(path!, state);
    } else if (
      state.thread_id !== input.threadId ||
      state.runtime !== input.runtime
    ) {
      if (!input.allowTransfer) return null;
      state.runtime = input.runtime;
      state.thread_id = input.threadId;
      state.updated_at = new Date().toISOString();
      writeJson(path!, state);
    }
    return state;
  }

  const worktreesRoot = resolve(input.repoRoot, "worktrees");
  if (!existsSync(worktreesRoot)) return null;
  const matches = readdirSync(worktreesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => statePath(input.repoRoot, entry.name))
    .filter((path): path is string => Boolean(path))
    .map(readState)
    .filter(
      (state): state is HookRouteState =>
        Boolean(
          state &&
            validRouteWorkspace(input.repoRoot, state) &&
            state.runtime === input.runtime &&
            state.thread_id === input.threadId,
        ),
    );
  return matches.length === 1 ? matches[0] : null;
}

export function updateHookRoute(
  route: HookRouteState,
  result: Record<string, unknown>,
): void {
  const directPath = resolve(route.workspace_root, ".loopship", "runtime", "hook-state.json");
  const current = (readJson(directPath) ?? {}) as Record<string, unknown>;
  const handle = fastflowResumeHandle(result, route.workspace_root);
  if (handle) current.fastflow = handle;
  else delete current.fastflow;
  current.updated_at = new Date().toISOString();
  writeJson(directPath, current);
}

export function updateHookRouteForWorkspace(input: {
  repoRoot: string;
  workspaceRoot: string;
  result: Record<string, unknown>;
}): void {
  const wtree = workspaceWtree(input.repoRoot, input.workspaceRoot);
  const path = wtree ? statePath(input.repoRoot, wtree) : null;
  const route = path ? readState(path) : null;
  if (!route || !validRouteWorkspace(input.repoRoot, route)) return;
  updateHookRoute(route, input.result);
}
