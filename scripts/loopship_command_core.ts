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
  createLoopshipShim,
  ensureGlobalSkillFiles,
  resolveGlobalLoopshipBinPath,
} from "./loopship_core.ts";
import {
  LOOPSHIP_DEFAULT_CHILD_MAX_CONCURRENCY,
  LOOPSHIP_MAX_CHILD_MAX_CONCURRENCY,
  recoverLoopshipFastflowWorkflow,
  resolveLoopshipFlowId,
  resumeLoopshipFastflowWorkflow,
  runLoopshipFastflowWorkflow,
} from "./loopship_fastflow.ts";
import {
  detectHandbookDuplicates,
  fixHandbookDuplicates,
  renderLoopshipHandbook,
  writeLoopshipHandbook,
} from "./loopship_handbook.ts";
import {
  nativeResumeRequest,
} from "./loopship_resume.ts";
import {
  resolveHookRoute,
  runtimeHookPayload,
  runtimeHookThreadId,
} from "./loopship_hook_state.ts";
import {
  expandHome,
  readJson,
  readText,
  resolveCwd,
  shellQuote,
  tsShellCommand,
  type Runtime,
  writeJson,
  writeText,
} from "./loopship_utils.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

export type LoopshipRuntimeName = Runtime | "all";

export type LoopshipCommandResult = {
  result: Record<string, unknown>;
  statusCode: number;
};

export class LoopshipCommandError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "LoopshipCommandError";
    this.code = code;
    this.details = details;
  }
}

export type LoopshipInitRequest = {
  request?: unknown;
  repo?: unknown;
  runtime?: unknown;
  flow?: unknown;
  wtree?: unknown;
  sourceBranch?: unknown;
  parentWtree?: unknown;
  parentTaskId?: unknown;
  parentContextRef?: unknown;
  targetBranch?: unknown;
  targetWorktree?: unknown;
  skillHome?: unknown;
  maxConcurrency?: unknown;
};

export type LoopshipResumeRequest = {
  repo?: unknown;
  wtree?: unknown;
  payload?: unknown;
};

export type LoopshipHookRequest = {
  runtime?: unknown;
  repo?: unknown;
  wtree?: unknown;
  payload?: unknown;
};

export type LoopshipDoctorRequest = {
  repo?: unknown;
  runtime?: unknown;
  fix?: unknown;
  hookScript?: unknown;
};

export type LoopshipHandbookRequest = {
  repo?: unknown;
  raw?: unknown;
  duplicates?: unknown;
  fixDuplicates?: unknown;
  failOnDuplicates?: unknown;
  minChars?: unknown;
  outputJson?: unknown;
};

function invalid(message: string): LoopshipCommandError {
  return new LoopshipCommandError("invalid-request", message);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {},
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid(`${label} must be a string`);
  const normalized = value.trim();
  if (!options.allowEmpty && !normalized) {
    throw invalid(`${label} requires a value`);
  }
  return normalized;
}

function optionalString(
  request: Record<string, unknown>,
  key: string,
  label = `--${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`,
): string | null {
  if (!(key in request)) return null;
  return requiredString(request[key], label);
}

function runtimeName(value: unknown): LoopshipRuntimeName {
  if (value === undefined || value === null || value === "") return "all";
  const normalized = requiredString(value, "runtime");
  if (!normalized || !["codex", "gemini", "copilot", "all"].includes(normalized)) {
    throw invalid("runtime must be codex, gemini, copilot, or all");
  }
  return normalized as LoopshipRuntimeName;
}

function positiveInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalid(`${label} must be a positive integer`);
  }
  return value;
}

function initConcurrency(value: unknown): number {
  const normalized = value === undefined || value === null
    ? LOOPSHIP_DEFAULT_CHILD_MAX_CONCURRENCY
    : value;
  if (
    typeof normalized !== "number" ||
    !Number.isInteger(normalized) ||
    normalized < 1 ||
    normalized > LOOPSHIP_MAX_CHILD_MAX_CONCURRENCY
  ) {
    throw invalid(
      `max_concurrency must be an integer from 1 to ${LOOPSHIP_MAX_CHILD_MAX_CONCURRENCY}`,
    );
  }
  return normalized;
}

