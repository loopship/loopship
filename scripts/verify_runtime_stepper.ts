#!/usr/bin/env bun

import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./loopship_utils.ts";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "loopship.ts");

type JsonObject = Record<string, any>;
type PauseToken = {
  sessionId: string;
  nonce?: string;
  reason: string;
  kind: "handoff_answer" | "supervisor_review" | "inline_answer";
};

function fail(message: string): never {
  throw new Error(message);
}

function runLoopship(repo: string, args: string[]) {
  return runCommand("bun", [SCRIPT, ...args], {
    cwd: repo,
    timeoutMs: 180_000,
  });
}

function parseJson(text: string, label: string): JsonObject {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`${label} must be a JSON object: ${text}`);
    }
    return parsed as JsonObject;
  } catch (error) {
    fail(`${label} must be JSON: ${error instanceof Error ? error.message : String(error)}\n${text}`);
  }
}

function createRepo(root: string): string {
  const repo = join(root, "repo");
  const git = runCommand("git", ["init", repo], { timeoutMs: 15_000 });
  if (git.status !== 0) fail(git.stderr || git.stdout);
  runCommand("git", ["config", "user.email", "loopship-stepper@example.invalid"], {
    cwd: repo,
  });
  runCommand("git", ["config", "user.name", "Loopship Stepper"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# stepper fixture\n", "utf8");
  runCommand("git", ["add", "README.md"], { cwd: repo });
  const commit = runCommand("git", ["commit", "-m", "stepper fixture"], {
    cwd: repo,
    timeoutMs: 15_000,
  });
  if (commit.status !== 0) fail(commit.stderr || commit.stdout);
  return repo;
}

function assertNoLoopshipStepEnvelope(value: JsonObject, label: string): void {
  for (const key of ["quest_step", "answer_schema", "continuation", "current_stage"]) {
    if (key in value) fail(`${label} must not expose old Loopship step envelope field '${key}'`);
  }
}

function nativeClarifyingPlanDecision(): Record<string, unknown> {
  return {
    classification: "greenfield_app",
    scope: "Clarify the requested full stack app before implementation.",
    questions: [
      {
        id: "app_goal",
        question: "What should the app do?",
        impact: "Defines MVP behavior.",
        default: "A minimal todo app.",
      },
      {
        id: "stack",
        question: "What stack should it use?",
        impact: "Determines implementation files.",
        default: "React frontend, Node API, SQLite.",
      },
    ],
    system_context: {
      relevant_object_refs: [],
      relevant_assertion_refs: [],
      relevant_resource_refs: [],
      relevant_memory_refs: [],
      durable_implications: [],
    },
    verification_targets: [
      "A scoped app request is captured before implementation.",
    ],
    task_graph: { tasks: [] },
  };
}

function pauseToken(value: JsonObject): PauseToken | null {
  if (value.schemaVersion !== "fastflow/interaction-response/v1") return null;
  const nextCall = value.nextCall && typeof value.nextCall === "object" ? value.nextCall : null;
  const args = nextCall?.args && typeof nextCall.args === "object" ? nextCall.args : null;
  const request =
    value.context && typeof value.context === "object" && !Array.isArray(value.context)
      ? value.context.request
      : null;
  const sessionId = String(args?.sessionId ?? "").trim();
  const nonce = String(args?.nonce ?? "").trim();
  const reason =
    request && typeof request === "object" && !Array.isArray(request)
      ? String(request.reason ?? "").trim()
      : "";
  if (!sessionId) fail(`interaction response must include nextCall.args.sessionId: ${JSON.stringify(value)}`);
  const kind = String(value.kind || "");
  if (kind !== "handoff_answer" && kind !== "supervisor_review" && kind !== "inline_answer") {
    fail(`interaction response has unsupported kind: ${JSON.stringify(value)}`);
  }
  return nonce ? { sessionId, nonce, reason, kind } : { sessionId, reason, kind };
}

function assertNativeFastflowResponse(value: JsonObject, label: string): PauseToken | null {
  assertNoLoopshipStepEnvelope(value, label);
  if (value.schemaVersion === "fastflow/interaction-response/v1") {
    return pauseToken(value);
  }
  if (
    value.schemaVersion !== "fastflow/workflow-run-artifact/v1" ||
    value.kind !== "workflow_result"
  ) {
    fail(`${label} must return native Fastflow response schema: ${JSON.stringify(value)}`);
  }
  if (value.ok !== true) fail(`${label} must be ok or paused: ${JSON.stringify(value)}`);
  return null;
}

function resumeNativePause(input: {
  repo: string;
  root: string;
  pause: PauseToken;
}): JsonObject {
  const resumePath = join(input.root, "native-resume.json");
  const resumePayload =
    input.pause.kind === "handoff_answer"
      ? { decision: nativeClarifyingPlanDecision() }
      : { supervisorDecision: "ok" };
  writeFileSync(
    resumePath,
    JSON.stringify({
      sessionId: input.pause.sessionId,
      ...(input.pause.nonce ? { nonce: input.pause.nonce } : {}),
      ...resumePayload,
    }),
    "utf8",
  );
  const resumed = runLoopship(input.repo, [
    "stepper",
    "step",
    "--repo",
    input.repo,
    "--json",
    `@${resumePath}`,
  ]);
  if (resumed.status !== 0) fail(resumed.stderr || resumed.stdout);
  return parseJson(resumed.stdout, "stepper step");
}

function main(): number {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopship-native-stepper-")));
  try {
    const repo = createRepo(root);
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
    const first = parseJson(start.stdout, "stepper init");
    const pause = assertNativeFastflowResponse(first, "stepper init");
    if (pause) {
      const resumed = resumeNativePause({ repo, root, pause });
      assertNativeFastflowResponse(resumed, "stepper step");
    }
    console.log("loopship native stepper verification passed");
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
