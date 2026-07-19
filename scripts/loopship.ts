#!/usr/bin/env bun

import * as child_process from "node:child_process";
import {
  existsSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expandHome,
  readJson,
  readStdinText,
  readText,
  resolveCwd,
  shellQuote,
  tsShellCommand,
  writeJson,
  writeText,
} from "./loopship_utils.ts";
import type { Runtime } from "./loopship_utils.ts";
import {
  createLoopshipShim,
  ensureGlobalSkillFiles,
  resolveGlobalLoopshipBinPath,
} from "./loopship_core.ts";
import { runHandbook } from "./loopship_handbook.ts";
import { runStepperCli } from "./loopship_stepper.ts";
import {
  recoverLoopshipFastflowWorkflow,
  resolveLoopshipFlowId,
  resumeLoopshipFastflowWorkflow,
  runLoopshipFastflowWorkflow,
} from "./loopship_fastflow.ts";
import { nativeResumeRequest } from "./loopship_resume.ts";
import {
  resolveHookRoute,
  runtimeHookPayload,
  runtimeHookThreadId,
} from "./loopship_hook_state.ts";

export { nativeResumeRequest } from "./loopship_resume.ts";

type Command =
  | "init"
  | "resume"
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
  loopship resume --repo <path> --wtree <name>
  loopship resume --repo <path> --json <fastflow-resume-json|@file|@->
  loopship hook --runtime <runtime> [--wtree <name>]
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
    !["init", "resume", "doctor", "hook", "stepper", "cmdproto", "handbook"].includes(cmd)
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

function parseInitArgs(argv: string[]): {
  repo: string;
  wtree: string | null;
  flowId: string | null;
  objective: string;
  runtime: DoctorArgs["runtime"];
  skillHome: string | null;
  sourceBranch: string | null;
  parentWtree: string | null;
  parentTaskId: string | null;
  parentContextRef: string | null;
  targetBranch: string | null;
  targetWorktree: string | null;
} {
  let repo: string | null = null;
  let wtree: string | null = null;
  let flowId: string | null = null;
  let runtime: DoctorArgs["runtime"] = "all";
  let skillHome: string | null = null;
  let sourceBranch: string | null = null;
  let parentWtree: string | null = null;
  let parentTaskId: string | null = null;
  let parentContextRef: string | null = null;
  let targetBranch: string | null = null;
  let targetWorktree: string | null = null;
  const objectiveParts: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") repo = requiredOptionValue(argv, ++i, "--repo");
    else if (arg?.startsWith("--repo=")) repo = inlineOptionValue(arg, "--repo");
    else if (arg === "--cwd" || arg?.startsWith("--cwd=")) {
      throw new Error("loopship init no longer accepts --cwd; run it from the repo root or pass --repo");
    } else if (arg === "--session" || arg?.startsWith("--session=")) {
      throw new Error("loopship init no longer accepts --session");
    } else if (arg === "--wtree") wtree = requiredOptionValue(argv, ++i, "--wtree");
    else if (arg?.startsWith("--wtree=")) wtree = inlineOptionValue(arg, "--wtree");
    else if (arg === "--source-branch")
      sourceBranch = requiredOptionValue(argv, ++i, "--source-branch");
    else if (arg?.startsWith("--source-branch="))
      sourceBranch = inlineOptionValue(arg, "--source-branch");
    else if (arg === "--parent-wtree")
      parentWtree = requiredOptionValue(argv, ++i, "--parent-wtree");
    else if (arg?.startsWith("--parent-wtree="))
      parentWtree = inlineOptionValue(arg, "--parent-wtree");
    else if (arg === "--parent-task-id")
      parentTaskId = requiredOptionValue(argv, ++i, "--parent-task-id");
    else if (arg?.startsWith("--parent-task-id="))
      parentTaskId = inlineOptionValue(arg, "--parent-task-id");
    else if (arg === "--parent-context-ref")
      parentContextRef = requiredOptionValue(argv, ++i, "--parent-context-ref");
    else if (arg?.startsWith("--parent-context-ref="))
      parentContextRef = inlineOptionValue(arg, "--parent-context-ref");
    else if (arg === "--target-branch")
      targetBranch = requiredOptionValue(argv, ++i, "--target-branch");
    else if (arg?.startsWith("--target-branch="))
      targetBranch = inlineOptionValue(arg, "--target-branch");
    else if (arg === "--target-worktree")
      targetWorktree = requiredOptionValue(argv, ++i, "--target-worktree");
    else if (arg?.startsWith("--target-worktree="))
      targetWorktree = inlineOptionValue(arg, "--target-worktree");
    else if (arg === "--flow") flowId = requiredOptionValue(argv, ++i, "--flow");
    else if (arg?.startsWith("--flow=")) flowId = inlineOptionValue(arg, "--flow");
    else if (arg === "--runtime")
      runtime = requiredOptionValue(argv, ++i, "--runtime") as DoctorArgs["runtime"];
    else if (arg?.startsWith("--runtime="))
      runtime = inlineOptionValue(arg, "--runtime") as DoctorArgs["runtime"];
    else if (arg === "--skill-home")
      skillHome = requiredOptionValue(argv, ++i, "--skill-home");
    else if (arg?.startsWith("--skill-home="))
      skillHome = inlineOptionValue(arg, "--skill-home");
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
    runtime,
    skillHome,
    sourceBranch: sourceBranch?.trim() || null,
    parentWtree: parentWtree?.trim() || null,
    parentTaskId: parentTaskId?.trim() || null,
    parentContextRef: parentContextRef?.trim() || null,
    targetBranch: targetBranch?.trim() || null,
    targetWorktree: targetWorktree?.trim() || null,
  };
}

