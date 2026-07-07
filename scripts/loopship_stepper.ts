#!/usr/bin/env bun

import { resolve } from "node:path";
import {
  loopshipFlowWorkflowRef,
  resolveLoopshipFastflowCommandBinding,
  resolveLoopshipFlowId,
  resumeLoopshipFastflowWorkflow,
  runLoopshipFastflowWorkflowRequest,
} from "./loopship_fastflow.ts";
import {
  expandHome,
  readJson,
  readStdinJson,
} from "./loopship_utils.ts";

type StepperCommand = "step" | "hook";

type StepperArgs = {
  command: StepperCommand;
  repo: string | null;
  json: string | null;
};

const STEPPER_INIT_BINDING: Record<string, unknown> = {
  path: ["init"],
  kind: "workflow.run",
  workflowRef: ({ flags }: { flags: Record<string, unknown> }) =>
    loopshipFlowWorkflowRef(
      resolveLoopshipFlowId(typeof flags.flow === "string" ? flags.flow : null),
    ),
  supervision: "step",
  progressMode: "compact",
  usage: {
    args: '"loopship: <request>" [--repo <path>] [--runtime <codex|gemini|copilot>] [--flow <id>] [--wtree <name>]',
  },
  flags: {
    repo: { valueName: "path", description: "Repository root." },
    runtime: { valueName: "runtime", description: "Agent runtime." },
    flow: { valueName: "id", description: "Loopship flow id." },
    wtree: { valueName: "name", description: "Coordinator worktree name." },
    "source-branch": { valueName: "branch", description: "Coordinator source branch." },
    "parent-wtree": { valueName: "name", description: "Parent coordinator worktree." },
    "parent-task-id": { valueName: "id", description: "Parent task id." },
    "parent-context-ref": { valueName: "path", description: "Parent runtime task state path." },
    "target-branch": { valueName: "branch", description: "Landing target branch." },
    "target-worktree": { valueName: "path", description: "Landing target worktree." },
    full: { type: "boolean", description: "Compatibility no-op." },
  },
  inputs: {
    request: { positional: 0, required: true, transform: "ensurePrefix:loopship:" },
    runtime: { flag: "runtime", default: "codex" },
    repoRoot: {
      flag: "repo",
      defaultFrom: "cwd",
      transform: (value: unknown) => defaultRepoRoot(String(value)),
    },
    wtree: { flag: "wtree" },
    sourceBranch: { flag: "source-branch" },
    parentWtree: { flag: "parent-wtree" },
    parentTaskId: { flag: "parent-task-id" },
    parentContextRef: { flag: "parent-context-ref" },
    targetBranch: { flag: "target-branch" },
    targetWorktree: { flag: "target-worktree" },
  },
};

function usage(exitCode = 1): number {
  const text = [
    "Usage:",
    '  loopship stepper init "loopship: <request>" [--repo <path>] [--runtime <codex|gemini|copilot>] [--flow <id>] [--wtree <name>]',
    "  loopship stepper step [--repo <path>] --json <json|@file|@->",
    "  loopship stepper hook [--repo <path>] [--json <json|@file|@->]",
  ].join("\n");
  if (exitCode === 0) console.log(text);
  else console.error(text);
  return exitCode;
}

function parseArgs(argv: string[]): StepperArgs {
  let repo: string | null = null;
  let json: string | null = null;
  const command = argv[0];
  let stepperCommand: StepperCommand;
  let body: string[];

  if (command === "step") {
    stepperCommand = "step";
    body = argv.slice(1);
  } else if (command === "hook") {
    stepperCommand = "hook";
    body = argv.slice(1);
  } else if (command === "--help" || command === "-h") {
    throw new Error("__STEPPER_HELP__");
  } else {
    throw new Error(`unknown stepper command: ${command ?? ""}`.trim());
  }

  for (let i = 0; i < body.length; i += 1) {
    const arg = body[i];
    if (arg === "--repo") repo = body[++i] ?? null;
    else if (arg?.startsWith("--repo=")) repo = arg.slice("--repo=".length);
    else if (arg === "--cwd" || arg?.startsWith("--cwd=")) {
      throw new Error("loopship stepper no longer accepts --cwd; use --repo or run from the repo root");
    } else if (arg === "--json") json = body[++i] ?? "@-";
    else if (arg?.startsWith("--json=")) json = arg.slice("--json=".length);
    else if (arg === "--help" || arg === "-h") throw new Error("__STEPPER_HELP__");
    else if (arg?.startsWith("-")) throw new Error(`unknown stepper argument: ${arg}`);
  }

  return {
    command: stepperCommand,
    repo,
    json,
  };
}

