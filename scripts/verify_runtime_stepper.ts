#!/usr/bin/env bun

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startLoopshipTestScheduler,
  type LoopshipTestScheduler,
} from "./loopship_fastflow_test_scheduler.ts";
import { runCommand } from "./loopship_utils.ts";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "loopship.ts");
const TEST_INFERENCE_ROUTES_JSON = JSON.stringify(
  Object.fromEntries(
    [
      "llm.cli.codex.gpt-5.5.max",
      "llm.cli.codex.gpt-5.3-codex-spark.max",
      "llm.cli.codex.gpt-5.3-codex-spark.high",
    ].map((routeRef) => [
      routeRef,
      { client: "handoff", resolverPath: routeRef, routeRef },
    ]),
  ),
);
let nativeRuntimeEnv: Record<string, string> = {};

type JsonObject = Record<string, any>;
type PauseToken = {
  sessionId: string;
  nonce: string;
  workspaceRoot: string;
  reason: string;
  kind: "handoff_answer" | "supervisor_review" | "inline_answer";
  command: string;
};

function fail(message: string): never {
  throw new Error(message);
}

function runLoopship(repo: string, args: string[]) {
  return runCommand("bun", [SCRIPT, ...args], {
    cwd: repo,
    env: nativeRuntimeEnv,
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
        options: [
          {
            label: "Todo app",
            description: "Minimal todo workflow with create and complete.",
          },
          {
            label: "Dashboard",
            description: "Read-only dashboard with sample data.",
          },
        ],
      },
      {
        id: "stack",
        question: "What stack should it use?",
        impact: "Determines implementation files.",
        default: "React frontend, Node API, SQLite.",
        options: [
          {
            label: "React Node SQLite",
            description: "Full-stack JavaScript app with local persistence.",
          },
          {
            label: "Next.js SQLite",
            description: "Single framework app with API routes.",
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
    verification_targets: [
      "A scoped app request is captured before implementation.",
    ],
  };
}

function pauseToken(value: JsonObject): PauseToken | null {
  if (value.schemaVersion !== "fastflow/interaction-response/v1") return null;
  const nextCall = value.nextCall && typeof value.nextCall === "object" ? value.nextCall : null;
  const args = nextCall?.args && typeof nextCall.args === "object" ? nextCall.args : null;
  const command = String(nextCall?.command ?? "").trim();
  const request =
    value.context && typeof value.context === "object" && !Array.isArray(value.context)
      ? value.context.request
      : null;
  const sessionId = String(args?.sessionId ?? "").trim();
  const nonce = String(args?.nonce ?? "").trim();
  const workspaceRoot = String(args?.workspaceRoot ?? "").trim();
  const reason =
    request && typeof request === "object" && !Array.isArray(request)
      ? String(request.reason ?? "").trim()
      : "";
  if (!sessionId) fail(`interaction response must include nextCall.args.sessionId: ${JSON.stringify(value)}`);
  if (!nonce) fail(`interaction response must include nextCall.args.nonce: ${JSON.stringify(value)}`);
  if (!workspaceRoot) fail(`interaction response must include nextCall.args.workspaceRoot: ${JSON.stringify(value)}`);
  if (command !== "loopship stepper step --json @-") {
    fail(`interaction response must advertise the Loopship resume wrapper: ${JSON.stringify(value)}`);
  }
  const kind = String(value.kind || "");
  if (kind !== "handoff_answer" && kind !== "supervisor_review" && kind !== "inline_answer") {
    fail(`interaction response has unsupported kind: ${JSON.stringify(value)}`);
  }
  if (value.supervision?.enabled !== true || value.supervision?.mode !== "step") {
    fail(`stepper interaction must carry Fastflow step supervision: ${JSON.stringify(value)}`);
  }
  const systemInstructions = String(value.systemInstructions ?? "");
  const hasDelegatedImplementationGuard =
    systemInstructions.includes("Do not perform delegated implementation work inline") ||
    systemInstructions.includes("Do not perform delegated implementation or correction inline");
  if (
    !systemInstructions.includes("loopship-supervisor") ||
    !systemInstructions.includes("native Fastflow decision") ||
    !hasDelegatedImplementationGuard
  ) {
    fail(`stepper interaction must include supervisor guidance: ${JSON.stringify(value)}`);
  }
  return {
    sessionId,
    nonce,
    workspaceRoot,
    reason,
    kind,
    command,
  };
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

function assertHookRouteMatches(workspaceRoot: string, pause: PauseToken | null): void {
  const path = join(workspaceRoot, ".loopship", "runtime", "hook-state.json");
  if (!existsSync(path)) fail(`stepper run must persist its hook route: ${path}`);
  const state = parseJson(readFileSync(path, "utf8"), "stepper hook route");
  const handle = state.fastflow && typeof state.fastflow === "object" ? state.fastflow : null;
  if (!pause) {
    if (handle) fail(`terminal stepper result must clear its hook route: ${JSON.stringify(state)}`);
    return;
  }
  if (
    String(handle?.sessionId ?? "") !== pause.sessionId ||
    String(handle?.nonce ?? "") !== pause.nonce ||
    String(handle?.workspaceRoot ?? "") !== pause.workspaceRoot
  ) {
    fail(`stepper hook route must advance to the emitted continuation: ${JSON.stringify(state)}`);
  }
}

function resumeNativePause(input: {
  repo: string;
  root: string;
  pause: PauseToken;
}): JsonObject {
  const response =
    input.pause.kind === "handoff_answer"
      ? { answer: nativeClarifyingPlanDecision() }
      : { decision: "ok" };
  const payload = {
    sessionId: input.pause.sessionId,
    nonce: input.pause.nonce,
    workspaceRoot: input.pause.workspaceRoot,
    response,
  };
  const tokens = input.pause.command.split(/\s+/u);
  if (tokens.shift() !== "loopship") {
    fail(`unexpected nextCall command: ${input.pause.command}`);
  }
  const resumed = runCommand("bun", [SCRIPT, ...tokens], {
    cwd: input.repo,
    env: nativeRuntimeEnv,
    timeoutMs: 180_000,
    input: JSON.stringify(payload),
  });
  if (resumed.status !== 0) fail(resumed.stderr || resumed.stdout);
  return parseJson(resumed.stdout, "stepper step");
}

async function main(): Promise<number> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopship-native-stepper-")));
  let scheduler: LoopshipTestScheduler | null = null;
  try {
    const repo = createRepo(root);
    scheduler = await startLoopshipTestScheduler({
      dbPath: join(root, "scheduler", "native-v1.sqlite"),
      home: join(root, "home"),
    });
    nativeRuntimeEnv = {
      ...scheduler.env,
      HOME: join(root, "home"),
      INFERENCE_CLIENT: "handoff",
      INFERENCE_PROVIDER: "",
      INFERENCE_MODEL: "",
      OPENAI_API_KEY: "",
      CODEX_THREAD_ID: "loopship-stepper-thread",
      INFERENCE_ROUTES_JSON: TEST_INFERENCE_ROUTES_JSON,
    };
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
      assertHookRouteMatches(pause.workspaceRoot, pause);
      const resumed = resumeNativePause({ repo, root, pause });
      const nextPause = assertNativeFastflowResponse(resumed, "stepper step");
      assertHookRouteMatches(pause.workspaceRoot, nextPause);
    }
    console.log(
      "loopship native stepper production run paused/resumed under superviseStep before child execution",
    );
    return 0;
  } finally {
    await scheduler?.stop();
    nativeRuntimeEnv = {};
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  process.exit(await main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
