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
  createLoopoShim,
  createQuest,
  ensureCoordinatorWorkspace,
  ensureTaskWorkspace,
  ensureGlobalSkillFiles,
  ensureGitRootCommit,
  ensureSystemScaffold,
  landingTargetWorktreePath,
  LOOPO_HOOK_STATE_FILE,
  LOOPO_SYSTEM_FILE,
  LOOPO_ROOT_MANIFEST_FILE,
  parseTasksYaml,
  taskAssignmentBranchRef,
  taskAssignmentChildSlug,
  taskAssignmentWorktreePath,
  type QuestFiles,
  type QuestTask,
  questFiles,
  resolveGlobalLoopoBinPath,
  slugify,
  updateQuestStage,
  verifyQuestManifest,
  verifyRootManifest,
  writeQuestPlan,
  writeQuestManifest,
} from "./loopo_core.ts";
import {
  DEFAULT_FLOW_ID,
  DEFAULT_FLOW_VERSION,
  flowStage,
  flowStep,
  loadFlowDefinition,
  type LoadedLoopoFlow,
} from "./loopo_flow.ts";
import {
  dereferencedV3Schema,
  validateV3Input,
  v3SchemaPath,
  v3SchemaRef,
} from "./loopo_schema.ts";
import { runLoopoCmdproto } from "./loopo_cmdproto.ts";
import { runSimCli } from "./loopo_sim.ts";

type Command = "init" | "doctor" | "quest" | "hook" | "sim" | "cmdproto";