function parseDoctorArgs(argv: string[]): DoctorArgs {
  let repo = process.cwd();
  let runtime: DoctorArgs["runtime"] = "all";
  let fix = false;
  let hookScript: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") repo = requiredOptionValue(argv, ++i, "--repo");
    else if (arg?.startsWith("--repo=")) repo = inlineOptionValue(arg, "--repo");
    else if (arg === "--runtime")
      runtime = requiredOptionValue(argv, ++i, "--runtime") as DoctorArgs["runtime"];
    else if (arg?.startsWith("--runtime="))
      runtime = inlineOptionValue(arg, "--runtime") as DoctorArgs["runtime"];
    else if (arg === "--fix") fix = true;
    else if (arg === "--hook-script")
      hookScript = requiredOptionValue(argv, ++i, "--hook-script");
    else if (arg?.startsWith("--hook-script="))
      hookScript = inlineOptionValue(arg, "--hook-script");
    else if (arg !== undefined) throw new Error(`unknown doctor argument: ${arg}`);
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
  ensureGitInfoExcludeEntries(repoRoot, [".codex/hooks.json"]);
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
  ensureGitInfoExcludeEntries(repoRoot, [".gemini/settings.json"]);
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
  ensureGitInfoExcludeEntries(repoRoot, [".github/hooks/loopship.json"]);
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
      return `bun -e ${shellQuote(wrapJs)} | ${tsShellCommand(args.hookScript, ["hook", "--json", "@-"])}`;
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
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function readJsonArg(json: string | null): Record<string, any> {
  if (!json) return {};
  let raw = json;
  if (json === "@-") {
    raw = readStdinText();
  } else if (json.startsWith("@")) {
    const path = resolve(expandHome(json.slice(1)));
    if (!existsSync(path)) throw new Error(`hook JSON file does not exist: ${path}`);
    raw = readText(path);
  }
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("hook requires a JSON object payload");
  }
  return parsed as Record<string, any>;
}

function simpleHookCommand(binPath: string, runtime: string): string {
  return [shellQuote(binPath), "hook", "--runtime", runtime].join(" ");
}

