#!/usr/bin/env bun

import * as child_process from "node:child_process";
import {
  existsSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expandHome,
  readJson,
  readStdinJson,
  readText,
  resolveCwd,
  shellQuote,
  tsShellCommand,
  writeJson,
} from "./loopship_utils.ts";
import type { Runtime } from "./loopship_utils.ts";
import {
  createLoopshipShim,
  ensureGlobalSkillFiles,
  resolveGlobalLoopshipBinPath,
} from "./loopship_core.ts";
import { runLoopshipCmdproto } from "./loopship_cmdproto.ts";
import { runHandbook } from "./loopship_handbook.ts";
import { runStepperCli } from "./loopship_stepper.ts";
import {
  resolveLoopshipFlowId,
  resumeLoopshipFastflowWorkflow,
  runLoopshipFastflowWorkflow,
} from "./loopship_fastflow.ts";

type Command =
  | "init"
  | "doctor"
  | "hook"
  | "stepper"
  | "cmdproto"
  | "handbook";

type DoctorArgs = {
  repo: string;
  runtime: "codex" | "gemini" | "copilot" | "all";
  fix: boolean;
  hookScript: string | null;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
function usage(): void {
  console.log(`loopship

Usage:
  loopship init "loopship: <request>" --runtime <codex|gemini|copilot|all> [--flow <id>] [--wtree <name>]
  loopship hook --runtime <codex|gemini|copilot>
  loopship stepper init "loopship: <request>" [--runtime <codex|gemini|copilot>] [--flow <id>] [--wtree <name>]
  loopship stepper step --json <fastflow-resume-json|@file|@->
  loopship stepper hook [--json <fastflow-resume-json|@file|@->]
  loopship doctor [--repo <path>] [--runtime <codex|gemini|copilot|all>] [--fix]
  loopship handbook [--repo <path>] [--raw|--duplicates|--fix-duplicates] [--json] [--min-chars <n>]
  loopship cmdproto --help [--json]
  loopship cmdproto execjson <path> <json|@file|@->
`);
}

function parseCommand(argv: string[]): Command {
  const cmd = argv[0] as Command | undefined;
  if (
    !cmd ||
    !["init", "doctor", "hook", "stepper", "cmdproto", "handbook"].includes(cmd)
  ) {
    usage();
    process.exit(1);
  }
  return cmd as Command;
}

function ensureRepo(path: string): string {
  const repo = resolve(expandHome(path));
  if (!existsSync(repo)) throw new Error(`repo path does not exist: ${repo}`);
  const gitRoot = gitRootFrom(repo);
  const normalized = gitRoot
    ? baseRepoRootFromWorktreeRoot(gitRoot) ?? gitRoot
    : repo;
  return realpathSync(normalized);
}

function gitRootFrom(cwd: string): string | null {
  try {
    const stdout = child_process.execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function baseRepoRootFromWorktreeRoot(path: string): string | null {
  const match = resolve(path).match(/^(.*)[\\/]worktrees[\\/][^\\/]+$/);
  if (!match?.[1]) return null;
  const base = match[1];
  return existsSync(resolve(base, ".git")) ? realpathSync(base) : null;
}

function resolveRepoContext(input?: {
  repo?: string | null;
  payload?: Record<string, any> | null;
  cwd?: string | null;
}): { repoRoot: string; source: string } {
  if (input?.repo) return { repoRoot: ensureRepo(input.repo), source: "flag" };
  const payload = input?.payload ?? {};
  const candidates = [
    payload.loopship_repo_root,
    payload.loopshipRepoRoot,
    payload.repo_root,
    payload.repoRoot,
    payload.cwd,
    input?.cwd,
    process.cwd(),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const resolved = resolve(expandHome(candidate));
    const gitRoot = gitRootFrom(resolved);
    if (gitRoot) {
      const base = baseRepoRootFromWorktreeRoot(gitRoot);
      return {
        repoRoot: realpathSync(base ?? gitRoot),
        source: base ? "repo_worktree" : "git_root",
      };
    }
    if (existsSync(resolve(resolved, ".loopship"))) {
      const base = baseRepoRootFromWorktreeRoot(resolved);
      return {
        repoRoot: realpathSync(base ?? resolved),
        source: base ? "repo_worktree" : "loopship_ancestor",
      };
    }
    let cursor = resolved;
    while (true) {
      if (existsSync(resolve(cursor, ".loopship"))) {
        const base = baseRepoRootFromWorktreeRoot(cursor);
        return {
          repoRoot: realpathSync(base ?? cursor),
          source: base ? "repo_worktree" : "loopship_ancestor",
        };
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (existsSync(resolved))
      return { repoRoot: realpathSync(resolved), source: "cwd" };
  }
  throw new Error("cannot resolve loopship context");
}

function parseInitArgs(argv: string[]): {
  repo: string;
  wtree: string | null;
  flowId: string | null;
  objective: string;
  force: boolean;
  runtime: DoctorArgs["runtime"];
  skillHome: string | null;
} {
  let repo: string | null = null;
  let wtree: string | null = null;
  let flowId: string | null = null;
  let force = false;
  let runtime: DoctorArgs["runtime"] = "all";
  let skillHome: string | null = null;
  const objectiveParts: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") repo = argv[++i] ?? repo;
    else if (arg?.startsWith("--repo=")) repo = arg.slice("--repo=".length);
    else if (arg === "--cwd" || arg?.startsWith("--cwd=")) {
      throw new Error("loopship init no longer accepts --cwd; run it from the repo root or pass --repo");
    } else if (arg === "--session" || arg?.startsWith("--session=")) {
      throw new Error("loopship init no longer accepts --session");
    } else if (arg === "--wtree") wtree = argv[++i] ?? null;
    else if (arg?.startsWith("--wtree=")) wtree = arg.slice("--wtree=".length);
    else if (arg === "--flow") flowId = argv[++i] ?? flowId;
    else if (arg?.startsWith("--flow=")) flowId = arg.slice("--flow=".length);
    else if (arg === "--force") force = true;
    else if (arg === "--runtime")
      runtime = (argv[++i] as DoctorArgs["runtime"]) ?? runtime;
    else if (arg?.startsWith("--runtime="))
      runtime = arg.slice("--runtime=".length) as DoctorArgs["runtime"];
    else if (arg === "--skill-home") skillHome = argv[++i] ?? null;
    else if (arg?.startsWith("-")) throw new Error(`unknown init argument: ${arg}`);
    else if (arg !== undefined) objectiveParts.push(arg);
  }
  if (!["codex", "gemini", "copilot", "all"].includes(runtime)) {
    throw new Error("--runtime must be codex, gemini, copilot, or all");
  }
  const objective = objectiveParts.join(" ").trim();
  const context = resolveRepoContext({ repo });
  return {
    repo: context.repoRoot,
    wtree,
    flowId: flowId?.trim() || null,
    objective,
    force,
    runtime,
    skillHome,
  };
}

function parseDoctorArgs(argv: string[]): DoctorArgs {
  let repo = process.cwd();
  let runtime: DoctorArgs["runtime"] = "all";
  let fix = false;
  let hookScript: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") repo = argv[++i] ?? repo;
    else if (arg === "--runtime")
      runtime = (argv[++i] as DoctorArgs["runtime"]) ?? runtime;
    else if (arg === "--fix") fix = true;
    else if (arg === "--hook-script") hookScript = argv[++i] ?? null;
  }
  if (!["codex", "gemini", "copilot", "all"].includes(runtime)) {
    throw new Error("--runtime must be codex, gemini, copilot, or all");
  }
  return {
    repo: ensureRepo(repo),
    runtime,
    fix,
    hookScript: hookScript ? resolve(expandHome(hookScript)) : null,
  };
}

function installCodexHook(repoRoot: string, cmd: string): string {
  const path = resolve(repoRoot, ".codex", "hooks.json");
  const cfg = (readJson(path) ?? {}) as Record<string, any>;
  const hooks = (cfg.hooks ??= {}) as Record<string, any[]>;
  const groups = (hooks.Stop ??= []) as Array<Record<string, unknown>>;
  const normalizeCommand = (value: unknown): string =>
    String(value ?? "")
      .toLowerCase()
      .replace(/['"]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const isLoopshipHookCommand = (value: unknown): boolean => {
    const normalized = normalizeCommand(value);
    if (!normalized) return false;
    if (/(^|\s)tasks_loop_hook\.(ts|py)(\s|$)/.test(normalized)) return true;
    return normalized.includes("loopship") && /\bhook\b/.test(normalized);
  };
  const normalized: Array<Record<string, unknown>> = [];
  for (const group of groups) {
    const items = Array.isArray((group as any).hooks)
      ? (group as any).hooks
      : [];
    const kept = items.filter((item: any) => {
      const command = String(item?.command ?? "");
      return !isLoopshipHookCommand(command);
    });
    if (kept.length) normalized.push({ ...group, hooks: kept });
  }
  normalized.push({
    hooks: [
      {
        type: "command",
        command: cmd,
        timeout: 30,
        statusMessage: "loopship: evaluating hook",
      },
    ],
  });
  hooks.Stop = normalized;
  writeJson(path, cfg);
  return path;
}

function installGeminiHook(repoRoot: string, cmd: string): string {
  const path = resolve(repoRoot, ".gemini", "settings.json");
  const cfg = (readJson(path) ?? {}) as Record<string, any>;
  (cfg.hooksConfig ??= {}).enabled = true;
  const hooks = (cfg.hooks ??= {}) as Record<string, any[]>;
  const groups = (hooks.AfterAgent ??= []) as Array<Record<string, unknown>>;
  const normalizeCommand = (value: unknown): string =>
    String(value ?? "")
      .toLowerCase()
      .replace(/['"]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const isLoopshipHookCommand = (value: unknown): boolean => {
    const normalized = normalizeCommand(value);
    if (!normalized) return false;
    if (/(^|\s)tasks_loop_hook\.(ts|py)(\s|$)/.test(normalized)) return true;
    return normalized.includes("loopship") && /\bhook\b/.test(normalized);
  };
  const normalized: Array<Record<string, unknown>> = [];
  for (const group of groups) {
    const items = Array.isArray((group as any).hooks)
      ? (group as any).hooks
      : [];
    const kept = items.filter((item: any) => {
      const command = String(item?.command ?? "");
      return !isLoopshipHookCommand(command);
    });
    if (kept.length) normalized.push({ ...group, hooks: kept });
  }
  normalized.push({
    hooks: [
      {
        name: "loopship-after-agent",
        type: "command",
        command: cmd,
        timeout: 10000,
        description: "Continue loopship when work remains",
      },
    ],
  });
  hooks.AfterAgent = normalized;
  writeJson(path, cfg);
  return path;
}

function installCopilotHook(repoRoot: string, cmd: string): string {
  const path = resolve(repoRoot, ".github", "hooks", "loopship.json");
  writeJson(path, {
    version: 1,
    hooks: {
      sessionStart: [{ type: "command", bash: cmd, timeoutSec: 30 }],
      Stop: [{ type: "command", bash: cmd, timeoutSec: 30 }],
      sessionEnd: [{ type: "command", bash: cmd, timeoutSec: 30 }],
      agentStop: [{ type: "command", bash: cmd, timeoutSec: 30 }],
    },
  });
  const previousHook = resolve(
    repoRoot,
    ".github",
    "hooks",
    ["task", "loop.json"].join("-"),
  );
  rmSync(previousHook, { force: true });
  return path;
}

export function runDoctor(argv: string[]): number {
  const args = parseDoctorArgs(argv);
  const wrapperScript = resolve(SCRIPT_DIR, "loopship.ts");
  const globalBin = resolveGlobalLoopshipBinPath();
  const repoRoot = args.repo;
  const expectedFiles = [globalBin];
  const issues: string[] = [];
  for (const path of expectedFiles) {
    if (!existsSync(path)) issues.push(`missing ${path}`);
  }
  if (args.runtime === "codex" || args.runtime === "all") {
    const codexPath = resolve(repoRoot, ".codex", "hooks.json");
    if (!existsSync(codexPath)) {
      issues.push("missing .codex/hooks.json");
    } else if (!args.hookScript && readText(codexPath).includes("node -e")) {
      issues.push("old codex hook command shells through node -e");
    } else if (readText(codexPath).includes(".loopship/bin/loopship")) {
      issues.push("old codex hook command uses .loopship/bin/loopship");
    } else if (
      readText(codexPath).includes("--cwd") ||
      readText(codexPath).includes("--repo")
    ) {
      issues.push("old codex hook command embeds a repo path");
    }
  }
  if (args.runtime === "gemini" || args.runtime === "all") {
    const geminiPath = resolve(repoRoot, ".gemini", "settings.json");
    if (!existsSync(geminiPath)) {
      issues.push("missing .gemini/settings.json");
    } else if (!args.hookScript && readText(geminiPath).includes("node -e")) {
      issues.push("old gemini hook command shells through node -e");
    } else if (readText(geminiPath).includes(".loopship/bin/loopship")) {
      issues.push("old gemini hook command uses .loopship/bin/loopship");
    } else if (
      readText(geminiPath).includes("--cwd") ||
      readText(geminiPath).includes("--repo")
    ) {
      issues.push("old gemini hook command embeds a repo path");
    }
  }
  if (args.runtime === "copilot" || args.runtime === "all") {
    const copilotPath = resolve(repoRoot, ".github", "hooks", "loopship.json");
    if (!existsSync(copilotPath)) {
      issues.push("missing .github/hooks/loopship.json");
    } else if (!args.hookScript && readText(copilotPath).includes("node -e")) {
      issues.push("old copilot hook command shells through node -e");
    } else if (
      readText(copilotPath).includes("--cwd") ||
      readText(copilotPath).includes("--repo")
    ) {
      issues.push("old copilot hook command embeds a repo path");
    }
  }

  if (!args.fix) {
    if (!issues.length) {
      console.log(`loopship doctor: status=healthy repo=${repoRoot}`);
      return 0;
    }
    console.log(`loopship doctor: status=issues repo=${repoRoot}`);
    for (const issue of issues) console.log(`- ${issue}`);
    console.log("loopship doctor: rerun with --fix");
    return 2;
  }

  createLoopshipShim(globalBin, wrapperScript);
  const buildHookCommand = (runtime: Runtime): string => {
    if (args.hookScript) {
      const wrapJs =
        "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{let p={};try{p=s.trim()?JSON.parse(s):{}}catch{};process.stdout.write(JSON.stringify({version:'2',request_id:'hook-'+Date.now(),command:'hook',context:{runtime:" +
        JSON.stringify(runtime) +
        ",cwd:process.cwd()},metadata:{},payload:p}))})";
      return `node -e ${shellQuote(wrapJs)} | ${tsShellCommand(args.hookScript, ["hook", "--json", "@-"])}`;
    }
    return simpleHookCommand(globalBin, runtime);
  };
  const codexCmd = buildHookCommand("codex");
  const geminiCmd = buildHookCommand("gemini");
  const copilotCmd = buildHookCommand("copilot");

  const written: string[] = [];
  if (args.runtime === "codex" || args.runtime === "all") {
    written.push(installCodexHook(repoRoot, codexCmd));
  }
  if (args.runtime === "gemini" || args.runtime === "all") {
    written.push(installGeminiHook(repoRoot, geminiCmd));
  }
  if (args.runtime === "copilot" || args.runtime === "all") {
    written.push(installCopilotHook(repoRoot, copilotCmd));
  }

  console.log(`loopship doctor: status=fixed repo=${repoRoot}`);
  for (const path of written) console.log(`- ${path}`);
  return 0;
}

function questResponse(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function readJsonArg(json: string | null): Record<string, any> {
  if (!json) return {};
  if (json === "@-") return readStdinJson() as Record<string, any>;
  if (json.startsWith("@")) {
    return (readJson(resolve(expandHome(json.slice(1)))) ?? {}) as Record<
      string,
      any
    >;
  }
  const parsed = JSON.parse(json);
  return parsed && typeof parsed === "object" ? parsed : {};
}

function simpleHookCommand(binPath: string, runtime: string): string {
  return [shellQuote(binPath), "hook", "--runtime", runtime].join(" ");
}

function readHookJsonArg(json: string | null): Record<string, any> {
  if (json) return readJsonArg(json);
  if (process.stdin.isTTY) return {};
  return readStdinJson() as Record<string, any>;
}

function ensureV3Runtime(input: {
  repoRoot: string;
  runtime: DoctorArgs["runtime"];
  skillHome?: string | null;
}): void {
  ensureGlobalSkillFiles(input.skillHome);
  const wrapperScript = resolve(SCRIPT_DIR, "loopship.ts");
  const globalBin = resolveGlobalLoopshipBinPath();
  createLoopshipShim(globalBin, wrapperScript);
  const buildHookCommand = (runtime: Runtime): string => {
    return simpleHookCommand(globalBin, runtime);
  };
  if (input.runtime === "codex" || input.runtime === "all") {
    installCodexHook(input.repoRoot, buildHookCommand("codex"));
  }
  if (input.runtime === "gemini" || input.runtime === "all") {
    installGeminiHook(input.repoRoot, buildHookCommand("gemini"));
  }
  if (input.runtime === "copilot" || input.runtime === "all") {
    installCopilotHook(input.repoRoot, buildHookCommand("copilot"));
  }
}

function parseQuestRepoArg(argv: string[]): {
  repo: string | null;
  wtree: string | null;
  runtime: Runtime | null;
  json: string | null;
  full: boolean;
  rest: string[];
} {
  let repo: string | null = null;
  let wtree: string | null = null;
  let runtime: Runtime | null = null;
  let json: string | null = null;
  let full = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") repo = argv[++i] ?? null;
    else if (arg?.startsWith("--repo=")) repo = arg.slice("--repo=".length);
    else if (arg === "--cwd" || arg?.startsWith("--cwd=")) {
      throw new Error("loopship no longer accepts --cwd; use --wtree and run from a repo/worktree context");
    } else if (arg === "--session" || arg?.startsWith("--session=")) {
      throw new Error("loopship no longer accepts --session; use --wtree");
    } else if (arg === "--wtree") wtree = argv[++i] ?? null;
    else if (arg?.startsWith("--wtree=")) wtree = arg.slice("--wtree=".length);
    else if (arg === "--runtime") runtime = (argv[++i] as Runtime) ?? null;
    else if (arg?.startsWith("--runtime="))
      runtime = arg.slice("--runtime=".length) as Runtime;
    else if (arg === "--json") json = argv[++i] ?? "@-";
    else if (arg?.startsWith("--json=")) json = arg.slice("--json=".length);
    else if (arg === "--full") full = true;
    else rest.push(arg);
  }
  return { repo, wtree, runtime, json, full, rest };
}

function nativeResumeRequest(value: Record<string, any>): Record<string, unknown> | null {
  const nextCall = value.nextCall && typeof value.nextCall === "object" && !Array.isArray(value.nextCall)
    ? (value.nextCall as Record<string, any>)
    : {};
  const nextArgs = nextCall.args && typeof nextCall.args === "object" && !Array.isArray(nextCall.args)
    ? (nextCall.args as Record<string, any>)
    : {};
  const source =
    value.fastflow && typeof value.fastflow === "object" && !Array.isArray(value.fastflow)
      ? (value.fastflow as Record<string, any>)
      : value.resume && typeof value.resume === "object" && !Array.isArray(value.resume)
        ? (value.resume as Record<string, any>)
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
  for (const field of ["supervisorDecision", "decision", "response"]) {
    if (source[field] !== undefined) request[field] = source[field];
    else if (value[field] !== undefined) request[field] = value[field];
  }
  return request;
}

export async function runHook(argv: string[]): Promise<number> {
  const args = parseQuestRepoArg(argv);
  const raw = readHookJsonArg(args.json);
  const envelopeLike = raw.command === "hook";
  const payload = envelopeLike && raw.payload ? raw.payload : raw;
  const contextPayload = {
    ...(envelopeLike ? raw.context : {}),
    ...(envelopeLike ? raw.metadata : {}),
    ...payload,
  };
  const request = nativeResumeRequest(payload);
  if (!request) {
    process.stdout.write("{}");
    return 0;
  }
  const context = resolveRepoContext({
    repo: args.repo,
    payload: contextPayload,
    cwd: resolveCwd(contextPayload),
  });
  const result = await resumeLoopshipFastflowWorkflow({
    repoRoot: context.repoRoot,
    request,
  });
  questResponse(result);
  return 0;
}

export async function runInit(argv: string[]): Promise<number> {
  const args = parseInitArgs(argv);
  if (args.objective) {
    ensureV3Runtime({
      repoRoot: args.repo,
      runtime: args.runtime,
      skillHome: args.skillHome,
    });
    const flowId = resolveLoopshipFlowId(args.flowId);
    const result = await runLoopshipFastflowWorkflow({
      repoRoot: args.repo,
      flowId,
      inputs: {
        request: args.objective,
        runtime: args.runtime,
        repoRoot: args.repo,
        ...(args.wtree ? { wtree: args.wtree } : {}),
      },
      progressMode: "compact",
    });
    questResponse(result);
    return 0;
  }
  const doctorStatus = runDoctor([
    "--repo",
    args.repo,
    "--runtime",
    args.runtime,
    "--fix",
  ]);
  if (doctorStatus !== 0) return doctorStatus;
  const skill = ensureGlobalSkillFiles(args.skillHome);
  console.log(`loopship init: repo=${args.repo}`);
  console.log(`loopship init: mode=installer`);
  console.log(`- ${skill}`);
  return 0;
}

export async function runCliCommand(argv: string[]): Promise<number> {
  if (
    argv[0] !== "cmdproto" &&
    argv.includes("--help") &&
    argv.includes("--json") &&
    argv.every((token) => token === "--help" || token === "--json")
  ) {
    return runLoopshipCmdproto(argv, { control: false });
  }
  if (
    argv[0] !== "cmdproto" &&
    (argv.includes("--help") || argv.includes("-h"))
  ) {
    usage();
    return 0;
  }
  const cmd = parseCommand(argv);
  const rest = argv.slice(1);
  if (cmd === "init") return await runInit(rest);
  if (cmd === "hook") return await runHook(rest);
  if (cmd === "stepper") return await runStepperCli(rest);
  if (cmd === "handbook") return runHandbook(rest);
  if (cmd === "cmdproto") return runLoopshipCmdproto(rest);
  return runDoctor(rest);
}

async function maybeRunSelfWrapper(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    usage();
    return 1;
  }
  return await runCliCommand(argv);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    return await maybeRunSelfWrapper(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
