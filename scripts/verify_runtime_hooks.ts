#!/usr/bin/env bun

import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./loopship_utils.ts";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "loopship.ts");

function fail(message: string): never {
  throw new Error(message);
}

function runLoopship(repo: string, args: string[], input?: Record<string, unknown>) {
  return runCommand("bun", [SCRIPT, ...args], {
    cwd: repo,
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
      cwd: repo,
      hook_event_name: "Stop",
    });
    if (noop.status !== 0) fail(noop.stderr || noop.stdout);
    if (noop.stdout.trim() !== "{}") {
      fail(`ordinary hook must no-op without a native Fastflow resume payload: ${noop.stdout}`);
    }

    const start = runLoopship(repo, [
      "stepper",
      "init",
      "loopship: build a full stack app",
      "--repo",
      repo,
      "--runtime",
      "codex",
    ]);
    if (start.status !== 0) fail(start.stderr || start.stdout);
    const started = parseJson(start.stdout, "stepper init");
    const pause = pauseToken(started);
    const resumePayload =
      pause.kind === "handoff_answer"
        ? { decision: nativePlanDecision() }
        : { supervisorDecision: "ok" };

    const resumePath = join(root, "resume.json");
    writeFileSync(
      resumePath,
      JSON.stringify({
        sessionId: pause.sessionId,
        ...(pause.nonce ? { nonce: pause.nonce } : {}),
        ...(pause.workspaceRoot ? { workspaceRoot: pause.workspaceRoot } : {}),
        ...resumePayload,
      }),
      "utf8",
    );
    const hook = runLoopship(repo, [
      "hook",
      "--runtime",
      "codex",
      "--repo",
      repo,
      "--json",
      `@${resumePath}`,
    ]);
    if (hook.status !== 0) fail(hook.stderr || hook.stdout);
    const output = parseJson(hook.stdout, "hook resume");
    assertNativeFastflowResponse(output, "hook resume");
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