function gitInfoExcludePath(repoRoot: string): string | null {
  try {
    const stdout = child_process.execSync("git rev-parse --git-path info/exclude", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const path = stdout.trim();
    return path ? resolve(repoRoot, path) : null;
  } catch {
    return null;
  }
}

function ensureGitInfoExcludeEntries(repoRoot: string, entries: string[]): void {
  const path = gitInfoExcludePath(repoRoot);
  if (!path) return;
  const text = readText(path);
  const existing = new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missing = entries.filter((entry) => !existing.has(entry));
  if (!missing.length) return;
  const prefix = text && !text.endsWith("\n") ? `${text}\n` : text;
  writeText(path, `${prefix}${missing.join("\n")}\n`);
}

function readHookJsonArg(json: string | null): Record<string, any> {
  if (json) return readJsonArg(json);
  if (process.stdin.isTTY) return {};
  return readJsonArg("@-");
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
    if (arg === "--repo") repo = requiredOptionValue(argv, ++i, "--repo");
    else if (arg?.startsWith("--repo=")) repo = inlineOptionValue(arg, "--repo");
    else if (arg === "--cwd" || arg?.startsWith("--cwd=")) {
      throw new Error("loopship no longer accepts --cwd; use --wtree and run from a repo/worktree context");
    } else if (arg === "--session" || arg?.startsWith("--session=")) {
      throw new Error("loopship no longer accepts --session; use --wtree");
    } else if (arg === "--wtree") wtree = requiredOptionValue(argv, ++i, "--wtree");
    else if (arg?.startsWith("--wtree=")) wtree = inlineOptionValue(arg, "--wtree");
    else if (arg === "--runtime")
      runtime = requiredOptionValue(argv, ++i, "--runtime") as Runtime;
    else if (arg?.startsWith("--runtime="))
      runtime = inlineOptionValue(arg, "--runtime") as Runtime;
    else if (arg === "--json") json = requiredOptionValue(argv, ++i, "--json");
    else if (arg?.startsWith("--json=")) json = inlineOptionValue(arg, "--json");
    else if (arg === "--full") full = true;
    else rest.push(arg);
  }
  return { repo, wtree, runtime, json, full, rest };
}