type ParentQuestAssignment = {
  parent_wtree: string;
  task_id: string;
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
  "Follow the instructions above, then construct one JSON payload matching callback_schema and send it to commands.next.";
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
  loopo cmdproto --help [--json]
  loopo cmdproto execjson <path> <json|@file|@->
`);
}

function parseCommand(argv: string[]): Command {
  const cmd = argv[0] as Command | undefined;
  if (
    !cmd ||
    !["init", "doctor", "quest", "hook", "sim", "cmdproto"].includes(cmd)
  ) {
    usage();
    process.exit(1);
  }
  return cmd as Command;
}

function ensureRepo(path: string): string {
  const repo = resolve(expandHome(path));
  if (!existsSync(repo)) throw new Error(`repo path does not exist: ${repo}`);
  return realpathSync(repo);
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
    if (existsSync(resolve(resolved, ".loopo"))) {
      return { repoRoot: realpathSync(resolved), source: "loopo_ancestor" };
    }
    let cursor = resolved;
    while (true) {
      if (existsSync(resolve(cursor, ".loopo"))) {
        return { repoRoot: realpathSync(cursor), source: "loopo_ancestor" };
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    const gitRoot = gitRootFrom(resolved);
    if (gitRoot) return { repoRoot: realpathSync(gitRoot), source: "git_root" };
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
    } else if (arg === "--slug" || arg?.startsWith("--slug=")) {
      throw new Error("loopo init no longer accepts --slug; use --wtree for an explicit base worktree name");
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
  const rootCheck = existsSync(resolve(repoRoot, LOOPO_ROOT_MANIFEST_FILE))
    ? verifyRootManifest(repoRoot)
    : { ok: false, errors: ["missing root system manifest"] };
  const issues: string[] = [];
  for (const path of expectedFiles) {
    if (!existsSync(path)) issues.push(`missing ${path}`);
  }
  for (const issue of rootCheck.errors) issues.push(issue);
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

  const systemFiles = ensureSystemScaffold(repoRoot);
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
  for (const path of systemFiles) console.log(`- ${path}`);
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
): string | null {
  return flowStep(flow, stage).input_schema;
}

function outputSchemaForStage(
  stage: string,
  flow = loadFlowDefinition(),
): string {
  return flowStep(flow, stage).output_schema;
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

function questBySlug(
  repoRoot: string,
  slug: string,
): { files: QuestFiles; state: Partial<{ [key: string]: any }> } | null {
  const files = questFiles(repoRoot, slug);
  if (!existsSync(files.tasks)) return null;
  return { files, state: parseTasksYaml(readText(files.tasks)) };
}

function allQuestSlugs(repoRoot: string): string[] {
  const questsDir = resolve(repoRoot, ".loopo", "quests");
  if (!existsSync(questsDir)) return [];
  return readdirSync(questsDir)
    .filter((slug) => existsSync(questFiles(repoRoot, slug).tasks))
    .sort();
}

function findParentQuestAssignment(
  repoRoot: string,
  childSlug: string,
): ParentQuestAssignment | null {
  for (const parentSlug of allQuestSlugs(repoRoot)) {
    const parentQuest = questBySlug(repoRoot, parentSlug);
    const parentTasks = Array.isArray(parentQuest?.state.tasks)
      ? (parentQuest!.state.tasks as QuestTask[])
      : [];
    const matched = parentTasks.find(
      (task) =>
        String(task.child_wtree ?? "").trim() === childSlug ||
        taskAssignmentChildSlug(parentSlug, String(task.id)) === childSlug ||
        `${parentSlug}-${task.id}` === childSlug,
    );
    if (!matched) continue;
    return {
      parent_wtree: parentSlug,
      task_id: matched.id,
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
  return allQuestSlugs(repoRoot)
    .map((slug) => {
      const quest = questBySlug(repoRoot, slug);
      const prompt = String(quest?.state.prompt ?? "");
      const haystack = requestTokens(`${slug} ${prompt}`);
      let score = 0;
      for (const token of tokens) {
        if (haystack.has(token)) score += 1;
      }
      return {
        wtree: slug,
        score,
        description: prompt || slug,
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
          slug,
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

function suggestedSlug(request: string): string {
  return slugify(request.replace(/^loopo:\s*/i, "") || "quest");
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
  ensureSystemScaffold(input.repoRoot);
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
    String(input.wtree ?? "").trim() || suggestedSlug(input.request),
  );
  const flow = loadFlowDefinition(input.flowId);
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
      callback_schema: embeddedCallbackSchema("next-input"),
      input: createQuestInput,
    },
  };
}

function lockPath(repoRoot: string, slug: string): string {
  return resolve(repoRoot, ".loopo", "locks", `${slug}.json`);
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

type SlugLock =
  | { ok: true; path: string; token: string }
  | { ok: false; response: Record<string, unknown> };

function acquireSlugLock(repoRoot: string, slug: string): SlugLock {
  const path = lockPath(repoRoot, slug);
  mkdirSync(dirname(path), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const body = {
    schema_version: 3,
    slug,
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
          wtree: slug,
          lock: {
            path,
            pid,
            retry: compactCommand("loopo", [
              "quest",
              "next",
              "--wtree",
              slug,
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
      wtree: slug,
      lock: { path, pid: null, retry: "stale lock could not be reaped" },
    },
  };
}

function releaseSlugLock(lock: SlugLock): void {
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
  slug: string,
  state: Partial<{ tasks: QuestTask[] }>,
  full = false,
): Array<Record<string, unknown>> {
  const command = full ? compactCommand : tokenCommand;
  const flowId = flowIdForState(state as Partial<{ [key: string]: any }>);
  const runtime = inferRepoRuntime(repoRoot);
  return readyChildTasks(state).map((task) => {
    const childSlug =
      String(task.child_wtree || "").trim() ||
      taskAssignmentChildSlug(slug, String(task.id));
    const workspace = ensureTaskWorkspace(
      repoRoot,
      String(task.branch_ref || taskAssignmentBranchRef(slug, String(task.id))),
      String(
        task.worktree_path ||
          taskAssignmentWorktreePath(repoRoot, slug, String(task.id)),
      ),
    );
    const request = `loopo: execute child task ${task.id}: ${task.title}`;
    return {
      task_id: task.id,
      title: task.title,
      child_wtree: childSlug,
      branch_ref: workspace.branch_ref,
      worktree_path: workspace.worktree_path,
      acceptance: task.acceptance,
      commands: {
        init: command("loopo", [
          "init",
          request,
          "--wtree",
          childSlug,
          "--runtime",
          runtime,
          "--flow",
          flowId,
        ]),
        next: command("loopo", [
          "quest",
          "next",
          "--wtree",
          childSlug,
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
  return `${stepDef.instructions.trimEnd()}\n\n${NEXT_PAYLOAD_INSTRUCTION}`;
}

function embeddedCallbackSchema(schemaName: string | null): unknown {
  return schemaName ? dereferencedV3Schema(schemaName) : null;
}

function stepContextData(
  stepDef: ReturnType<typeof flowStep>,
): Record<string, unknown> {
  return {
    schema_version: stepDef.schema_version,
    id: stepDef.id,
    handler: stepDef.handler,
    input_step: stepDef.input_step,
    callback_schema: embeddedCallbackSchema(stepDef.input_schema),
    output_schema: stepDef.output_schema,
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
    input.files.slug,
    "--json",
    "@-",
  ];
  if (!input.full) {
    const compactOutput: Record<string, unknown> = {
      step: compactStepData(stepDef),
      callback_schema: embeddedCallbackSchema(stepDef.input_schema),
      commands: {
        next: tokenCommand("loopo", nextArgs),
      },
    };
    if (step === "executing") {
      compactOutput.children = readyChildrenForV3(
        input.repoRoot,
        input.files.slug,
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
    schema_path: v3SchemaPath(schema),
    wtree: input.files.slug,
    flow_id: flow.id,
    flow_version: flow.version,
    step,
    state: stage,
    summary: v3StepSummary(stage, flow),
    callback_schema: embeddedCallbackSchema(stepDef.input_schema),
    commands: {
      next: tokenCommand("loopo", nextArgs),
    },
  };
  if (input.full) {
    output.quest_id = input.files.slug;
    output.allowed_transitions = flowStage(flow, stage).transitions;
    output.context = {
      step: stepContextData(stepDef),
    };
    output.commands = {
      next: compactCommand("loopo", nextArgs),
    };
    output.docs = {
      state_yaml: input.files.tasks,
      plan_yaml: input.files.plan,
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
      input.files.slug,
      input.state,
      input.full === true,
    );
  }
  if (step === "archived") {
    output.callback_schema = null;
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
  appendJsonl(files.handoffs, {
    event,
    quest_id: files.slug,
    payload,
  });
}

function writeV3Manifest(files: QuestFiles, requestId: string): void {
  writeQuestManifest(files, requestId, "loopo quest next");
}

function validatePlan(
  input: Record<string, any>,
  state: Partial<{ [key: string]: any }>,
  files: QuestFiles,
): string | null {
  for (const key of [
    "classification",
    "scope",
    "af",
    "of",
    "verification_targets",
    "task_graph",
  ]) {
    if (input[key] == null) return `plan missing required field: ${key}`;
  }
  const highImpact = asArray(input.high_impact_unknowns);
  const defaulted = asArray(input.defaulted_unknowns);
  const questions = asArray(input.questions);
  const hasRecordedAnswers = readText(files.questions)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => {
      try {
        return JSON.parse(line)?.event === "answers";
      } catch {
        return false;
      }
    });
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
  return null;
}

function handlePlan(input: {
  files: QuestFiles;
  state: Partial<{ [key: string]: any }>;
  payload: Record<string, any>;
  requestId: string;
}): Partial<{ [key: string]: any }> {
  const validation = validatePlan(input.payload, input.state, input.files);
  if (validation) throw new Error(validation);
  const questions = asArray(input.payload.questions);
  appendJsonl(input.files.plans, {
    event: "plan",
    quest_id: input.files.slug,
    payload: input.payload,
  });
  if (questions.length) {
    appendJsonl(input.files.questions, {
      event: "question_round",
      quest_id: input.files.slug,
      questions,
    });
    return updateQuestStage(
      input.files,
      "awaiting_user_answers",
      input.requestId,
      "loopo quest next",
    );
  }
  const plan = {
    summary: String(input.payload.summary ?? input.payload.scope ?? ""),
    assumptions: asArray(input.payload.assumptions),
    constraints: asArray(input.payload.constraints),
    tasks: asArray(input.payload.task_graph?.tasks),
  };
  const planned = applyQuestPlanToTasks(input.files, input.state, plan);
  writeQuestPlan(input.files, planned, plan);
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
  appendJsonl(input.files.questions, {
    event: "answers",
    quest_id: input.files.slug,
    answers: input.payload.answers,
  });
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
  const normalized = slugify(taskId);
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
  return entry.replace(/^[A-Z?! ][A-Z?! ]\s+/, "").trim();
}

function isIgnorableOperationalDirtyPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized === ".codex/hooks.json" ||
    normalized === ".gemini/settings.json" ||
    normalized === ".github/hooks/loopo.json" ||
    normalized === ".github/hooks" ||
    normalized.startsWith(".loopo/") ||
    normalized.startsWith("worktrees/")
  );
}

function relevantGitDirtyEntries(path: string): string[] {
  return gitWorktreeDirtyEntries(path).filter(
    (entry) => !isIgnorableOperationalDirtyPath(dirtyEntryPath(entry)),
  );
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
  const dirtyTargetEntries = relevantGitDirtyEntries(targetWorktree);
  if (dirtyTargetEntries.length) {
    throw new Error(
      `cannot merge into dirty landing target worktree ${targetWorktree}: ${dirtyTargetEntries.slice(0, 5).join(", ")}`,
    );
  }
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
  const dirtyAfterMerge = relevantGitDirtyEntries(targetWorktree);
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
  slug: string;
  state: Partial<{ [key: string]: any }>;
}): {
  parentQuestSlug: string;
  landingTargetBranch: string;
  landingTargetWorktree: string;
} {
  const parentQuestSlug = String(input.state.parent_wtree ?? "").trim();
  const landingTargetBranch = String(
    input.state.landing_target_branch ?? "",
  ).trim();
  const landingTargetWorktree = String(
    input.state.landing_target_worktree ?? "",
  ).trim();
  if (landingTargetBranch) {
    return {
      parentQuestSlug,
      landingTargetBranch,
      landingTargetWorktree:
        landingTargetWorktree ||
        landingTargetWorktreePath(input.repoRoot, landingTargetBranch),
    };
  }
  if (isChildExecutionQuestPrompt(input.state.prompt)) {
    const parent = findParentQuestAssignment(input.repoRoot, input.slug);
    if (parent) {
      return {
        parentQuestSlug: parent.parent_wtree,
        landingTargetBranch: parent.landing_target_branch,
        landingTargetWorktree: parent.landing_target_worktree,
      };
    }
  }
  return {
    parentQuestSlug: "",
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
  const payloadChildSlug = String(input.payload.child_wtree ?? "").trim();
  if (task.child_wtree.trim() && payloadChildSlug !== task.child_wtree.trim()) {
    throw new Error(
      `child_result child_wtree must match planned child wtree ${task.child_wtree}`,
    );
  }
  if (status === "passed") {
    const childQuest = task.child_wtree.trim()
      ? questBySlug(input.repoRoot, task.child_wtree.trim())
      : null;
    if (childQuest) {
      const childStage = String(childQuest.state.stage ?? "");
      if (childStage !== "archived") {
        throw new Error(
          `child_result cannot pass until child quest ${task.child_wtree} is archived; current stage=${childStage || "unknown"}`,
        );
      }
    }
  }
  const taskUpdate = {
    id: String(input.payload.task_id),
    child_wtree: String(input.payload.child_wtree),
    branch_ref: String(input.payload.branch_ref ?? input.payload.child_wtree),
    worktree_path: String(input.payload.worktree_path ?? ""),
    merge_target: input.files.slug,
    merge_lease_id: String(
      input.payload.merge_lease_id ??
        `lease-${input.files.slug}-${input.payload.task_id}`,
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
  appendJsonl(input.files.evidence, {
    event: "child_result",
    quest_id: input.files.slug,
    payload: input.payload,
  });
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
  appendJsonl(input.files.validation, {
    event: "validation",
    quest_id: input.files.slug,
    payload: input.payload,
  });
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
  appendJsonl(input.files.review, {
    event: "verification",
    quest_id: input.files.slug,
    payload: input.payload,
  });
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
  payload: Record<string, any>;
  requestId: string;
}): Partial<{ [key: string]: any }> {
  if (!input.payload.system_update) {
    throw new Error("system_update input requires system_update");
  }
  appendJsonl(input.files.review, {
    event: "system_update",
    quest_id: input.files.slug,
    payload: input.payload,
  });
  applySystemUpdate(
    input.repoRoot,
    input.payload.system_update,
    input.requestId,
  );
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
}): Partial<{ [key: string]: any }> {
  if (!["landed", "blocked"].includes(String(input.payload.status))) {
    throw new Error("landing status must be landed or blocked");
  }
  let landingReceipt: GitLandingReceipt | null = null;
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
    const unresolvedChildren = tasks.filter((task) => {
      if (!CHILD_DONE_STATUSES.has(task.status)) return false;
      const slug = String(task.child_wtree ?? "").trim();
      if (!slug) return false;
      const childQuest = questBySlug(input.repoRoot, slug);
      return childQuest != null && String(childQuest.state.stage ?? "") !== "archived";
    });
    if (unresolvedChildren.length) {
      throw new Error(
        `cannot land while child quests are unresolved: ${unresolvedChildren.map((task) => task.child_wtree).join(", ")}`,
      );
    }
    const dirtyCoordinatorEntries = relevantGitDirtyEntries(
      String(currentState.coordinator_worktree ?? ""),
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
      slug: input.files.slug,
      state: currentState,
    });
    landingReceipt = gitMergeIntoBranch(
      input.repoRoot,
      String(currentState.coordinator_branch ?? ""),
      landingContext.landingTargetBranch,
      landingContext.landingTargetWorktree,
    );
    applyLandingReceipt(input.files, currentState, {
      parent_wtree: landingContext.parentQuestSlug,
      landing_target_branch: landingReceipt.target_branch,
      landing_target_worktree: landingReceipt.target_worktree,
      landed_commit: landingReceipt.landed_commit,
      landing_strategy: landingReceipt.strategy,
    });
  }
  appendV3Event(input.files, "landing", {
    ...input.payload,
    ...(landingReceipt
      ? {
          landing: {
            source_branch: landingReceipt.source_branch,
            target_branch: landingReceipt.target_branch,
            target_worktree: landingReceipt.target_worktree,
            landed_commit: landingReceipt.landed_commit,
            strategy: landingReceipt.strategy,
          },
        }
      : {}),
  });
  return updateQuestStage(
    input.files,
    input.payload.status === "landed" ? "archived" : "landing_ready",
    input.requestId,
    "loopo quest next",
  );
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

function loadHookRuntimeState(repoRoot: string): HookRuntimeState {
  const parsed = readJson(resolve(repoRoot, LOOPO_HOOK_STATE_FILE));
  if (!parsed || typeof parsed !== "object") {
    return { schema_version: 1, chains: {} };
  }
  const chains =
    parsed.chains && typeof parsed.chains === "object"
      ? (parsed.chains as Record<string, HookChainState>)
      : {};
  return { schema_version: 1, chains };
}

function saveHookRuntimeState(repoRoot: string, state: HookRuntimeState): void {
  writeJson(resolve(repoRoot, LOOPO_HOOK_STATE_FILE), state);
}

function hookChainKey(
  runtime: Runtime,
  contextRoot: string,
  slug: string,
): string {
  return hashText([runtime, contextRoot, slug].join("\n"));
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
  const childFiles = existsSync(files.children_dir)
    ? readdirSync(files.children_dir)
        .filter((name) => name.endsWith(".yaml") || name.endsWith(".jsonl"))
        .map((name) => resolve(files.children_dir, name))
    : [];
  return [
    files.tasks,
    files.plan,
    files.questions,
    files.plans,
    files.evidence,
    files.validation,
    files.review,
    files.handoffs,
    ...childFiles,
  ].sort();
}

function questHookSnapshotFingerprint(files: QuestFiles): string {
  return hashText(
    questHookSnapshotFiles(files)
      .map((file) => `${file}:${hashText(readText(file))}`)
      .join("\n"),
  );
}

function latestHookStopState(files: QuestFiles): {
  iteration: string;
  stopReason: string;
} {
  let iteration = "0";
  let stopReason = "none";
  for (const line of readText(files.handoffs).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, any>;
      const payload =
        record.payload && typeof record.payload === "object"
          ? (record.payload as Record<string, any>)
          : {};
      const handoff =
        payload.handoff && typeof payload.handoff === "object"
          ? (payload.handoff as Record<string, any>)
          : {};
      const nextIteration =
        record.iteration ??
        record.iteration_id ??
        payload.iteration ??
        payload.iteration_id ??
        handoff.iteration ??
        handoff.iteration_id;
      if (nextIteration != null) iteration = String(nextIteration);
      const nextStopReason =
        record.stop_reason ?? payload.stop_reason ?? handoff.stop_reason;
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
    } else if (arg === "--slug" || arg?.startsWith("--slug=")) {
      throw new Error("loopo no longer accepts --slug; use --wtree");
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
  slug: string;
  request: string;
  resolutionSource: string;
  flowId: string;
}): { files: QuestFiles; state: Partial<{ [key: string]: any }> } {
  ensureSystemScaffold(input.repoRoot);
  ensureGitRootCommit(input.repoRoot);
  const flow = loadFlowDefinition(input.flowId);
  const workspace = ensureCoordinatorWorkspace(input.repoRoot, input.slug);
  const parentAssignment = isChildExecutionQuestPrompt(input.request)
    ? findParentQuestAssignment(input.repoRoot, input.slug)
    : null;
  const landingTargetBranch = parentAssignment
    ? parentAssignment.landing_target_branch
    : "main";
  const landingTargetWorktree = parentAssignment
    ? parentAssignment.landing_target_worktree
    : landingTargetWorktreePath(input.repoRoot, landingTargetBranch);
  const { files, state } = createQuest({
    repoRoot: input.repoRoot,
    slug: input.slug,
    prompt: input.request,
    resolutionSource: input.resolutionSource,
    workspace,
    flowId: flow.id,
    flowVersion: flow.version,
    parentQuestSlug: parentAssignment?.parent_wtree ?? "",
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
  let slug: string;
  try {
    slug = requireWtreeName(String(args.wtree ?? payload.wtree ?? "").trim());
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
  const lock = acquireSlugLock(context.repoRoot, slug);
  if (!lock.ok) {
    questResponse(lock.response);
    return 2;
  }
  try {
    const existing = questBySlug(context.repoRoot, slug);
    if (!existing) {
      const stepError = assertStep(payload, "select_quest");
      if (stepError) {
        questResponse(
          v3Error("quest does not exist; create it with select_quest input", {
            wtree: slug,
            expected_callback_schema: embeddedCallbackSchema("next-input"),
          }),
        );
        return 1;
      }
      const schemaErrors = validateV3Input(payload, "next-input");
      if (schemaErrors.length) {
        questResponse(
          v3Error("callback schema validation failed", {
            wtree: slug,
            schema: v3SchemaRef("next-input"),
            errors: schemaErrors,
          }),
        );
        return 1;
      }
      if (String(payload.action ?? "") !== "create_quest") {
        questResponse(
          v3Error("select_quest action must be create_quest", { wtree: slug }),
        );
        return 1;
      }
      if (payload.wtree && String(payload.wtree) !== slug) {
        questResponse(v3Error("payload wtree does not match --wtree", { wtree: slug }));
        return 1;
      }
      const request = String(payload.request ?? "").trim();
      if (!request) {
        questResponse(v3Error("create_quest requires request", { wtree: slug }));
        return 1;
      }
      const flowId = String(payload.flow_id ?? DEFAULT_FLOW_ID).trim();
      const created = createV3Quest({
        repoRoot: context.repoRoot,
        slug,
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

    const rootManifest = verifyRootManifest(context.repoRoot);
    if (!rootManifest.ok) {
      questResponse(
          v3Error("root manifest verification failed", {
            errors: rootManifest.errors,
        }),
      );
      return 2;
    }
    const manifestCheck = verifyQuestManifest(existing.files);
    if (!manifestCheck.ok) {
      questResponse(
        v3Error("quest manifest verification failed", {
          wtree: slug,
          errors: manifestCheck.errors,
        }),
      );
      return 2;
    }

    let state = existing.state;
    const hasInput = Object.keys(payload).length > 0;
    if (hasInput) {
      const flow = loadStateFlow(state);
      const currentStage = String(state.stage ?? flow.default_stage);
      const expected = stageInputStep(currentStage, flow);
      const stepError = assertStep(payload, expected);
      if (stepError) {
        questResponse(v3Error(stepError, { wtree: slug, state: state.stage }));
        return 1;
      }
      const schemaName = inputSchemaForStage(currentStage, flow);
      if (!schemaName) {
        questResponse(
          v3Error("current step does not accept a callback payload", { wtree: slug }),
        );
        return 1;
      }
      const schemaErrors = validateV3Input(payload, schemaName);
      if (schemaErrors.length) {
        questResponse(
          v3Error("callback schema validation failed", {
            wtree: slug,
            state: state.stage,
            schema: v3SchemaRef(schemaName),
            errors: schemaErrors,
          }),
        );
        return 1;
      }
      const requestId = `next-${slug}-${Date.now().toString(36)}`;
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
            payload,
            requestId,
          });
        } else if (expected === "landing") {
          state = handleLanding({
            repoRoot: context.repoRoot,
            files: existing.files,
            payload,
            requestId,
          });
        }
      } catch (error) {
        questResponse(
          v3Error(error instanceof Error ? error.message : String(error), {
            wtree: slug,
            state: state.stage,
          }),
        );
        return 1;
      }
    }

    const refreshed = parseTasksYaml(readText(existing.files.tasks));
    questResponse(
      v3StepOutput({
        repoRoot: context.repoRoot,
        files: existing.files,
        state: refreshed,
        full: args.full,
      }),
    );
    return 0;
  } finally {
    releaseSlugLock(lock);
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
  const chainState = loadHookRuntimeState(context.repoRoot);
  const chainKey = hookChainKey(
    runtime,
    context.repoRoot,
    activeQuest.files.slug,
  );
  const chain = (chainState.chains[chainKey] ??= {});
  const duplicateKey = [
    runtime,
    eventName,
    context.repoRoot,
    activeQuest.files.slug,
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
    saveHookRuntimeState(context.repoRoot, chainState);
    appendJsonl(activeQuest.files.hook_events, {
      runtime,
      event: eventName || null,
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
    saveHookRuntimeState(context.repoRoot, chainState);
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
    wtree: activeQuest.files.slug,
    step: stageToV3Step(stage, loadStateFlow(activeQuest.state)),
    stop_reason: "budget_exhausted",
    summary:
      "Continuation budget exhausted. Resume manually with loopo quest next --wtree <name> --json @-.",
  });
  if (budgetExhausted) chain.budget_prompted = true;
  else chain.continuation_count = budgetUsed + 1;
  rememberHookKey(chain, duplicateKey);
  saveHookRuntimeState(context.repoRoot, chainState);
  appendJsonl(activeQuest.files.hook_events, {
    runtime,
    event: eventName || null,
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
  const systemFiles = ensureSystemScaffold(args.repo);
  const skill = ensureGlobalSkillFiles(args.skillHome);
  console.log(`loopo init: repo=${args.repo}`);
  console.log(`loopo init: mode=installer`);
  for (const path of systemFiles) console.log(`- ${path}`);
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