function ensureRepo(path: string): string {
  const repo = resolve(expandHome(path));
  if (!existsSync(repo)) throw invalid(`repo path does not exist: ${repo}`);
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

function resolveRepoContext(input: {
  repo?: string | null;
  payload?: Record<string, unknown> | null;
  cwd?: string | null;
} = {}): { repoRoot: string; source: string } {
  if (input.repo) return { repoRoot: ensureRepo(input.repo), source: "flag" };
  const payload = input.payload ?? {};
  const candidates: unknown[] = [
    payload.loopship_repo_root,
    payload.loopshipRepoRoot,
    payload.repo_root,
    payload.repoRoot,
    payload.cwd,
    input.cwd,
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
    if (existsSync(resolved)) return { repoRoot: realpathSync(resolved), source: "cwd" };
  }
  throw invalid("cannot resolve loopship context");
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

type LoopshipHookCommandKind = "loopship" | "legacy";

function normalizeHookCommand(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\'\"]/g, " ")
    .replace(/--json\s*=\s*@-/g, "--json @-")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyLoopshipHookCommand(value: unknown): LoopshipHookCommandKind | null {
  const normalized = normalizeHookCommand(value);
  if (!normalized) return null;
  if (/(^|[\s\/\\])tasks_loop_hook\.(ts|py)(\s|$)/.test(normalized)) return "legacy";
  if (normalized.includes("loopship") && /\bhook\b/.test(normalized)) return "loopship";
  return null;
}

function isLoopshipHookCommand(value: unknown): boolean {
  return classifyLoopshipHookCommand(value) !== null;
}

function installCodexHook(repoRoot: string, command: string): string {
  const path = resolve(repoRoot, ".codex", "hooks.json");
  ensureGitInfoExcludeEntries(repoRoot, [".codex/hooks.json"]);
  const config = (readJson(path) ?? {}) as Record<string, unknown>;
  const hooks = (config.hooks ??= {}) as Record<string, unknown>;
  const groups = (hooks.Stop ??= []) as Array<Record<string, unknown>>;
  const normalized: Array<Record<string, unknown>> = [];
  for (const group of groups) {
    const items = Array.isArray(group.hooks)
      ? (group.hooks as Array<Record<string, unknown>>)
      : [];
    const kept = items.filter((item) => !isLoopshipHookCommand(item.command));
    if (kept.length) normalized.push({ ...group, hooks: kept });
  }
  normalized.push({
    hooks: [
      {
        type: "command",
        command,
        timeout: 30,
        statusMessage: "loopship: evaluating hook",
      },
    ],
  });
  hooks.Stop = normalized;
  writeJson(path, config);
  return path;
}

function installGeminiHook(repoRoot: string, command: string): string {
  const path = resolve(repoRoot, ".gemini", "settings.json");
  ensureGitInfoExcludeEntries(repoRoot, [".gemini/settings.json"]);
  const config = (readJson(path) ?? {}) as Record<string, unknown>;
  const hooksConfig = (config.hooksConfig ??= {}) as Record<string, unknown>;
  hooksConfig.enabled = true;
  const hooks = (config.hooks ??= {}) as Record<string, unknown>;
  const groups = (hooks.AfterAgent ??= []) as Array<Record<string, unknown>>;
  const normalized: Array<Record<string, unknown>> = [];
  for (const group of groups) {
    const items = Array.isArray(group.hooks)
      ? (group.hooks as Array<Record<string, unknown>>)
      : [];
    const kept = items.filter((item) => !isLoopshipHookCommand(item.command));
    if (kept.length) normalized.push({ ...group, hooks: kept });
  }
  normalized.push({
    hooks: [
      {
        name: "loopship-after-agent",
        type: "command",
        command,
        timeout: 10000,
        description: "Continue loopship when work remains",
      },
    ],
  });
  hooks.AfterAgent = normalized;
  writeJson(path, config);
  return path;
}

function installCopilotHook(repoRoot: string, command: string): string {
  const path = resolve(repoRoot, ".github", "hooks", "loopship.json");
  ensureGitInfoExcludeEntries(repoRoot, [".github/hooks/loopship.json"]);
  writeJson(path, {
    version: 1,
    hooks: {
      sessionStart: [{ type: "command", bash: command, timeoutSec: 30 }],
      Stop: [{ type: "command", bash: command, timeoutSec: 30 }],
      sessionEnd: [{ type: "command", bash: command, timeoutSec: 30 }],
      agentStop: [{ type: "command", bash: command, timeoutSec: 30 }],
    },
  });
  const previousHook = resolve(repoRoot, ".github", "hooks", ["task", "loop.json"].join("-"));
  rmSync(previousHook, { force: true });
  return path;
}

function simpleHookCommand(binPath: string, runtime: string): string {
  return [shellQuote(binPath), "hook", "--runtime", runtime, "--json", "@-"].join(" ");
}

function hookCommandNeedsExplicitStdin(value: unknown): boolean {
  const normalized = normalizeHookCommand(value);
  return classifyLoopshipHookCommand(normalized) === "loopship" &&
    !normalized.includes("--json @-");
}

function configuredHookCommands(value: unknown): string[] {
  const commands: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    for (const key of ["command", "bash"]) {
      if (typeof record[key] === "string") commands.push(record[key]);
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== "command" && key !== "bash") visit(child);
    }
  };
  visit(value);
  return commands;
}

function ensureV3Runtime(input: {
  repoRoot: string;
  runtime: LoopshipRuntimeName;
  skillHome?: string | null;
}): void {
  ensureGlobalSkillFiles(input.skillHome);
  const wrapperScript = resolve(SCRIPT_DIR, "loopship.ts");
  const globalBin = resolveGlobalLoopshipBinPath();
  createLoopshipShim(globalBin, wrapperScript);
  const buildHookCommand = (runtime: Runtime): string => simpleHookCommand(globalBin, runtime);
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

function inspectDoctor(
  repoRoot: string,
  runtime: LoopshipRuntimeName,
  hookScript: string | null,
): string[] {
  const globalBin = resolveGlobalLoopshipBinPath();
  const issues: string[] = [];
  if (!existsSync(globalBin)) issues.push(`missing ${globalBin}`);
  const inspectHook = (path: string, label: string): void => {
    if (!existsSync(path)) {
      issues.push(`missing ${label}`);
      return;
    }
    const config = readJson(path);
    for (const [index, command] of configuredHookCommands(config).entries()) {
      const commandLabel = `${label} command ${index + 1}`;
      const kind = classifyLoopshipHookCommand(command);
      if (!kind) continue;
      const normalized = normalizeHookCommand(command);
      if (kind === "legacy") {
        issues.push("old " + commandLabel + " uses tasks_loop_hook");
      } else if (!hookScript && normalized.includes("node -e")) {
        issues.push(`old ${commandLabel} shells through node -e`);
      } else if (normalized.includes(".loopship/bin/loopship")) {
        issues.push(`old ${commandLabel} uses .loopship/bin/loopship`);
      } else if (normalized.includes("--cwd") || normalized.includes("--repo")) {
        issues.push(`old ${commandLabel} embeds a repo path`);
      } else if (!hookScript && hookCommandNeedsExplicitStdin(command)) {
        issues.push(`old ${commandLabel} does not bind hook stdin with --json @-`);
      }
    }
  };
  if (runtime === "codex" || runtime === "all") {
    inspectHook(resolve(repoRoot, ".codex", "hooks.json"), ".codex/hooks.json");
  }
  if (runtime === "gemini" || runtime === "all") {
    inspectHook(resolve(repoRoot, ".gemini", "settings.json"), ".gemini/settings.json");
  }
  if (runtime === "copilot" || runtime === "all") {
    inspectHook(resolve(repoRoot, ".github", "hooks", "loopship.json"), ".github/hooks/loopship.json");
  }
  return issues;
}

export function executeDoctor(request: LoopshipDoctorRequest): LoopshipCommandResult {
  const repoValue = optionalString(request as Record<string, unknown>, "repo", "--repo");
  const runtime = runtimeName(request.runtime);
  const hookScriptValue = optionalString(
    request as Record<string, unknown>,
    "hookScript",
    "--hook-script",
  );
  const hookScript = hookScriptValue
    ? resolve(expandHome(hookScriptValue))
    : null;
  const repoRoot = resolveRepoContext({ repo: repoValue }).repoRoot;
  const fix = request.fix === true;
  if (request.fix !== undefined && typeof request.fix !== "boolean") {
    throw invalid("fix must be a boolean");
  }
  const issues = inspectDoctor(repoRoot, runtime, hookScript);
  if (!fix) {
    return {
      result: {
        status: issues.length ? "issues" : "healthy",
        repo: repoRoot,
        items: issues,
        ...(issues.length ? { rerun_with_fix: true } : {}),
      },
      statusCode: issues.length ? 2 : 0,
    };
  }

  const wrapperScript = resolve(SCRIPT_DIR, "loopship.ts");
  const globalBin = resolveGlobalLoopshipBinPath();
  createLoopshipShim(globalBin, wrapperScript);
  const buildHookCommand = (runtimeNameValue: Runtime): string => {
    if (hookScript) {
      const wrapJs =
        "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{let p={};try{p=s.trim()?JSON.parse(s):{}}catch{};process.stdout.write(JSON.stringify({version:'2',request_id:'hook-'+Date.now(),command:'hook',context:{runtime:" +
        JSON.stringify(runtimeNameValue) +
        ",cwd:process.cwd()},metadata:{},payload:p}))})";
      return `bun -e ${shellQuote(wrapJs)} | ${tsShellCommand(hookScript, ["hook", "--json", "@-"])}`;
    }
    return simpleHookCommand(globalBin, runtimeNameValue);
  };
  const written: string[] = [];
  if (runtime === "codex" || runtime === "all") {
    written.push(installCodexHook(repoRoot, buildHookCommand("codex")));
  }
  if (runtime === "gemini" || runtime === "all") {
    written.push(installGeminiHook(repoRoot, buildHookCommand("gemini")));
  }
  if (runtime === "copilot" || runtime === "all") {
    written.push(installCopilotHook(repoRoot, buildHookCommand("copilot")));
  }
  return {
    result: { status: "fixed", repo: repoRoot, items: written },
    statusCode: 0,
  };
}

function assertInitIsNewQuest(repoRoot: string, wtree: string | null): void {
  if (!wtree) return;
  const tasksPath = join(repoRoot, "worktrees", wtree, ".loopship", "runtime", "tasks.yaml");
  if (!existsSync(tasksPath)) return;
  throw new LoopshipCommandError(
    "invalid-request",
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

function booleanValue(
  request: Record<string, unknown>,
  key: string,
  label: string,
): boolean {
  if (!(key in request)) return false;
  if (typeof request[key] !== "boolean") throw invalid(`${label} must be a boolean`);
  return request[key] as boolean;
}

function payloadValue(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} requires a JSON object payload`);
  }
  return value as Record<string, unknown>;
}

function resultObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function nativeResume(value: Record<string, unknown>): Record<string, unknown> | null {
  try {
    return nativeResumeRequest(value);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
}

function hookRuntime(value: unknown): string {
  const normalized = value === undefined || value === null || value === ""
    ? "codex"
    : requiredString(value, "runtime");
  if (!normalized) throw invalid("runtime requires a value");
  return normalized;
}

export async function executeInit(
  request: LoopshipInitRequest,
): Promise<LoopshipCommandResult> {
  const source = request as Record<string, unknown>;
  const objective = request.request === undefined
    ? ""
    : requiredString(request.request, "request", { allowEmpty: true }) ?? "";
  const repoValue = optionalString(source, "repo", "--repo");
  const runtime = runtimeName(request.runtime);
  const flow = optionalString(source, "flow", "--flow");
  const wtree = optionalString(source, "wtree", "--wtree");
  const sourceBranch = optionalString(source, "sourceBranch", "--source-branch");
  const parentWtree = optionalString(source, "parentWtree", "--parent-wtree");
  const parentTaskId = optionalString(source, "parentTaskId", "--parent-task-id");
  const parentContextRef = optionalString(source, "parentContextRef", "--parent-context-ref");
  const targetBranch = optionalString(source, "targetBranch", "--target-branch");
  const targetWorktree = optionalString(source, "targetWorktree", "--target-worktree");
  const skillHome = optionalString(source, "skillHome", "--skill-home");
  const maxConcurrency = initConcurrency(request.maxConcurrency);
  const repoRoot = resolveRepoContext({ repo: repoValue }).repoRoot;

  if (objective) {
    assertInitIsNewQuest(repoRoot, wtree);
    let flowId: string;
    try {
      flowId = resolveLoopshipFlowId(flow);
    } catch (error) {
      if (flow) {
        throw invalid(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
    ensureV3Runtime({ repoRoot, runtime, skillHome });
    const result = await runLoopshipFastflowWorkflow({
      repoRoot,
      flowId,
      inputs: {
        request: objective,
        runtime,
        repoRoot,
        maxConcurrency,
        ...(wtree ? { wtree } : {}),
        ...(sourceBranch ? { sourceBranch } : {}),
        ...(parentWtree ? { parentWtree } : {}),
        ...(parentTaskId ? { parentTaskId } : {}),
        ...(parentContextRef ? { parentContextRef } : {}),
        ...(targetBranch ? { targetBranch } : {}),
        ...(targetWorktree ? { targetWorktree } : {}),
      },
      progressMode: "compact",
    });
    return { result: resultObject(result), statusCode: 0 };
  }

  const doctor = executeDoctor({ repo: repoRoot, runtime, fix: true });
  if (doctor.statusCode !== 0) {
    throw invalid("init could not repair Loopship runtime scaffolding");
  }
  const skill = ensureGlobalSkillFiles(skillHome);
  return {
    result: { mode: "installer", repo: repoRoot, files: [skill] },
    statusCode: 0,
  };
}

export async function executeResume(
  request: LoopshipResumeRequest,
): Promise<LoopshipCommandResult> {
  const source = request as Record<string, unknown>;
  const repoValue = optionalString(source, "repo", "--repo");
  const wtree = optionalString(source, "wtree", "--wtree");
  const rawPayload = payloadValue(request.payload, "resume payload");
  const hasPayload = Object.prototype.hasOwnProperty.call(source, "payload");
  if (hasPayload && wtree) {
    throw invalid("loopship resume accepts either --wtree or --json, not both");
  }

  if (hasPayload) {
    const envelopeLike = rawPayload.command === "hook" && rawPayload.payload !== undefined;
    const payload = envelopeLike ? payloadValue(rawPayload.payload, "resume payload") : rawPayload;
    const native = nativeResume(payload);
    if (!native) {
      throw invalid("loopship resume --json requires a native Fastflow payload with sessionId");
    }
    const contextPayload = {
      ...(envelopeLike ? objectValue(rawPayload.context) : {}),
      ...(envelopeLike ? objectValue(rawPayload.metadata) : {}),
      ...payload,
    };
    const context = resolveRepoContext({
      repo: repoValue,
      payload: contextPayload,
      cwd: resolveCwd(contextPayload),
    });
    const result = await resumeLoopshipFastflowWorkflow({
      repoRoot: context.repoRoot,
      request: native,
    });
    return { result: resultObject(result), statusCode: 0 };
  }

  if (!wtree) {
    throw invalid("loopship resume requires --wtree or --json: use --wtree for canonical recovery and --json for a Fastflow handoff");
  }
  const context = resolveRepoContext({ repo: repoValue, cwd: process.cwd() });
  const result = await recoverLoopshipFastflowWorkflow({
    repoRoot: context.repoRoot,
    wtree,
    progressMode: "compact",
  });
  return { result: resultObject(result), statusCode: 0 };
}

export async function executeHook(
  request: LoopshipHookRequest,
): Promise<LoopshipCommandResult> {
  const source = request as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(source, "payload")) {
    throw invalid("hook requires --json <json|@file|@->; bind runtime hook stdin with --json @-");
  }
  const raw = payloadValue(request.payload, "hook payload");
  const envelopeLike = raw.command === "hook" && raw.payload !== undefined;
  const payload = envelopeLike ? payloadValue(raw.payload, "hook payload") : raw;
  const contextPayload = {
    ...(envelopeLike ? objectValue(raw.context) : {}),
    ...(envelopeLike ? objectValue(raw.metadata) : {}),
    ...payload,
  };
  const explicitRuntime = source.runtime === undefined
    ? null
    : requiredString(source.runtime, "runtime");
  const runtime = hookRuntime(
    explicitRuntime ?? contextPayload.runtime ?? (envelopeLike ? objectValue(raw.context).runtime : null),
  );
  const repoValue = optionalString(source, "repo", "--repo");
  const explicitWtree = optionalString(source, "wtree", "--wtree");

  if (runtimeHookPayload(payload)) {
    const threadId = runtimeHookThreadId(payload);
    if (!threadId) return { result: {}, statusCode: 0 };
    const context = resolveRepoContext({
      repo: repoValue,
      payload: contextPayload,
      cwd: resolveCwd(contextPayload),
    });
    const payloadWtree = String(payload.wtree ?? payload.loopship_wtree ?? "").trim();
    const transferWtree = explicitWtree || payloadWtree;
    const envWtree = String(process.env.WTREE ?? process.env.LOOPSHIP_WTREE ?? "").trim();
    const routeWtree = transferWtree || envWtree;
    const route = resolveHookRoute({
      repoRoot: context.repoRoot,
      runtime,
      threadId,
      ...(routeWtree ? { wtree: routeWtree } : {}),
      ...(transferWtree ? { allowTransfer: true } : {}),
    });
    if (!route || !Object.prototype.hasOwnProperty.call(payload, "response")) {
      return { result: {}, statusCode: 0 };
    }
    const native = nativeResume({
      ...route.fastflow,
      response: payload.response,
    });
    if (!native) return { result: {}, statusCode: 0 };
    const result = await resumeLoopshipFastflowWorkflow({
      repoRoot: context.repoRoot,
      workspaceRoot: route.workspace_root,
      request: native,
    });
    return { result: resultObject(result), statusCode: 0 };
  }

  const native = nativeResume(payload);
  if (!native) return { result: {}, statusCode: 0 };
  const context = resolveRepoContext({
    repo: repoValue,
    payload: contextPayload,
    cwd: resolveCwd(contextPayload),
  });
  const result = await resumeLoopshipFastflowWorkflow({
    repoRoot: context.repoRoot,
    request: native,
  });
  return { result: resultObject(result), statusCode: 0 };
}

export async function executeHandbook(
  request: LoopshipHandbookRequest,
): Promise<LoopshipCommandResult> {
  const source = request as Record<string, unknown>;
  const repo = optionalString(source, "repo", "--repo") ?? undefined;
  const raw = booleanValue(source, "raw", "raw");
  const duplicates = booleanValue(source, "duplicates", "duplicates");
  const fixDuplicates = booleanValue(source, "fixDuplicates", "fix_duplicates");
  const failOnDuplicates = booleanValue(source, "failOnDuplicates", "fail_on_duplicates");
  const outputJson = booleanValue(source, "outputJson", "output_json");
  void outputJson;
  const minChars = positiveInteger(source.minChars, "min_chars");

  if (fixDuplicates) {
    const result = fixHandbookDuplicates(repo, { ...(minChars ? { minChars } : {}) });
    return {
      result: resultObject(result),
      statusCode: failOnDuplicates && result.duplicate_count > 0 ? 2 : 0,
    };
  }
  if (duplicates) {
    const result = detectHandbookDuplicates(repo, { ...(minChars ? { minChars } : {}) });
    return {
      result: resultObject(result),
      statusCode: failOnDuplicates && result.duplicate_count > 0 ? 2 : 0,
    };
  }
  if (raw) return { result: { markdown: renderLoopshipHandbook(repo) }, statusCode: 0 };
  const result = writeLoopshipHandbook(repo);
  return {
    result: { path: result.path, file_url: result.file_url },
    statusCode: 0,
  };
}

export async function executeLoopshipCommand(
  commandPath: string,
  params: Record<string, unknown> = {},
): Promise<LoopshipCommandResult> {
  switch (commandPath) {
    case "init":
      return executeInit(params);
    case "resume":
      return executeResume(params);
    case "hook":
      return executeHook(params);
    case "doctor":
      return executeDoctor(params);
    case "handbook":
      return executeHandbook(params);
    default:
      throw new LoopshipCommandError(
        "unsupported-command",
        `Unsupported public command ${commandPath}`,
      );
  }
}
