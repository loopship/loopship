#!/usr/bin/env bun

import { resolve } from "node:path";
import {
  resolveLoopshipFlowId,
  resumeLoopshipFastflowWorkflow,
  runLoopshipFastflowWorkflow,
} from "./loopship_fastflow.ts";
import {
  expandHome,
  readJson,
  readStdinJson,
} from "./loopship_utils.ts";

type StepperCommand = "init" | "step" | "hook";

type StepperArgs = {
  command: StepperCommand;
  repo: string | null;
  runtime: string | null;
  json: string | null;
  request: string | null;
  flow: string | null;
  wtree: string | null;
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
  let runtime: string | null = null;
  let json: string | null = null;
  let flow: string | null = null;
  let wtree: string | null = null;
  const requestParts: string[] = [];
  const command = argv[0];
  let stepperCommand: StepperCommand;
  let body: string[];

  if (command === "init") {
    stepperCommand = "init";
    body = argv.slice(1);
  } else if (command === "step") {
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
    } else if (arg === "--wtree") wtree = body[++i] ?? null;
    else if (arg?.startsWith("--wtree=")) wtree = arg.slice("--wtree=".length);
    else if (arg === "--runtime") runtime = body[++i] ?? null;
    else if (arg?.startsWith("--runtime="))
      runtime = arg.slice("--runtime=".length);
    else if (arg === "--json") json = body[++i] ?? "@-";
    else if (arg?.startsWith("--json=")) json = arg.slice("--json=".length);
    else if (arg === "--flow") flow = body[++i] ?? null;
    else if (arg?.startsWith("--flow=")) flow = arg.slice("--flow=".length);
    else if (arg === "--help" || arg === "-h") throw new Error("__STEPPER_HELP__");
    else if (arg === "--full") continue;
    else if (arg?.startsWith("-")) throw new Error(`unknown stepper argument: ${arg}`);
    else if (arg !== undefined && stepperCommand === "init") requestParts.push(arg);
  }

  return {
    command: stepperCommand,
    repo,
    runtime,
    json,
    request: requestParts.join(" ").trim() || null,
    flow,
    wtree,
  };
}

function defaultRepoRoot(repo: string | null): string {
  if (repo) return resolve(expandHome(repo));
  return resolve(process.cwd());
}

function normalizeRequestText(request: string | null): string {
  const raw = String(request ?? "").trim();
  if (!raw) {
    throw new Error('stepper init requires a request, for example: loopship stepper init "loopship: build the app" --runtime codex');
  }
  return /^loopship:/i.test(raw) ? raw : `loopship: ${raw}`;
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

function nativeResumeRequest(value: Record<string, unknown>): Record<string, unknown> | null {
  const source =
    value.fastflow && typeof value.fastflow === "object" && !Array.isArray(value.fastflow)
      ? (value.fastflow as Record<string, unknown>)
      : value.resume && typeof value.resume === "object" && !Array.isArray(value.resume)
        ? (value.resume as Record<string, unknown>)
        : value;
  const sessionId = String(source.sessionId ?? source.session_id ?? "").trim();
  if (!sessionId) return null;
  return { ...source, sessionId };
}

function writeJson(payload: Record<string, unknown>): number {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  return 0;
}

async function runInit(args: StepperArgs): Promise<number> {
  const repoRoot = defaultRepoRoot(args.repo);
  const flowId = resolveLoopshipFlowId(args.flow);
  const result = await runLoopshipFastflowWorkflow({
    repoRoot,
    flowId,
    inputs: {
      request: normalizeRequestText(args.request),
      runtime: args.runtime || "codex",
      repo: repoRoot,
      repoRoot,
      ...(args.wtree ? { wtree: args.wtree } : {}),
    },
    superviseStep: true,
    progressMode: "compact",
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
  if (args.command === "init") return await runInit(args);
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
