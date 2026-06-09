#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expandHome,
  hashText,
  readJson,
  readStdinJson,
  readText,
  resolveCwd,
  runCommand,
  shellQuote,
  tsShellCommand,
  writeJson,
  writeText,
  AUTO_CONTINUE_BUDGET,
} from "./loopo_utils.ts";
import type { Runtime } from "./loopo_utils.ts";
import {
  applyLandingReceipt,
  applyQuestPlanToTasks,
  applyChildSummaryToTasks,
  applyChildStatusToTasks,
  applySystemUpdate,
  appendJsonl,
  coordinatorWorktreePath,
  createLoopoShim,
  createQuest,
  ensureCoordinatorWorkspace,
  ensureTaskWorkspace,
  ensureGlobalSkillFiles,
  ensureGitRootCommit,
  landingTargetWorktreePath,
  LOOPO_ROOT_MANIFEST_FILE,
  parseTasksYaml,
  taskAssignmentBranchRef,
  taskAssignmentChildWtree,
  taskAssignmentWorktreePath,
  type QuestFiles,
  type QuestTask,
  questFiles,
  questWorkspaceRoot,
  renderTasksYaml,
  resolveGlobalLoopoBinPath,
  normalizeName,
  updateQuestStage,
  verifyQuestManifest,
  verifyRootManifest,
  writeQuestManifest,
} from "./loopo_core.ts";
import {
  DEFAULT_FLOW_ID,
  DEFAULT_FLOW_VERSION,
  flowStage,
  flowStep,
  loadFlowDefinition,
  type LoadedLoopoFlow,
} from "./loopo_workflow_runner.ts";
import {
  dereferencedSchemaSource,
  dereferencedV3Schema,
  type LoopoSchemaSource,
  validateSchemaSource,
  validateV3Input,
  v3SchemaPath,
  v3SchemaRef,
} from "./loopo_schema.ts";
import { runLoopoCmdproto } from "./loopo_cmdproto.ts";
import { runHandbook } from "./loopo_handbook.ts";
import { runSimCli } from "./loopo_sim.ts";

type Command =
  | "init"
  | "doctor"
  | "quest"
  | "hook"
  | "sim"
  | "cmdproto"
  | "handbook";

type ParentQuestAssignment = {
  parent_wtree: string;
  task_id: string;
  parent_context_ref: string;
  landing_target_branch: string;
  landing_target_worktree: string;
  merge_lease_id: string;
};

type GitLandingReceipt = {
  source_branch: string;
  target_branch: string;
  target_worktree: string;
  landed_commit: string;
  strategy: "already-up-to-date" | "fast-forward" | "merge-commit";
};

type DoctorArgs = {
  repo: string;
  runtime: "codex" | "gemini" | "copilot" | "all";
  fix: boolean;
  hookScript: string | null;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const NEXT_PAYLOAD_INSTRUCTION =
  "This step is reusable across flows. The orchestrator owns flow transitions and decides which step, if any, follows this callback. Follow the instructions above, then construct one JSON payload matching output_schema and send it to commands.next.";
const TERMINAL_OUTPUT_INSTRUCTION =
  "This terminal step is reusable across flows. The orchestrator owns terminal flow state. output_schema is null, so report the terminal output and do not invent a next payload.";
const MAX_EMBEDDED_SCHEMA_BYTES = 64 * 1024;
function usage(): void {
  console.log(`loopo

Usage:
  loopo init "loopo: <request>" --runtime <codex|gemini|copilot|all> [--flow swe] [--wtree <name>]
  loopo quest next --wtree <name> --json <json|@file|@->
  loopo hook --runtime <codex|gemini|copilot>
  loopo sim init "loopo: <request>" [--runtime <codex|gemini|copilot>] [--flow <id>] [--wtree <name>]
  loopo sim quest next --wtree <name> --json <json|@file|@->
  loopo sim hook [--runtime <codex|gemini|copilot>] [--json <json|@file|@->]
  loopo doctor [--repo <path>] [--runtime <codex|gemini|copilot|all>] [--fix]
  loopo handbook [--repo <path>] [--raw]
  loopo cmdproto --help [--json]
  loopo cmdproto execjson <path> <json|@file|@->
`);
}

function parseCommand(argv: string[]): Command {
  const cmd = argv[0] as Command | undefined;
  if (
    !cmd ||
    !["init", "doctor", "quest", "hook", "sim", "cmdproto", "handbook"].includes(cmd)
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
    payload.loopo_repo_root,
    payload.loopoRepoRoot,
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
    if (existsSync(resolve(resolved, ".loopo"))) {
      const base = baseRepoRootFromWorktreeRoot(resolved);
      return {
        repoRoot: realpathSync(base ?? resolved),
        source: base ? "repo_worktree" : "loopo_ancestor",
      };
    }
    let cursor = resolved;
    while (true) {
      if (existsSync(resolve(cursor, ".loopo"))) {
        const base = baseRepoRootFromWorktreeRoot(cursor);
        return {
          repoRoot: realpathSync(base ?? cursor),
          source: base ? "repo_worktree" : "loopo_ancestor",
        };
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (existsSync(resolved))
      return { repoRoot: realpathSync(resolved), source: "cwd" };
  }
  throw new Error("cannot resolve loopo context");
}

const GENERIC_GREENFIELD_TOKENS = new Set([
  "app",
  "application",
  "website",
  "site",
  "dashboard",
  "tool",
  "platform",
  "service",
  "product",
  "system",
  "portal",
  "api",
  "project",
  "prototype",
  "mvp",
  "fullstack",
  "frontend",
  "backend",
  "web",
  "mobile",
  "desktop",
  "create",
  "build",
  "make",
  "develop",
  "start",
  "ship",
  "new",
  "simple",
]);

const PROMPT_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "for",
  "to",
  "with",
  "and",
  "or",
  "of",
  "in",
  "on",
  "from",
  "me",
  "us",
  "some",
  "please",
]);

function normalizePromptText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^loopo:\s*/, "")
    .replace(/\bfull\s+stack\b/g, "fullstack")
    .replace(/\bfront\s+end\b/g, "frontend")
    .replace(/\bback\s+end\b/g, "backend")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function looksLikeVagueGreenfieldPrompt(prompt: unknown): boolean {
  const normalized = normalizePromptText(prompt);
  if (!normalized) return false;
  const informative = normalized
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !PROMPT_STOPWORDS.has(token));
  if (!informative.length) return false;
  if (!informative.some((token) => GENERIC_GREENFIELD_TOKENS.has(token))) {
    return false;
  }
  return informative.every((token) => GENERIC_GREENFIELD_TOKENS.has(token));
}

