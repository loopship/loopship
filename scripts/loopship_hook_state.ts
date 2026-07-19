import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { acquireCrashSafeFileLock, writeJson } from "./loopship_utils.ts";

export type FastflowResumeHandle = {
  sessionId: string;
  nonce: string;
  workspaceRoot: string;
  kind?: string;
};

export type HookRouteState = {
  schema_version: 2;
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

const HOOK_STATE_LOCK_WAIT_MS = 5_000;

function hookStateError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function legacyHookStateUnsupported(path: string): Error {
  return hookStateError(
    "legacy_execution_unsupported",
    `hook route at ${path} predates the Native v1 nonce contract; resubmit it as a new Native execution`,
  );
}

function readStateDocument(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw hookStateError(
      "loopship_hook_state_corrupt",
      `hook route at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw hookStateError(
      "loopship_hook_state_corrupt",
      `hook route at ${path} must contain a JSON object`,
    );
  }
  return parsed as Record<string, unknown>;
}

function assertNativeHookStateVersion(
  value: Record<string, unknown>,
  path: string,
): void {
  if (value.schema_version !== 2) throw legacyHookStateUnsupported(path);
}

function withHookStateLock<T>(statePath: string, operation: () => T): T {
  let release: (() => void) | null = null;
  try {
    release = acquireCrashSafeFileLock(`${statePath}.lock.sqlite`, HOOK_STATE_LOCK_WAIT_MS);
  } catch (error) {
    if ((error as { code?: string }).code === "loopship_file_lock_busy") {
      throw hookStateError(
        "loopship_hook_state_busy",
        `hook route update is already in progress at ${statePath}`,
      );
    }
    throw error;
  }
  try {
    return operation();
  } finally {
    release();
  }
}

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
  const value = readStateDocument(path);
  if (!value) return null;
  if (!Object.keys(value).length) return null;
  assertNativeHookStateVersion(value, path);
  const fastflow = objectValue(value.fastflow);
  const sessionId = stringValue(fastflow.sessionId);
  if (!sessionId) return null;
  const nonce = stringValue(fastflow.nonce);
  if (!nonce) throw legacyHookStateUnsupported(path);
  const state: HookRouteState = {
    ...value,
    schema_version: 2,
    runtime: stringValue(value.runtime),
    wtree: stringValue(value.wtree),
    workspace_root: stringValue(value.workspace_root),
    fastflow: {
      sessionId,
      nonce,
      workspaceRoot: stringValue(fastflow.workspaceRoot),
      ...(stringValue(fastflow.kind) ? { kind: stringValue(fastflow.kind) } : {}),
    },
    updated_at: stringValue(value.updated_at),
    ...(stringValue(value.thread_id) ? { thread_id: stringValue(value.thread_id) } : {}),
  };
  if (
    !state.runtime ||
    !state.wtree ||
    !state.workspace_root ||
    !state.fastflow.workspaceRoot ||
    !state.updated_at
  ) {
    throw hookStateError(
      "loopship_hook_state_corrupt",
      `Native v1 hook route at ${path} is missing required routing fields`,
    );
  }
  return state;
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
  const nonce = stringValue(args.nonce);
  const resolvedWorkspace = stringValue(args.workspaceRoot) || stringValue(workspaceRoot);
  if (!sessionId || !nonce || !resolvedWorkspace) return null;
  return {
    sessionId,
    nonce,
    workspaceRoot: resolve(resolvedWorkspace),
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
  return withHookStateLock(path, () => {
    const current = readStateDocument(path) ?? {};
    if (Object.keys(current).length) assertNativeHookStateVersion(current, path);
    const threadId = stringValue(input.threadId);
    const currentRuntime = stringValue(current.runtime);
    const state: HookRouteState = {
      ...current,
      schema_version: 2,
      runtime:
        !threadId && currentRuntime && currentRuntime !== "all"
          ? currentRuntime
          : input.runtime,
      wtree,
      workspace_root: workspaceRoot,
      fastflow: handle,
      updated_at: new Date().toISOString(),
      ...(threadId ? { thread_id: threadId } : {}),
    };
    writeJson(path, state);
    return state;
  });
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
    if (!path) return null;
    return withHookStateLock(path, () => {
      const state = readState(path);
      if (!state || !validRouteWorkspace(input.repoRoot, state)) return null;
      if (!state.thread_id) {
        state.runtime = input.runtime;
        state.thread_id = input.threadId;
        state.updated_at = new Date().toISOString();
        writeJson(path, state);
      } else if (
        state.thread_id !== input.threadId ||
        state.runtime !== input.runtime
      ) {
        if (!input.allowTransfer) return null;
        state.runtime = input.runtime;
        state.thread_id = input.threadId;
        state.updated_at = new Date().toISOString();
        writeJson(path, state);
      }
      return state;
    });
  }

  const worktreesRoot = resolve(input.repoRoot, "worktrees");
  if (!existsSync(worktreesRoot)) return null;
  const states = readdirSync(worktreesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => statePath(input.repoRoot, entry.name))
    .filter((path): path is string => Boolean(path))
    .flatMap((path) => {
      try {
        const state = readState(path);
        return state ? [state] : [];
      } catch {
        return [];
      }
    });
  const matches = states
    .filter(
      (state): state is HookRouteState =>
        Boolean(
          state &&
            validRouteWorkspace(input.repoRoot, state) &&
            state.runtime === input.runtime &&
            state.thread_id === input.threadId,
        ),
    );
  if (matches.length === 1) return matches[0];
  return null;
}

export function readHookRouteForWorkspace(input: {
  repoRoot: string;
  workspaceRoot: string;
}): HookRouteState | null {
  const wtree = workspaceWtree(input.repoRoot, input.workspaceRoot);
  const path = wtree ? statePath(input.repoRoot, wtree) : null;
  if (!path) return null;
  return withHookStateLock(path, () => {
    const state = readState(path);
    return state && validRouteWorkspace(input.repoRoot, state) ? state : null;
  });
}

export function updateHookRoute(
  route: HookRouteState,
  result: Record<string, unknown>,
  expected: { sessionId: string; nonce?: string } = route.fastflow,
): void {
  const directPath = resolve(route.workspace_root, ".loopship", "runtime", "hook-state.json");
  const handle = fastflowResumeHandle(result, route.workspace_root);
  if (!existsSync(directPath) && !handle) {
    return;
  }
  withHookStateLock(directPath, () => {
    const current = readStateDocument(directPath);
    if (!current) {
      throw hookStateError(
        "loopship_hook_state_corrupt",
        `active hook route disappeared before update at ${directPath}`,
      );
    }
    assertNativeHookStateVersion(current, directPath);
    const currentHandle = objectValue(current.fastflow);
    if (
      stringValue(currentHandle.sessionId) !== expected.sessionId ||
      (expected.nonce !== undefined &&
        stringValue(currentHandle.nonce) !== expected.nonce)
    ) {
      return;
    }
    if (handle) {
      if (resolve(handle.workspaceRoot) !== resolve(route.workspace_root)) {
        throw hookStateError(
          "loopship_hook_state_corrupt",
          `Fastflow resume workspace does not match hook route ${route.workspace_root}`,
        );
      }
      handle.workspaceRoot = route.workspace_root;
      current.fastflow = handle;
    } else {
      delete current.fastflow;
    }
    current.updated_at = new Date().toISOString();
    writeJson(directPath, current);
  });
}

export function updateHookRouteForWorkspace(input: {
  repoRoot: string;
  workspaceRoot: string;
  result: Record<string, unknown>;
  expectedSessionId?: string;
  expectedNonce?: string;
}): void {
  const wtree = workspaceWtree(input.repoRoot, input.workspaceRoot);
  const path = wtree ? statePath(input.repoRoot, wtree) : null;
  const route = path ? readState(path) : null;
  if (!route || !validRouteWorkspace(input.repoRoot, route)) return;
  updateHookRoute(route, input.result, {
    sessionId: input.expectedSessionId || route.fastflow.sessionId,
    ...(input.expectedNonce ? { nonce: input.expectedNonce } : {}),
  });
}