export async function runHook(argv: string[]): Promise<number> {
  const args = parseQuestRepoArg(argv);
  if (args.rest.length) {
    throw new Error(`unknown hook argument: ${args.rest[0]}`);
  }
  const raw = readHookJsonArg(args.json);
  const envelopeLike = raw.command === "hook";
  const payload = envelopeLike && raw.payload ? raw.payload : raw;
  const contextPayload = {
    ...(envelopeLike ? raw.context : {}),
    ...(envelopeLike ? raw.metadata : {}),
    ...payload,
  };
  const runtime = String(
    args.runtime ?? contextPayload.runtime ?? (envelopeLike ? raw.context?.runtime : null) ?? "codex",
  );
  if (runtimeHookPayload(payload)) {
    const threadId = runtimeHookThreadId(payload);
    if (!threadId) {
      process.stdout.write("{}");
      return 0;
    }
    const context = resolveRepoContext({
      repo: args.repo,
      payload: contextPayload,
      cwd: resolveCwd(contextPayload),
    });
    const payloadWtree = String(payload.wtree ?? payload.loopship_wtree ?? "").trim();
    const transferWtree = args.wtree || payloadWtree;
    const explicitWtree =
      transferWtree ||
      String(process.env.WTREE ?? "").trim() ||
      String(process.env.LOOPSHIP_WTREE ?? "").trim();
    const route = resolveHookRoute({
      repoRoot: context.repoRoot,
      runtime,
      threadId,
      ...(explicitWtree ? { wtree: explicitWtree } : {}),
      ...(transferWtree ? { allowTransfer: true } : {}),
    });
    if (!route) {
      process.stdout.write("{}");
      return 0;
    }
    const hasResponse = Object.prototype.hasOwnProperty.call(payload, "response");
    if (!hasResponse) {
      process.stdout.write("{}");
      return 0;
    }
    const request = nativeResumeRequest({
      ...route.fastflow,
      ...(Object.prototype.hasOwnProperty.call(payload, "response")
        ? { response: payload.response }
        : {}),
    });
    if (!request) {
      process.stdout.write("{}");
      return 0;
    }
    const result = await resumeLoopshipFastflowWorkflow({
      repoRoot: context.repoRoot,
      workspaceRoot: route.workspace_root,
      request,
    });
    questResponse(result);
    return 0;
  }

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

export async function runResume(argv: string[]): Promise<number> {
  const args = parseQuestRepoArg(argv);
  if (args.rest.length) {
    throw new Error(`unknown resume argument: ${args.rest[0]}`);
  }
  if (args.json && args.wtree) {
    throw new Error("loopship resume accepts either --wtree or --json, not both");
  }
  if (args.json) {
    const raw = readHookJsonArg(args.json);
    const envelopeLike = raw.command === "hook";
    const payload = envelopeLike && raw.payload ? raw.payload : raw;
    const request = nativeResumeRequest(payload);
    if (!request) {
      throw new Error("loopship resume --json requires a native Fastflow payload with sessionId");
    }
    const contextPayload = {
      ...(envelopeLike ? raw.context : {}),
      ...(envelopeLike ? raw.metadata : {}),
      ...payload,
    };
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
  if (!args.wtree) {
    throw new Error("loopship resume requires --wtree or --json: use --wtree for canonical recovery and --json for a Fastflow handoff");
  }
  const context = resolveRepoContext({ repo: args.repo, cwd: process.cwd() });
  const result = await recoverLoopshipFastflowWorkflow({
    repoRoot: context.repoRoot,
    wtree: args.wtree,
    progressMode: "compact",
  });
  questResponse(result);
  return 0;
}

export async function runInit(argv: string[]): Promise<number> {
  const args = parseInitArgs(argv);
  if (args.objective) {
    assertInitIsNewQuest(args.repo, args.wtree);
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
        ...(args.sourceBranch ? { sourceBranch: args.sourceBranch } : {}),
        ...(args.parentWtree ? { parentWtree: args.parentWtree } : {}),
        ...(args.parentTaskId ? { parentTaskId: args.parentTaskId } : {}),
        ...(args.parentContextRef ? { parentContextRef: args.parentContextRef } : {}),
        ...(args.targetBranch ? { targetBranch: args.targetBranch } : {}),
        ...(args.targetWorktree ? { targetWorktree: args.targetWorktree } : {}),
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

function assertInitIsNewQuest(repoRoot: string, wtree: string | null): void {
  if (!wtree) return;
  const tasksPath = join(repoRoot, "worktrees", wtree, ".loopship", "runtime", "tasks.yaml");
  if (!existsSync(tasksPath)) return;
  throw new Error(
    [
      `loopship init refused: worktree '${wtree}' is already initialized at ${tasksPath}.`,
      `Recover an interrupted inline run with: loopship resume --repo ${repoRoot} --wtree ${wtree}`,
      "Resume a handoff with the Fastflow pause response instead of starting a new init.",
      "The resume JSON must include sessionId, nonce, workspaceRoot, and exactly one response.answer or response.decision='ok'.",
      "Native resume command: loopship stepper step --json @-",
      `Resume handoff payloads with: loopship resume --repo ${repoRoot} --json @pause-response-with-answer.json`,
      `Resume HITL handoff payloads with: loopship hook --repo ${repoRoot} --json @pause-response-with-answer.json`,
      "Resume superviseStep payloads with: loopship stepper step --json @pause-response-with-decision.json",
      "Start a new quest with a different --wtree.",
    ].join("\n"),
  );
}

export async function runCliCommand(argv: string[]): Promise<number> {
  if (
    argv[0] !== "cmdproto" &&
    argv.includes("--help") &&
    argv.includes("--json") &&
    argv.every((token) => token === "--help" || token === "--json")
  ) {
    const { runLoopshipCmdproto } = await import("./loopship_cmdproto.ts");
    return await runLoopshipCmdproto(argv, {
      control: false,
      handlers: { runInit, runResume, runHook, runDoctor },
    });
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
  if (cmd === "resume") return await runResume(rest);
  if (cmd === "hook") return await runHook(rest);
  if (cmd === "stepper") return await runStepperCli(rest);
  if (cmd === "handbook") return runHandbook(rest);
  if (cmd === "cmdproto") {
    const { runLoopshipCmdproto } = await import("./loopship_cmdproto.ts");
    return await runLoopshipCmdproto(rest, {
      handlers: { runInit, runResume, runHook, runDoctor },
    });
  }
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