function parseInitArgs(argv: string[]): {
  repo: string;
  wtree: string | null;
  flowId: string;
  objective: string;
  force: boolean;
  runtime: DoctorArgs["runtime"];
  skillHome: string | null;
} {
  let repo: string | null = null;
  let wtree: string | null = null;
  let flowId = DEFAULT_FLOW_ID;
  let force = false;
  let runtime: DoctorArgs["runtime"] = "all";
  let skillHome: string | null = null;
  const objectiveParts: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") repo = argv[++i] ?? repo;
    else if (arg?.startsWith("--repo=")) repo = arg.slice("--repo=".length);
    else if (arg === "--cwd" || arg?.startsWith("--cwd=")) {
      throw new Error("loopo init no longer accepts --cwd; run it from the repo root or pass --repo");
    } else if (arg === "--session" || arg?.startsWith("--session=")) {
      throw new Error("loopo init no longer accepts --session");
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
    flowId: flowId.trim() || DEFAULT_FLOW_ID,
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

function hookOutput(
  runtime: Runtime,
  shouldContinue: boolean,
  reason: string,
  eventName: string,
): Record<string, unknown> {
  if (!shouldContinue) return {};
  if (runtime === "gemini") {
    return { decision: "deny", reason, suppressOutput: true };
  }
  if (runtime === "copilot" && eventName === "Stop") {
    return {
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: "Stop",
        decision: "block",
        reason,
      },
    };
  }
  return { decision: "block", reason };
}

import * as child_process from "node:child_process";

function resolveAbsoluteGitDir(repoRoot: string): string | null {
  try {
    const stdout = child_process.execSync("git rev-parse --absolute-git-dir", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout.trim();
  } catch {
    return null;
  }
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
  const isLoopoHookCommand = (value: unknown): boolean => {
    const normalized = normalizeCommand(value);
    if (!normalized) return false;
    if (/(^|\s)tasks_loop_hook\.(ts|py)(\s|$)/.test(normalized)) return true;
    return normalized.includes("loopo") && /\bhook\b/.test(normalized);
  };
  const normalized: Array<Record<string, unknown>> = [];
  for (const group of groups) {
    const items = Array.isArray((group as any).hooks)
      ? (group as any).hooks
      : [];
    const kept = items.filter((item: any) => {
      const command = String(item?.command ?? "");
      return !isLoopoHookCommand(command);
    });
    if (kept.length) normalized.push({ ...group, hooks: kept });
  }
  normalized.push({
    hooks: [
      {
        type: "command",
        command: cmd,
        timeout: 30,
        statusMessage: "loopo: evaluating continuation",
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
  const isLoopoHookCommand = (value: unknown): boolean => {
    const normalized = normalizeCommand(value);
    if (!normalized) return false;
    if (/(^|\s)tasks_loop_hook\.(ts|py)(\s|$)/.test(normalized)) return true;
    return normalized.includes("loopo") && /\bhook\b/.test(normalized);
  };
  const normalized: Array<Record<string, unknown>> = [];
  for (const group of groups) {
    const items = Array.isArray((group as any).hooks)
      ? (group as any).hooks
      : [];
    const kept = items.filter((item: any) => {
      const command = String(item?.command ?? "");
      return !isLoopoHookCommand(command);
    });
    if (kept.length) normalized.push({ ...group, hooks: kept });
  }
  normalized.push({
    hooks: [
      {
        name: "loopo-after-agent",
        type: "command",
        command: cmd,
        timeout: 10000,
        description: "Continue loopo when work remains",
      },
    ],
  });
  hooks.AfterAgent = normalized;
  writeJson(path, cfg);
  return path;
}

function installCopilotHook(repoRoot: string, cmd: string): string {
  const path = resolve(repoRoot, ".github", "hooks", "loopo.json");
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
  const wrapperScript = resolve(SCRIPT_DIR, "loopo.ts");
  const globalBin = resolveGlobalLoopoBinPath();
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
    } else if (readText(codexPath).includes(".loopo/bin/loopo")) {
      issues.push("old codex hook command uses .loopo/bin/loopo");
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
    } else if (readText(geminiPath).includes(".loopo/bin/loopo")) {
      issues.push("old gemini hook command uses .loopo/bin/loopo");
    } else if (
      readText(geminiPath).includes("--cwd") ||
      readText(geminiPath).includes("--repo")
    ) {
      issues.push("old gemini hook command embeds a repo path");
    }
  }
  if (args.runtime === "copilot" || args.runtime === "all") {
    const copilotPath = resolve(repoRoot, ".github", "hooks", "loopo.json");
    if (!existsSync(copilotPath)) {
      issues.push("missing .github/hooks/loopo.json");
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
      console.log(`loopo doctor: status=healthy repo=${repoRoot}`);
      return 0;
    }
    console.log(`loopo doctor: status=issues repo=${repoRoot}`);
    for (const issue of issues) console.log(`- ${issue}`);
    console.log("loopo doctor: rerun with --fix");
    return 2;
  }

  createLoopoShim(globalBin, wrapperScript);
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

  console.log(`loopo doctor: status=fixed repo=${repoRoot}`);
  for (const path of written) console.log(`- ${path}`);
  return 0;
}

const CHILD_DONE_STATUSES = new Set([
  "child_merged",
  "child_archived",
  "done",
  "merged",
]);
const CHILD_STALLED_STATUSES = new Set(["blocked", "deferred", "failed"]);

function inferRepoRuntime(repoRoot: string): DoctorArgs["runtime"] {
  const runtimes: Runtime[] = [];
  if (existsSync(resolve(repoRoot, ".codex", "hooks.json"))) {
    runtimes.push("codex");
  }
  if (existsSync(resolve(repoRoot, ".gemini", "settings.json"))) {
    runtimes.push("gemini");
  }
  if (existsSync(resolve(repoRoot, ".github", "hooks", "loopo.json"))) {
    runtimes.push("copilot");
  }
  if (runtimes.length === 1) return runtimes[0];
  return "all";
}

function readyChildTasks(state: Partial<{ tasks: QuestTask[] }>): QuestTask[] {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const done = new Set(
    tasks
      .filter((task) => CHILD_DONE_STATUSES.has(String(task.status)))
      .map((task) => task.id),
  );
  const selected: QuestTask[] = [];
  const usedGroups = new Set<string>();
  const usedScopes = new Set<string>();
  for (const task of tasks) {
    const status = String(task.status || "child_received");
    if (!["child_received", "pending", "ready"].includes(status)) continue;
    if (!task.dependencies.every((id) => done.has(id))) continue;
    const group = task.concurrency_group.trim();
    if (group && usedGroups.has(group)) continue;
    const scopes = task.scope_files
      .map((scope) => scope.trim())
      .filter(Boolean);
    if (scopes.some((scope) => usedScopes.has(scope))) continue;
    selected.push(task);
    if (group) usedGroups.add(group);
    for (const scope of scopes) usedScopes.add(scope);
  }
  return selected;
}

function questResponse(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function questNextResponse(
  payload: Record<string, unknown>,
  full: boolean,
): void {
  process.stdout.write(`${JSON.stringify(payload, null, full ? 2 : 0)}\n`);
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

function flowIdForState(state: Partial<{ [key: string]: any }>): string {
  return String(state.flow_id ?? DEFAULT_FLOW_ID).trim() || DEFAULT_FLOW_ID;
}

function flowVersionForState(state: Partial<{ [key: string]: any }>): number {
  const version = Number(state.flow_version ?? DEFAULT_FLOW_VERSION);
  return Number.isInteger(version) && version > 0
    ? version
    : DEFAULT_FLOW_VERSION;
}

function loadStateFlow(
  state: Partial<{ [key: string]: any }>,
): LoadedLoopoFlow {
  return loadFlowDefinition(flowIdForState(state));
}

function stageToV3Step(stage: string, flow = loadFlowDefinition()): string {
  return flowStep(flow, stage).id;
}

function inputSchemaForStage(
  stage: string,
  flow = loadFlowDefinition(),
): LoopoSchemaSource {
  return flowStep(flow, stage).output_schema;
}

function outputSchemaForStage(
  stage: string,
  flow = loadFlowDefinition(),
): string {
  return flowStep(flow, stage).result_schema;
}

function v3StepSummary(stage: string, flow = loadFlowDefinition()): string {
  return flowStep(flow, stage).summary;
}

function compactCommand(cmd: string, args: string[]): Record<string, unknown> {
  return { cmd, args };
}

function tokenCommand(cmd: string, args: string[]): Record<string, unknown> {
  return { cmd, args };
}

function simpleHookCommand(binPath: string, runtime: string): string {
  return [shellQuote(binPath), "hook", "--runtime", runtime].join(" ");
}

function readHookJsonArg(json: string | null): Record<string, any> {
  if (json) return readJsonArg(json);
  if (process.stdin.isTTY) return {};
  return readStdinJson() as Record<string, any>;
}

function questByWtree(
  repoRoot: string,
  wtree: string,
): { files: QuestFiles; state: Partial<{ [key: string]: any }> } | null {
  const files = questFiles(repoRoot, wtree);
  if (!existsSync(files.tasks)) return null;
  return { files, state: parseTasksYaml(readText(files.tasks)) };
}

function allQuestWtrees(repoRoot: string): string[] {
  const wtrees = new Set<string>();
  const worktreesDir = resolve(repoRoot, "worktrees");
  if (!existsSync(worktreesDir)) return [];
  for (const entry of readdirSync(worktreesDir)) {
    if (!validWtreeName(entry)) continue;
    if (existsSync(questFiles(repoRoot, entry).tasks)) {
      wtrees.add(entry);
    }
  }
  return [...wtrees].sort();
}

function findParentQuestAssignment(
  repoRoot: string,
  childWtree: string,
): ParentQuestAssignment | null {
  for (const parentWtree of allQuestWtrees(repoRoot)) {
    const parentQuest = questByWtree(repoRoot, parentWtree);
    const parentTasks = Array.isArray(parentQuest?.state.tasks)
      ? (parentQuest!.state.tasks as QuestTask[])
      : [];
    const matched = parentTasks.find(
      (task) =>
        String(task.child_wtree ?? "").trim() === childWtree ||
        taskAssignmentChildWtree(parentWtree, String(task.id)) === childWtree ||
        `${parentWtree}-${task.id}` === childWtree,
    );
    if (!matched) continue;
    return {
      parent_wtree: parentWtree,
      task_id: matched.id,
      parent_context_ref: String(parentQuest?.files.tasks ?? ""),
      landing_target_branch: String(
        matched.merge_target || parentQuest?.state.coordinator_branch || "main",
      ),
      landing_target_worktree: String(
        parentQuest?.state.coordinator_worktree ??
          landingTargetWorktreePath(
            repoRoot,
            String(matched.merge_target || "main"),
          ),
      ),
      merge_lease_id: String(matched.merge_lease_id ?? ""),
    };
  }
  return null;
}

function requestTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2 && token !== "loopo"),
  );
}

function rankQuestCandidates(
  repoRoot: string,
  request: string,
): Array<Record<string, unknown>> {
  const tokens = requestTokens(request);
  return allQuestWtrees(repoRoot)
    .map((wtree) => {
      const quest = questByWtree(repoRoot, wtree);
      const prompt = String(quest?.state.prompt ?? "");
      const haystack = requestTokens(`${wtree} ${prompt}`);
      let score = 0;
      for (const token of tokens) {
        if (haystack.has(token)) score += 1;
      }
      return {
        wtree,
        score,
        description: prompt || wtree,
        state: String(quest?.state.stage ?? "unknown"),
        current_step: stageToV3Step(
          String(quest?.state.stage ?? "planning"),
          loadStateFlow(quest?.state ?? {}),
        ),
        flow_id: flowIdForState(quest?.state ?? {}),
        flow_version: flowVersionForState(quest?.state ?? {}),
        worktree_path: String(quest?.state.coordinator_worktree ?? ""),
        command: compactCommand("loopo", [
          "quest",
          "next",
          "--wtree",
          wtree,
          "--json",
          "@-",
        ]),
      };
    })
    .sort((left, right) => {
      const score = Number(right.score ?? 0) - Number(left.score ?? 0);
      return score || String(left.wtree).localeCompare(String(right.wtree));
    });
}

function suggestedWtree(request: string): string {
  return normalizeName(request.replace(/^loopo:\s*/i, "") || "quest");
}

function validWtreeName(value: string): boolean {
  const text = value.trim();
  return (
    text.length > 0 &&
    text === basename(text) &&
    text !== "." &&
    text !== ".." &&
    !text.includes("/") &&
    !text.includes("\\")
  );
}

function requireWtreeName(value: string, label = "wtree"): string {
  const text = value.trim();
  if (!validWtreeName(text)) {
    throw new Error(`${label} must be a base worktree name`);
  }
  return text;
}

function ensureV3Runtime(input: {
  repoRoot: string;
  runtime: DoctorArgs["runtime"];
  skillHome?: string | null;
}): void {
  ensureGlobalSkillFiles(input.skillHome);
  const wrapperScript = resolve(SCRIPT_DIR, "loopo.ts");
  const globalBin = resolveGlobalLoopoBinPath();
  createLoopoShim(globalBin, wrapperScript);
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

function v3InitRoute(input: {
  repoRoot: string;
  runtime: DoctorArgs["runtime"];
  request: string;
  flowId: string;
  wtree?: string | null;
}): Record<string, unknown> {
  const wtree = requireWtreeName(
    String(input.wtree ?? "").trim() || suggestedWtree(input.request),
  );
  const flow = loadFlowDefinition(input.flowId);
  const compactSchema = process.env.LOOPO_COMPACT_INIT_SCHEMA === "1";
  const createQuestInput = {
    step: "select_quest",
    action: "create_quest",
    wtree,
    flow_id: flow.id,
    request: input.request,
  };
  return {
    schema_version: 3,
    kind: "init_route",
    schema_path: v3SchemaPath("init-output"),
    request: input.request,
    runtime: input.runtime,
    flow_id: flow.id,
    flow_version: flow.version,
    candidates: rankQuestCandidates(input.repoRoot, input.request),
    new_quest: {
      suggested_wtree: wtree,
      command: compactCommand("loopo", [
        "quest",
        "next",
        "--wtree",
        wtree,
        "--json",
        JSON.stringify(createQuestInput),
      ]),
      output_schema: compactSchema
        ? { schema_path: v3SchemaPath("next-input") }
        : boundedSchema(v3SchemaPath("next-input")),
      input: createQuestInput,
    },
  };
}

function lockPath(repoRoot: string, wtree: string): string {
  return questFiles(repoRoot, wtree).lock;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

type WtreeLock =
  | { ok: true; path: string; token: string }
  | { ok: false; response: Record<string, unknown> };

function acquireWtreeLock(repoRoot: string, wtree: string): WtreeLock {
  const path = lockPath(repoRoot, wtree);
  mkdirSync(dirname(path), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const body = {
    schema_version: 3,
    wtree,
    pid: process.pid,
    token,
    created_at: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return { ok: true, path, token };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readJson(path) as Record<string, any> | null;
      const pid = Number(existing?.pid ?? 0);
      if (!pidAlive(pid)) {
        rmSync(path, { force: true });
        continue;
      }
      return {
        ok: false,
        response: {
          schema_version: 3,
          kind: "lock_error",
          schema_path: v3SchemaPath("lock-error"),
          wtree,
          lock: {
            path,
            pid,
            retry: compactCommand("loopo", [
              "quest",
              "next",
              "--wtree",
              wtree,
              "--json",
              "@-",
            ]),
          },
        },
      };
    }
  }
  return {
    ok: false,
    response: {
      schema_version: 3,
      kind: "lock_error",
      schema_path: v3SchemaPath("lock-error"),
      wtree,
      lock: { path, pid: null, retry: "stale lock could not be reaped" },
    },
  };
}

function releaseWtreeLock(lock: WtreeLock): void {
  if (!lock.ok) return;
  try {
    const current = readJson(lock.path) as Record<string, any> | null;
    if (current?.token === lock.token) unlinkSync(lock.path);
  } catch {
    // Best effort release; stale locks are reaped on the next command.
  }
}

function readyChildrenForV3(
  repoRoot: string,
  wtree: string,
  state: Partial<{ tasks: QuestTask[] }>,
  full = false,
): Array<Record<string, unknown>> {
  const command = full ? compactCommand : tokenCommand;
  const flowId = flowIdForState(state as Partial<{ [key: string]: any }>);
  const runtime = inferRepoRuntime(repoRoot);
  return readyChildTasks(state).map((task) => {
    const childWtree =
      String(task.child_wtree || "").trim() ||
      taskAssignmentChildWtree(wtree, String(task.id));
    const workspace = ensureTaskWorkspace(
      repoRoot,
      String(task.branch_ref || taskAssignmentBranchRef(wtree, String(task.id))),
      String(
        task.worktree_path ||
          taskAssignmentWorktreePath(repoRoot, wtree, String(task.id)),
      ),
    );
    const mergeTarget = String(task.merge_target || wtree);
    const parentContextRef = resolve(
      coordinatorWorktreePath(repoRoot, wtree),
      ".loopo",
      "runtime",
      "tasks.yaml",
    );
    const request = `loopo: execute child task ${task.id}: ${task.title}. Read parent context at ${parentContextRef}. Implement only this assigned task. Do not split into child worktrees. Land into ${mergeTarget} and return the merge_commit.`;
    return {
      task_id: task.id,
      title: task.title,
      child_wtree: childWtree,
      parent_wtree: wtree,
      parent_task_id: task.id,
      parent_context_ref: parentContextRef,
      branch_ref: workspace.branch_ref,
      worktree_path: workspace.worktree_path,
      merge_target: mergeTarget,
      merge_target_worktree: coordinatorWorktreePath(repoRoot, wtree),
      acceptance: task.acceptance,
      commands: {
        init: command("loopo", [
          "init",
          request,
          "--wtree",
          childWtree,
          "--runtime",
          runtime,
          "--flow",
          flowId,
        ]),
        next: command("loopo", [
          "quest",
          "next",
          "--wtree",
          childWtree,
          "--json",
          "@-",
        ]),
      },
      result_schema: full
        ? v3SchemaRef("child-result-input")
        : "child-result-input",
    };
  });
}

function compactStepData(
  stepDef: ReturnType<typeof flowStep>,
): Record<string, string> {
  return {
    id: stepDef.id,
    instructions: stepInstructions(stepDef),
  };
}

function stepInstructions(stepDef: ReturnType<typeof flowStep>): string {
  const callbackInstruction = stepDef.output_schema
    ? NEXT_PAYLOAD_INSTRUCTION
    : TERMINAL_OUTPUT_INSTRUCTION;
  return `${stepDef.instructions.trimEnd()}\n\n${callbackInstruction}`;
}

function schemaRefForSource(schemaSource: LoopoSchemaSource): unknown {
  if (schemaSource == null) return null;
  if (typeof schemaSource === "string") return { schema_path: schemaSource };
  const schemaId = schemaSource.$id;
  return typeof schemaId === "string" && schemaId.trim()
    ? { schema_path: schemaId }
    : schemaSource;
}

function boundedSchema(schemaSource: LoopoSchemaSource): unknown {
  const embedded = dereferencedSchemaSource(schemaSource);
  if (embedded == null) return null;
  if (
    typeof schemaSource === "string" &&
    JSON.stringify(embedded).length > MAX_EMBEDDED_SCHEMA_BYTES
  ) {
    return schemaRefForSource(schemaSource);
  }
  return embedded;
}

function stepContextData(
  stepDef: ReturnType<typeof flowStep>,
): Record<string, unknown> {
  return {
    schema_version: stepDef.schema_version,
    id: stepDef.id,
    handler: stepDef.handler,
    input_step: stepDef.input_step,
    input_schema: boundedSchema(stepDef.input_schema),
    output_schema: boundedSchema(stepDef.output_schema),
    result_schema_path: stepDef.result_schema,
    summary: stepDef.summary,
    instructions: stepInstructions(stepDef),
  };
}

function v3StepOutput(input: {
  repoRoot: string;
  files: QuestFiles;
  state: Partial<{ [key: string]: any }>;
  full?: boolean;
}): Record<string, unknown> {
  const stage = String(input.state.stage ?? "planning");
  const flow = loadStateFlow(input.state);
  const stepDef = flowStep(flow, stage);
  const step = stepDef.id;
  const schema = outputSchemaForStage(stage, flow);
  const nextArgs = [
    "quest",
    "next",
    "--wtree",
    input.files.wtree,
    "--json",
    "@-",
  ];
  if (!input.full) {
    const compactOutput: Record<string, unknown> = {
      step: compactStepData(stepDef),
      output_schema: boundedSchema(stepDef.output_schema),
      commands: {
        next: tokenCommand("loopo", nextArgs),
      },
    };
    if (step === "executing") {
      compactOutput.children = readyChildrenForV3(
        input.repoRoot,
        input.files.wtree,
        input.state,
      );
    }
    if (step === "archived" && String(input.state.landed_commit ?? "").trim()) {
      compactOutput.landing = {
        source_branch: String(input.state.coordinator_branch ?? ""),
        target_branch: String(input.state.landing_target_branch ?? ""),
        target_worktree: String(input.state.landing_target_worktree ?? ""),
        landed_commit: String(input.state.landed_commit ?? ""),
        strategy: String(input.state.landing_strategy ?? ""),
      };
    }
    return compactOutput;
  }

  const output: Record<string, unknown> = {
    schema_version: 3,
    kind: "quest_step",
    schema_path: schema,
    wtree: input.files.wtree,
    flow_id: flow.id,
    flow_version: flow.version,
    step,
    state: stage,
    summary: v3StepSummary(stage, flow),
    output_schema: boundedSchema(stepDef.output_schema),
    commands: {
      next: tokenCommand("loopo", nextArgs),
    },
  };
  if (input.full) {
    output.quest_id = input.files.wtree;
    output.allowed_transitions = flowStage(flow, stage).transitions;
    output.context = {
      step: stepContextData(stepDef),
    };
    output.commands = {
      next: compactCommand("loopo", nextArgs),
    };
    output.docs = {
      state_yaml: input.files.tasks,
      events_jsonl: input.files.events,
      manifest: input.files.manifest,
    };
  }
  if (step === "plan") {
    if (input.full) {
      output.requirements = [
        "Classify the request.",
        "Use repository discovery before asking questions.",
        "Use AF to surface contradictions, hidden assumptions, weak evidence, and edge cases.",
        "Use OF to collapse scope, defaults, acceptance, decomposition, and verification targets.",
        "For greenfield app/product work, ask or explicitly default every high-impact unknown before task graph approval.",
      ];
    }
  }
  if (step === "executing") {
    output.children = readyChildrenForV3(
      input.repoRoot,
      input.files.wtree,
      input.state,
      input.full === true,
    );
  }
  if (step === "archived") {
    output.output_schema = null;
    if (String(input.state.landed_commit ?? "").trim()) {
      output.landing = {
        source_branch: String(input.state.coordinator_branch ?? ""),
        target_branch: String(input.state.landing_target_branch ?? ""),
        target_worktree: String(input.state.landing_target_worktree ?? ""),
        landed_commit: String(input.state.landed_commit ?? ""),
        strategy: String(input.state.landing_strategy ?? ""),
      };
    }
  }
  return output;
}

function v3Error(
  message: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 3,
    kind: "error",
    schema_path: v3SchemaPath("error-output"),
    error: message,
    ...extra,
  };
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function isChildExecutionQuestPrompt(prompt: unknown): boolean {
  const normalized = String(prompt ?? "")
    .trim()
    .toLowerCase();
  return (
    normalized.startsWith("loopo: execute child task ") ||
    normalized.startsWith("execute child task ")
  );
}

function stageInputStep(stage: string, flow = loadFlowDefinition()): string {
  const step = flowStep(flow, stage);
  return step.input_step ?? step.id;
}

function assertStep(
  input: Record<string, any>,
  expected: string,
): string | null {
  if (String(input.step ?? "") !== expected) {
    return `expected step "${expected}", got "${String(input.step ?? "(empty)")}"`;
  }
  return null;
}

function appendV3Event(
  files: QuestFiles,
  event: string,
  payload: Record<string, unknown>,
): void {
  appendJsonl(files.events, {
    event,
    quest_id: files.wtree,
    payload,
  });
}

function writeV3Manifest(files: QuestFiles, requestId: string): void {
  writeQuestManifest(files, requestId, "loopo quest next");
}

function persistQuestState(
  files: QuestFiles,
  nextState: Partial<{ [key: string]: any }>,
): Partial<{ [key: string]: any }> {
  writeText(files.tasks, renderTasksYaml(nextState as any));
  return parseTasksYaml(readText(files.tasks));
}

function appendAuditEvent(
  files: QuestFiles,
  event: string,
  stage: string,
  requestId: string,
  payload: Record<string, unknown>,
): void {
  appendJsonl(files.events, {
    event,
    quest_id: files.wtree,
    stage,
    request_id: requestId,
    payload_digest: hashText(JSON.stringify(payload)),
  });
}

function validatePlan(
  input: Record<string, any>,
  state: Partial<{ [key: string]: any }>,
): string | null {
  for (const key of [
    "classification",
    "scope",
    "system_context",
    "verification_targets",
    "task_graph",
  ]) {
    if (input[key] == null) return `plan missing required field: ${key}`;
  }
  const highImpact = asArray(input.high_impact_unknowns);
  const defaulted = asArray(input.defaulted_unknowns);
  const questions = asArray(input.questions);
  const hasRecordedAnswers = hasAnsweredQuestions(state);
  const leafChild = isChildExecutionQuestPrompt(state.prompt);
  if (
    input.classification === "greenfield_app" &&
    questions.length === 0 &&
    looksLikeVagueGreenfieldPrompt(state.prompt) &&
    !hasRecordedAnswers
  ) {
    return "generic greenfield request requires a clarification round before task decomposition";
  }
  if (
    input.classification === "greenfield_app" &&
    highImpact.length > 0 &&
    defaulted.length === 0 &&
    questions.length === 0
  ) {
    return "greenfield plan has unresolved high-impact ambiguity; provide questions or explicit defaults";
  }
  if (!questions.length && !Array.isArray(input.task_graph?.tasks)) {
    return "plan must include task_graph.tasks unless it is asking questions";
  }
  if (leafChild && !questions.length) {
    const tasks = Array.isArray(input.task_graph?.tasks) ? input.task_graph.tasks : [];
    if (tasks.length !== 1) {
      return "execute child task quests must contain exactly one local task and must not split further";
    }
  }
  return null;
}

function hasAnsweredQuestions(state: Partial<{ [key: string]: any }>): boolean {
  return asArray(state.question_rounds).some((round) =>
    asArray(round?.questions).some(
      (question) => String(question?.answer ?? "").trim().length > 0,
    ),
  );
}

function answerKey(answer: Record<string, any>): string {
  return String(answer.question_id ?? answer.id ?? "").trim();
}

function mergeAnswersIntoLatestQuestionRound(
  state: Partial<{ [key: string]: any }>,
  answers: Array<Record<string, any>>,
): Array<Record<string, any>> {
  const rounds = asArray(state.question_rounds).map((round) => ({
    ...round,
    questions: asArray(round?.questions),
  }));
  if (!rounds.length) {
    throw new Error("questions input cannot be applied before a question round exists");
  }
  const latest = rounds[rounds.length - 1];
  const questions = asArray(latest.questions);
  const answerById = new Map<string, Record<string, any>>();
  const answerByQuestion = new Map<string, Record<string, any>>();
  for (const answer of answers) {
    const text = String(answer.answer ?? "").trim();
    if (!text) throw new Error("questions input answers require non-empty answer text");
    const key = answerKey(answer);
    if (key) answerById.set(key, answer);
    const questionText = String(answer.question ?? "").trim();
    if (questionText) answerByQuestion.set(questionText, answer);
  }
  const matched = new Set<Record<string, any>>();
  latest.questions = questions.map((question) => {
    const id = String(question.id ?? "").trim();
    const questionText = String(question.question ?? "").trim();
    const answer = answerById.get(id) ?? answerByQuestion.get(questionText);
    if (!answer) return question;
    matched.add(answer);
    const acceptedDefault = Boolean(answer.accepted_default);
    return {
      ...question,
      status: acceptedDefault ? "defaulted" : "answered",
      answer: String(answer.answer ?? "").trim(),
      accepted_default: acceptedDefault,
    };
  });
  for (const answer of answers) {
    if (!matched.has(answer)) {
      const key = answerKey(answer) || String(answer.question ?? "").trim();
      throw new Error(`questions input references unknown question: ${key || "<missing id>"}`);
    }
  }
  return rounds;
}

function handlePlan(input: {
  files: QuestFiles;
  state: Partial<{ [key: string]: any }>;
  payload: Record<string, any>;
  requestId: string;
}): Partial<{ [key: string]: any }> {
  const validation = validatePlan(input.payload, input.state);
  if (validation) throw new Error(validation);
  const questions = asArray(input.payload.questions);
  const current = parseTasksYaml(readText(input.files.tasks));
  if (questions.length) {
    const nextState = {
      ...current,
      question_rounds: [
        ...(Array.isArray(current.question_rounds) ? current.question_rounds : []),
        { questions },
      ],
    };
    writeText(input.files.tasks, renderTasksYaml(nextState as any));
    appendAuditEvent(
      input.files,
      "question_round",
      String(current.stage ?? "planning"),
      input.requestId,
      { question_count: questions.length },
    );
    return updateQuestStage(
      input.files,
      "awaiting_user_answers",
      input.requestId,
      "loopo quest next",
    );
  }
  const plan = {
    classification: String(input.payload.classification ?? ""),
    scope: String(input.payload.scope ?? ""),
    summary: String(input.payload.summary ?? input.payload.scope ?? ""),
    system_context:
      input.payload.system_context &&
      typeof input.payload.system_context === "object"
        ? input.payload.system_context
        : {},
    high_impact_unknowns: asArray(input.payload.high_impact_unknowns),
    defaulted_unknowns: asArray(input.payload.defaulted_unknowns),
    verification_targets: asArray(input.payload.verification_targets),
    assumptions: asArray(input.payload.assumptions),
    constraints: asArray(input.payload.constraints),
    tasks: asArray(input.payload.task_graph?.tasks),
  };
  const planned = applyQuestPlanToTasks(input.files, input.state, plan);
  appendAuditEvent(
    input.files,
    "plan_submitted",
    String(planned.stage ?? "planning"),
    input.requestId,
    {
      classification: plan.classification,
      task_count: plan.tasks.length,
      verification_target_count: plan.verification_targets.length,
    },
  );
  return updateQuestStage(
    input.files,
    "plan_review",
    input.requestId,
    "loopo quest next",
  );
}

function handleQuestions(input: {
  files: QuestFiles;
  payload: Record<string, any>;
  requestId: string;
}): Partial<{ [key: string]: any }> {
  if (!Array.isArray(input.payload.answers)) {
    throw new Error("questions input requires answers array");
  }
  const current = parseTasksYaml(readText(input.files.tasks));
  const answers = input.payload.answers as Array<Record<string, any>>;
  const nextState = {
    ...current,
    question_rounds: mergeAnswersIntoLatestQuestionRound(current, answers),
  };
  writeText(input.files.tasks, renderTasksYaml(nextState as any));
  appendAuditEvent(
    input.files,
    "answers_submitted",
    String(current.stage ?? "awaiting_user_answers"),
    input.requestId,
    { answer_count: answers.length },
  );
  return updateQuestStage(
    input.files,
    "planning",
    input.requestId,
    "loopo quest next",
  );
}

function taskById(
  state: Partial<{ tasks: QuestTask[] }>,
  taskId: string,
): QuestTask | null {
  const normalized = normalizeName(taskId);
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  return tasks.find((task) => task.id === normalized) ?? null;
}

function gitWorktreeDirtyEntries(path: string): string[] {
  const cwd = path.trim();
  if (!cwd || !existsSync(cwd)) return [];
  const probe = runCommand("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    timeoutMs: 15_000,
  });
  if (probe.status !== 0) return [];
  const status = runCommand(
    "git",
    ["status", "--short", "--untracked-files=all"],
    {
      cwd,
      timeoutMs: 15_000,
    },
  );
  if (status.status !== 0) return [];
  return status.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function dirtyEntryPath(entry: string): string {
  return entry.replace(/^[A-Z?!]{1,2}\s+/, "").trim();
}

function isIgnorableOperationalDirtyPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized === ".codex/hooks.json" ||
    normalized === ".gemini/settings.json" ||
    normalized === ".github/hooks/loopo.json" ||
    normalized === ".github/hooks" ||
    normalized === ".loopo/runtime/hook-state.json" ||
    normalized === ".loopo/runtime/lock.json" ||
    normalized.startsWith("worktrees/")
  );
}

function isDurableLoopoDirtyPath(path: string): boolean {
  return path.replace(/\\/g, "/").startsWith(".loopo/");
}

function nonLoopoGitDirtyEntries(path: string): string[] {
  return gitWorktreeDirtyEntries(path).filter((entry) => {
    const dirtyPath = dirtyEntryPath(entry);
    return (
      !isIgnorableOperationalDirtyPath(dirtyPath) &&
      !isDurableLoopoDirtyPath(dirtyPath)
    );
  });
}

function commitDurableLoopoState(cwd: string, message: string): string | null {
  if (!existsSync(resolve(cwd, ".loopo"))) return null;
  const add = runCommand("git", ["add", "--", ".loopo"], {
    cwd,
    timeoutMs: 30_000,
  });
  if (add.status !== 0) {
    throw new Error(add.stderr || add.stdout || "failed to stage .loopo state");
  }
  const diff = runCommand("git", ["diff", "--cached", "--quiet", "--", ".loopo"], {
    cwd,
    timeoutMs: 15_000,
  });
  if (diff.status === 0) return null;
  if (diff.status !== 1) {
    throw new Error(diff.stderr || diff.stdout || "failed to inspect staged .loopo state");
  }
  const commit = runCommand("git", ["commit", "-m", message], {
    cwd,
    timeoutMs: 60_000,
  });
  if (commit.status !== 0) {
    throw new Error(commit.stderr || commit.stdout || "failed to commit .loopo state");
  }
  return gitRevParse(cwd, "HEAD");
}

function gitCurrentBranch(cwd: string): string | null {
  const proc = runCommand("git", ["branch", "--show-current"], {
    cwd,
    timeoutMs: 15_000,
  });
  if (proc.status !== 0) return null;
  const branch = proc.stdout.trim();
  return branch || null;
}

function gitRevParse(cwd: string, ref: string): string {
  const proc = runCommand("git", ["rev-parse", "--verify", ref], {
    cwd,
    timeoutMs: 15_000,
  });
  if (proc.status !== 0) {
    throw new Error(proc.stderr || proc.stdout || `git rev-parse failed for ${ref}`);
  }
  return proc.stdout.trim();
}

function gitIsAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  const proc = runCommand("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    timeoutMs: 15_000,
  });
  return proc.status === 0;
}

function gitMergeIntoBranch(
  repoRoot: string,
  sourceBranch: string,
  targetBranch: string,
  preferredWorktree: string,
): GitLandingReceipt {
  const workspace = ensureTaskWorkspace(
    repoRoot,
    targetBranch,
    preferredWorktree || landingTargetWorktreePath(repoRoot, targetBranch),
  );
  const targetWorktree = String(workspace.worktree_path);
  const currentBranch = gitCurrentBranch(targetWorktree);
  if (currentBranch !== targetBranch) {
    throw new Error(
      `landing target worktree ${targetWorktree} is on ${currentBranch || "unknown"} instead of ${targetBranch}`,
    );
  }
  const dirtyTargetNonLoopoEntries = nonLoopoGitDirtyEntries(targetWorktree);
  if (dirtyTargetNonLoopoEntries.length) {
    throw new Error(
      `cannot merge into dirty landing target worktree ${targetWorktree}: ${dirtyTargetNonLoopoEntries.slice(0, 5).join(", ")}`,
    );
  }
  commitDurableLoopoState(
    targetWorktree,
    `chore(loopo): record ${targetBranch} target state`,
  );
  const sourceCommit = gitRevParse(repoRoot, sourceBranch);
  const targetCommit = gitRevParse(repoRoot, targetBranch);
  if (sourceCommit === targetCommit) {
    return {
      source_branch: sourceBranch,
      target_branch: targetBranch,
      target_worktree: targetWorktree,
      landed_commit: sourceCommit,
      strategy: "already-up-to-date",
    };
  }
  const ffOnly = gitIsAncestor(repoRoot, targetCommit, sourceCommit);
  const mergeArgs = ffOnly
    ? ["merge", "--ff-only", sourceBranch]
    : ["merge", "--no-ff", "--no-edit", sourceBranch];
  const merge = runCommand("git", mergeArgs, {
    cwd: targetWorktree,
    timeoutMs: 60_000,
  });
  if (merge.status !== 0) {
    throw new Error(
      merge.stderr ||
        merge.stdout ||
        `failed to merge ${sourceBranch} into ${targetBranch}`,
    );
  }
  const landedCommit = gitRevParse(targetWorktree, "HEAD");
  const dirtyAfterMerge = nonLoopoGitDirtyEntries(targetWorktree);
  if (dirtyAfterMerge.length) {
    throw new Error(
      `landing target worktree ${targetWorktree} is dirty after merge: ${dirtyAfterMerge.slice(0, 5).join(", ")}`,
    );
  }
  return {
    source_branch: sourceBranch,
    target_branch: targetBranch,
    target_worktree: targetWorktree,
    landed_commit: landedCommit,
    strategy: ffOnly ? "fast-forward" : "merge-commit",
  };
}

function resolveQuestLandingContext(input: {
  repoRoot: string;
  wtree: string;
  state: Partial<{ [key: string]: any }>;
}): {
  parentWtree: string;
  landingTargetBranch: string;
  landingTargetWorktree: string;
} {
  const parentWtree = String(input.state.parent_wtree ?? "").trim();
  const landingTargetBranch = String(
    input.state.landing_target_branch ?? "",
  ).trim();
  const landingTargetWorktree = String(
    input.state.landing_target_worktree ?? "",
  ).trim();
  if (landingTargetBranch) {
    return {
      parentWtree,
      landingTargetBranch,
      landingTargetWorktree:
        landingTargetWorktree ||
        landingTargetWorktreePath(input.repoRoot, landingTargetBranch),
    };
  }
  if (isChildExecutionQuestPrompt(input.state.prompt)) {
    const parent = findParentQuestAssignment(input.repoRoot, input.wtree);
    if (parent) {
      return {
        parentWtree: parent.parent_wtree,
        landingTargetBranch: parent.landing_target_branch,
        landingTargetWorktree: parent.landing_target_worktree,
      };
    }
  }
  return {
    parentWtree: "",
    landingTargetBranch: "main",
    landingTargetWorktree: landingTargetWorktreePath(input.repoRoot, "main"),
  };
}

function handleTaskGraph(input: {
  files: QuestFiles;
  state: Partial<{ [key: string]: any }>;
  payload: Record<string, any>;
  requestId: string;
}): Partial<{ [key: string]: any }> {
  if (typeof input.payload.approved !== "boolean") {
    throw new Error("task_graph input requires approved boolean");
  }
  if (!input.payload.approved) {
    appendV3Event(input.files, "task_graph_rejected", input.payload);
    return updateQuestStage(
      input.files,
      "planning",
      input.requestId,
      "loopo quest next",
    );
  }
  const tasks = Array.isArray(input.state.tasks) ? input.state.tasks : [];
  if (!tasks.length) throw new Error("cannot execute an empty task graph");
  appendV3Event(input.files, "task_graph_approved", input.payload);
  if (isChildExecutionQuestPrompt(input.state.prompt)) {
    return updateQuestStage(
      input.files,
      "validating",
      input.requestId,
      "loopo quest next",
    );
  }
  return updateQuestStage(
    input.files,
    "task_graph_ready",
    input.requestId,
    "loopo quest next",
  );
}

function allTasksDone(state: Partial<{ tasks: QuestTask[] }>): boolean {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  return (
    tasks.length > 0 &&
    tasks.every((task) => {
      if (!CHILD_DONE_STATUSES.has(task.status)) return false;
      if (task.status === "child_archived" || task.status === "child_merged") {
        return Boolean(String(task.merge_commit ?? "").trim());
      }
      return true;
    })
  );
}

function handleChildResult(input: {
  repoRoot: string;
  files: QuestFiles;
  state: Partial<{ [key: string]: any }>;
  payload: Record<string, any>;
  requestId: string;
}): Partial<{ [key: string]: any }> {
  for (const key of ["task_id", "child_wtree", "status", "evidence"]) {
    if (input.payload[key] == null) {
      throw new Error(`child_result missing required field: ${key}`);
    }
  }
  const status = String(input.payload.status);
  if (status === "passed" && !String(input.payload.merge_commit ?? "").trim()) {
    throw new Error(
      "child_result with status=passed requires merge_commit from the merged child branch",
    );
  }
  const task = taskById(
    input.state,
    String(input.payload.task_id ?? input.payload.id ?? ""),
  );
  if (!task) {
    throw new Error(
      `child_result references unknown task_id: ${input.payload.task_id}`,
    );
  }
  if (CHILD_DONE_STATUSES.has(String(task.status ?? ""))) {
    throw new Error(
      `child_result cannot update already completed task: ${task.id}`,
    );
  }
  const payloadChildWtree = String(input.payload.child_wtree ?? "").trim();
  if (task.child_wtree.trim() && payloadChildWtree !== task.child_wtree.trim()) {
    throw new Error(
      `child_result child_wtree must match planned child wtree ${task.child_wtree}`,
    );
  }
  if (status === "passed") {
    const mergeCommit = String(input.payload.merge_commit ?? "").trim();
    const activeChildQuest = questByWtree(input.repoRoot, payloadChildWtree);
    if (
      activeChildQuest &&
      String(activeChildQuest.state.stage ?? "") !== "archived"
    ) {
      throw new Error(
        `cannot pass until child quest ${payloadChildWtree} is archived`,
      );
    }
    const mergeTarget = String(task.merge_target ?? input.files.wtree).trim();
    let mergeCommitResolved: string | null = null;
    try {
      mergeCommitResolved = gitRevParse(input.repoRoot, mergeCommit);
    } catch {
      mergeCommitResolved = null;
    }
    if (mergeCommitResolved) {
      if (!gitIsAncestor(input.repoRoot, mergeCommitResolved, mergeTarget)) {
        throw new Error(
          `child_result merge_commit ${mergeCommit} is not present in merge target ${mergeTarget}`,
        );
      }
    }
  }
  const taskUpdate = {
    id: String(input.payload.task_id),
    child_wtree: String(input.payload.child_wtree),
    branch_ref: String(input.payload.branch_ref ?? task.branch_ref ?? ""),
    worktree_path: String(input.payload.worktree_path ?? task.worktree_path ?? ""),
    merge_target: String(input.payload.merge_target ?? task.merge_target ?? ""),
    merge_lease_id: String(
      input.payload.merge_lease_id ?? task.merge_lease_id ?? "",
    ),
    merge_commit: String(input.payload.merge_commit ?? ""),
  };
  const next =
    status === "passed"
      ? applyChildSummaryToTasks(input.files, input.state, taskUpdate)
      : applyChildStatusToTasks(input.files, input.state, {
          ...taskUpdate,
          status: status === "blocked" ? "blocked" : "failed",
        });
  appendAuditEvent(
    input.files,
    "child_result_submitted",
    String(next.stage ?? input.state.stage ?? "executing"),
    input.requestId,
    {
      task_id: String(input.payload.task_id ?? ""),
      child_wtree: String(input.payload.child_wtree ?? ""),
      status,
      merge_commit: String(input.payload.merge_commit ?? ""),
    },
  );
  if (allTasksDone(next)) {
    return updateQuestStage(
      input.files,
      "validating",
      input.requestId,
      "loopo quest next",
    );
  }
  writeV3Manifest(input.files, input.requestId);
  return parseTasksYaml(readText(input.files.tasks));
}

function handleValidation(input: {
  files: QuestFiles;
  state: Partial<{ [key: string]: any }>;
  payload: Record<string, any>;
  requestId: string;
}): Partial<{ [key: string]: any }> {
  if (!["passed", "failed"].includes(String(input.payload.status))) {
    throw new Error("validation status must be passed or failed");
  }
  const current = parseTasksYaml(readText(input.files.tasks));
  writeText(
    input.files.tasks,
    renderTasksYaml({
      ...(current as any),
      validation_receipt: {
        status: String(input.payload.status ?? ""),
        checks: Array.isArray(input.payload.checks) ? input.payload.checks : [],
      },
    }),
  );
  appendAuditEvent(
    input.files,
    "validation_submitted",
    String(current.stage ?? "validating"),
    input.requestId,
    {
      status: String(input.payload.status ?? ""),
      check_count: Array.isArray(input.payload.checks)
        ? input.payload.checks.length
        : 0,
    },
  );
  return updateQuestStage(
    input.files,
    input.payload.status === "passed"
      ? "verification_pending"
      : isChildExecutionQuestPrompt(input.state.prompt)
        ? "validating"
        : "task_graph_ready",
    input.requestId,
    "loopo quest next",
  );
}

function handleVerification(input: {
  files: QuestFiles;
  payload: Record<string, any>;
  requestId: string;
}): Partial<{ [key: string]: any }> {
  if (!["passed", "failed"].includes(String(input.payload.status))) {
    throw new Error("verification status must be passed or failed");
  }
  const current = parseTasksYaml(readText(input.files.tasks));
  writeText(
    input.files.tasks,
    renderTasksYaml({
      ...(current as any),
      verification_receipt: {
        status: String(input.payload.status ?? ""),
        acceptance_trace: Array.isArray(input.payload.acceptance_trace)
          ? input.payload.acceptance_trace
          : [],
        risks: Array.isArray(input.payload.risks) ? input.payload.risks : [],
      },
    }),
  );
  appendAuditEvent(
    input.files,
    "verification_submitted",
    String(current.stage ?? "verification_pending"),
    input.requestId,
    {
      status: String(input.payload.status ?? ""),
      acceptance_count: Array.isArray(input.payload.acceptance_trace)
        ? input.payload.acceptance_trace.length
        : 0,
      risk_count: Array.isArray(input.payload.risks)
        ? input.payload.risks.length
        : 0,
    },
  );
  return updateQuestStage(
    input.files,
    input.payload.status === "passed" ? "system_update_pending" : "validating",
    input.requestId,
    "loopo quest next",
  );
}

function handleSystemUpdate(input: {
  repoRoot: string;
  files: QuestFiles;
  state: Partial<{ [key: string]: any }>;
  payload: Record<string, any>;
  requestId: string;
}): Partial<{ [key: string]: any }> {
  if (!input.payload.system_update) {
    throw new Error("system_update input requires system_update");
  }
  appendAuditEvent(
    input.files,
    "system_update_submitted",
    String(input.state.stage ?? "system_update_pending"),
    input.requestId,
    {
      update_mode: String(input.payload.system_update?.mode ?? ""),
      external_doc_count: Array.isArray(input.payload.system_update?.external_docs)
        ? input.payload.system_update.external_docs.length
        : 0,
    },
  );
  if (!isChildExecutionQuestPrompt(input.state.prompt)) {
    applySystemUpdate(
      questWorkspaceRoot(input.files),
      input.payload.system_update,
      input.requestId,
    );
  }
  return updateQuestStage(
    input.files,
    "landing_ready",
    input.requestId,
    "loopo quest next",
  );
}

function handleLanding(input: {
  repoRoot: string;
  files: QuestFiles;
  payload: Record<string, any>;
  requestId: string;
}): { files: QuestFiles; state: Partial<{ [key: string]: any }> } {
  if (!["landed", "blocked"].includes(String(input.payload.status))) {
    throw new Error("landing status must be landed or blocked");
  }
  if (String(input.payload.status) === "landed") {
    const currentState = parseTasksYaml(readText(input.files.tasks));
    const tasks = Array.isArray(currentState.tasks)
      ? (currentState.tasks as QuestTask[])
      : [];
    const unmerged = tasks.filter(
      (task) =>
        CHILD_DONE_STATUSES.has(task.status) &&
        !String(task.merge_commit ?? "").trim(),
    );
    if (unmerged.length) {
      throw new Error(
        `cannot land while child tasks are missing merge_commit: ${unmerged.map((task) => task.id).join(", ")}`,
      );
    }
    const coordinatorWorktree = String(currentState.coordinator_worktree ?? "");
    const dirtyCoordinatorEntries = nonLoopoGitDirtyEntries(
      coordinatorWorktree,
    );
    if (dirtyCoordinatorEntries.length) {
      throw new Error(
        `cannot land while coordinator worktree has uncommitted changes: ${dirtyCoordinatorEntries.slice(0, 5).join(", ")}`,
      );
    }
    const trackedWorktreePaths = runCommand(
      "git",
      ["ls-files", "--", "worktrees"],
      { cwd: input.repoRoot, timeoutMs: 15_000 },
    );
    if (trackedWorktreePaths.status === 0) {
      const leakedPaths = trackedWorktreePaths.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (leakedPaths.length) {
        throw new Error(
          `cannot land while tracked files remain under worktrees/: ${leakedPaths.slice(0, 5).join(", ")}`,
        );
      }
    }
    const landingContext = resolveQuestLandingContext({
      repoRoot: input.repoRoot,
      wtree: input.files.wtree,
      state: currentState,
    });
    const landingReceipt = gitMergeIntoBranch(
      input.repoRoot,
      String(currentState.coordinator_branch ?? ""),
      landingContext.landingTargetBranch,
      landingContext.landingTargetWorktree,
    );
    applyLandingReceipt(input.files, currentState, {
      parent_wtree: landingContext.parentWtree,
      landing_target_branch: landingReceipt.target_branch,
      landing_target_worktree: landingReceipt.target_worktree,
      landed_commit: landingReceipt.landed_commit,
      landing_strategy: landingReceipt.strategy,
    });
    appendAuditEvent(
      input.files,
      "landing_submitted",
      String(currentState.stage ?? "landing_ready"),
      input.requestId,
      {
        status: String(input.payload.status ?? ""),
        source_branch: landingReceipt.source_branch,
        target_branch: landingReceipt.target_branch,
        target_worktree: landingReceipt.target_worktree,
        landed_commit: landingReceipt.landed_commit,
        strategy: landingReceipt.strategy,
      },
    );
    const archived = updateQuestStage(
      input.files,
      "archived",
      input.requestId,
      "loopo quest next",
    );
    return { files: input.files, state: archived };
  }
  appendAuditEvent(
    input.files,
    "landing_submitted",
    "landing_ready",
    input.requestId,
    { status: String(input.payload.status ?? "") },
  );
  return {
    files: input.files,
    state: updateQuestStage(
      input.files,
      "landing_ready",
      input.requestId,
      "loopo quest next",
    ),
  };
}

type HookChainState = {
  continuation_count?: number;
  handled_keys?: Record<string, string>;
  budget_prompted?: boolean;
};

type HookRuntimeState = {
  schema_version: 1;
  chains: Record<string, HookChainState>;
};

function hookEventName(
  payload: Record<string, any> | null | undefined,
): string {
  return String(
    payload?.hook_event_name ??
      payload?.hookEventName ??
      payload?.event_name ??
      payload?.eventName ??
      "",
  );
}

function loadHookRuntimeState(files: QuestFiles): HookRuntimeState {
  const parsed = readJson(files.hook_state);
  if (!parsed || typeof parsed !== "object") {
    return { schema_version: 1, chains: {} };
  }
  const chains =
    parsed.chains && typeof parsed.chains === "object"
      ? (parsed.chains as Record<string, HookChainState>)
      : {};
  return { schema_version: 1, chains };
}

function saveHookRuntimeState(files: QuestFiles, state: HookRuntimeState): void {
  writeJson(files.hook_state, state);
}

function hookChainKey(
  runtime: Runtime,
  contextRoot: string,
  wtree: string,
): string {
  return hashText([runtime, contextRoot, wtree].join("\n"));
}

function rememberHookKey(chain: HookChainState, key: string): void {
  const handled = (chain.handled_keys ??= {});
  handled[key] = new Date().toISOString();
  const entries = Object.entries(handled).sort((a, b) =>
    a[1].localeCompare(b[1]),
  );
  for (const [oldKey] of entries.slice(0, Math.max(0, entries.length - 128))) {
    delete handled[oldKey];
  }
}

function questHookSnapshotFiles(files: QuestFiles): string[] {
  return [files.tasks, files.events].sort();
}

function questHookSnapshotFingerprint(files: QuestFiles): string {
  const eventText = readText(files.events)
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.trim()) return false;
      try {
        const record = JSON.parse(line) as Record<string, any>;
        return String(record.event ?? "") !== "hook_decision";
      } catch {
        return true;
      }
    })
    .join("\n");
  return hashText(
    [
      `${files.tasks}:${hashText(readText(files.tasks))}`,
      `${files.events}:${hashText(eventText)}`,
    ].join("\n"),
  );
}

