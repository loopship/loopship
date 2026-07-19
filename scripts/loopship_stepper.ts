#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
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
import { nativeResumeRequest } from "./loopship_resume.ts";

export { nativeResumeRequest } from "./loopship_resume.ts";

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

function requiredOptionValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function inlineOptionValue(argument: string, option: string): string {
  const value = argument.slice(`${option}=`.length);
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

const STEPPER_INIT_VALUE_OPTIONS = new Set([
  "--repo",
  "--runtime",
  "--flow",
  "--wtree",
  "--source-branch",
  "--parent-wtree",
  "--parent-task-id",
  "--parent-context-ref",
  "--target-branch",
  "--target-worktree",
]);

function validateInitOptionValues(argv: string[]): void {
  for (let i = 1; i < argv.length; i += 1) {
    const argument = argv[i];
    if (!argument?.startsWith("--")) continue;
    const separator = argument.indexOf("=");
    const option = separator < 0 ? argument : argument.slice(0, separator);
    if (!STEPPER_INIT_VALUE_OPTIONS.has(option)) continue;
    if (separator >= 0) {
      inlineOptionValue(argument, option);
    } else {
      requiredOptionValue(argv, ++i, option);
    }
  }
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
    if (arg === "--repo") repo = requiredOptionValue(body, ++i, "--repo");
    else if (arg?.startsWith("--repo=")) repo = inlineOptionValue(arg, "--repo");
    else if (arg === "--cwd" || arg?.startsWith("--cwd=")) {
      throw new Error("loopship stepper no longer accepts --cwd; use --repo or run from the repo root");
    } else if (arg === "--json") json = requiredOptionValue(body, ++i, "--json");
    else if (arg?.startsWith("--json=")) json = inlineOptionValue(arg, "--json");
    else if (arg === "--help" || arg === "-h") throw new Error("__STEPPER_HELP__");
    else if (arg?.startsWith("-")) throw new Error(`unknown stepper argument: ${arg}`);
    else if (arg !== undefined) throw new Error(`unknown stepper argument: ${arg}`);
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

function writeJson(payload: Record<string, unknown>): number {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return 0;
}

async function runInit(argv: string[]): Promise<number> {
  validateInitOptionValues(argv);
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
  const payload = readJsonSource(args.json, "stepper step");
  const request = nativeResumeRequest(payload);
  if (!request) {
    throw new Error("stepper step requires a native Fastflow resume payload with sessionId");
  }
  const workspaceRoot = String(request.workspaceRoot ?? "").trim();
  if (!workspaceRoot) {
    throw new Error("stepper step requires the native Fastflow workspaceRoot");
  }
  const repoRoot = args.repo
    ? defaultRepoRoot(args.repo)
    : dirname(dirname(resolve(workspaceRoot)));
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
