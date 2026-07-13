#!/usr/bin/env bun

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./loopship_utils.ts";
import { nativeResumeRequest } from "./loopship_resume.ts";
import {
  recordHookRoute,
  resolveHookRoute,
  runtimeHookThreadId,
  runtimeIdentityFromEnv,
} from "./loopship_hook_state.ts";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "loopship.ts");

function fail(message: string): never {
  throw new Error(message);
}

function runLoopship(
  repo: string,
  args: string[],
  input?: Record<string, unknown>,
  env?: Record<string, string>,
) {
  return runCommand("bun", [SCRIPT, ...args], {
    cwd: repo,
    env,
    timeoutMs: 120_000,
    input: input ? JSON.stringify(input) : undefined,
  });
}

function parseJson(text: string, label: string): Record<string, any> {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`${label} must be a JSON object: ${text}`);
    }
    return parsed as Record<string, any>;
  } catch (error) {
    fail(`${label} must be JSON: ${error instanceof Error ? error.message : String(error)}\n${text}`);
  }
}

function assertNoOldEnvelope(value: Record<string, any>, label: string): void {
  for (const key of ["quest_step", "answer_schema", "continuation", "current_stage"]) {
    if (key in value) fail(`${label} must not expose old Loopship step envelope field '${key}'`);
  }
}

type PauseToken = {
  sessionId: string;
  nonce?: string;
  workspaceRoot?: string;
  kind: string;
};

function pauseToken(value: Record<string, any>): PauseToken {
  if (value.schemaVersion !== "fastflow/interaction-response/v1") {
    fail(`expected Fastflow interaction response: ${JSON.stringify(value)}`);
  }
  const args =
    value.nextCall &&
    typeof value.nextCall === "object" &&
    value.nextCall.args &&
    typeof value.nextCall.args === "object"
      ? value.nextCall.args
      : null;
  const sessionId = String(args?.sessionId ?? "").trim();
  const nonce = String(args?.nonce ?? "").trim();
  const workspaceRoot = String(args?.workspaceRoot ?? "").trim();
  if (!sessionId) {
    fail(`missing Fastflow interaction nextCall sessionId: ${JSON.stringify(value)}`);
  }
  const kind = String(value.kind ?? "").trim();
  if (kind !== "handoff_answer" && kind !== "supervisor_review" && kind !== "inline_answer") {
    fail(`unsupported Fastflow interaction kind: ${JSON.stringify(value)}`);
  }
  return {
    sessionId,
    ...(nonce ? { nonce } : {}),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    kind,
  };
}

function assertNativeFastflowResponse(value: Record<string, any>, label: string): void {
  assertNoOldEnvelope(value, label);
  if (value.schemaVersion === "fastflow/interaction-response/v1") {
    pauseToken(value);
    return;
  }
  if (
    value.schemaVersion !== "fastflow/workflow-run-artifact/v1" ||
    value.kind !== "workflow_result" ||
    value.ok !== true
  ) {
    fail(`${label} must return native Fastflow response: ${JSON.stringify(value)}`);
  }
}