function defaultRepoRoot(repo: string | null): string {
  if (repo) return resolve(expandHome(repo));
  return resolve(process.cwd());
}

function readJsonSource(raw: string | null, label: string): Record<string, unknown> {
  if (!raw) throw new Error(`${label} requires --json <json|@file|@->`);
  const value =
    raw === "@-"
      ? readStdinJson()
      : raw.startsWith("@")
        ? readJson(resolve(expandHome(raw.slice(1))))
        : JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} requires a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function nativeResumeRequest(value: Record<string, unknown>): Record<string, unknown> | null {
  const nextCall =
    value.nextCall && typeof value.nextCall === "object" && !Array.isArray(value.nextCall)
      ? (value.nextCall as Record<string, unknown>)
      : {};
  const nextArgs =
    nextCall.args && typeof nextCall.args === "object" && !Array.isArray(nextCall.args)
      ? (nextCall.args as Record<string, unknown>)
      : {};
  const source =
    value.fastflow && typeof value.fastflow === "object" && !Array.isArray(value.fastflow)
      ? (value.fastflow as Record<string, unknown>)
      : value.resume && typeof value.resume === "object" && !Array.isArray(value.resume)
        ? (value.resume as Record<string, unknown>)
        : Object.keys(nextArgs).length
          ? nextArgs
          : value;
  const sessionId = String(source.sessionId ?? source.session_id ?? "").trim();
  if (!sessionId) return null;
  const request: Record<string, unknown> = { sessionId };
  for (const field of ["nonce", "workspaceRoot", "executionName", "progressMode"]) {
    const fieldValue = source[field] ?? nextArgs[field];
    if (typeof fieldValue === "string" && fieldValue.trim()) {
      request[field] = fieldValue.trim();
    }
  }
  const supervisorDecision = source.supervisorDecision ?? value.supervisorDecision;
  if (supervisorDecision !== undefined) request.supervisorDecision = supervisorDecision;
  const response = source.response ?? value.response;
  if (response !== undefined) {
    request.response = response;
    return request;
  }
  const decision = source.decision ?? value.decision;
  if (decision !== undefined) {
    request.response = { answer: decision };
  }
  return request;
}

function writeJson(payload: Record<string, unknown>): number {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return 0;
}

async function runInit(argv: string[]): Promise<number> {
  const binding = await resolveLoopshipFastflowCommandBinding(
    argv,
    [STEPPER_INIT_BINDING],
    { cwd: process.cwd() },
  );
  if (!binding) {
    throw new Error("stepper init did not match a Fastflow command binding");
  }
  if (binding.kind === "help") {
    console.log(String(binding.text || ""));
    return 0;
  }
  const request =
    binding.params && typeof binding.params === "object" && !Array.isArray(binding.params)
      ? (binding.params as Record<string, unknown>)
      : {};
  const inputs =
    request.inputs && typeof request.inputs === "object" && !Array.isArray(request.inputs)
      ? (request.inputs as Record<string, unknown>)
      : {};
  const repoRoot = defaultRepoRoot(String(inputs.repoRoot || process.cwd()));
  const result = await runLoopshipFastflowWorkflowRequest({
    repoRoot,
    request,
  });
  return writeJson(result);
}

async function runStep(args: StepperArgs): Promise<number> {
  const repoRoot = defaultRepoRoot(args.repo);
  const payload = readJsonSource(args.json, "stepper step");
  const request = nativeResumeRequest(payload);
  if (!request) {
    throw new Error("stepper step requires a native Fastflow resume payload with sessionId");
  }
  const result = await resumeLoopshipFastflowWorkflow({
    repoRoot,
    request,
  });
  return writeJson(result);
}

async function runHook(args: StepperArgs): Promise<number> {
  const payload = args.json ? readJsonSource(args.json, "stepper hook") : {};
  const request = nativeResumeRequest(payload);
  if (!request) return writeJson({});
  const result = await resumeLoopshipFastflowWorkflow({
    repoRoot: defaultRepoRoot(args.repo),
    request,
  });
  return writeJson(result);
}

export async function runStepperCli(argv: string[]): Promise<number> {
  if (argv[0] === "init") return await runInit(argv);
  let args: StepperArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof Error && error.message === "__STEPPER_HELP__") {
      return usage(0);
    }
    if (
      error instanceof Error &&
      (error.message.startsWith("unknown stepper argument:") ||
        error.message.startsWith("unknown stepper command:"))
    ) {
      console.error(error.message);
      return usage(1);
    }
    throw error;
  }
  if (args.command === "step") return await runStep(args);
  return await runHook(args);
}

if (import.meta.main) {
  try {
    process.exit(await runStepperCli(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