function latestHookStopState(files: QuestFiles): {
  iteration: string;
  stopReason: string;
} {
  let iteration = "0";
  let stopReason = "none";
  for (const line of readText(files.events).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, any>;
      if (String(record.event ?? "") === "hook_decision") continue;
      const nextIteration = record.iteration ?? record.iteration_id;
      if (nextIteration != null) iteration = String(nextIteration);
      const nextStopReason = record.stop_reason;
      if (nextStopReason != null) {
        stopReason = String(nextStopReason).trim().toLowerCase() || "none";
      }
    } catch {
      continue;
    }
  }
  return { iteration, stopReason };
}

function taskTerminalState(
  state: Partial<{ tasks: QuestTask[] }>,
): "unknown" | "all_done" | "all_stalled" | "continue" {
  const statuses = (Array.isArray(state.tasks) ? state.tasks : [])
    .map((task) => String(task.status || "child_received"))
    .filter(Boolean);
  if (!statuses.length) return "unknown";
  if (statuses.every((status) => CHILD_DONE_STATUSES.has(status)))
    return "all_done";
  if (statuses.every((status) => CHILD_STALLED_STATUSES.has(status))) {
    return "all_stalled";
  }
  return "continue";
}

function shouldHookContinue(input: {
  stopReason: string;
  taskState: "unknown" | "all_done" | "all_stalled" | "continue";
}): boolean {
  if (input.stopReason === "none") return input.taskState !== "all_stalled";
  if (input.stopReason === "all_done") return input.taskState !== "all_done";
  if (input.stopReason === "all_blocked_or_deferred") {
    return input.taskState !== "all_stalled";
  }
  return false;
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
      throw new Error("loopo no longer accepts --cwd; use --wtree and run from a repo/worktree context");
    } else if (arg === "--session" || arg?.startsWith("--session=")) {
      throw new Error("loopo no longer accepts --session; use --wtree");
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

function createV3Quest(input: {
  repoRoot: string;
  wtree: string;
  request: string;
  resolutionSource: string;
  flowId: string;
}): { files: QuestFiles; state: Partial<{ [key: string]: any }> } {
  ensureGitRootCommit(input.repoRoot);
  const flow = loadFlowDefinition(input.flowId);
  const workspace = ensureCoordinatorWorkspace(input.repoRoot, input.wtree);
  const parentAssignment = isChildExecutionQuestPrompt(input.request)
    ? findParentQuestAssignment(input.repoRoot, input.wtree)
    : null;
  const landingTargetBranch = parentAssignment
    ? parentAssignment.landing_target_branch
    : "main";
  const landingTargetWorktree = parentAssignment
    ? parentAssignment.landing_target_worktree
    : landingTargetWorktreePath(input.repoRoot, landingTargetBranch);
  const { files, state } = createQuest({
    repoRoot: input.repoRoot,
    wtree: input.wtree,
    prompt: input.request,
    resolutionSource: input.resolutionSource,
    workspace,
    flowId: flow.id,
    flowVersion: flow.version,
    parentWtree: parentAssignment?.parent_wtree ?? "",
    parentTaskId: parentAssignment?.task_id ?? "",
    parentContextRef: parentAssignment?.parent_context_ref ?? "",
    landingTargetBranch,
    landingTargetWorktree,
  });
  return { files, state };
}

type HookWtreeResolution =
  | { ok: true; wtree: string; source: string; cwd: string }
  | { ok: false; reason: string; cwd: string };

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function wtreeFromPathUnderWorktrees(
  repoRoot: string,
  cwd: string,
): string | null {
  const worktreesRoot = resolve(repoRoot, "worktrees");
  const resolvedCwd = resolve(expandHome(cwd));
  const pathRelative = relative(worktreesRoot, resolvedCwd);
  if (!pathRelative || pathRelative.startsWith("..") || isAbsolute(pathRelative)) {
    return null;
  }
  const candidate = pathRelative.split(/[\\/]/)[0] ?? "";
  return validWtreeName(candidate) ? candidate : null;
}

function deriveHookWtreeFromCwd(repoRoot: string, cwd: string): {
  wtree: string | null;
  reason: string | null;
} {
  const direct = wtreeFromPathUnderWorktrees(repoRoot, cwd);
  const gitTop = gitRootFrom(resolve(expandHome(cwd)));
  const gitDerived = gitTop ? wtreeFromPathUnderWorktrees(repoRoot, gitTop) : null;
  if (direct && gitDerived && direct !== gitDerived) {
    return { wtree: null, reason: "hook cwd and git worktree signals conflict" };
  }
  return { wtree: direct ?? gitDerived, reason: null };
}

function questExistsForWtree(repoRoot: string, wtree: string): boolean {
  return validWtreeName(wtree) && existsSync(questFiles(repoRoot, wtree).tasks);
}

function resolveHookWtree(input: {
  repoRoot: string;
  explicitWtree?: string | null;
  payload: Record<string, any>;
  contextPayload: Record<string, any>;
  processCwd?: string;
}): HookWtreeResolution {
  const cwd =
    stringField(input.contextPayload.cwd) ||
    stringField(input.payload.cwd) ||
    resolve(input.processCwd ?? process.cwd());
  const explicit =
    stringField(input.explicitWtree) ||
    stringField(input.payload.wtree) ||
    stringField(input.payload.loopo_wtree);
  if (explicit && !validWtreeName(explicit)) {
    return { ok: false, reason: "explicit wtree is not a base name", cwd };
  }

  const derived = deriveHookWtreeFromCwd(input.repoRoot, cwd);
  if (derived.reason) return { ok: false, reason: derived.reason, cwd };
  const cwdWtree = derived.wtree;
  if (explicit && cwdWtree && explicit !== cwdWtree) {
    return {
      ok: false,
      reason: "explicit wtree and hook cwd resolve to different quests",
      cwd,
    };
  }

  const selected = explicit || cwdWtree;
  if (!selected) {
    return { ok: false, reason: "hook did not resolve a worktree", cwd };
  }
  if (!questExistsForWtree(input.repoRoot, selected)) {
    return { ok: false, reason: "hook worktree has no quest state", cwd };
  }
  return {
    ok: true,
    wtree: selected,
    source: explicit ? "explicit" : "cwd",
    cwd,
  };
}

export function runQuestNextV3(argv: string[]): number {
  const args = parseQuestRepoArg(argv);
  const payload = readJsonArg(args.json);
  const context = resolveRepoContext({
    repo: args.repo,
    payload,
  });
  let wtree: string;
  try {
    wtree = requireWtreeName(String(args.wtree ?? payload.wtree ?? "").trim());
  } catch (error) {
    questResponse(
      v3Error(
        error instanceof Error
          ? error.message
          : "quest next requires --wtree <base-worktree-name>",
      ),
    );
    return 1;
  }
  const lock = acquireWtreeLock(context.repoRoot, wtree);
  if (!lock.ok) {
    questResponse(lock.response);
    return 2;
  }
  try {
    const existing = questByWtree(context.repoRoot, wtree);
    if (!existing) {
      const stepError = assertStep(payload, "select_quest");
      if (stepError) {
        questResponse(
          v3Error("quest does not exist; create it with select_quest input", {
            wtree,
            expected_output_schema: dereferencedV3Schema("next-input"),
          }),
        );
        return 1;
      }
      const schemaErrors = validateV3Input(payload, "next-input");
      if (schemaErrors.length) {
        questResponse(
          v3Error("output schema validation failed", {
            wtree,
            schema: v3SchemaRef("next-input"),
            errors: schemaErrors,
          }),
        );
        return 1;
      }
      if (String(payload.action ?? "") !== "create_quest") {
        questResponse(
          v3Error("select_quest action must be create_quest", { wtree }),
        );
        return 1;
      }
      if (payload.wtree && String(payload.wtree) !== wtree) {
        questResponse(v3Error("payload wtree does not match --wtree", { wtree }));
        return 1;
      }
      const request = String(payload.request ?? "").trim();
      if (!request) {
        questResponse(v3Error("create_quest requires request", { wtree }));
        return 1;
      }
      const flowId = String(payload.flow_id ?? DEFAULT_FLOW_ID).trim();
      const created = createV3Quest({
        repoRoot: context.repoRoot,
        wtree,
        request,
        resolutionSource: context.source,
        flowId: flowId || DEFAULT_FLOW_ID,
      });
      questResponse(
        v3StepOutput({
          repoRoot: context.repoRoot,
          files: created.files,
          state: created.state,
          full: args.full,
        }),
      );
      return 0;
    }

    const rootSignaturePath = resolve(
      questWorkspaceRoot(existing.files),
      LOOPO_ROOT_MANIFEST_FILE,
    );
    if (existsSync(rootSignaturePath)) {
      const rootSignature = verifyRootManifest(questWorkspaceRoot(existing.files));
      if (!rootSignature.ok) {
        questResponse(
          v3Error("root signature verification failed", {
            errors: rootSignature.errors,
          }),
        );
        return 2;
      }
    }
    const manifestCheck = verifyQuestManifest(existing.files);
    if (!manifestCheck.ok) {
      questResponse(
        v3Error("quest manifest verification failed", {
          wtree,
          errors: manifestCheck.errors,
        }),
      );
      return 2;
    }

    let state = existing.state;
    let responseFiles = existing.files;
    const hasInput = Object.keys(payload).length > 0;
    if (hasInput) {
      const flow = loadStateFlow(state);
      const currentStage = String(state.stage ?? flow.default_stage);
      const expected = stageInputStep(currentStage, flow);
      const stepError = assertStep(payload, expected);
      if (stepError) {
        questResponse(v3Error(stepError, { wtree, state: state.stage }));
        return 1;
      }
      const schemaSource = inputSchemaForStage(currentStage, flow);
      if (!schemaSource) {
        questResponse(
          v3Error("current step does not accept an output payload", { wtree }),
        );
        return 1;
      }
      const schemaErrors = validateSchemaSource(payload, schemaSource);
      if (schemaErrors.length) {
        questResponse(
          v3Error("output schema validation failed", {
            wtree,
            state: state.stage,
            schema:
              typeof schemaSource === "string"
                ? { schema_path: schemaSource }
                : schemaSource,
            errors: schemaErrors,
          }),
        );
        return 1;
      }
      const requestId = `next-${wtree}-${Date.now().toString(36)}`;
      try {
        if (expected === "plan") {
          state = handlePlan({
            files: existing.files,
            state,
            payload,
            requestId,
          });
        } else if (expected === "questions") {
          state = handleQuestions({
            files: existing.files,
            payload,
            requestId,
          });
        } else if (expected === "task_graph") {
          state = handleTaskGraph({
            files: existing.files,
            state,
            payload,
            requestId,
          });
        } else if (expected === "child_result") {
          state = handleChildResult({
            repoRoot: context.repoRoot,
            files: existing.files,
            state,
            payload,
            requestId,
          });
        } else if (expected === "validation") {
          state = handleValidation({
            files: existing.files,
            state,
            payload,
            requestId,
          });
        } else if (expected === "verification") {
          state = handleVerification({
            files: existing.files,
            payload,
            requestId,
          });
        } else if (expected === "system_update") {
          state = handleSystemUpdate({
            repoRoot: context.repoRoot,
            files: existing.files,
            state,
            payload,
            requestId,
          });
        } else if (expected === "landing") {
          const landing = handleLanding({
            repoRoot: context.repoRoot,
            files: existing.files,
            payload,
            requestId,
          });
          state = landing.state;
          responseFiles = landing.files;
        }
      } catch (error) {
        questResponse(
          v3Error(error instanceof Error ? error.message : String(error), {
            wtree,
            state: state.stage,
          }),
        );
        return 1;
      }
    }

    const refreshed = parseTasksYaml(readText(responseFiles.tasks));
    questResponse(
      v3StepOutput({
        repoRoot: context.repoRoot,
        files: responseFiles,
        state: refreshed,
        full: args.full,
      }),
    );
    return 0;
  } finally {
    releaseWtreeLock(lock);
  }
}

export function runHook(argv: string[]): number {
  const args = parseQuestRepoArg(argv);
  const raw = readHookJsonArg(args.json);
  const envelopeLike = raw.command === "hook";
  const payload = envelopeLike && raw.payload ? raw.payload : raw;
  const contextPayload = {
    ...(envelopeLike ? raw.context : {}),
    ...(envelopeLike ? raw.metadata : {}),
    ...payload,
  };
  const runtime = String(
    args.runtime ??
      contextPayload.runtime ??
      (envelopeLike ? raw.context?.runtime : null) ??
      "codex",
  ) as Runtime;
  let context: { repoRoot: string; source: string };
  try {
    const hookCwd = resolveCwd(contextPayload);
    context = resolveRepoContext({
      repo: args.repo,
      payload: contextPayload,
      cwd: hookCwd,
    });
  } catch {
    process.stdout.write("{}");
    return 0;
  }
  const resolved = resolveHookWtree({
    repoRoot: context.repoRoot,
    explicitWtree: args.wtree,
    payload,
    contextPayload,
  });
  if (!resolved.ok) {
    process.stdout.write("{}");
    return 0;
  }
  const activeQuest = {
    files: questFiles(context.repoRoot, resolved.wtree),
    state: parseTasksYaml(readText(questFiles(context.repoRoot, resolved.wtree).tasks)),
  };
  const manifestCheck = verifyQuestManifest(activeQuest.files);
  if (!manifestCheck.ok) {
    process.stdout.write("{}");
    return 0;
  }
  const stage = String(activeQuest.state.stage ?? "planning");
  const eventName = hookEventName(payload);
  const snapshot = questHookSnapshotFingerprint(activeQuest.files);
  const latestStop = latestHookStopState(activeQuest.files);
  const chainState = loadHookRuntimeState(activeQuest.files);
  const chainKey = hookChainKey(
    runtime,
    context.repoRoot,
    activeQuest.files.wtree,
  );
  const chain = (chainState.chains[chainKey] ??= {});
  const duplicateKey = [
    runtime,
    eventName,
    context.repoRoot,
    activeQuest.files.wtree,
    latestStop.iteration,
    snapshot,
  ].join("\n");
  if (chain.handled_keys?.[duplicateKey]) {
    process.stdout.write("{}");
    return 0;
  }
  const taskState = taskTerminalState(activeQuest.state);
  const canContinue =
    stage !== "archived" &&
    shouldHookContinue({
      stopReason: latestStop.stopReason,
      taskState,
    });
  if (!canContinue) {
    chain.continuation_count = 0;
    chain.budget_prompted = false;
    rememberHookKey(chain, duplicateKey);
    saveHookRuntimeState(activeQuest.files, chainState);
    appendJsonl(activeQuest.files.events, {
      event: "hook_decision",
      runtime,
      hook_event_name: eventName || null,
      stage,
      iteration: latestStop.iteration,
      stop_reason: latestStop.stopReason,
      task_state: taskState,
      decision: null,
    });
    writeQuestManifest(activeQuest.files, "hook", "loopo hook");
    process.stdout.write("{}");
    return 0;
  }
  const budgetUsed = Number(chain.continuation_count ?? 0);
  const budgetExhausted =
    budgetUsed >= AUTO_CONTINUE_BUDGET || chain.budget_prompted === true;
  if (budgetExhausted && chain.budget_prompted) {
    rememberHookKey(chain, duplicateKey);
    saveHookRuntimeState(activeQuest.files, chainState);
    process.stdout.write("{}");
    return 0;
  }
  const stepDoc = v3StepOutput({
    repoRoot: context.repoRoot,
    files: activeQuest.files,
    state: activeQuest.state,
  });
  const reason = JSON.stringify({
    loopo: true,
    command: "quest.next",
    ...stepDoc,
  });
  const budgetReason = JSON.stringify({
    loopo: true,
    command: "quest.next",
    wtree: activeQuest.files.wtree,
    step: stageToV3Step(stage, loadStateFlow(activeQuest.state)),
    stop_reason: "budget_exhausted",
    summary:
      "Continuation budget exhausted. Resume manually with loopo quest next --wtree <name> --json @-.",
  });
  if (budgetExhausted) chain.budget_prompted = true;
  else chain.continuation_count = budgetUsed + 1;
  rememberHookKey(chain, duplicateKey);
  saveHookRuntimeState(activeQuest.files, chainState);
  appendJsonl(activeQuest.files.events, {
    event: "hook_decision",
    runtime,
    hook_event_name: eventName || null,
    stage,
    iteration: latestStop.iteration,
    stop_reason: latestStop.stopReason,
    task_state: taskState,
    decision: budgetExhausted ? "budget_exhausted" : "continue",
    continuation_count: chain.continuation_count ?? budgetUsed,
    snapshot_fingerprint: snapshot,
  });
  writeQuestManifest(activeQuest.files, "hook", "loopo hook");
  process.stdout.write(
    JSON.stringify(
      hookOutput(
        runtime,
        true,
        budgetExhausted ? budgetReason : reason,
        eventName,
      ),
    ),
  );
  return 0;
}

function runQuest(argv: string[]): number {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  if (subcommand === "next") return runQuestNextV3(rest);
  usage();
  return 1;
}

export function runInit(argv: string[]): number {
  const args = parseInitArgs(argv);
  if (args.objective) {
    ensureV3Runtime({
      repoRoot: args.repo,
      runtime: args.runtime,
      skillHome: args.skillHome,
    });
    questResponse(
      v3InitRoute({
        repoRoot: args.repo,
        runtime: args.runtime,
        request: args.objective,
        flowId: args.flowId,
        wtree: args.wtree,
      }),
    );
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
  console.log(`loopo init: repo=${args.repo}`);
  console.log(`loopo init: mode=installer`);
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
    return runLoopoCmdproto(argv, { control: false });
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
  if (cmd === "init") return runInit(rest);
  if (cmd === "hook") return runHook(rest);
  if (cmd === "quest") return runQuest(rest);
  if (cmd === "sim") return runSimCli(rest);
  if (cmd === "handbook") return runHandbook(rest);
  if (cmd === "cmdproto") return runLoopoCmdproto(rest);
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