function createRepo(root: string): string {
  const repo = join(root, "repo");
  const git = runCommand("git", ["init", repo], { timeoutMs: 15_000 });
  if (git.status !== 0) fail(git.stderr || git.stdout);
  runCommand("git", ["config", "user.email", "loopship-hooks@example.invalid"], {
    cwd: repo,
  });
  runCommand("git", ["config", "user.name", "Loopship Hooks"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# hook fixture\n", "utf8");
  runCommand("git", ["add", "README.md"], { cwd: repo });
  const commit = runCommand("git", ["commit", "-m", "hook fixture"], {
    cwd: repo,
    timeoutMs: 15_000,
  });
  if (commit.status !== 0) fail(commit.stderr || commit.stdout);
  return repo;
}

function nativePlanDecision(): Record<string, unknown> {
  return {
    classification: "greenfield_app",
    scope: "Clarify the requested app before implementation.",
    questions: [
      {
        id: "app_goal",
        question: "What should the app do first?",
        impact: "Defines the app MVP.",
        default: "A minimal CRUD app.",
        options: [
          {
            label: "CRUD app",
            description: "Create, read, update, and delete one resource.",
          },
          {
            label: "Dashboard",
            description: "Display a simple status overview.",
          },
        ],
      },
    ],
    system_context: {
      relevant_object_refs: [],
      relevant_assertion_refs: [],
      relevant_resource_refs: [],
      relevant_memory_refs: [],
      durable_implications: [],
    },
    verification_targets: ["Capture a scoped app request before implementation."],
  };
}

function main(): number {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopship-native-hooks-")));
  try {
    const repo = createRepo(root);
    const noop = runLoopship(repo, ["hook", "--runtime", "codex"], {
      session_id: "codex-ordinary-thread",
      cwd: repo,
      hook_event_name: "Stop",
    });
    if (noop.status !== 0) fail(noop.stderr || noop.stdout);
    if (noop.stdout.trim() !== "{}") {
      fail(`ordinary hook must no-op without a native Fastflow resume payload: ${noop.stdout}`);
    }
    if (nativeResumeRequest({ session_id: "codex-thread" }) !== null) {
      fail("Codex session_id must not be interpreted as a Fastflow sessionId");
    }
    if (runtimeHookThreadId({ conversationId: "agy-thread" }) !== "agy-thread") {
      fail("runtime hook identity must normalize conversationId");
    }
    const claudeIdentity = runtimeIdentityFromEnv("claude", {
      CLAUDE_CODE_SESSION_ID: "claude-thread",
    });
    if (claudeIdentity?.threadId !== "claude-thread") {
      fail("runtime environment identity must normalize Claude sessions");
    }
    const allCodexIdentity = runtimeIdentityFromEnv("all", {
      CODEX_THREAD_ID: "codex-thread-from-all",
    });
    if (
      allCodexIdentity?.runtime !== "codex" ||
      allCodexIdentity.threadId !== "codex-thread-from-all"
    ) {
      fail("runtime all must retain a concrete environment identity when available");
    }
    if (
      runtimeIdentityFromEnv("all", {
        LOOPSHIP_THREAD_ID: "runtime-unknown-thread",
      }) !== null
    ) {
      fail("runtime all must remain unbound when no concrete runtime identity is available");
    }

    const start = runLoopship(
      repo,
      [
        "stepper",
        "init",
        "loopship: build a full stack app",
        "--repo",
        repo,
        "--runtime",
        "codex",
        "--wtree",
        "hook-route",
      ],
      undefined,
      { CODEX_THREAD_ID: "" },
    );
    if (start.status !== 0) fail(start.stderr || start.stdout);
    const started = parseJson(start.stdout, "stepper init");
    const pause = pauseToken(started);
    const bind = runLoopship(
      repo,
      ["hook", "--runtime", "codex", "--repo", repo],
      {
        session_id: "codex-thread-a",
        cwd: repo,
        hook_event_name: "Stop",
        stop_hook_active: false,
      },
      { WTREE: "hook-route" },
    );
    if (bind.status !== 0) fail(bind.stderr || bind.stdout);
    if (bind.stdout.trim() !== "{}") {
      fail(`thread binding without a workflow response must no-op: ${bind.stdout}`);
    }
    const hookState = parseJson(
      readFileSync(
        join(repo, "worktrees", "hook-route", ".loopship", "runtime", "hook-state.json"),
        "utf8",
      ),
      "hook state",
    );
    if (hookState.thread_id !== "codex-thread-a") {
      fail(`hook state must bind the Codex thread id: ${JSON.stringify(hookState)}`);
    }
    if (hookState.fastflow?.sessionId !== pause.sessionId) {
      fail(`hook state must preserve the Fastflow session separately: ${JSON.stringify(hookState)}`);
    }

    const secondWorkspace = join(repo, "worktrees", "hook-route-b");
    mkdirSync(join(secondWorkspace, ".loopship", "runtime"), { recursive: true });
    recordHookRoute({
      repoRoot: repo,
      runtime: "codex",
      threadId: "codex-thread-b",
      workspaceRoot: secondWorkspace,
      result: {
        kind: "supervisor_review",
        nextCall: {
          args: {
            sessionId: "fastflow-session-b",
            nonce: "nonce-b",
            workspaceRoot: secondWorkspace,
          },
        },
      },
    });
    const firstRoute = resolveHookRoute({
      repoRoot: repo,
      runtime: "codex",
      threadId: "codex-thread-a",
    });
    const secondRoute = resolveHookRoute({
      repoRoot: repo,
      runtime: "codex",
      threadId: "codex-thread-b",
    });
    if (firstRoute?.wtree !== "hook-route" || secondRoute?.wtree !== "hook-route-b") {
      fail("concurrent runtime threads must resolve their own worktrees");
    }
    const escapedWorkspace = join(root, "escaped-hook-route");
    mkdirSync(join(escapedWorkspace, ".loopship", "runtime"), { recursive: true });
    symlinkSync(escapedWorkspace, join(repo, "worktrees", "hook-route-link"), "dir");
    const escapedRoute = recordHookRoute({
      repoRoot: repo,
      runtime: "codex",
      threadId: "escaped-thread",
      workspaceRoot: join(repo, "worktrees", "hook-route-link"),
      result: {
        nextCall: {
          args: {
            sessionId: "escaped-session",
            workspaceRoot: join(repo, "worktrees", "hook-route-link"),
          },
        },
      },
    });
    if (escapedRoute !== null) {
      fail("hook routes must reject worktree symlinks that escape the repository");
    }
    if (existsSync(join(escapedWorkspace, ".loopship", "runtime", "hook-state.json"))) {
      fail("rejected hook routes must not write state outside the repository worktrees root");
    }
    const symlinkRootRepo = join(root, "symlink-root-repo");
    const symlinkRootTarget = join(root, "symlink-root-target");
    const symlinkRootWorkspace = join(symlinkRootTarget, "hook-route");
    mkdirSync(join(symlinkRootWorkspace, ".loopship", "runtime"), { recursive: true });
    mkdirSync(symlinkRootRepo, { recursive: true });
    symlinkSync(symlinkRootTarget, join(symlinkRootRepo, "worktrees"), "dir");
    const symlinkRootRoute = recordHookRoute({
      repoRoot: symlinkRootRepo,
      runtime: "codex",
      threadId: "symlink-root-thread",
      workspaceRoot: join(symlinkRootRepo, "worktrees", "hook-route"),
      result: {
        nextCall: {
          args: {
            sessionId: "symlink-root-session",
            workspaceRoot: join(symlinkRootRepo, "worktrees", "hook-route"),
          },
        },
      },
    });
    if (symlinkRootRoute !== null) {
      fail("hook routes must reject a symlinked repository worktrees root");
    }
    const wildcardWorkspace = join(repo, "worktrees", "hook-route-wildcard");
    mkdirSync(join(wildcardWorkspace, ".loopship", "runtime"), { recursive: true });
    recordHookRoute({
      repoRoot: repo,
      runtime: "all",
      threadId: "shared-thread",
      workspaceRoot: wildcardWorkspace,
      result: {
        kind: "supervisor_review",
        nextCall: {
          args: {
            sessionId: "fastflow-session-wildcard",
            workspaceRoot: wildcardWorkspace,
          },
        },
      },
    });
    if (
      resolveHookRoute({
        repoRoot: repo,
        runtime: "codex",
        threadId: "shared-thread",
      }) !== null
    ) {
      fail("runtime all must not act as a wildcard during implicit route lookup");
    }

    const routedNoop = runLoopship(repo, ["hook", "--runtime", "codex", "--repo", repo], {
      session_id: "codex-thread-a",
      cwd: repo,
      hook_event_name: "Stop",
      stop_hook_active: false,
    });
    if (routedNoop.status !== 0) fail(routedNoop.stderr || routedNoop.stdout);
    if (routedNoop.stdout.trim() !== "{}") {
      fail(`bound thread lookup without a workflow response must no-op: ${routedNoop.stdout}`);
    }

    const handoff = runLoopship(
      repo,
      [
        "hook",
        "--runtime",
        "claude",
        "--repo",
        repo,
        "--wtree",
        "hook-route",
      ],
      {
        session_id: "claude-thread-a",
        cwd: repo,
        hook_event_name: "Stop",
      },
    );
    if (handoff.status !== 0) fail(handoff.stderr || handoff.stdout);
    if (handoff.stdout.trim() !== "{}") {
      fail(`runtime handoff without a workflow response must no-op: ${handoff.stdout}`);
    }
    const handedOffState = parseJson(
      readFileSync(
        join(repo, "worktrees", "hook-route", ".loopship", "runtime", "hook-state.json"),
        "utf8",
      ),
      "handed off hook state",
    );
    if (
      handedOffState.runtime !== "claude" ||
      handedOffState.thread_id !== "claude-thread-a"
    ) {
      fail(`explicit worktree must transfer the runtime binding: ${JSON.stringify(handedOffState)}`);
    }
    if (JSON.stringify(handedOffState.fastflow) !== JSON.stringify(hookState.fastflow)) {
      fail(`runtime handoff must preserve the Fastflow resume handle: ${JSON.stringify(handedOffState)}`);
    }
    if (
      resolveHookRoute({
        repoRoot: repo,
        runtime: "codex",
        threadId: "codex-thread-a",
      }) !== null
    ) {
      fail("the previous runtime thread must not resolve after handoff");
    }
    const handedOffRoute = resolveHookRoute({
      repoRoot: repo,
      runtime: "claude",
      threadId: "claude-thread-a",
    });
    if (handedOffRoute?.wtree !== "hook-route") {
      fail("the new runtime thread must resolve the handed-off worktree");
    }
    const staleOwner = runLoopship(
      repo,
      ["hook", "--runtime", "codex", "--repo", repo],
      {
        session_id: "codex-thread-a",
        cwd: repo,
        hook_event_name: "Stop",
      },
      { WTREE: "hook-route" },
    );
    if (staleOwner.status !== 0) fail(staleOwner.stderr || staleOwner.stdout);
    const retainedHandoff = parseJson(
      readFileSync(
        join(repo, "worktrees", "hook-route", ".loopship", "runtime", "hook-state.json"),
        "utf8",
      ),
      "retained handoff hook state",
    );
    if (
      retainedHandoff.runtime !== "claude" ||
      retainedHandoff.thread_id !== "claude-thread-a"
    ) {
      fail("an ambient WTREE must not reclaim an existing runtime binding");
    }
    const resumePayload =
      pause.kind === "handoff_answer"
        ? { decision: nativePlanDecision() }
        : { supervisorDecision: "ok" };

    const hook = runLoopship(
      repo,
      ["hook", "--runtime", "claude", "--repo", repo],
      {
        session_id: "claude-thread-a",
        cwd: repo,
        hook_event_name: "Stop",
        ...resumePayload,
      },
    );
    if (hook.status !== 0) fail(hook.stderr || hook.stdout);
    const output = parseJson(hook.stdout, "handed-off hook resume");
    assertNativeFastflowResponse(output, "handed-off hook resume");
    const updatedHookState = parseJson(
      readFileSync(
        join(repo, "worktrees", "hook-route", ".loopship", "runtime", "hook-state.json"),
        "utf8",
      ),
      "updated hook state",
    );
    if (output.schemaVersion === "fastflow/interaction-response/v1") {
      const nextPause = pauseToken(output);
      if (updatedHookState.fastflow?.sessionId !== nextPause.sessionId) {
        fail("handed-off runtime resume must refresh the stored Fastflow handle");
      }
      const directResumePayload =
        nextPause.kind === "handoff_answer"
          ? { decision: nativePlanDecision() }
          : { supervisorDecision: "ok" };
      const resumePath = join(root, "resume.json");
      writeFileSync(
        resumePath,
        JSON.stringify({
          sessionId: nextPause.sessionId,
          ...(nextPause.nonce ? { nonce: nextPause.nonce } : {}),
          ...(nextPause.workspaceRoot ? { workspaceRoot: nextPause.workspaceRoot } : {}),
          ...directResumePayload,
        }),
        "utf8",
      );
      const directHook = runLoopship(repo, [
        "hook",
        "--runtime",
        "codex",
        "--repo",
        repo,
        "--json",
        `@${resumePath}`,
      ]);
      if (directHook.status !== 0) fail(directHook.stderr || directHook.stdout);
      const directOutput = parseJson(directHook.stdout, "direct Fastflow hook resume");
      assertNativeFastflowResponse(directOutput, "direct Fastflow hook resume");
      const directlyUpdatedState = parseJson(
        readFileSync(
          join(repo, "worktrees", "hook-route", ".loopship", "runtime", "hook-state.json"),
          "utf8",
        ),
        "directly updated hook state",
      );
      if (directOutput.schemaVersion === "fastflow/interaction-response/v1") {
        const directNextPause = pauseToken(directOutput);
        if (directlyUpdatedState.fastflow?.sessionId !== directNextPause.sessionId) {
          fail("direct Fastflow resume must refresh the stored handle");
        }
      } else if (directlyUpdatedState.fastflow !== undefined) {
        fail("terminal direct Fastflow resume must retire the stored handle");
      }
    } else if (updatedHookState.fastflow !== undefined) {
      fail("terminal handed-off runtime resume must retire the stored Fastflow handle");
    }
    console.log("loopship native hook verification passed");
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
