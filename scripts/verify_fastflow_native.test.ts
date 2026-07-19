import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
  type PathLike,
  type StatFsOptions,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  createAfnInvocation,
  digestNativeContract,
  type JsonValue,
  validateExecutionDecision,
} from "@cueintent/fastflow";
import {
  applyQuestPlanToTasks,
  createQuest,
  ensureCoordinatorWorkspace,
  ensureTaskWorkspace,
  ensureSystemScaffold,
  applySystemUpdate,
  landingTargetWorktreePath,
  parseTasksYaml,
  questFiles,
  renderTasksYaml,
  taskAssignmentChildWtree,
  updateQuestStage,
  verifyQuestManifest,
  verifyRootManifest,
  type QuestState,
  type QuestTask,
} from "./loopship_core.ts";
import {
  LOOPSHIP_AFN_CALLS,
  LOOPSHIP_AFN_DESCRIPTORS,
  LOOPSHIP_CALL_CATALOG_ROOT,
  LOOPSHIP_DATA_CALLS,
  LOOPSHIP_SUPERVISOR_GUIDANCE,
  cleanupCompletedNativeWorkspaceResidue,
  cleanupLandedWorktrees,
  createLoopshipFastflowAdapters,
  ensureLoopshipFastflowWorkflowCatalog,
  loopshipFlowWorkflowRef,
  recoverLoopshipFastflowWorkflow,
  resumeLoopshipFastflowWorkflow,
  runLoopshipFastflowWorkflow,
  runLoopshipFastflowWorkflowRequest,
} from "./loopship_fastflow.ts";
import { validateSchemaPath, validateV3Input } from "./loopship_schema.ts";
import { nativeResumeRequest } from "./loopship.ts";
import { nativeResumeRequest as nativeStepperResumeRequest } from "./loopship_stepper.ts";
import {
  startLoopshipTestScheduler,
  type LoopshipTestScheduler,
} from "./loopship_fastflow_test_scheduler.ts";
import {
  markLoopshipNativeExecutionCompleted,
  loopshipNativeResultIsTerminal,
  readLoopshipNativeExecutionRequest,
  resolveLoopshipNativeExecutionRequest,
} from "./loopship_native_execution.ts";
import { recordHookRoute } from "./loopship_hook_state.ts";
import {
  acquireCrashSafeFileLock,
  removeFileDurably,
  runCommand,
  writeJson as writeJsonFile,
  writeText,
} from "./loopship_utils.ts";

const LOOPSHIP_SCRIPT = resolve(process.cwd(), "scripts", "loopship.ts");
const FASTFLOW_RUNTIME_GITIGNORE =
  "# fastflow runtime data\ncache/\ndata/\ncatalog.db\ncatalog.db-shm\ncatalog.db-wal\n";
let nativeInvocationSequence = 0;

type LoopshipTestAfnOutput = Record<string, unknown> & {
  actions?: Record<string, { args: string[] }>;
  branch_ref?: string;
  landed_commit?: string;
  prepared_children?: Array<Record<string, unknown>>;
};

async function executeLoopshipAfn(
  adapters: Record<string, unknown>,
  request: Record<string, unknown> & {
    action?: { call?: string; with?: { body?: Record<string, unknown> } };
  },
  identity: { executionId?: string; effectKey?: string } = {},
): Promise<LoopshipTestAfnOutput> {
  const call = String(request.action?.call || "");
  const dispatch = adapters.afnDispatch as {
    listRoutes(): Array<{
      callId: string;
      contractDigest: string;
      implementationDigest: string;
    }>;
    dispatch(invocation: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  const route = dispatch.listRoutes().find((entry) => entry.callId === call);
  if (!route) throw new Error(`Unknown Loopship Native AFN route: ${call}`);
  nativeInvocationSequence += 1;
  const executionId = identity.executionId || `loopship-native-test-${nativeInvocationSequence}`;
  const invocation = createAfnInvocation({
    executionId,
    nodeId: call,
    invocationId: digestNativeContract({ executionId, call, attempt: 1 }),
    attempt: 1,
    call: {
      callId: route.callId,
      contractDigest: route.contractDigest,
      implementationDigest: route.implementationDigest,
    },
    input: (request.action?.with?.body || {}) as unknown as JsonValue,
    effectKey: identity.effectKey || digestNativeContract({ executionId, call, effect: 1 }),
    bindingRefs: [],
    affinityRefs: [],
    grants: [],
  });
  const decision = validateExecutionDecision(
    await dispatch.dispatch(JSON.parse(JSON.stringify(invocation))),
  );
  if (decision.kind === "completed") {
    return decision.output as LoopshipTestAfnOutput;
  }
  throw new Error(
    decision.kind === "failed"
      ? decision.error.message
      : `Loopship AFN '${call}' returned '${decision.kind}'.`,
  );
}

const TEST_INFERENCE_ROUTES_JSON = JSON.stringify(
  Object.fromEntries(
    [
      "llm.cli.codex.gpt-5.5.max",
      "llm.cli.codex.gpt-5.3-codex-spark.max",
      "llm.cli.codex.gpt-5.3-codex-spark.high",
    ].map((routeRef) => [
      routeRef,
      {
        client: "handoff",
        resolverPath: routeRef,
        routeRef,
      },
    ]),
  ),
);

function parseCallId(call: string): {
  registry: string;
  kind: string;
  target: string;
  scope: string;
  name: string;
} {
  const parts = call.split(".");
  expect(parts.length).toBeGreaterThanOrEqual(5);
  for (const part of parts) {
    expect(part).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
  }
  return {
    registry: parts[0],
    kind: parts[1],
    target: parts[2],
    scope: parts[3],
    name: parts.slice(4).join("."),
  };
}

function runNodeCheck(source: string, args: string[] = []): string {
  const dir = mkdtempSync(join(process.cwd(), "tmp", "loopship-fastflow-native-"));
  const script = join(dir, "check.mjs");
  writeFileSync(script, source);
  try {
    return execFileSync("node", [script, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runBunCheck(source: string, args: string[] = []): string {
  const dir = mkdtempSync(join(process.cwd(), "tmp", "loopship-fastflow-bun-"));
  const script = join(dir, "check.mjs");
  writeFileSync(script, source);
  try {
    return execFileSync(process.execPath, ["--no-install", script, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fastflowImport(subpath: "root" | "workflow"): string {
  const fastflowRoot = resolveFastflowRoot();
  const sourcePath =
    subpath === "root"
      ? join(fastflowRoot, "src", "index.mjs")
      : join(fastflowRoot, "src", "workflow.mjs");
  return pathToFileURL(sourcePath).href;
}

function resolveFastflowRoot(requiredFiles = ["src/index.mjs", "src/catalog.mjs"]): string {
  const candidates = [
    process.env.LOOPSHIP_FASTFLOW_ROOT,
    join(process.cwd(), "node_modules", "@cueintent", "fastflow"),
  ].filter(Boolean) as string[];
  const fastflowRoot = candidates.find((candidate) =>
    existsSync(join(candidate, "package.json")) &&
    requiredFiles.every((file) => existsSync(join(candidate, file))),
  );
  if (!fastflowRoot) {
    throw new Error("could not resolve @cueintent/fastflow from node_modules or LOOPSHIP_FASTFLOW_ROOT");
  }
  return fastflowRoot;
}

function fastflowSourceImport(relativePath: string): string {
  return pathToFileURL(join(resolveFastflowRoot([relativePath]), relativePath)).href;
}

function validateNativeWorkflows(workflows: Record<string, unknown>): void {
  const workflowDir = mkdtempSync(
    join(process.cwd(), "tmp", "loopship-fastflow-native-workflows-"),
  );
  const file = join(workflowDir, "workflows.json");
  writeFileSync(file, JSON.stringify(workflows));
  try {
    runNodeCheck(
      `
        import { readFileSync } from "node:fs";
        import {
          normalizeSwfWorkflow,
          validateFastflowSwfSubset,
          validateFastflowWorkflowSchema,
        } from ${JSON.stringify(fastflowImport("workflow"))};

        const workflows = JSON.parse(readFileSync(process.argv[2], "utf8"));
        for (const [name, workflow] of Object.entries(workflows)) {
          const schemaErrors = [];
          validateFastflowWorkflowSchema(workflow, schemaErrors);
          if (schemaErrors.length) throw new Error(name + " schema: " + schemaErrors.join("; "));
          const subsetErrors = [];
          validateFastflowSwfSubset(workflow, { workflow, filePath: "generated/" + name + ".yaml" }, subsetErrors);
          if (subsetErrors.length) throw new Error(name + " subset: " + subsetErrors.join("; "));
          const normalizeErrors = [];
          const normalized = normalizeSwfWorkflow(
            workflow,
            { workflow, filePath: "generated/" + name + ".yaml" },
            normalizeErrors,
          );
          if (normalizeErrors.length) throw new Error(name + " normalize: " + normalizeErrors.join("; "));
          if (!normalized) throw new Error(name + " did not normalize");
        }
      `,
      [file],
    );
  } finally {
    rmSync(workflowDir, { recursive: true, force: true });
  }
}

function executeNativeWorkflow(
  workflow: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Record<string, any> {
  const dir = mkdtempSync(join(process.cwd(), "tmp", "loopship-fastflow-exec-"));
  const workflowFile = join(dir, "workflow.yaml");
  const inputsFile = join(dir, "inputs.json");
  writeFileSync(workflowFile, stringifyYaml(workflow), "utf8");
  writeFileSync(inputsFile, JSON.stringify(inputs), "utf8");
  try {
    const output = runBunCheck(
      `
        import { readFileSync } from "node:fs";
        import { parse as parseYaml } from "yaml";
        import { configureFastflowApp } from ${JSON.stringify(fastflowImport("root"))};
        import {
          normalizeSwfWorkflow,
          validateFastflowSwfSubset,
          validateFastflowWorkflowSchema,
        } from ${JSON.stringify(fastflowImport("workflow"))};
        import { markWorkflowRecordValidated } from ${JSON.stringify(fastflowSourceImport("src/lib/workflows.mjs"))};
        import { executeNativeWorkflow as executeWorkflow } from ${JSON.stringify(fastflowSourceImport("src/lib/native-workflow-runtime.mjs"))};
        import {
          LOOPSHIP_CALL_CATALOG_ROOT,
          createLoopshipFastflowAdapters,
        } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "scripts", "loopship_fastflow.ts")).href)};

        const workflow = parseYaml(readFileSync(process.argv[2], "utf8"));
        const inputs = JSON.parse(readFileSync(process.argv[3], "utf8"));
        configureFastflowApp({
          appName: "loopship",
          systemWorkflowsDir: LOOPSHIP_CALL_CATALOG_ROOT,
          callCatalogRoots: [LOOPSHIP_CALL_CATALOG_ROOT],
          adapters: createLoopshipFastflowAdapters(),
        });
        const recordSeed = {
          filePath: process.argv[2],
          store: "project",
        };
        const errors = [];
        validateFastflowWorkflowSchema(workflow, errors);
        validateFastflowSwfSubset(workflow, recordSeed, errors);
        if (errors.length) throw new Error(errors.join("; "));
        const normalizeErrors = [];
        const normalized = normalizeSwfWorkflow(workflow, recordSeed, normalizeErrors);
        if (normalizeErrors.length) throw new Error(normalizeErrors.join("; "));
        const record = markWorkflowRecordValidated({
          ...recordSeed,
          rawWorkflow: workflow,
          reference: "loopship.workflow.service.step.test",
          workflow_call_id: "loopship.workflow.service.step.test",
          summary: {
            id: "loopship.workflow.service.step.test",
            name: normalized.name,
            namespace: normalized.namespace,
            version: normalized.version,
            dsl: normalized.dsl,
            filePath: recordSeed.filePath,
            store: recordSeed.store,
            reference: "loopship.workflow.service.step.test",
            digest: "sha256:test",
            target: normalized.target,
          },
          workflow: normalized,
        });
        const runtime = {
          target: normalized.target,
          currentMode: "headed",
          preferredMode: "headed",
          async close() {},
        };
        const result = await executeWorkflow(runtime, record, inputs, {
          workspaceRoot: process.cwd(),
          schedulerMode: "test",
        });
        console.log(JSON.stringify({
          output: result.output,
          state: result.state,
          status: result.status,
        }));
      `,
      [workflowFile, inputsFile],
    );
    return JSON.parse(output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function walk(value: unknown, visit: (value: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      walk(item, visit);
    }
  }
}

function loadYamlWorkflow(path: string): Record<string, unknown> {
  return parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function workflowTaskDefinition(
  workflow: Record<string, unknown>,
  taskName: string,
): Record<string, unknown> {
  const tasks = Array.isArray(workflow.do) ? workflow.do : [];
  for (const entry of tasks) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (taskName in (entry as Record<string, unknown>)) {
      const task = (entry as Record<string, unknown>)[taskName];
      if (task && typeof task === "object" && !Array.isArray(task)) {
        return task as Record<string, unknown>;
      }
    }
  }
  throw new Error(`missing workflow task: ${taskName}`);
}

type WorkflowTaskScriptResult = Record<string, unknown> & {
  events: Array<Record<string, unknown>>;
  state_patch: Record<string, unknown>;
};

function executeWorkflowTaskScript(
  task: Record<string, unknown>,
  state: Record<string, unknown>,
): WorkflowTaskScriptResult {
  const run = task.run && typeof task.run === "object" && !Array.isArray(task.run)
    ? (task.run as Record<string, unknown>)
    : {};
  const script = run.script && typeof run.script === "object" && !Array.isArray(run.script)
    ? (run.script as Record<string, unknown>)
    : {};
  const code = typeof script.code === "string" ? script.code : "";
  if (!code.trim()) throw new Error("workflow task is missing run.script.code");
  return Function(
    "state",
    `"use strict"; return (() => { ${code}\n})();`,
  )(state) as WorkflowTaskScriptResult;
}

function workflowIdsFromIndex(path: string): string[] {
  const index = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
  const workflows = index.workflows;
  if (!workflows || typeof workflows !== "object" || Array.isArray(workflows)) {
    return [];
  }
  return Object.keys(workflows);
}

function workflowFileName(id: string): string {
  return `${id.replace(/_/g, "-")}.stable.yaml`;
}

function loadCatalogWorkflows(scopeRoot: string): Record<string, Record<string, unknown>> {
  const ids = workflowIdsFromIndex(join(scopeRoot, "index.yaml"));
  return Object.fromEntries(
    ids.map((id) => [id, loadYamlWorkflow(join(scopeRoot, workflowFileName(id)))]),
  );
}

function allWorkflowFiles(scopeRoot: string): string[] {
  return readdirSync(scopeRoot)
    .filter((name) => name !== "index.yaml")
    .filter((name) => name.endsWith(".stable.yaml"));
}

function workflowContainsCall(workflow: Record<string, unknown>, callId: string): boolean {
  let found = false;
  walk(workflow, (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    if ((item as Record<string, unknown>).call === callId) found = true;
  });
  return found;
}

function findWorkflowByCall(
  workflows: Record<string, Record<string, unknown>>,
  callId: string,
): Record<string, unknown> {
  const workflow = Object.values(workflows).find((candidate) =>
    workflowContainsCall(candidate, callId),
  );
  if (!workflow) throw new Error(`missing workflow containing ${callId}`);
  return workflow;
}

function runGit(cwd: string, args: string[]): string {
  const proc = runCommand("git", args, { cwd, timeoutMs: 30_000 });
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
  return proc.stdout.trim();
}

function createGitFixture(prefix: string): { root: string; repo: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repo = join(root, "repo");
  const init = runCommand("git", ["init", "--initial-branch=main", repo], {
    timeoutMs: 15_000,
  });
  expect(init.status, init.stderr || init.stdout).toBe(0);
  runGit(repo, ["config", "user.email", "loopship-test@example.invalid"]);
  runGit(repo, ["config", "user.name", "Loopship Fastflow Test"]);
  writeFileSync(join(repo, "README.md"), "# loopship fastflow\n", "utf8");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "fixture"]);
  return { root, repo };
}

function createNativeQuest(repo: string, wtree = "demo") {
  const workspace = ensureCoordinatorWorkspace(repo, wtree);
  return createQuest({
    repoRoot: repo,
    wtree,
    prompt: "loopship: native landing",
    resolutionSource: "test",
    workspace,
    flowId: "swe",
    initialStage: "initial",
  });
}

function createFastflowQuest(repo: string, wtree: string, prompt: string) {
  const workspace = ensureCoordinatorWorkspace(repo, wtree);
  return createQuest({
    repoRoot: repo,
    wtree,
    prompt,
    resolutionSource: "fastflow",
    workspace,
    flowId: "swe",
    initialStage: "initial",
    landingTargetBranch: "main",
    landingTargetWorktree: landingTargetWorktreePath(repo, "main"),
  });
}

function questTaskFixture(
  input: Pick<QuestTask, "id"> & Partial<QuestTask>,
): QuestTask {
  return {
    title: input.id,
    type: "coding",
    status: "child_received",
    dependencies: [],
    scope_files: [],
    spec_refs: [],
    context_refs: [],
    branch_ref: "",
    worktree_path: "",
    child_wtree: "",
    concurrency_group: "",
    merge_target: "",
    merge_lease_id: "",
    merge_commit: "",
    system_impact_ref: "",
    acceptance: "",
    ...input,
  };
}

function runLoopshipCli(
  repo: string,
  args: string[],
  input?: Record<string, unknown>,
  extraEnv: Record<string, string | undefined> = {},
): { status: number | null; stdout: string; stderr: string } {
  return runCommand("bun", ["--no-install", LOOPSHIP_SCRIPT, ...args], {
    cwd: repo,
    env: {
      HOME: resolve(repo, "..", "home"),
      INFERENCE_CLIENT: "handoff",
      INFERENCE_PROVIDER: "",
      INFERENCE_MODEL: "",
      OPENAI_API_KEY: "",
      INFERENCE_ROUTES_JSON: TEST_INFERENCE_ROUTES_JSON,
      LOOPSHIP_GLOBAL_BIN: resolve(repo, "..", "bin", "loopship"),
      LOOPSHIP_SCRIPT: resolve(process.cwd(), "index.ts"),
      FASTFLOW_SCHEDULER_MODE: "test",
      ...extraEnv,
    },
    timeoutMs: 600_000,
    input: input ? JSON.stringify(input) : undefined,
  });
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON (${text.length} bytes): ${error instanceof Error ? error.message : String(error)}; tail=${JSON.stringify(text.slice(-500))}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object: ${text}`);
  }
  return parsed as Record<string, unknown>;
}

async function readFirstLine(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const read = async (): Promise<string> => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`stream ended before its first line: ${buffered}`);
      buffered += decoder.decode(value, { stream: true });
      const newline = buffered.indexOf("\n");
      if (newline >= 0) return buffered.slice(0, newline);
    }
  };
  return Promise.race([
    read(),
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`timed out waiting for first line: ${buffered}`);
    }),
  ]);
}

async function startQuestStage(
  repo: string,
  prompt: string,
  wtree: string,
  extraArgs: string[] = [],
  extraEnv: Record<string, string | undefined> = {},
): Promise<Record<string, unknown>> {
  const proc = runLoopshipCli(repo, [
    "init",
    prompt,
    "--runtime",
    "codex",
    "--flow",
    "swe",
    "--wtree",
    wtree,
    ...extraArgs,
  ], undefined, extraEnv);
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
  const result = parseJsonObject(proc.stdout, "loopship init");
  expect(validateSchemaPath(result, "schemas/steps/fastflow-response.yaml")).toEqual([]);
  return result;
}

function workflowOutput(value: Record<string, unknown>): Record<string, unknown> | null {
  if (
    value.schemaVersion !== "fastflow/workflow-run-artifact/v1" ||
    value.kind !== "workflow_result"
  ) {
    return null;
  }
  expect(value.ok).toBe(true);
  return value.output && typeof value.output === "object" && !Array.isArray(value.output)
    ? (value.output as Record<string, unknown>)
    : {};
}

function interactionPause(value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.schemaVersion !== "fastflow/interaction-response/v1") return null;
  const nextCall =
    value.nextCall && typeof value.nextCall === "object" && !Array.isArray(value.nextCall)
      ? (value.nextCall as Record<string, unknown>)
      : {};
  const args =
    nextCall.args && typeof nextCall.args === "object" && !Array.isArray(nextCall.args)
      ? (nextCall.args as Record<string, unknown>)
      : {};
  const sessionId = String(args.sessionId ?? "").trim();
  const nonce = String(args.nonce ?? "").trim();
  expect(sessionId).toBeTruthy();
  expect(nonce).toBeTruthy();
  return {
    sessionId,
    nonce,
    workspaceRoot: String(args.workspaceRoot ?? "").trim(),
    kind: String(value.kind ?? ""),
  };
}

async function resumeQuestPause(
  repo: string,
  pause: Record<string, unknown>,
  decision: Record<string, unknown>,
  extraEnv: Record<string, string | undefined> = {},
): Promise<Record<string, unknown>> {
  const payload = {
    sessionId: String(pause.sessionId),
    nonce: String(pause.nonce),
    ...(String(pause.workspaceRoot ?? "").trim()
      ? { workspaceRoot: String(pause.workspaceRoot) }
      : {}),
    response: pause.kind === "supervisor_review"
      ? { decision: "ok" }
      : { answer: decision },
  };
  const proc = runLoopshipCli(
    repo,
    ["hook", "--repo", repo, "--json", "@-"],
    payload,
    extraEnv,
  );
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
  const result = parseJsonObject(proc.stdout, "loopship hook");
  expect(validateSchemaPath(result, "schemas/steps/fastflow-response.yaml")).toEqual([]);
  return result;
}

describe("Loopship Fastflow-native bridge", () => {
  test("keeps running Native workflow results on the current execution ledger", () => {
    expect(loopshipNativeResultIsTerminal({
      schemaVersion: "fastflow/workflow-run-artifact/v1",
      kind: "workflow_result",
      status: "running",
    })).toBe(false);
    expect(loopshipNativeResultIsTerminal({
      schemaVersion: "fastflow/workflow-run-artifact/v1",
      kind: "workflow_result",
      status: "completed",
    })).toBe(true);
    expect(loopshipNativeResultIsTerminal({
      schemaVersion: "fastflow/workflow-run-artifact/v1",
      kind: "workflow_result",
      status: "failed",
    })).toBe(true);
  });

  test("atomic state writes preserve private modes and reject symbolic-link targets", () => {
    const root = mkdtempSync(join(tmpdir(), "loopship-atomic-write-"));
    try {
      const textPath = join(root, ".codex", "hooks.json");
      mkdirSync(dirname(textPath), { recursive: true });
      writeFileSync(textPath, "old\n", "utf8");
      chmodSync(textPath, 0o600);
      writeText(textPath, "new\n");
      expect(statSync(textPath).mode & 0o777).toBe(0o600);

      const jsonPath = join(root, ".gemini", "settings.json");
      mkdirSync(dirname(jsonPath), { recursive: true });
      writeFileSync(jsonPath, "{}\n", "utf8");
      chmodSync(jsonPath, 0o600);
      writeJsonFile(jsonPath, { enabled: true });
      expect(statSync(jsonPath).mode & 0o777).toBe(0o600);

      const runtimePath = join(root, ".loopship", "runtime", "hook-state.json");
      writeJsonFile(runtimePath, {});
      expect(statSync(runtimePath).mode & 0o777).toBe(0o600);
      expect(
        readdirSync(dirname(runtimePath)).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);

      const linkedTarget = join(root, "shared-hooks.json");
      const linkedPath = join(root, ".codex", "linked-hooks.json");
      writeFileSync(linkedTarget, "shared\n", "utf8");
      symlinkSync(linkedTarget, linkedPath);
      expect(() => writeText(linkedPath, "replacement\n")).toThrow(
        "refusing to replace symbolic-link target",
      );
      expect(lstatSync(linkedPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(linkedTarget, "utf8")).toBe("shared\n");

      const externalDatabase = join(root, "external.sqlite");
      const linkedDatabase = join(root, ".loopship", "runtime", "linked-lock.sqlite");
      writeFileSync(externalDatabase, "not-a-loopship-lock\n", "utf8");
      symlinkSync(externalDatabase, linkedDatabase);
      let linkedDatabaseError: unknown;
      try {
        acquireCrashSafeFileLock(linkedDatabase, 10);
      } catch (error) {
        linkedDatabaseError = error;
      }
      expect(linkedDatabaseError).toMatchObject({
        code: "FASTFLOW_UNSUPPORTED_DURABLE_FILESYSTEM",
      });
      expect((linkedDatabaseError as Error).message).toContain("symbolic link");
      expect(readFileSync(externalDatabase, "utf8")).toBe("not-a-loopship-lock\n");

      const danglingPath = join(root, ".loopship", "runtime", "dangling.json");
      symlinkSync(join(root, "missing-target.json"), danglingPath);
      expect(removeFileDurably(danglingPath)).toBe(true);
      expect(() => lstatSync(danglingPath)).toThrow();

      const hardLinkedDatabase = join(root, "hard-linked-external.sqlite");
      const hardLinkPath = join(root, ".loopship", "runtime", "hard-linked-lock.sqlite");
      writeFileSync(hardLinkedDatabase, "hard-linked-marker\n", "utf8");
      const hardLinkedMode = statSync(hardLinkedDatabase).mode & 0o777;
      linkSync(hardLinkedDatabase, hardLinkPath);
      expect(() => acquireCrashSafeFileLock(hardLinkPath, 10)).toThrow(
        "must remain one private regular file",
      );
      expect(readFileSync(hardLinkedDatabase, "utf8")).toBe("hard-linked-marker\n");
      expect(statSync(hardLinkedDatabase).mode & 0o777).toBe(hardLinkedMode);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(
    "SQLite locks stay bound to their canonical parent after alias retargeting",
    () => {
      const root = mkdtempSync(join(tmpdir(), "loopship-canonical-lock-"));
      const firstRoot = join(root, "first");
      const secondRoot = join(root, "second");
      const aliasRoot = join(root, "active");
      const lockName = "quest.sqlite";
      mkdirSync(firstRoot);
      mkdirSync(secondRoot);
      symlinkSync(firstRoot, aliasRoot, "dir");

      const release = acquireCrashSafeFileLock(join(aliasRoot, lockName), 10);
      try {
        expect(realpathSync(join(aliasRoot, lockName))).toBe(
          join(realpathSync(firstRoot), lockName),
        );
        rmSync(aliasRoot);
        symlinkSync(secondRoot, aliasRoot, "dir");

        let concurrentError: unknown;
        try {
          acquireCrashSafeFileLock(join(firstRoot, lockName), 10);
        } catch (error) {
          concurrentError = error;
        }
        expect(concurrentError).toMatchObject({ code: "loopship_file_lock_busy" });
        expect(existsSync(join(secondRoot, lockName))).toBe(false);
      } finally {
        release();
        rmSync(root, { recursive: true, force: true });
      }
    },
    { timeout: 10_000 },
  );

  test("requires focused native lifecycle release verification", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      version: string;
      scripts: Record<string, string>;
      engines: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      peerDependencies?: Record<string, string>;
      exports?: Record<string, string>;
      bundledDependencies?: string[];
      resolutions?: Record<string, string>;
      bin?: Record<string, string>;
    };
    expect(packageJson.scripts["verify:lifecycle"]).toContain(
      "LOOPSHIP_EXECUTE_LIFECYCLE_MATRIX=1",
    );
    expect(packageJson.scripts["verify:lifecycle"]).toContain(
      "LOOPSHIP_LIFECYCLE_CASES=bugfix,feature-parallel,vague-greenfield",
    );
    expect(packageJson.scripts["verify:lifecycle"]).toContain(
      "scripts/report_lifecycle_matrix.ts",
    );
    expect(packageJson.scripts["verify:release"]).toContain("bun run verify");
    expect(packageJson.scripts["verify:release"]).toContain(
      "bun run verify:lifecycle",
    );
    expect(packageJson.scripts["verify:release"]).toContain(
      "bun run verify:stress",
    );
    expect(packageJson.scripts.prepublishOnly).toBe("bun run verify:release");
    expect(packageJson.version).toBe("1.0.1");
    expect(packageJson.engines.node).toBe(">=26.0.0");
    expect(packageJson.engines.bun).toBe(">=1.3.0");
    expect(packageJson.dependencies["@cueintent/fastflow"]).toBe("1.0.1");
    expect(packageJson.resolutions?.["@cueintent/fastflow"]).toBe(
      "git+ssh://git@github.com/cueintent/fastflow.git#c0aee6b1529ccb68921f843c7dfe6089fd48dcf1",
    );
    expect(packageJson.bundledDependencies).toEqual(["@cueintent/fastflow"]);
    expect(packageJson.dependencies.cmdproto).toBe(
      "git+https://github.com/omar391/cmdproto.git#b0d9997544ef265f861ea045035b948a48bc334a",
    );
    expect(packageJson.devDependencies.typescript).toBe("^5");
    expect(packageJson.peerDependencies).toBeUndefined();
    expect(packageJson.bin?.loopship).toBe("bin/loopship");
    expect(packageJson.bin?.["loopship-fastflow-daemon"]).toBe(
      "bin/loopship-fastflow-daemon",
    );
    expect(packageJson.exports?.["./fastflow/daemon"]).toBe(
      "./scripts/loopship_fastflow_daemon.mjs",
    );
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("Native v1 is the sole execution path");
    expect(readme).toContain("local-durable");
    expect(readme).toContain("legacy_execution_unsupported");
    expect(readme).toContain("Bun is the canonical application and daemon runtime");
    expect(readme).toContain("it is not a second supported Loopship application host");
    expect(readme).not.toContain("retried once automatically");
    expect(readFileSync("index.ts", "utf8").startsWith("#!/usr/bin/env bun\n")).toBe(true);
    expect(readFileSync("bin/loopship", "utf8").startsWith("#!/usr/bin/env bun\n")).toBe(true);
    expect(
      readFileSync("bin/loopship-fastflow-daemon", "utf8").startsWith(
        "#!/usr/bin/env bun\n",
      ),
    ).toBe(true);
    for (const file of [
      "scripts/ensure_cmdproto_deps.mjs",
      "scripts/loopship_fastflow.ts",
      "scripts/loopship_fastflow_lifecycle.ts",
    ]) {
      expect(readFileSync(file, "utf8")).not.toMatch(
        /resolve\([^\n]*"cueintent",\s*"fastflow"/,
      );
    }
  });

  test(
    "vendors the private Fastflow runtime in the release artifact",
    () => {
      const proc = runCommand(
        "npm",
        ["publish", "--dry-run", "--json", "--ignore-scripts"],
        { cwd: process.cwd(), timeoutMs: 30_000 },
      );
      expect(proc.status, proc.stderr || proc.stdout).toBe(0);
      const result = JSON.parse(proc.stdout) as Record<
        string,
        { files?: Array<{ path?: unknown }> }
      >;
      const artifact = Object.values(result)[0];
      const files = (artifact?.files || [])
        .map((entry) => entry.path)
        .filter((path): path is string => typeof path === "string");
      const fastflowPrefix = "node_modules/@cueintent/fastflow/";
      expect(files).toContain("bin/loopship");
      expect(files).toContain(`${fastflowPrefix}package.json`);
      expect(files).toContain(`${fastflowPrefix}src/index.mjs`);
      expect(files).toContain(
        `${fastflowPrefix}vendor/serverlessworkflow/1.0.3/workflow.json`,
      );
      expect(files.some((path) => path.startsWith(`${fastflowPrefix}test/`))).toBe(false);
      expect(files.some((path) => path.startsWith(`${fastflowPrefix}examples/`))).toBe(false);

      const adapters = createLoopshipFastflowAdapters();
      const implementation = (adapters.describeCallImplementation as Function)({
        call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
      }) as Record<string, unknown>;
      const shippedLoopshipFiles = files
        .filter((path) => !path.includes("node_modules/") && !path.startsWith("../"))
        .sort();
      expect(implementation.implementation_manifest).toBe("package.json#files+bun.lock");
      expect(implementation.implementation_files).toEqual(shippedLoopshipFiles);
      expect(implementation.implementation_files).toContain("bun.lock");
      expect(implementation.implementation_files).toContain(
        "bin/loopship-fastflow-daemon",
      );
      expect(implementation.implementation_files).toContain("scripts/loopship_core.ts");
      expect(implementation.implementation_files).toContain(
        "scripts/loopship_fastflow_daemon.mjs",
      );
      expect(implementation.implementation_files).toContain(
        "scripts/loopship_native_execution.ts",
      );
      expect(implementation.implementation_files).toContain("scripts/loopship_sqlite.ts");
      expect(implementation.implementation_files).toContain("scripts/loopship_utils.ts");
      expect(implementation.dependency_lock_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(implementation.implementation_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(implementation.runtime_ref).toBe(`bun:${process.versions.bun}`);
      const routeDigests = (adapters.afnDispatch as {
        listRoutes(): Array<{ implementationDigest: string }>;
      }).listRoutes().map((route) => route.implementationDigest);
      expect(new Set(routeDigests)).toEqual(
        new Set([String(implementation.implementation_digest)]),
      );
    },
    { timeout: 30_000 },
  );

  test(
    "starts the durable daemon and a Native session from a clean packed install",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "loopship-packed-daemon-"));
      const consumer = join(root, "consumer");
      let fixture: ReturnType<typeof createGitFixture> | null = null;
      let daemon: ReturnType<typeof Bun.spawn> | null = null;
      try {
        mkdirSync(consumer, { recursive: true });
        writeFileSync(
          join(consumer, "package.json"),
          `${JSON.stringify({ private: true })}\n`,
          "utf8",
        );
        const packed = runCommand(
          "npm",
          ["pack", "--json", "--ignore-scripts", "--pack-destination", root],
          { cwd: process.cwd(), timeoutMs: 60_000 },
        );
        expect(packed.status, packed.stderr || packed.stdout).toBe(0);
        const artifact = JSON.parse(packed.stdout) as Array<{ filename?: string }>;
        const tarball = resolve(root, String(artifact[0]?.filename || ""));
        expect(existsSync(tarball)).toBe(true);
        const installed = runCommand(
          "npm",
          ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
          { cwd: consumer, timeoutMs: 120_000 },
        );
        expect(installed.status, installed.stderr || installed.stdout).toBe(0);
        const binPath = join(
          consumer,
          "node_modules",
          ".bin",
          "loopship-fastflow-daemon",
        );
        expect(existsSync(binPath)).toBe(true);
        const {
          FASTFLOW_APP_MODULE: _ignoredAppModule,
          LOOPSHIP_FASTFLOW_ROOT: _ignoredFastflowRoot,
          ...baseEnv
        } = process.env;
        const schedulerDb = join(root, "scheduler", "native-v1.sqlite");
        daemon = Bun.spawn({
          cmd: [binPath],
          cwd: consumer,
          env: {
            ...baseEnv,
            HOME: join(root, "home"),
            FASTFLOW_SCHEDULER_DB: ` ${schedulerDb} `,
            FASTFLOW_APP_MODULE: pathToFileURL(join(root, "wrong-app-module.mjs")).href,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const ready = JSON.parse(
          await readFirstLine(daemon.stdout as ReadableStream<Uint8Array>, 15_000),
        ) as Record<string, unknown>;
        expect(ready).toMatchObject({
          ok: true,
          scheduler: "fastflow.scheduler.native/v1",
          profile: "local-durable",
        });
        fixture = createGitFixture("loopship-packed-native-session-");
        const loopshipBin = join(consumer, "node_modules", ".bin", "loopship");
        const session = runCommand(
          loopshipBin,
          [
            "stepper",
            "init",
            "loopship: prove the packed Native session boundary",
            "--repo",
            fixture.repo,
            "--runtime",
            "codex",
            "--flow",
            "swe",
            "--wtree",
            "packed-native-session",
          ],
          {
            cwd: fixture.repo,
            env: {
              ...baseEnv,
              HOME: join(root, "home"),
              CODEX_THREAD_ID: "packed-native-session-test",
              FASTFLOW_SCHEDULER_MODE: "local-durable",
              FASTFLOW_SCHEDULER_DB: schedulerDb,
              INFERENCE_CLIENT: "handoff",
              INFERENCE_PROVIDER: "",
              INFERENCE_MODEL: "",
              OPENAI_API_KEY: "",
              INFERENCE_ROUTES_JSON: TEST_INFERENCE_ROUTES_JSON,
            },
            timeoutMs: 120_000,
          },
        );
        expect(session.status, session.stderr || session.stdout).toBe(0);
        const response = parseJsonObject(session.stdout.trim(), "packed Native session");
        expect(response.schemaVersion).toBe("fastflow/interaction-response/v1");
        expect(interactionPause(response)).not.toBeNull();
        daemon.kill("SIGINT");
        expect(await daemon.exited).toBe(0);
        daemon = null;
      } finally {
        daemon?.kill("SIGKILL");
        if (daemon) await daemon.exited;
        if (fixture) rmSync(fixture.root, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      }
    },
    { timeout: 180_000 },
  );

  test(
    "recovers a pre-submission failure with one identical Native submit",
    async () => {
      const fixture = createGitFixture("loopship-native-single-submit-");
      const fakeFastflowRoot = mkdtempSync(
        join(process.cwd(), "tmp", "loopship-fake-fastflow-"),
      );
      const requestLog = join(fakeFastflowRoot, "requests.jsonl");
      mkdirSync(join(fakeFastflowRoot, "src"), { recursive: true });
      writeFileSync(join(fakeFastflowRoot, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(join(fakeFastflowRoot, "src", "catalog.mjs"), "export {};\n");
      writeFileSync(
      join(fakeFastflowRoot, "src", "index.mjs"),
      `
        import { appendFileSync, existsSync, readFileSync } from "node:fs";
        export function configureFastflowApp() {}
        export async function executeFastflowWorkflowRunRequest(request) {
          const prior = existsSync(process.env.LOOPSHIP_NATIVE_REQUEST_LOG)
            ? readFileSync(process.env.LOOPSHIP_NATIVE_REQUEST_LOG, "utf8").trim()
            : "";
          appendFileSync(process.env.LOOPSHIP_NATIVE_REQUEST_LOG, JSON.stringify(request) + "\\n");
          if (!prior) throw new Error("synthetic native submission failure");
          return {
            schemaVersion: "fastflow/interaction-response/v1",
            kind: "handoff_answer",
            nextCall: {
              command: "loopship stepper step --json @-",
              args: {
                sessionId: request.executionId,
                nonce: "nonce-test",
                workspaceRoot: process.cwd(),
                response: { answer: "{{answer}}" },
              },
            },
          };
        }
        export async function executeFastflowWorkflowRecoverRequest() {
          const error = new Error("synthetic execution not submitted");
          error.code = "FASTFLOW_EXECUTION_NOT_FOUND";
          throw error;
        }
        export async function executeFastflowWorkflowResumeRequest() {
          throw new Error("unexpected resume");
        }
        `,
      );
      const previousRoot = process.env.LOOPSHIP_FASTFLOW_ROOT;
      const previousLog = process.env.LOOPSHIP_NATIVE_REQUEST_LOG;
      process.env.LOOPSHIP_FASTFLOW_ROOT = fakeFastflowRoot;
      process.env.LOOPSHIP_NATIVE_REQUEST_LOG = requestLog;
      const input = {
        repoRoot: fixture.repo,
        flowId: "swe",
        inputs: {
          request: "loopship: recover one ambiguous native submit",
          repoRoot: fixture.repo,
          runtime: "codex",
          wtree: "single-submit",
        },
      };
      try {
        await expect(runLoopshipFastflowWorkflow(input)).rejects.toThrow(
          "synthetic native submission failure",
        );
        const requests = readFileSync(requestLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(requests).toHaveLength(1);
        expect(requests[0].executionId).toMatch(/^loopship-[0-9a-f]{64}$/);
        expect(requests[0].idempotencyKey).toBe(requests[0].executionId);
        const requestEnvelope = JSON.parse(
          readFileSync(
            join(
              fixture.repo,
              "worktrees",
              "single-submit",
              ".loopship",
              "runtime",
              "native-execution.json",
            ),
            "utf8",
          ),
        );
        expect(requestEnvelope.request).toEqual(requests[0]);
        await expect(
          runLoopshipFastflowWorkflow({
            ...input,
            inputs: {
              ...input.inputs,
              request: "loopship: conflicting request while Native execution is pending",
            },
          }),
        ).rejects.toThrow("conflicts with pending");
        expect(readFileSync(requestLog, "utf8").trim().split("\n")).toHaveLength(1);

        const tasksPath = join(
          fixture.repo,
          "worktrees",
          "single-submit",
          ".loopship",
          "runtime",
          "tasks.yaml",
        );
        const recovered = await recoverLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          wtree: "single-submit",
        });
        const pause = interactionPause(recovered);
        expect(pause, JSON.stringify(recovered)).not.toBeNull();
        expect(pause?.sessionId).toBe(requests[0].executionId);
        const recoveredRequests = readFileSync(requestLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(recoveredRequests).toHaveLength(2);
        expect(recoveredRequests[1]).toEqual(recoveredRequests[0]);
        expect(existsSync(tasksPath)).toBe(true);
      } finally {
        if (previousRoot === undefined) delete process.env.LOOPSHIP_FASTFLOW_ROOT;
        else process.env.LOOPSHIP_FASTFLOW_ROOT = previousRoot;
        if (previousLog === undefined) delete process.env.LOOPSHIP_NATIVE_REQUEST_LOG;
        else process.env.LOOPSHIP_NATIVE_REQUEST_LOG = previousLog;
        rmSync(fakeFastflowRoot, { recursive: true, force: true });
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    { timeout: 60_000 },
  );

  test("assigns a fresh durable execution when canonical resume follows a terminal stage", async () => {
    const fixture = createGitFixture("loopship-native-stage-ledger-");
    const fakeFastflowRoot = mkdtempSync(
      join(process.cwd(), "tmp", "loopship-stage-ledger-fastflow-"),
    );
    const requestLog = join(fakeFastflowRoot, "requests.jsonl");
    mkdirSync(join(fakeFastflowRoot, "src"), { recursive: true });
    writeFileSync(join(fakeFastflowRoot, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(fakeFastflowRoot, "src", "catalog.mjs"), "export {};\n");
    writeFileSync(
      join(fakeFastflowRoot, "src", "index.mjs"),
      `
        import { appendFileSync } from "node:fs";
        export function configureFastflowApp() {}
        export async function executeFastflowWorkflowRunRequest(request) {
          appendFileSync(process.env.LOOPSHIP_NATIVE_REQUEST_LOG, JSON.stringify(request) + "\\n");
          return {
            schemaVersion: "fastflow/workflow-run-artifact/v1",
            kind: "workflow_result",
            ok: true,
            status: "completed",
            output: { stage_after: "next" },
          };
        }
        export async function executeFastflowWorkflowResumeRequest() {
          throw new Error("unexpected resume");
        }
      `,
    );
    const previousRoot = process.env.LOOPSHIP_FASTFLOW_ROOT;
    const previousLog = process.env.LOOPSHIP_NATIVE_REQUEST_LOG;
    process.env.LOOPSHIP_FASTFLOW_ROOT = fakeFastflowRoot;
    process.env.LOOPSHIP_NATIVE_REQUEST_LOG = requestLog;
    const input = {
      repoRoot: fixture.repo,
      flowId: "swe",
      inputs: {
        request: "loopship: execute two terminal stages",
        repoRoot: fixture.repo,
        runtime: "codex",
        wtree: "stage-ledger",
      },
    };
    try {
      await runLoopshipFastflowWorkflow(input);
      const workspaceRoot = join(fixture.repo, "worktrees", "stage-ledger");
      const route = recordHookRoute({
        repoRoot: fixture.repo,
        runtime: "codex",
        threadId: "terminal-recovery-thread",
        workspaceRoot,
        result: {
          kind: "supervisor_review",
          nextCall: {
            args: {
              sessionId: "stale-terminal-session",
              nonce: "stale-terminal-nonce",
              workspaceRoot,
            },
          },
        },
      });
      expect(route).not.toBeNull();
      await recoverLoopshipFastflowWorkflow({
        repoRoot: fixture.repo,
        wtree: "stage-ledger",
      });
      const requests = readFileSync(requestLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests).toHaveLength(2);
      expect(requests[0].executionId).toMatch(/^loopship-[0-9a-f]{64}$/);
      expect(requests[1].executionId).toMatch(/^loopship-[0-9a-f]{64}$/);
      expect(requests[1].executionId).not.toBe(requests[0].executionId);

      const runtimeRoot = join(
        fixture.repo,
        "worktrees",
        "stage-ledger",
        ".loopship",
        "runtime",
      );
      const current = JSON.parse(
        readFileSync(join(runtimeRoot, "native-execution.json"), "utf8"),
      );
      expect(current).toMatchObject({
        status: "completed",
        ordinal: 2,
        executionId: requests[1].executionId,
      });
      const hookState = JSON.parse(
        readFileSync(join(runtimeRoot, "hook-state.json"), "utf8"),
      );
      expect(hookState.fastflow).toBeUndefined();
      expect(readdirSync(join(runtimeRoot, "native-executions"))).toHaveLength(2);
    } finally {
      if (previousRoot === undefined) delete process.env.LOOPSHIP_FASTFLOW_ROOT;
      else process.env.LOOPSHIP_FASTFLOW_ROOT = previousRoot;
      if (previousLog === undefined) delete process.env.LOOPSHIP_NATIVE_REQUEST_LOG;
      else process.env.LOOPSHIP_NATIVE_REQUEST_LOG = previousLog;
      rmSync(fakeFastflowRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects legacy quest state instead of interpreting or migrating it", async () => {
    const fixture = createGitFixture("loopship-native-legacy-state-");
    try {
      createNativeQuest(fixture.repo, "legacy-state");
      await expect(
        recoverLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          wtree: "legacy-state",
        }),
      ).rejects.toThrow("legacy_execution_unsupported");
      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "swe",
          inputs: {
            request: "loopship: do not migrate legacy state",
            repoRoot: fixture.repo,
            wtree: "legacy-state",
          },
        }),
      ).rejects.toThrow("legacy_execution_unsupported");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects forged Native execution identities before history path construction", () => {
    const fixture = createGitFixture("loopship-native-forged-execution-id-");
    const wtree = "forged-execution-id";
    const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
    const workspaceRoot = workspace.worktree_path;
    try {
      const request = {
        workflowRef: loopshipFlowWorkflowRef("swe"),
        inputs: {
          request: "loopship: reject forged execution identities",
          repoRoot: fixture.repo,
          wtree,
        },
      };
      resolveLoopshipNativeExecutionRequest(workspaceRoot, request);
      const executionPath = join(
        workspaceRoot,
        ".loopship",
        "runtime",
        "native-execution.json",
      );
      const forged = JSON.parse(readFileSync(executionPath, "utf8"));
      forged.status = "completed";
      forged.executionId = "../../escaped-ledger";
      forged.idempotencyKey = forged.executionId;
      forged.request.executionId = forged.executionId;
      forged.request.idempotencyKey = forged.executionId;
      forged.requestDigest = digestNativeContract(forged.request as JsonValue);
      writeFileSync(executionPath, `${JSON.stringify(forged)}\n`, "utf8");

      expect(() => readLoopshipNativeExecutionRequest(workspaceRoot)).toThrow(
        "integrity check failed",
      );
      expect(() =>
        resolveLoopshipNativeExecutionRequest(workspaceRoot, request),
      ).toThrow("integrity check failed");
      expect(
        existsSync(join(workspaceRoot, ".loopship", "escaped-ledger.json")),
      ).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects a status-only tamper of a live Native execution ledger", () => {
    const fixture = createGitFixture("loopship-native-forged-completion-");
    const wtree = "forged-completion";
    const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
    const workspaceRoot = workspace.worktree_path;
    const request = {
      workflowRef: loopshipFlowWorkflowRef("swe"),
      inputs: {
        request: "loopship: reject a forged Native completion",
        repoRoot: fixture.repo,
        wtree,
      },
    };
    try {
      resolveLoopshipNativeExecutionRequest(workspaceRoot, request);
      const executionPath = join(
        workspaceRoot,
        ".loopship",
        "runtime",
        "native-execution.json",
      );
      const forged = JSON.parse(readFileSync(executionPath, "utf8"));
      forged.status = "completed";
      writeFileSync(executionPath, `${JSON.stringify(forged)}\n`, "utf8");

      expect(() => readLoopshipNativeExecutionRequest(workspaceRoot)).toThrow(
        "completed ledger has no immutable history receipt",
      );
      expect(() =>
        resolveLoopshipNativeExecutionRequest(workspaceRoot, request),
      ).toThrow("completed ledger has no immutable history receipt");
      expect(
        existsSync(join(workspaceRoot, ".loopship", "runtime", "native-executions")),
      ).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("treats immutable completion history as authoritative across the current-ledger crash gap", () => {
    const fixture = createGitFixture("loopship-native-completion-crash-gap-");
    const wtree = "completion-crash-gap";
    const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
    const workspaceRoot = workspace.worktree_path;
    const request = {
      workflowRef: loopshipFlowWorkflowRef("swe"),
      inputs: {
        request: "loopship: recover an archived Native completion",
        repoRoot: fixture.repo,
        wtree,
      },
    };
    try {
      const first = resolveLoopshipNativeExecutionRequest(workspaceRoot, request);
      const executionPath = join(
        workspaceRoot,
        ".loopship",
        "runtime",
        "native-execution.json",
      );
      expect(statSync(executionPath).mode & 0o777).toBe(0o600);
      chmodSync(executionPath, 0o600);
      markLoopshipNativeExecutionCompleted(workspaceRoot, first.executionId);
      expect(statSync(executionPath).mode & 0o777).toBe(0o600);
      expect(
        statSync(
          join(
            workspaceRoot,
            ".loopship",
            "runtime",
            "native-executions",
            `${first.executionId}.json`,
          ),
        ).mode & 0o777,
      ).toBe(0o600);
      const crashGap = JSON.parse(readFileSync(executionPath, "utf8"));
      crashGap.status = "pending";
      writeFileSync(executionPath, `${JSON.stringify(crashGap)}\n`, "utf8");

      expect(readLoopshipNativeExecutionRequest(workspaceRoot)).toMatchObject({
        executionId: first.executionId,
        ordinal: 1,
        status: "completed",
      });
      const second = resolveLoopshipNativeExecutionRequest(workspaceRoot, request);
      expect(second).toMatchObject({ ordinal: 2, status: "pending" });
      expect(second.executionId).not.toBe(first.executionId);
      expect(statSync(executionPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("Native ledger replacement rejects a symbolic-link target", () => {
    const fixture = createGitFixture("loopship-native-ledger-symlink-");
    const wtree = "ledger-symlink";
    const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
    const workspaceRoot = workspace.worktree_path;
    const request = {
      workflowRef: loopshipFlowWorkflowRef("swe"),
      inputs: {
        request: "loopship: reject a linked Native ledger",
        repoRoot: fixture.repo,
        wtree,
      },
    };
    try {
      const native = resolveLoopshipNativeExecutionRequest(workspaceRoot, request);
      const executionPath = join(
        workspaceRoot,
        ".loopship",
        "runtime",
        "native-execution.json",
      );
      const linkedTarget = join(fixture.root, "external-native-execution.json");
      const original = readFileSync(executionPath, "utf8");
      writeFileSync(linkedTarget, original, "utf8");
      rmSync(executionPath);
      symlinkSync(linkedTarget, executionPath);

      expect(() =>
        markLoopshipNativeExecutionCompleted(workspaceRoot, native.executionId),
      ).toThrow("refusing to replace symbolic-link target");
      expect(lstatSync(executionPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(linkedTarget, "utf8")).toBe(original);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("a stale recovery snapshot cannot allocate an unsubmitted next Native execution", () => {
    const fixture = createGitFixture("loopship-native-stale-recovery-ledger-");
    const wtree = "stale-recovery-ledger";
    const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
    const workspaceRoot = workspace.worktree_path;
    const request = {
      workflowRef: loopshipFlowWorkflowRef("swe"),
      inputs: {
        request: "loopship: reject a stale Native recovery snapshot",
        repoRoot: fixture.repo,
        wtree,
      },
    };
    try {
      const stale = resolveLoopshipNativeExecutionRequest(workspaceRoot, request);
      markLoopshipNativeExecutionCompleted(workspaceRoot, stale.executionId);

      expect(() =>
        resolveLoopshipNativeExecutionRequest(workspaceRoot, request, {
          expectedExecutionId: stale.executionId,
          expectedStatus: "pending",
        }),
      ).toThrow("is no longer the current ledger");
      expect(readLoopshipNativeExecutionRequest(workspaceRoot)).toMatchObject({
        executionId: stale.executionId,
        ordinal: 1,
        status: "completed",
      });
      expect(
        readdirSync(
          join(workspaceRoot, ".loopship", "runtime", "native-executions"),
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("a stale completed recovery snapshot cannot skip to a third Native execution", () => {
    const fixture = createGitFixture("loopship-native-stale-completed-ledger-");
    const wtree = "stale-completed-ledger";
    const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
    const workspaceRoot = workspace.worktree_path;
    const request = {
      workflowRef: loopshipFlowWorkflowRef("swe"),
      inputs: {
        request: "loopship: rotate one completed Native execution exactly once",
        repoRoot: fixture.repo,
        wtree,
      },
    };
    try {
      const first = resolveLoopshipNativeExecutionRequest(workspaceRoot, request);
      markLoopshipNativeExecutionCompleted(workspaceRoot, first.executionId);
      const second = resolveLoopshipNativeExecutionRequest(workspaceRoot, request, {
        expectedExecutionId: first.executionId,
        expectedStatus: "completed",
      });
      expect(second).toMatchObject({ ordinal: 2, status: "pending" });
      markLoopshipNativeExecutionCompleted(workspaceRoot, second.executionId);

      expect(() =>
        resolveLoopshipNativeExecutionRequest(workspaceRoot, request, {
          expectedExecutionId: first.executionId,
          expectedStatus: "completed",
        }),
      ).toThrow("is no longer the current ledger");
      expect(readLoopshipNativeExecutionRequest(workspaceRoot)).toMatchObject({
        executionId: second.executionId,
        ordinal: 2,
        status: "completed",
      });
      expect(
        readdirSync(
          join(workspaceRoot, ".loopship", "runtime", "native-executions"),
        ),
      ).toHaveLength(2);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("revalidates recovery and resume after the workspace filesystem changes", async () => {
    const fixture = createGitFixture("loopship-native-remounted-recovery-");
    const wtree = "remounted-recovery";
    const prompt = "loopship: re-admit a remounted Native workspace";
    const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
    const workspaceRoot = workspace.worktree_path;
    const native = resolveLoopshipNativeExecutionRequest(workspaceRoot, {
      workflowRef: loopshipFlowWorkflowRef("swe"),
      inputs: {
        request: prompt,
        repoRoot: fixture.repo,
        runtime: "codex",
        wtree,
      },
    });
    const { files } = createQuest({
      repoRoot: fixture.repo,
      wtree,
      prompt,
      resolutionSource: "test",
      workspace,
      flowId: "swe",
      initialStage: "initial",
    });
    const executionPath = join(
      workspaceRoot,
      ".loopship",
      "runtime",
      "native-execution.json",
    );
    const authoritativePaths = [
      files.tasks,
      files.events,
      files.hook_state,
      files.manifest,
      executionPath,
    ];
    const before = new Map(
      authoritativePaths.map((path) => [path, readFileSync(path, "utf8")]),
    );
    const previousDb = process.env.FASTFLOW_SCHEDULER_DB;
    const previousMode = process.env.FASTFLOW_SCHEDULER_MODE;
    const originalStatfsSync = fs.statfsSync;
    try {
      process.env.FASTFLOW_SCHEDULER_DB = join(
        fixture.root,
        "scheduler",
        "native-v1.sqlite",
      );
      process.env.FASTFLOW_SCHEDULER_MODE = "local-durable";
      const remoteFilesystemType = process.platform === "darwin" ? 2 : 0x6969;
      fs.statfsSync = ((
        probePath: PathLike,
        options?: StatFsOptions,
      ) => {
        const current = originalStatfsSync(probePath, options);
        const probe = resolve(String(probePath));
        const workspaceRelative = relative(workspaceRoot, probe);
        const insideWorkspace = workspaceRelative === "" ||
          (!workspaceRelative.startsWith("..") && !isAbsolute(workspaceRelative));
        if (!insideWorkspace) return current;
        return {
          ...current,
          type: typeof current.type === "bigint"
            ? BigInt(remoteFilesystemType)
            : remoteFilesystemType,
        } as ReturnType<typeof fs.statfsSync>;
      }) as typeof fs.statfsSync;

      await expect(
        recoverLoopshipFastflowWorkflow({ repoRoot: fixture.repo, wtree }),
      ).rejects.toMatchObject({
        code: "FASTFLOW_UNSUPPORTED_DURABLE_FILESYSTEM",
      });
      await expect(
        resumeLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          workspaceRoot,
          request: {
            sessionId: native.executionId,
            workspaceRoot,
            response: { answer: { status: "ok" } },
          },
        }),
      ).rejects.toMatchObject({
        code: "FASTFLOW_UNSUPPORTED_DURABLE_FILESYSTEM",
      });
      for (const [path, content] of before) {
        expect(readFileSync(path, "utf8")).toBe(content);
      }
      expect(
        existsSync(join(workspaceRoot, ".loopship", "runtime", "quest-init.lock.sqlite")),
      ).toBe(false);

      for (const mode of ["embedded", "test"] as const) {
        process.env.FASTFLOW_SCHEDULER_MODE = mode;
        await expect(
          resumeLoopshipFastflowWorkflow({
            repoRoot: fixture.repo,
            workspaceRoot,
            request: {
              sessionId: "loopship-wrong-ledger",
              workspaceRoot,
              response: { answer: { status: "ok" } },
            },
          }),
        ).rejects.toThrow("does not match current ledger");
      }
    } finally {
      fs.statfsSync = originalStatfsSync;
      if (previousDb === undefined) delete process.env.FASTFLOW_SCHEDULER_DB;
      else process.env.FASTFLOW_SCHEDULER_DB = previousDb;
      if (previousMode === undefined) delete process.env.FASTFLOW_SCHEDULER_MODE;
      else process.env.FASTFLOW_SCHEDULER_MODE = previousMode;
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rechecks durable workspace authority after child dispatch before finalization", async () => {
    const fixture = createGitFixture("loopship-native-post-dispatch-remount-");
    const fakeFastflowRoot = mkdtempSync(join(process.cwd(), "tmp", "loopship-remount-fastflow-"));
    const markerPath = join(fakeFastflowRoot, "remounted");
    const operationLog = join(fakeFastflowRoot, "operations.jsonl");
    const wtree = "post-dispatch-remount";
    const prompt = "loopship: stop finalization after a workspace remount";
    const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
    const workspaceRoot = workspace.worktree_path;
    const native = resolveLoopshipNativeExecutionRequest(workspaceRoot, {
      workflowRef: loopshipFlowWorkflowRef("swe"),
      inputs: {
        request: prompt,
        repoRoot: fixture.repo,
        runtime: "codex",
        wtree,
      },
    });
    const { files } = createQuest({
      repoRoot: fixture.repo,
      wtree,
      prompt,
      resolutionSource: "test",
      workspace,
      flowId: "swe",
      initialStage: "initial",
    });
    const previousDb = process.env.FASTFLOW_SCHEDULER_DB;
    const previousMode = process.env.FASTFLOW_SCHEDULER_MODE;
    const previousRoot = process.env.LOOPSHIP_FASTFLOW_ROOT;
    const previousMarker = process.env.LOOPSHIP_REMOUNT_MARKER;
    const previousLog = process.env.LOOPSHIP_REMOUNT_OPERATION_LOG;
    const originalStatfsSync = fs.statfsSync;
    const originalHookState = readFileSync(files.hook_state, "utf8");
    try {
      mkdirSync(join(fakeFastflowRoot, "src"), { recursive: true });
      writeFileSync(join(fakeFastflowRoot, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(join(fakeFastflowRoot, "src", "catalog.mjs"), "export {};\n");
      writeFileSync(
        join(fakeFastflowRoot, "src", "index.mjs"),
        `
          import { appendFileSync, writeFileSync } from "node:fs";
          export function configureFastflowApp() {}
          function completed(executionId, operation) {
            appendFileSync(process.env.LOOPSHIP_REMOUNT_OPERATION_LOG, operation + "\\n");
            writeFileSync(process.env.LOOPSHIP_REMOUNT_MARKER, "remounted\\n");
            return {
              schemaVersion: "fastflow/workflow-run-artifact/v1",
              kind: "workflow_result",
              ok: true,
              status: "completed",
              executionId,
            };
          }
          export async function executeFastflowWorkflowRecoverRequest({ executionId }) {
            return completed(executionId, "recover");
          }
          export async function executeFastflowWorkflowResumeRequest(request) {
            return completed(request.sessionId, "resume");
          }
          export async function executeFastflowWorkflowRunRequest(request) {
            return completed(request.executionId, "run");
          }
        `,
      );
      process.env.FASTFLOW_SCHEDULER_DB = join(
        fixture.root,
        "scheduler",
        "native-v1.sqlite",
      );
      process.env.FASTFLOW_SCHEDULER_MODE = "local-durable";
      process.env.LOOPSHIP_FASTFLOW_ROOT = fakeFastflowRoot;
      process.env.LOOPSHIP_REMOUNT_MARKER = markerPath;
      process.env.LOOPSHIP_REMOUNT_OPERATION_LOG = operationLog;
      const remoteFilesystemType = process.platform === "darwin" ? 2 : 0x6969;
      fs.statfsSync = ((
        probePath: PathLike,
        options?: StatFsOptions,
      ) => {
        const current = originalStatfsSync(probePath, options);
        const probe = resolve(String(probePath));
        const workspaceRelative = relative(workspaceRoot, probe);
        const insideWorkspace = workspaceRelative === "" ||
          (!workspaceRelative.startsWith("..") && !isAbsolute(workspaceRelative));
        if (!insideWorkspace || !existsSync(markerPath)) return current;
        return {
          ...current,
          type: typeof current.type === "bigint"
            ? BigInt(remoteFilesystemType)
            : remoteFilesystemType,
        } as ReturnType<typeof fs.statfsSync>;
      }) as typeof fs.statfsSync;

      await expect(
        recoverLoopshipFastflowWorkflow({ repoRoot: fixture.repo, wtree }),
      ).rejects.toMatchObject({
        code: "FASTFLOW_UNSUPPORTED_DURABLE_FILESYSTEM",
      });
      expect(readLoopshipNativeExecutionRequest(workspaceRoot)).toMatchObject({
        executionId: native.executionId,
        status: "pending",
      });
      expect(readFileSync(files.hook_state, "utf8")).toBe(originalHookState);

      rmSync(markerPath, { force: true });
      await expect(
        resumeLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          workspaceRoot,
          request: {
            sessionId: native.executionId,
            workspaceRoot,
            response: { answer: { status: "ok" } },
          },
        }),
      ).rejects.toMatchObject({
        code: "FASTFLOW_UNSUPPORTED_DURABLE_FILESYSTEM",
      });
      expect(readLoopshipNativeExecutionRequest(workspaceRoot)).toMatchObject({
        executionId: native.executionId,
        status: "pending",
      });
      expect(readFileSync(files.hook_state, "utf8")).toBe(originalHookState);
      expect(readFileSync(operationLog, "utf8").trim().split("\n")).toEqual([
        "recover",
        "resume",
      ]);
    } finally {
      fs.statfsSync = originalStatfsSync;
      if (previousDb === undefined) delete process.env.FASTFLOW_SCHEDULER_DB;
      else process.env.FASTFLOW_SCHEDULER_DB = previousDb;
      if (previousMode === undefined) delete process.env.FASTFLOW_SCHEDULER_MODE;
      else process.env.FASTFLOW_SCHEDULER_MODE = previousMode;
      if (previousRoot === undefined) delete process.env.LOOPSHIP_FASTFLOW_ROOT;
      else process.env.LOOPSHIP_FASTFLOW_ROOT = previousRoot;
      if (previousMarker === undefined) delete process.env.LOOPSHIP_REMOUNT_MARKER;
      else process.env.LOOPSHIP_REMOUNT_MARKER = previousMarker;
      if (previousLog === undefined) delete process.env.LOOPSHIP_REMOUNT_OPERATION_LOG;
      else process.env.LOOPSHIP_REMOUNT_OPERATION_LOG = previousLog;
      rmSync(fakeFastflowRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects a moved authoritative ledger before recovery or resume reads it", async () => {
    const fixture = createGitFixture("loopship-native-moved-ledger-");
    const wtree = "moved-ledger";
    const prompt = "loopship: reject a moved Native ledger";
    const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
    const workspaceRoot = workspace.worktree_path;
    const native = resolveLoopshipNativeExecutionRequest(workspaceRoot, {
      workflowRef: loopshipFlowWorkflowRef("swe"),
      inputs: {
        request: prompt,
        repoRoot: fixture.repo,
        runtime: "codex",
        wtree,
      },
    });
    const { files } = createQuest({
      repoRoot: fixture.repo,
      wtree,
      prompt,
      resolutionSource: "test",
      workspace,
      flowId: "swe",
      initialStage: "initial",
    });
    const executionPath = join(
      workspaceRoot,
      ".loopship",
      "runtime",
      "native-execution.json",
    );
    const movedExecutionPath = join(fixture.root, "moved-native-execution.json");
    const originalExecution = readFileSync(executionPath, "utf8");
    const originalHookState = readFileSync(files.hook_state, "utf8");
    rmSync(executionPath);
    writeFileSync(movedExecutionPath, originalExecution, "utf8");
    symlinkSync(movedExecutionPath, executionPath);
    const previousDb = process.env.FASTFLOW_SCHEDULER_DB;
    const previousMode = process.env.FASTFLOW_SCHEDULER_MODE;
    try {
      process.env.FASTFLOW_SCHEDULER_DB = join(
        fixture.root,
        "scheduler",
        "native-v1.sqlite",
      );
      process.env.FASTFLOW_SCHEDULER_MODE = "local-durable";

      await expect(
        recoverLoopshipFastflowWorkflow({ repoRoot: fixture.repo, wtree }),
      ).rejects.toMatchObject({
        code: "FASTFLOW_UNSUPPORTED_DURABLE_FILESYSTEM",
      });
      await expect(
        resumeLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          workspaceRoot,
          request: {
            sessionId: native.executionId,
            workspaceRoot,
            response: { answer: { status: "ok" } },
          },
        }),
      ).rejects.toMatchObject({
        code: "FASTFLOW_UNSUPPORTED_DURABLE_FILESYSTEM",
      });
      expect(lstatSync(executionPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(movedExecutionPath, "utf8")).toBe(originalExecution);
      expect(readFileSync(files.hook_state, "utf8")).toBe(originalHookState);
      expect(
        existsSync(join(workspaceRoot, ".loopship", "runtime", "quest-init.lock.sqlite")),
      ).toBe(false);
    } finally {
      if (previousDb === undefined) delete process.env.FASTFLOW_SCHEDULER_DB;
      else process.env.FASTFLOW_SCHEDULER_DB = previousDb;
      if (previousMode === undefined) delete process.env.FASTFLOW_SCHEDULER_MODE;
      else process.env.FASTFLOW_SCHEDULER_MODE = previousMode;
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("binds Native recovery and resume to the registered canonical worktree ledger", async () => {
    const fixture = createGitFixture("loopship-native-canonical-recovery-");
    const wtree = "canonical-recovery";
    const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
    const workspaceRoot = workspace.worktree_path;
    const native = resolveLoopshipNativeExecutionRequest(workspaceRoot, {
      workflowRef: loopshipFlowWorkflowRef("swe"),
      inputs: {
        request: "loopship: recover only the canonical Native execution",
        repoRoot: fixture.repo,
        runtime: "codex",
        wtree,
      },
    });
    createQuest({
      repoRoot: fixture.repo,
      wtree,
      prompt: "loopship: recover only the canonical Native execution",
      resolutionSource: "test",
      workspace,
      flowId: "swe",
      initialStage: "initial",
    });
    try {
      await expect(
        resumeLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          workspaceRoot,
          request: {
            sessionId: "loopship-wrong-ledger",
            workspaceRoot,
            response: { answer: { status: "ok" } },
          },
        }),
      ).rejects.toThrow("does not match current ledger");

      const linkedWorkspace = join(fixture.repo, "worktrees", "linked-recovery");
      symlinkSync(workspaceRoot, linkedWorkspace, "dir");
      await expect(
        resumeLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          workspaceRoot: linkedWorkspace,
          request: {
            sessionId: native.executionId,
            workspaceRoot: linkedWorkspace,
            response: { answer: { status: "ok" } },
          },
        }),
      ).rejects.toMatchObject({
        code: "FASTFLOW_UNSUPPORTED_DURABLE_FILESYSTEM",
      });
      rmSync(linkedWorkspace);

      const wrongBranch = "codex/wrong-native-recovery";
      runGit(workspaceRoot, ["checkout", "-b", wrongBranch]);
      await expect(
        resumeLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          workspaceRoot,
          request: {
            sessionId: native.executionId,
            workspaceRoot,
            response: { answer: { status: "ok" } },
          },
        }),
      ).rejects.toThrow("does not match canonical quest branch");
      await expect(
        recoverLoopshipFastflowWorkflow({ repoRoot: fixture.repo, wtree }),
      ).rejects.toThrow("does not match canonical quest branch");
      runGit(workspaceRoot, ["checkout", workspace.branch_ref]);
      runGit(fixture.repo, ["branch", "-D", "--", wrongBranch]);

      const tasksPath = join(workspaceRoot, ".loopship", "runtime", "tasks.yaml");
      const executionPath = join(
        workspaceRoot,
        ".loopship",
        "runtime",
        "native-execution.json",
      );
      const tasks = readFileSync(tasksPath, "utf8");
      const execution = readFileSync(executionPath, "utf8");
      runGit(fixture.repo, ["worktree", "remove", "--force", workspaceRoot]);
      mkdirSync(join(workspaceRoot, ".loopship", "runtime"), { recursive: true });
      writeFileSync(tasksPath, tasks, "utf8");
      writeFileSync(executionPath, execution, "utf8");

      await expect(
        recoverLoopshipFastflowWorkflow({ repoRoot: fixture.repo, wtree }),
      ).rejects.toThrow("requires a registered Git worktree");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects Native recovery ledgers bound to another repository root", async () => {
    const fixture = createGitFixture("loopship-native-repo-authority-");
    const foreign = createGitFixture("loopship-native-foreign-repo-");
    const wtree = "repo-authority";
    const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
    const workspaceRoot = workspace.worktree_path;
    resolveLoopshipNativeExecutionRequest(workspaceRoot, {
      workflowRef: loopshipFlowWorkflowRef("swe"),
      inputs: {
        request: "loopship: reject a foreign repository authority",
        repoRoot: foreign.repo,
        wtree,
      },
    });
    createQuest({
      repoRoot: fixture.repo,
      wtree,
      prompt: "loopship: reject a foreign repository authority",
      resolutionSource: "test",
      workspace,
      flowId: "swe",
      initialStage: "initial",
    });
    try {
      await expect(
        recoverLoopshipFastflowWorkflow({ repoRoot: fixture.repo, wtree }),
      ).rejects.toThrow("does not match canonical repository");

      const aliasWtree = "repo-alias-authority";
      const aliasWorkspace = ensureCoordinatorWorkspace(fixture.repo, aliasWtree);
      resolveLoopshipNativeExecutionRequest(aliasWorkspace.worktree_path, {
        workflowRef: loopshipFlowWorkflowRef("swe"),
        inputs: {
          request: "loopship: reject a foreign repository alias",
          repo: foreign.repo,
          repoRoot: fixture.repo,
          wtree: aliasWtree,
        },
      });
      createQuest({
        repoRoot: fixture.repo,
        wtree: aliasWtree,
        prompt: "loopship: reject a foreign repository alias",
        resolutionSource: "test",
        workspace: aliasWorkspace,
        flowId: "swe",
        initialStage: "initial",
      });
      await expect(
        recoverLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          wtree: aliasWtree,
        }),
      ).rejects.toThrow("does not match canonical repository");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
      rmSync(foreign.root, { recursive: true, force: true });
    }
  });

  test("binds initial Native execution inputs to the authoritative repository", async () => {
    const fixture = createGitFixture("loopship-native-initial-repo-authority-");
    const foreign = createGitFixture("loopship-native-initial-foreign-repo-");
    try {
      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "swe",
          inputs: {
            request: "loopship: reject a foreign initial repoRoot",
            repoRoot: foreign.repo,
            wtree: "foreign-repo-root",
          },
        }),
      ).rejects.toThrow("inputs.repoRoot");
      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "swe",
          inputs: {
            request: "loopship: reject a foreign initial repo alias",
            repoRoot: fixture.repo,
            repo: foreign.repo,
            wtree: "foreign-repo-alias",
          },
        }),
      ).rejects.toThrow("inputs.repo");
      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "swe",
          inputs: {
            request: "loopship: reject conflicting execution aliases",
            repoRoot: fixture.repo,
            targetBranch: "main",
            target_branch: "release",
            wtree: "conflicting-target-aliases",
          },
        }),
      ).rejects.toThrow("inputs.targetBranch conflicts with inputs.target_branch");
      expect(existsSync(join(fixture.repo, "worktrees", "foreign-repo-root"))).toBe(false);
      expect(existsSync(join(fixture.repo, "worktrees", "foreign-repo-alias"))).toBe(false);
      expect(existsSync(join(fixture.repo, "worktrees", "conflicting-target-aliases"))).toBe(false);
      expect(existsSync(join(foreign.repo, ".loopship", "runtime"))).toBe(false);
    } finally {
      rmSync(foreign.root, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects initial Native execution without a canonical worktree identity", async () => {
    const fixture = createGitFixture("loopship-native-missing-worktree-");
    try {
      await expect(
        runLoopshipFastflowWorkflowRequest({
          repoRoot: fixture.repo,
          request: {
            workflowRef: loopshipFlowWorkflowRef("swe"),
            inputs: { repoRoot: fixture.repo },
          },
        }),
      ).rejects.toThrow("requires inputs.wtree or inputs.request");
      expect(existsSync(join(fixture.repo, ".loopship", "runtime"))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects an explicit initial workspace outside the canonical registered worktree before writing a ledger", async () => {
    const fixture = createGitFixture("loopship-native-initial-workspace-authority-");
    const outsideWorkspace = join(fixture.root, "outside-workspace");
    mkdirSync(outsideWorkspace, { recursive: true });
    try {
      await expect(
        runLoopshipFastflowWorkflowRequest({
          repoRoot: fixture.repo,
          workspaceRoot: outsideWorkspace,
          request: {
            workflowRef: loopshipFlowWorkflowRef("swe"),
            inputs: {
              repoRoot: fixture.repo,
              wtree: "outside-workspace",
            },
          },
        }),
      ).rejects.toThrow("requires canonical worktree");
      expect(existsSync(join(outsideWorkspace, ".loopship"))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects a relative durable scheduler database before claiming quest state", async () => {
    const fixture = createGitFixture("loopship-native-relative-scheduler-db-");
    const previousDb = process.env.FASTFLOW_SCHEDULER_DB;
    const wtree = "relative-scheduler-db";
    try {
      process.env.FASTFLOW_SCHEDULER_DB = "./native-v1.sqlite";
      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "swe",
          inputs: {
            request: "loopship: reject cwd-relative scheduler authority",
            repoRoot: fixture.repo,
            wtree,
          },
        }),
      ).rejects.toThrow("FASTFLOW_SCHEDULER_DB must be an absolute path");
      expect(existsSync(join(fixture.repo, "worktrees", wtree))).toBe(false);

      const daemon = Bun.spawn(
        [process.execPath, "--no-install", resolve(process.cwd(), "bin", "loopship-fastflow-daemon")],
        {
          cwd: fixture.repo,
          env: { ...process.env, FASTFLOW_SCHEDULER_DB: "./native-v1.sqlite" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await daemon.exited).not.toBe(0);
      expect(await new Response(daemon.stderr).text()).toContain(
        "FASTFLOW_SCHEDULER_DB must be an absolute path",
      );

      const canonicalDb = join(fixture.root, "scheduler", "native-v1.sqlite");
      process.env.FASTFLOW_SCHEDULER_DB = ` ${canonicalDb} `;
      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "missing-flow",
          inputs: { request: "loopship: canonicalize scheduler authority" },
        }),
      ).rejects.toThrow("Unknown Loopship flow");
      expect(process.env.FASTFLOW_SCHEDULER_DB).toBe(canonicalDb);

      process.env.FASTFLOW_SCHEDULER_DB = "   ";
      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "missing-flow",
          inputs: { request: "loopship: clear empty scheduler authority" },
        }),
      ).rejects.toThrow("Unknown Loopship flow");
      expect(process.env.FASTFLOW_SCHEDULER_DB).toBeUndefined();
    } finally {
      if (previousDb === undefined) delete process.env.FASTFLOW_SCHEDULER_DB;
      else process.env.FASTFLOW_SCHEDULER_DB = previousDb;
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects an unsupported default scheduler database before claiming quest state", async () => {
    const fixture = createGitFixture("loopship-native-default-scheduler-db-");
    const previousDb = process.env.FASTFLOW_SCHEDULER_DB;
    const previousHome = process.env.LOOPSHIP_HOME;
    const previousMode = process.env.FASTFLOW_SCHEDULER_MODE;
    const wtree = "unsupported-default-scheduler";
    try {
      const schedulerRoot = join(fixture.root, "loopship-home", "scheduler");
      const target = join(fixture.root, "scheduler-target.sqlite");
      mkdirSync(schedulerRoot, { recursive: true });
      writeFileSync(target, "");
      symlinkSync(target, join(schedulerRoot, "native-v1.sqlite"));
      delete process.env.FASTFLOW_SCHEDULER_DB;
      process.env.LOOPSHIP_HOME = join(fixture.root, "loopship-home");
      process.env.FASTFLOW_SCHEDULER_MODE = " local-durable ";

      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "swe",
          inputs: {
            request: "loopship: reject an unsupported default scheduler authority",
            wtree,
          },
        }),
      ).rejects.toMatchObject({
        code: "FASTFLOW_UNSUPPORTED_DURABLE_FILESYSTEM",
      });
      expect(process.env.FASTFLOW_SCHEDULER_MODE).toBe("local-durable");
      expect(existsSync(join(fixture.repo, "worktrees", wtree))).toBe(false);
    } finally {
      if (previousDb === undefined) delete process.env.FASTFLOW_SCHEDULER_DB;
      else process.env.FASTFLOW_SCHEDULER_DB = previousDb;
      if (previousHome === undefined) delete process.env.LOOPSHIP_HOME;
      else process.env.LOOPSHIP_HOME = previousHome;
      if (previousMode === undefined) delete process.env.FASTFLOW_SCHEDULER_MODE;
      else process.env.FASTFLOW_SCHEDULER_MODE = previousMode;
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects an unsupported prospective worktree before creating its branch", async () => {
    const fixture = createGitFixture("loopship-native-worktree-filesystem-");
    const previousDb = process.env.FASTFLOW_SCHEDULER_DB;
    const previousMode = process.env.FASTFLOW_SCHEDULER_MODE;
    const wtree = "unsupported-worktree";
    try {
      const worktreesRoot = join(fixture.repo, "worktrees");
      const prospective = join(worktreesRoot, wtree);
      const target = join(fixture.root, "worktree-target");
      mkdirSync(worktreesRoot, { recursive: true });
      mkdirSync(target, { recursive: true });
      symlinkSync(target, prospective);
      process.env.FASTFLOW_SCHEDULER_DB = join(fixture.root, "scheduler", "native-v1.sqlite");
      process.env.FASTFLOW_SCHEDULER_MODE = "local-durable";

      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "swe",
          inputs: {
            request: "loopship: reject an unsupported prospective worktree",
            wtree,
          },
        }),
      ).rejects.toMatchObject({
        code: "FASTFLOW_UNSUPPORTED_DURABLE_FILESYSTEM",
      });
      expect(
        runCommand("git", ["show-ref", "--verify", `refs/heads/${wtree}`], {
          cwd: fixture.repo,
          timeoutMs: 10_000,
        }).status,
      ).not.toBe(0);
    } finally {
      if (previousDb === undefined) delete process.env.FASTFLOW_SCHEDULER_DB;
      else process.env.FASTFLOW_SCHEDULER_DB = previousDb;
      if (previousMode === undefined) delete process.env.FASTFLOW_SCHEDULER_MODE;
      else process.env.FASTFLOW_SCHEDULER_MODE = previousMode;
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects an unknown scheduler mode before creating a worktree", async () => {
    const fixture = createGitFixture("loopship-native-scheduler-mode-");
    const previousMode = process.env.FASTFLOW_SCHEDULER_MODE;
    const wtree = "unsupported-scheduler-mode";
    try {
      process.env.FASTFLOW_SCHEDULER_MODE = "production";
      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "swe",
          inputs: {
            request: "loopship: reject an unknown scheduler profile",
            wtree,
          },
        }),
      ).rejects.toThrow("unsupported schedulerMode 'production'");
      expect(existsSync(join(fixture.repo, "worktrees", wtree))).toBe(false);
    } finally {
      if (previousMode === undefined) delete process.env.FASTFLOW_SCHEDULER_MODE;
      else process.env.FASTFLOW_SCHEDULER_MODE = previousMode;
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects a relative Loopship home before selecting scheduler authority", async () => {
    const fixture = createGitFixture("loopship-native-relative-home-");
    const previousHome = process.env.LOOPSHIP_HOME;
    const wtree = "relative-loopship-home";
    try {
      process.env.LOOPSHIP_HOME = "./relative-loopship-home";
      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "swe",
          inputs: {
            request: "loopship: reject cwd-relative durable authority",
            wtree,
          },
        }),
      ).rejects.toThrow("LOOPSHIP_HOME must be an absolute path");
      expect(existsSync(join(fixture.repo, "worktrees", wtree))).toBe(false);

      const env: Record<string, string | undefined> = {
        ...process.env,
        LOOPSHIP_HOME: "./relative-loopship-home",
      };
      delete env.FASTFLOW_SCHEDULER_DB;
      const daemon = Bun.spawn(
        [process.execPath, "--no-install", resolve(process.cwd(), "bin", "loopship-fastflow-daemon")],
        {
          cwd: fixture.repo,
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await daemon.exited).not.toBe(0);
      expect(await new Response(daemon.stderr).text()).toContain(
        "LOOPSHIP_HOME must be an absolute path",
      );
    } finally {
      if (previousHome === undefined) delete process.env.LOOPSHIP_HOME;
      else process.env.LOOPSHIP_HOME = previousHome;
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects a coordinator branch collision before writing Native state outside the canonical worktree", async () => {
    const fixture = createGitFixture("loopship-native-coordinator-branch-collision-");
    try {
      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "swe",
          inputs: {
            request: "loopship: reject the repository root as a coordinator workspace",
            repoRoot: fixture.repo,
            wtree: "main",
          },
        }),
      ).rejects.toThrow("already checked out outside its requested worktree");
      expect(
        existsSync(join(fixture.repo, ".loopship", "runtime", "native-execution.json")),
      ).toBe(false);
      expect(existsSync(join(fixture.repo, "worktrees", "main"))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects a detached canonical coordinator worktree before writing Native state", async () => {
    const fixture = createGitFixture("loopship-native-detached-coordinator-");
    const wtree = "detached-coordinator";
    const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
    try {
      runGit(workspace.worktree_path, ["checkout", "--detach"]);
      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "swe",
          inputs: {
            request: "loopship: reject a detached coordinator",
            repoRoot: fixture.repo,
            wtree,
          },
        }),
      ).rejects.toThrow("requires an attached Git branch");
      expect(
        existsSync(
          join(workspace.worktree_path, ".loopship", "runtime", "native-execution.json"),
        ),
      ).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("repairs a deterministic partial quest initialization after claiming the Native request", async () => {
    const fixture = createGitFixture("loopship-native-partial-init-");
    const fakeFastflowRoot = mkdtempSync(join(process.cwd(), "tmp", "loopship-fake-fastflow-"));
    const previousRoot = process.env.LOOPSHIP_FASTFLOW_ROOT;
    const wtree = "partial-init";
    const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
    const request = {
      workflowRef: loopshipFlowWorkflowRef("swe"),
      inputs: {
        request: "loopship: recover deterministic partial initialization",
        prompt: "loopship: recover deterministic partial initialization",
        repo: fixture.repo,
        repoRoot: fixture.repo,
        sourceBranch: wtree,
        source_branch: wtree,
        targetBranch: "main",
        target_branch: "main",
        targetWorktree: landingTargetWorktreePath(fixture.repo, "main"),
        target_worktree: landingTargetWorktreePath(fixture.repo, "main"),
        wtree,
      },
    };
    try {
      mkdirSync(join(fakeFastflowRoot, "src"), { recursive: true });
      writeFileSync(join(fakeFastflowRoot, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(join(fakeFastflowRoot, "src", "catalog.mjs"), "export {};\n");
      writeFileSync(
        join(fakeFastflowRoot, "src", "index.mjs"),
        `
          export function configureFastflowApp() {}
          export async function executeFastflowWorkflowRunRequest() {
            return {
              schemaVersion: "fastflow/workflow-run-artifact/v1",
              kind: "workflow_result",
              ok: true,
              status: "completed",
              output: { stage_after: "initial" },
            };
          }
          export async function executeFastflowWorkflowResumeRequest() {
            throw new Error("unexpected resume");
          }
        `,
      );
      process.env.LOOPSHIP_FASTFLOW_ROOT = fakeFastflowRoot;
      resolveLoopshipNativeExecutionRequest(workspace.worktree_path, request);
      const { files } = createFastflowQuest(
        fixture.repo,
        wtree,
        String(request.inputs.request),
      );
      rmSync(files.events, { force: true });
      rmSync(files.hook_state, { force: true });
      rmSync(files.manifest, { force: true });

      await runLoopshipFastflowWorkflowRequest({
        repoRoot: fixture.repo,
        workspaceRoot: workspace.worktree_path,
        request,
      });

      expect(JSON.parse(readFileSync(files.events, "utf8").trim())).toMatchObject({
        event: "quest_started",
        quest_id: wtree,
      });
      expect(JSON.parse(readFileSync(files.hook_state, "utf8"))).toEqual({});
      expect(verifyQuestManifest(files)).toEqual({ ok: true, errors: [] });
      expect(
        readLoopshipNativeExecutionRequest(workspace.worktree_path).executionId,
      ).toMatch(/^loopship-[0-9a-f]{64}$/);
    } finally {
      if (previousRoot === undefined) delete process.env.LOOPSHIP_FASTFLOW_ROOT;
      else process.env.LOOPSHIP_FASTFLOW_ROOT = previousRoot;
      rmSync(fakeFastflowRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("serializes concurrent same-request quest initialization across processes", async () => {
    const fixture = createGitFixture("loopship-native-concurrent-init-");
    const fakeFastflowRoot = mkdtempSync(join(process.cwd(), "tmp", "loopship-concurrent-init-fastflow-"));
    const scriptRoot = mkdtempSync(join(process.cwd(), "tmp", "loopship-concurrent-init-script-"));
    const startPath = join(scriptRoot, "start");
    const script = join(scriptRoot, "run.ts");
    const wtree = "concurrent-init";
    const prompt = "loopship: serialize concurrent Native initialization";
    const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
    try {
      mkdirSync(join(fakeFastflowRoot, "src"), { recursive: true });
      writeFileSync(join(fakeFastflowRoot, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(join(fakeFastflowRoot, "src", "catalog.mjs"), "export {};\n");
      writeFileSync(
        join(fakeFastflowRoot, "src", "index.mjs"),
        `
          export function configureFastflowApp() {}
          export async function executeFastflowWorkflowRunRequest(request) {
            return {
              schemaVersion: "fastflow/interaction-response/v1",
              kind: "handoff_answer",
              ok: true,
              status: "paused",
              executionId: request.executionId,
              nextCall: {
                args: {
                  sessionId: request.executionId,
                  nonce: "concurrent-init-nonce",
                  workspaceRoot: process.cwd(),
                },
              },
            };
          }
          export async function executeFastflowWorkflowResumeRequest() {
            throw new Error("unexpected resume");
          }
        `,
      );
      writeFileSync(
        script,
        `
          import { existsSync, writeFileSync } from "node:fs";
          import { runLoopshipFastflowWorkflow } from ${JSON.stringify(
            pathToFileURL(resolve(process.cwd(), "scripts", "loopship_fastflow.ts")).href,
          )};
          const [repoRoot, workspaceRoot, readyPath, startPath, wtree, prompt] = process.argv.slice(2);
          writeFileSync(readyPath, "ready");
          while (!existsSync(startPath)) await Bun.sleep(5);
          const result = await runLoopshipFastflowWorkflow({
            repoRoot,
            workspaceRoot,
            flowId: "swe",
            inputs: { request: prompt, repoRoot, runtime: "codex", wtree },
          });
          console.log(JSON.stringify(result));
        `,
        "utf8",
      );
      const spawnInit = (id: string) => {
        const readyPath = join(scriptRoot, `ready-${id}`);
        const proc = Bun.spawn(
          [
            process.execPath,
            "--no-install",
            script,
            fixture.repo,
            workspace.worktree_path,
            readyPath,
            startPath,
            wtree,
            prompt,
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              LOOPSHIP_FASTFLOW_ROOT: fakeFastflowRoot,
              CODEX_THREAD_ID: "",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        return { proc, readyPath };
      };
      const contenders = [spawnInit("a"), spawnInit("b")];
      const readyDeadline = Date.now() + 10_000;
      while (
        contenders.some(({ readyPath }) => !existsSync(readyPath)) &&
        Date.now() < readyDeadline
      ) {
        await Bun.sleep(10);
      }
      expect(contenders.every(({ readyPath }) => existsSync(readyPath))).toBe(true);
      writeFileSync(startPath, "start", "utf8");
      const results = await Promise.all(
        contenders.map(async ({ proc }) => ({
          status: await proc.exited,
          stdout: await new Response(proc.stdout).text(),
          stderr: await new Response(proc.stderr).text(),
        })),
      );
      for (const result of results) {
        expect(result.status, result.stderr || result.stdout).toBe(0);
      }

      const files = questFiles(fixture.repo, wtree);
      const events = readFileSync(files.events, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.filter((event) => event.event === "quest_started")).toHaveLength(1);
      expect(verifyQuestManifest(files)).toEqual({ ok: true, errors: [] });
      expect(readLoopshipNativeExecutionRequest(files.workspace_root)).toMatchObject({
        status: "pending",
        ordinal: 1,
      });
    } finally {
      rmSync(scriptRoot, { recursive: true, force: true });
      rmSync(fakeFastflowRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("rejects missing tasks with progressed siblings instead of blessing a reset", async () => {
    const fixture = createGitFixture("loopship-native-missing-progressed-tasks-");
    const wtree = "missing-progressed-tasks";
    const prompt = "loopship: preserve progressed quest evidence";
    try {
      const { files } = createFastflowQuest(fixture.repo, wtree, prompt);
      updateQuestStage(files, "planning", "progress-before-loss", "test");
      const eventsBefore = readFileSync(files.events, "utf8");
      const manifestBefore = readFileSync(files.manifest, "utf8");
      rmSync(files.tasks);

      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "swe",
          inputs: { request: prompt, repoRoot: fixture.repo, wtree },
        }),
      ).rejects.toThrow("stale initialization siblings without tasks");
      expect(readFileSync(files.events, "utf8")).toBe(eventsBefore);
      expect(readFileSync(files.manifest, "utf8")).toBe(manifestBefore);
      expect(
        existsSync(join(files.dir, "native-execution.json")),
      ).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects a tampered initial document instead of signing a repaired manifest", async () => {
    const fixture = createGitFixture("loopship-native-tampered-initial-prefix-");
    const wtree = "tampered-initial-prefix";
    const prompt = "loopship: reject a tampered initialization prefix";
    try {
      const { files } = createFastflowQuest(fixture.repo, wtree, prompt);
      const state = parseTasksYaml(readFileSync(files.tasks, "utf8"));
      state.prompt = "hostile replacement prompt";
      writeFileSync(files.tasks, renderTasksYaml(state as QuestState), "utf8");
      const tasksBefore = readFileSync(files.tasks, "utf8");
      rmSync(files.manifest);

      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "swe",
          inputs: { request: prompt, repoRoot: fixture.repo, wtree },
        }),
      ).rejects.toThrow("not a pristine initialization prefix");
      expect(readFileSync(files.tasks, "utf8")).toBe(tasksBefore);
      expect(existsSync(files.manifest)).toBe(false);
      expect(existsSync(join(files.dir, "native-execution.json"))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("verifies canonical quest bytes before delivering a Native resume signal", async () => {
    const fixture = createGitFixture("loopship-native-resume-manifest-guard-");
    const wtree = "resume-manifest-guard";
    const prompt = "loopship: reject drift before resume";
    try {
      const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
      const native = resolveLoopshipNativeExecutionRequest(workspace.worktree_path, {
        workflowRef: loopshipFlowWorkflowRef("swe"),
        inputs: { request: prompt, repoRoot: fixture.repo, wtree },
      });
      const { files } = createFastflowQuest(fixture.repo, wtree, prompt);
      const manifestBefore = readFileSync(files.manifest, "utf8");
      writeFileSync(
        files.events,
        `${readFileSync(files.events, "utf8")}${JSON.stringify({
          event: "tampered_while_paused",
          quest_id: wtree,
        })}\n`,
        "utf8",
      );

      await expect(
        resumeLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          workspaceRoot: files.workspace_root,
          request: {
            sessionId: native.executionId,
            nonce: "valid-looking-nonce",
            workspaceRoot: files.workspace_root,
            response: { answer: { status: "ok" } },
          },
        }),
      ).rejects.toThrow("manifest is corrupt before resume");
      expect(readFileSync(files.manifest, "utf8")).toBe(manifestBefore);
      expect(verifyQuestManifest(files).ok).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects missing request and unknown flow before claiming a Native ledger", async () => {
    const fixture = createGitFixture("loopship-native-preflight-inputs-");
    try {
      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "swe",
          inputs: { repoRoot: fixture.repo, wtree: "request-required" },
        }),
      ).rejects.toThrow("requires inputs.request");
      expect(
        existsSync(
          join(
            fixture.repo,
            "worktrees",
            "request-required",
            ".loopship",
            "runtime",
            "native-execution.json",
          ),
        ),
      ).toBe(false);
      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "missing-flow",
          inputs: {
            request: "loopship: reject an unknown flow",
            repoRoot: fixture.repo,
            wtree: "unknown-flow",
          },
        }),
      ).rejects.toThrow("Unknown Loopship flow 'missing-flow'");
      expect(existsSync(join(fixture.repo, "worktrees", "unknown-flow"))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("normalizes subdirectory repository authority and permits a corrected preflight retry", async () => {
    const fixture = createGitFixture("loopship-native-corrected-preflight-");
    const fakeFastflowRoot = mkdtempSync(join(process.cwd(), "tmp", "loopship-preflight-fastflow-"));
    const previousRoot = process.env.LOOPSHIP_FASTFLOW_ROOT;
    const subdirectory = join(fixture.repo, "src");
    const wtree = "corrected-preflight";
    const prompt = "loopship: retry corrected deterministic inputs";
    try {
      mkdirSync(subdirectory, { recursive: true });
      mkdirSync(join(fakeFastflowRoot, "src"), { recursive: true });
      writeFileSync(join(fakeFastflowRoot, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(join(fakeFastflowRoot, "src", "catalog.mjs"), "export {};\n");
      writeFileSync(
        join(fakeFastflowRoot, "src", "index.mjs"),
        `
          export function configureFastflowApp() {}
          export async function executeFastflowWorkflowRunRequest(request) {
            return {
              schemaVersion: "fastflow/workflow-run-artifact/v1",
              kind: "workflow_result",
              ok: true,
              status: "completed",
              executionId: request.executionId,
              output: { stage_after: "initial" },
            };
          }
          export async function executeFastflowWorkflowResumeRequest() {
            throw new Error("unexpected resume");
          }
        `,
      );
      process.env.LOOPSHIP_FASTFLOW_ROOT = fakeFastflowRoot;
      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: subdirectory,
          flowId: "swe",
          inputs: {
            request: prompt,
            repoRoot: subdirectory,
            wtree,
            targetBranch: "invalid branch name",
          },
        }),
      ).rejects.toThrow("landing target branch");
      const workspaceRoot = join(fixture.repo, "worktrees", wtree);
      expect(
        existsSync(join(workspaceRoot, ".loopship", "runtime", "native-execution.json")),
      ).toBe(false);

      await runLoopshipFastflowWorkflow({
        repoRoot: subdirectory,
        flowId: "swe",
        inputs: {
          request: prompt,
          repoRoot: subdirectory,
          wtree,
          targetBranch: "main",
        },
      });
      const state = parseTasksYaml(
        readFileSync(join(workspaceRoot, ".loopship", "runtime", "tasks.yaml"), "utf8"),
      );
      expect(state.context_root).toBe(fixture.repo);
      expect(state.coordinator_worktree).toBe(workspaceRoot);
      expect(existsSync(join(subdirectory, "worktrees"))).toBe(false);
    } finally {
      if (previousRoot === undefined) delete process.env.LOOPSHIP_FASTFLOW_ROOT;
      else process.env.LOOPSHIP_FASTFLOW_ROOT = previousRoot;
      rmSync(fakeFastflowRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("canonical recovery preserves its hook route while the Native execution is still running", async () => {
    const fixture = createGitFixture("loopship-native-running-recovery-");
    const fakeFastflowRoot = mkdtempSync(join(process.cwd(), "tmp", "loopship-running-fastflow-"));
    const recoveryLog = join(fakeFastflowRoot, "operations.log");
    const previousRoot = process.env.LOOPSHIP_FASTFLOW_ROOT;
    const previousLog = process.env.LOOPSHIP_NATIVE_RECOVERY_LOG;
    const previousThread = process.env.CODEX_THREAD_ID;
    const wtree = "running-recovery";
    const prompt = "loopship: preserve a running Native recovery route";
    try {
      mkdirSync(join(fakeFastflowRoot, "src"), { recursive: true });
      writeFileSync(join(fakeFastflowRoot, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(join(fakeFastflowRoot, "src", "catalog.mjs"), "export {};\n");
      writeFileSync(
        join(fakeFastflowRoot, "src", "index.mjs"),
        `
          import { appendFileSync, existsSync } from "node:fs";
          export function configureFastflowApp() {}
          export async function executeFastflowWorkflowRecoverRequest({ executionId }) {
            const alreadyRunning = existsSync(process.env.LOOPSHIP_NATIVE_RECOVERY_LOG);
            appendFileSync(process.env.LOOPSHIP_NATIVE_RECOVERY_LOG, "recover\\n");
            if (!alreadyRunning) {
              return {
                schemaVersion: "fastflow/workflow-run-artifact/v1",
                kind: "workflow_result",
                ok: true,
                status: "running",
              };
            }
            return {
              schemaVersion: "fastflow/interaction-response/v1",
              kind: "handoff_answer",
              ok: true,
              status: "paused",
              executionId,
              nextCall: {
                args: {
                  sessionId: executionId,
                  nonce: "settled-running-nonce",
                  workspaceRoot: process.cwd(),
                },
              },
            };
          }
          export async function executeFastflowWorkflowRunRequest() {
            throw new Error("unexpected resubmission");
          }
          export async function executeFastflowWorkflowResumeRequest() {
            throw new Error("unexpected resume");
          }
        `,
      );
      process.env.LOOPSHIP_FASTFLOW_ROOT = fakeFastflowRoot;
      process.env.LOOPSHIP_NATIVE_RECOVERY_LOG = recoveryLog;
      delete process.env.CODEX_THREAD_ID;
      const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
      const native = resolveLoopshipNativeExecutionRequest(workspace.worktree_path, {
        workflowRef: loopshipFlowWorkflowRef("swe"),
        inputs: {
          request: prompt,
          repo: fixture.repo,
          repoRoot: fixture.repo,
          runtime: "codex",
          wtree,
        },
      });
      const { files } = createFastflowQuest(fixture.repo, wtree, prompt);
      const route = recordHookRoute({
        repoRoot: fixture.repo,
        runtime: "codex",
        threadId: "running-recovery-thread",
        workspaceRoot: files.workspace_root,
        result: {
          kind: "supervisor_review",
          nextCall: {
            args: {
              sessionId: native.executionId,
              nonce: "prior-running-nonce",
              workspaceRoot: files.workspace_root,
            },
          },
        },
      });
      expect(route).not.toBeNull();
      const priorRoute = readFileSync(files.hook_state, "utf8");

      await expect(
        recoverLoopshipFastflowWorkflow({ repoRoot: fixture.repo, wtree }),
      ).rejects.toMatchObject({
        code: "FASTFLOW_NATIVE_EXECUTION_RUNNING",
        retryable: true,
      });
      expect(readFileSync(files.hook_state, "utf8")).toBe(priorRoute);
      expect(readLoopshipNativeExecutionRequest(files.workspace_root)).toMatchObject({
        executionId: native.executionId,
        status: "pending",
      });

      const settled = await recoverLoopshipFastflowWorkflow({
        repoRoot: fixture.repo,
        wtree,
      });
      expect(interactionPause(settled)?.nonce).toBe("settled-running-nonce");
      expect(JSON.parse(readFileSync(files.hook_state, "utf8"))).toMatchObject({
        runtime: "codex",
        thread_id: "running-recovery-thread",
        fastflow: { nonce: "settled-running-nonce" },
      });
      expect(readFileSync(recoveryLog, "utf8").trim().split("\n")).toEqual([
        "recover",
        "recover",
      ]);
    } finally {
      if (previousRoot === undefined) delete process.env.LOOPSHIP_FASTFLOW_ROOT;
      else process.env.LOOPSHIP_FASTFLOW_ROOT = previousRoot;
      if (previousLog === undefined) delete process.env.LOOPSHIP_NATIVE_RECOVERY_LOG;
      else process.env.LOOPSHIP_NATIVE_RECOVERY_LOG = previousLog;
      if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThread;
      rmSync(fakeFastflowRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("canonical recovery addresses the persisted Native execution before considering resubmission", async () => {
    const fixture = createGitFixture("loopship-native-direct-recovery-");
    const fakeFastflowRoot = mkdtempSync(join(process.cwd(), "tmp", "loopship-recovery-fastflow-"));
    const recoveryLog = join(fakeFastflowRoot, "operations.jsonl");
    const previousRoot = process.env.LOOPSHIP_FASTFLOW_ROOT;
    const previousLog = process.env.LOOPSHIP_NATIVE_RECOVERY_LOG;
    const previousThread = process.env.CODEX_THREAD_ID;
    const wtree = "direct-recovery";
    const prompt = "loopship: recover the persisted pinned plan";
    try {
      mkdirSync(join(fakeFastflowRoot, "src"), { recursive: true });
      writeFileSync(join(fakeFastflowRoot, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(join(fakeFastflowRoot, "src", "catalog.mjs"), "export const changed = true;\n");
      writeFileSync(
        join(fakeFastflowRoot, "src", "index.mjs"),
        `
          import { appendFileSync } from "node:fs";
          export function configureFastflowApp() {}
          export async function executeFastflowWorkflowRunRequest() {
            appendFileSync(process.env.LOOPSHIP_NATIVE_RECOVERY_LOG, "run\\n");
            const error = new Error("current-source submit must not run");
            error.code = "FASTFLOW_SUBMIT_CONFLICT";
            throw error;
          }
          export async function executeFastflowWorkflowRecoverRequest({ executionId }) {
            appendFileSync(process.env.LOOPSHIP_NATIVE_RECOVERY_LOG, "recover\\n");
            return {
              schemaVersion: "fastflow/interaction-response/v1",
              kind: "handoff_answer",
              ok: true,
              status: "paused",
              executionId,
              nextCall: {
                args: {
                  sessionId: executionId,
                  nonce: "persisted-plan-nonce",
                  workspaceRoot: process.cwd(),
                },
              },
            };
          }
          export async function executeFastflowWorkflowResumeRequest() {
            throw new Error("unexpected resume");
          }
        `,
      );
      process.env.LOOPSHIP_FASTFLOW_ROOT = fakeFastflowRoot;
      process.env.LOOPSHIP_NATIVE_RECOVERY_LOG = recoveryLog;
      process.env.CODEX_THREAD_ID = "direct-recovery-thread";
      const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
      const native = resolveLoopshipNativeExecutionRequest(workspace.worktree_path, {
        workflowRef: loopshipFlowWorkflowRef("swe"),
        inputs: {
          request: prompt,
          repo: fixture.repo,
          repoRoot: fixture.repo,
          runtime: "codex",
          wtree,
        },
      });
      const { files } = createFastflowQuest(fixture.repo, wtree, prompt);

      const result = await recoverLoopshipFastflowWorkflow({ repoRoot: fixture.repo, wtree });
      expect(interactionPause(result)?.sessionId).toBe(native.executionId);
      expect(readFileSync(recoveryLog, "utf8").trim().split("\n")).toEqual(["recover"]);
      expect(JSON.parse(readFileSync(files.hook_state, "utf8"))).toMatchObject({
        schema_version: 2,
        runtime: "codex",
        thread_id: "direct-recovery-thread",
        fastflow: {
          sessionId: native.executionId,
          nonce: "persisted-plan-nonce",
          workspaceRoot: files.workspace_root,
        },
      });
    } finally {
      if (previousRoot === undefined) delete process.env.LOOPSHIP_FASTFLOW_ROOT;
      else process.env.LOOPSHIP_FASTFLOW_ROOT = previousRoot;
      if (previousLog === undefined) delete process.env.LOOPSHIP_NATIVE_RECOVERY_LOG;
      else process.env.LOOPSHIP_NATIVE_RECOVERY_LOG = previousLog;
      if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = previousThread;
      rmSync(fakeFastflowRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("incompatible pinned plans preserve structured recovery guidance without resubmission", async () => {
    const fixture = createGitFixture("loopship-native-incompatible-recovery-");
    const fakeFastflowRoot = mkdtempSync(join(process.cwd(), "tmp", "loopship-incompatible-fastflow-"));
    const operationLog = join(fakeFastflowRoot, "operations.jsonl");
    const previousRoot = process.env.LOOPSHIP_FASTFLOW_ROOT;
    const previousLog = process.env.LOOPSHIP_NATIVE_RECOVERY_LOG;
    const wtree = "incompatible-recovery";
    const prompt = "loopship: keep an incompatible pinned execution fail closed";
    try {
      mkdirSync(join(fakeFastflowRoot, "src"), { recursive: true });
      writeFileSync(join(fakeFastflowRoot, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(join(fakeFastflowRoot, "src", "catalog.mjs"), "export {};\n");
      writeFileSync(
        join(fakeFastflowRoot, "src", "index.mjs"),
        `
          import { appendFileSync } from "node:fs";
          export function configureFastflowApp() {}
          export async function executeFastflowWorkflowRecoverRequest() {
            appendFileSync(process.env.LOOPSHIP_NATIVE_RECOVERY_LOG, "recover\\n");
            const error = new Error("pinned plan has no exact dispatch route");
            error.code = "FASTFLOW_PLAN_INCOMPATIBLE";
            error.retryable = false;
            throw error;
          }
          export async function executeFastflowWorkflowRunRequest() {
            appendFileSync(process.env.LOOPSHIP_NATIVE_RECOVERY_LOG, "run\\n");
            throw new Error("incompatible recovery must not resubmit");
          }
          export async function executeFastflowWorkflowResumeRequest() {
            throw new Error("unexpected resume");
          }
        `,
      );
      process.env.LOOPSHIP_FASTFLOW_ROOT = fakeFastflowRoot;
      process.env.LOOPSHIP_NATIVE_RECOVERY_LOG = operationLog;
      const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
      const native = resolveLoopshipNativeExecutionRequest(workspace.worktree_path, {
        workflowRef: loopshipFlowWorkflowRef("swe"),
        inputs: {
          request: prompt,
          repo: fixture.repo,
          repoRoot: fixture.repo,
          runtime: "codex",
          wtree,
        },
      });
      const { files } = createFastflowQuest(fixture.repo, wtree, prompt);

      let failure: unknown;
      try {
        await recoverLoopshipFastflowWorkflow({ repoRoot: fixture.repo, wtree });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "FASTFLOW_PLAN_INCOMPATIBLE",
        retryable: false,
      });
      expect((failure as Error).message).toContain(native.executionId);
      expect((failure as Error).message).toContain("Restore the exact prior Loopship/Fastflow release");
      expect((failure as Error).message).toContain("finish or cancel");
      expect((failure as Error).message).toContain("resubmit as a new Native execution");
      expect(readFileSync(operationLog, "utf8").trim().split("\n")).toEqual(["recover"]);
      expect(readLoopshipNativeExecutionRequest(files.workspace_root)).toMatchObject({
        executionId: native.executionId,
        status: "pending",
      });
    } finally {
      if (previousRoot === undefined) delete process.env.LOOPSHIP_FASTFLOW_ROOT;
      else process.env.LOOPSHIP_FASTFLOW_ROOT = previousRoot;
      if (previousLog === undefined) delete process.env.LOOPSHIP_NATIVE_RECOVERY_LOG;
      else process.env.LOOPSHIP_NATIVE_RECOVERY_LOG = previousLog;
      rmSync(fakeFastflowRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("retires and reports a recovered terminal failure before allocating a new execution", async () => {
    const fixture = createGitFixture("loopship-native-failed-recovery-");
    const fakeFastflowRoot = mkdtempSync(join(process.cwd(), "tmp", "loopship-failed-fastflow-"));
    const operationLog = join(fakeFastflowRoot, "operations.jsonl");
    const previousRoot = process.env.LOOPSHIP_FASTFLOW_ROOT;
    const previousLog = process.env.LOOPSHIP_NATIVE_RECOVERY_LOG;
    const wtree = "failed-recovery";
    const prompt = "loopship: retire a failed durable execution";
    try {
      mkdirSync(join(fakeFastflowRoot, "src"), { recursive: true });
      writeFileSync(join(fakeFastflowRoot, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(join(fakeFastflowRoot, "src", "catalog.mjs"), "export {};\n");
      writeFileSync(
        join(fakeFastflowRoot, "src", "index.mjs"),
        `
          import { appendFileSync } from "node:fs";
          export function configureFastflowApp() {}
          export async function executeFastflowWorkflowRecoverRequest({ executionId }) {
            appendFileSync(process.env.LOOPSHIP_NATIVE_RECOVERY_LOG, "recover:" + executionId + "\\n");
            return {
              schemaVersion: "fastflow/workflow-run-artifact/v1",
              kind: "workflow_result",
              ok: false,
              status: "failed",
              error: { code: "SYNTHETIC_DURABLE_FAILURE", message: "synthetic durable failure" },
            };
          }
          export async function executeFastflowWorkflowRunRequest(request) {
            appendFileSync(process.env.LOOPSHIP_NATIVE_RECOVERY_LOG, "run:" + request.executionId + "\\n");
            return {
              schemaVersion: "fastflow/workflow-run-artifact/v1",
              kind: "workflow_result",
              ok: true,
              status: "completed",
              executionId: request.executionId,
              output: { stage_after: "initial" },
            };
          }
          export async function executeFastflowWorkflowResumeRequest() {
            throw new Error("unexpected resume");
          }
        `,
      );
      process.env.LOOPSHIP_FASTFLOW_ROOT = fakeFastflowRoot;
      process.env.LOOPSHIP_NATIVE_RECOVERY_LOG = operationLog;
      const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
      const first = resolveLoopshipNativeExecutionRequest(workspace.worktree_path, {
        workflowRef: loopshipFlowWorkflowRef("swe"),
        inputs: { request: prompt, repo: fixture.repo, repoRoot: fixture.repo, wtree },
      });
      const { files } = createFastflowQuest(fixture.repo, wtree, prompt);

      await expect(
        recoverLoopshipFastflowWorkflow({ repoRoot: fixture.repo, wtree }),
      ).rejects.toThrow("synthetic durable failure");
      expect(readLoopshipNativeExecutionRequest(files.workspace_root)).toMatchObject({
        executionId: first.executionId,
        status: "completed",
        ordinal: 1,
      });

      await recoverLoopshipFastflowWorkflow({ repoRoot: fixture.repo, wtree });
      const second = readLoopshipNativeExecutionRequest(files.workspace_root);
      expect(second).toMatchObject({ status: "completed", ordinal: 2 });
      expect(second.executionId).not.toBe(first.executionId);
      expect(readFileSync(operationLog, "utf8").trim().split("\n")).toEqual([
        `recover:${first.executionId}`,
        `run:${second.executionId}`,
      ]);
    } finally {
      if (previousRoot === undefined) delete process.env.LOOPSHIP_FASTFLOW_ROOT;
      else process.env.LOOPSHIP_FASTFLOW_ROOT = previousRoot;
      if (previousLog === undefined) delete process.env.LOOPSHIP_NATIVE_RECOVERY_LOG;
      else process.env.LOOPSHIP_NATIVE_RECOVERY_LOG = previousLog;
      rmSync(fakeFastflowRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("distinguishes cleaned Native workspace residue from live legacy quest state", () => {
    const root = mkdtempSync(join(tmpdir(), "loopship-native-cleanup-ledger-"));
    const workspaceRoot = join(root, "worktree");
    const runtimeRoot = join(workspaceRoot, ".loopship", "runtime");
    try {
      mkdirSync(join(runtimeRoot, "afn-effects"), { recursive: true });
      writeFileSync(join(runtimeRoot, "afn-effects", "residue.json"), "{}\n", "utf8");
      expect(() =>
        markLoopshipNativeExecutionCompleted(workspaceRoot, "loopship-cleaned"),
      ).not.toThrow();

      writeFileSync(join(runtimeRoot, "tasks.yaml"), "schema_version: 4\n", "utf8");
      expect(() =>
        markLoopshipNativeExecutionCompleted(workspaceRoot, "loopship-legacy"),
      ).toThrow("legacy_execution_unsupported");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removes only receipt-authorized residue after Native cleanup finalizes", () => {
    const fixture = createGitFixture("loopship-native-cleanup-residue-");
    const workspaceRoot = join(fixture.repo, "worktrees", "residue");
    try {
      ensureTaskWorkspace(fixture.repo, "codex/residue", workspaceRoot, "main");
      expect(
        cleanupCompletedNativeWorkspaceResidue({ repo: fixture.repo, workspaceRoot }),
      ).toBe(false);
      expect(existsSync(workspaceRoot)).toBe(true);

      const receiptRoot = join(fixture.repo, ".loopship", "runtime", "afn-effects");
      mkdirSync(receiptRoot, { recursive: true });
      writeFileSync(
        join(receiptRoot, "cleanup.json"),
        `${JSON.stringify({
          schemaVersion: "loopship.afn-effect-receipt/v1",
          status: "completed",
          callId: LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees,
          effectKey: "effect:cleanup",
          inputDigest: "sha256:cleanup",
          requestId: null,
          output: { removed_worktrees: [workspaceRoot] },
        })}\n`,
        "utf8",
      );

      expect(
        cleanupCompletedNativeWorkspaceResidue({ repo: fixture.repo, workspaceRoot }),
      ).toBe(false);
      runGit(fixture.repo, ["worktree", "remove", "--force", workspaceRoot]);
      mkdirSync(resolve(workspaceRoot, ".loopship", "runtime"), { recursive: true });
      writeFileSync(
        join(workspaceRoot, ".loopship", "runtime", "tasks.yaml"),
        "schema_version: 4\n",
        "utf8",
      );

      expect(
        cleanupCompletedNativeWorkspaceResidue({ repo: fixture.repo, workspaceRoot }),
      ).toBe(false);
      rmSync(join(workspaceRoot, ".loopship", "runtime", "tasks.yaml"));
      const unrelatedPath = join(workspaceRoot, "unrelated.txt");
      writeFileSync(unrelatedPath, "must survive\n", "utf8");
      expect(
        cleanupCompletedNativeWorkspaceResidue({ repo: fixture.repo, workspaceRoot }),
      ).toBe(false);
      expect(readFileSync(unrelatedPath, "utf8")).toBe("must survive\n");
      rmSync(unrelatedPath);

      const unexpectedDataPath = join(workspaceRoot, ".loopship", "data", "json", "user.json");
      mkdirSync(resolve(unexpectedDataPath, ".."), { recursive: true });
      writeFileSync(unexpectedDataPath, '{"owner":"user"}\n', "utf8");
      expect(
        cleanupCompletedNativeWorkspaceResidue({ repo: fixture.repo, workspaceRoot }),
      ).toBe(false);
      expect(readFileSync(unexpectedDataPath, "utf8")).toContain('"owner":"user"');
      rmSync(unexpectedDataPath);

      const fastflowRoot = join(workspaceRoot, ".loopship");
      mkdirSync(join(fastflowRoot, "workflows"), { recursive: true });
      mkdirSync(join(fastflowRoot, "data", "projections"), { recursive: true });
      writeFileSync(join(fastflowRoot, ".gitignore"), FASTFLOW_RUNTIME_GITIGNORE, "utf8");
      const cacheTarget = join(fixture.root, "fastflow-cache");
      mkdirSync(cacheTarget, { recursive: true });
      writeFileSync(join(cacheTarget, "survives.txt"), "external cache\n", "utf8");
      symlinkSync(cacheTarget, join(fastflowRoot, "cache"), "dir");
      expect(
        cleanupCompletedNativeWorkspaceResidue({ repo: fixture.repo, workspaceRoot }),
      ).toBe(true);
      expect(existsSync(workspaceRoot)).toBe(false);
      expect(readFileSync(join(cacheTarget, "survives.txt"), "utf8")).toBe("external cache\n");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("terminal residue cleanup ignores malformed sibling effect receipts", () => {
    const fixture = createGitFixture("loopship-native-cleanup-malformed-receipt-");
    const workspaceRoot = join(fixture.repo, "worktrees", "terminal-residue");
    const receiptRoot = join(fixture.repo, ".loopship", "runtime", "afn-effects");
    try {
      mkdirSync(join(workspaceRoot, ".loopship", "runtime"), { recursive: true });
      mkdirSync(receiptRoot, { recursive: true });
      writeFileSync(join(receiptRoot, "malformed.json"), "{not-json\n", "utf8");
      expect(() =>
        cleanupCompletedNativeWorkspaceResidue({ repo: fixture.repo, workspaceRoot }),
      ).not.toThrow();
      expect(
        cleanupCompletedNativeWorkspaceResidue({ repo: fixture.repo, workspaceRoot }),
      ).toBe(false);
      writeFileSync(
        join(receiptRoot, "valid-cleanup.json"),
        `${JSON.stringify({
          schemaVersion: "loopship.afn-effect-receipt/v1",
          status: "completed",
          callId: LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees,
          effectKey: "effect:terminal-cleanup",
          inputDigest: "sha256:terminal-cleanup",
          requestId: null,
          output: { removed_worktrees: [workspaceRoot] },
        })}\n`,
        "utf8",
      );
      expect(
        cleanupCompletedNativeWorkspaceResidue({ repo: fixture.repo, workspaceRoot }),
      ).toBe(true);
      expect(existsSync(workspaceRoot)).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("concurrent Native residue finalizers are idempotent", async () => {
    const fixture = createGitFixture("loopship-native-cleanup-race-");
    const workspaceRoot = join(fixture.repo, "worktrees", "cleanup-race");
    const receiptRoot = join(fixture.repo, ".loopship", "runtime", "afn-effects");
    const scriptRoot = mkdtempSync(join(process.cwd(), "tmp", "loopship-cleanup-race-"));
    const script = join(scriptRoot, "finalize.ts");
    try {
      mkdirSync(join(workspaceRoot, ".loopship", "data", "projections"), {
        recursive: true,
      });
      mkdirSync(join(workspaceRoot, ".loopship", "runtime"), { recursive: true });
      writeFileSync(
        join(workspaceRoot, ".loopship", ".gitignore"),
        FASTFLOW_RUNTIME_GITIGNORE,
        "utf8",
      );
      writeFileSync(
        join(workspaceRoot, ".loopship", "runtime", "native-execution.lock.sqlite"),
        "",
        "utf8",
      );
      mkdirSync(receiptRoot, { recursive: true });
      writeFileSync(
        join(receiptRoot, "cleanup-race.json"),
        `${JSON.stringify({
          schemaVersion: "loopship.afn-effect-receipt/v1",
          status: "completed",
          callId: LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees,
          effectKey: "effect:cleanup-race",
          inputDigest: "sha256:cleanup-race",
          requestId: null,
          output: { removed_worktrees: [workspaceRoot] },
        })}\n`,
        "utf8",
      );
      writeFileSync(
        script,
        `
          import { cleanupCompletedNativeWorkspaceResidue } from ${JSON.stringify(
            pathToFileURL(resolve(process.cwd(), "scripts", "loopship_fastflow.ts")).href,
          )};
          const [repo, workspaceRoot] = process.argv.slice(2);
          console.log(JSON.stringify({
            removed: cleanupCompletedNativeWorkspaceResidue({ repo, workspaceRoot }),
          }));
        `,
        "utf8",
      );

      const runFinalizer = () =>
        Bun.spawn([process.execPath, "--no-install", script, fixture.repo, workspaceRoot], {
          cwd: process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
        });
      const finalizers = [runFinalizer(), runFinalizer()];
      const results = await Promise.all(
        finalizers.map(async (proc) => ({
          status: await proc.exited,
          stdout: await new Response(proc.stdout).text(),
          stderr: await new Response(proc.stderr).text(),
        })),
      );
      for (const result of results) {
        expect(result.status, result.stderr || result.stdout).toBe(0);
      }
      expect(existsSync(workspaceRoot)).toBe(false);
    } finally {
      rmSync(scriptRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("keeps cmdproto response schemas aligned with native Fastflow results", () => {
    expect(
      validateSchemaPath(
        {
          schemaVersion: "fastflow/interaction-response/v1",
          kind: "handoff_answer",
          systemInstructions: "Continue the workflow.",
          instructions: "",
          context: {
            request: {},
            answerSchema: {},
          },
          nextCall: {
            command: "loopship stepper step --json @-",
            args: {
              sessionId: "session-1",
              nonce: "nonce-1",
              workspaceRoot: "/tmp/loopship-worktree",
              response: { answer: {} },
            },
          },
        },
        "schemas/steps/fastflow-response.yaml",
      ),
    ).toEqual([]);
    expect(
      validateSchemaPath(
        {
          schemaVersion: "fastflow/interaction-response/v1",
          kind: "handoff_answer",
          systemInstructions: "Continue the workflow.",
          instructions: "",
          context: { request: {}, answerSchema: {} },
          nextCall: {
            command: "fastflow cmdproto execjson workflows resume @-",
            args: {
              sessionId: "session-1",
              nonce: "nonce-1",
              workspaceRoot: "/tmp/loopship-worktree",
              response: { answer: {} },
            },
          },
        },
        "schemas/steps/fastflow-response.yaml",
      ),
    ).not.toEqual([]);
    expect(
      validateSchemaPath(
        {
          schemaVersion: "fastflow/interaction-response/v1",
          kind: "handoff_answer",
          systemInstructions: "Continue the workflow.",
          instructions: "",
          context: { request: {}, answerSchema: {} },
          nextCall: {
            command: "loopship stepper step --json @-",
            args: {
              sessionId: "session-1",
              nonce: "nonce-1",
              response: { answer: {} },
            },
          },
        },
        "schemas/steps/fastflow-response.yaml",
      ),
    ).not.toEqual([]);
    expect(
      validateSchemaPath(
        {
          schemaVersion: "fastflow/interaction-response/v1",
          kind: "handoff_answer",
          systemInstructions: "Continue the workflow.",
          instructions: "",
          context: { request: {}, answerSchema: {} },
          nextCall: {
            command: "loopship stepper step --json @-",
            args: {
              sessionId: "session-1",
              nonce: "nonce-1",
              workspaceRoot: "/tmp/loopship-worktree",
              response: { answer: {}, decision: "ok" },
            },
          },
        },
        "schemas/steps/fastflow-response.yaml",
      ),
    ).not.toEqual([]);
    expect(
      validateSchemaPath(
        {
          schemaVersion: "fastflow/interaction-response/v1",
          kind: "handoff_answer",
          nextCall: {},
        },
        "schemas/steps/fastflow-response.yaml",
      ),
    ).not.toEqual([]);
    expect(
      validateSchemaPath(
        {
          schemaVersion: "fastflow/workflow-run-artifact/v1",
          kind: "workflow_result",
          ok: true,
          status: "completed",
        },
        "schemas/steps/fastflow-response.yaml",
      ),
    ).toEqual([]);
    expect(
      validateSchemaPath(
        {
          schemaVersion: "fastflow/workflow-run-artifact/v1",
          kind: "workflow_result",
          status: "completed",
        },
        "schemas/steps/fastflow-response.yaml",
      ),
    ).not.toEqual([]);
  });

  test("registers exactly the minimal Loopship AFNs", () => {
    const calls = LOOPSHIP_AFN_DESCRIPTORS.map((descriptor) => descriptor.call).sort();
    expect(calls).toEqual([
      LOOPSHIP_AFN_CALLS.childPrepareWorktree,
      LOOPSHIP_AFN_CALLS.flowComposeTransitionResult,
      LOOPSHIP_AFN_CALLS.gitResolveCommit,
      LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees,
      LOOPSHIP_AFN_CALLS.landingApplyOutcome,
      LOOPSHIP_AFN_CALLS.runtimeCommitQuestState,
      LOOPSHIP_AFN_CALLS.systemApplyUpdate,
    ].sort());
    for (const call of calls) {
      expect(parseCallId(call)).toMatchObject({
        registry: "loopship",
        kind: "afn",
        target: "service",
      });
    }
  });

  test("exposes exact Native Loopship routes without a runtime-rich dispatch hook", () => {
    const adapters = createLoopshipFastflowAdapters();
    const dispatch = adapters.afnDispatch as {
      listRoutes(): Array<{ callId: string }>;
    };
    const offer = adapters.runtimeOffer as {
      exactCalls: Array<{ callId: string }>;
    };
    const routes = dispatch.listRoutes();
    expect(adapters.executeAfn).toBeUndefined();
    expect(routes.map((route) => route.callId).sort()).toEqual(
      LOOPSHIP_AFN_DESCRIPTORS.map((descriptor) => descriptor.call).sort(),
    );
    expect(offer.exactCalls).toEqual(routes);
  });

  test("deduplicates redelivered side effects by stable effect identity", async () => {
    const fixture = createGitFixture("loopship-native-effect-redelivery-");
    try {
      ensureSystemScaffold(fixture.repo);
      const root = parseYaml(
        readFileSync(join(fixture.repo, ".loopship", "system.yaml"), "utf8"),
      ) as Record<string, unknown>;
      const adapters = createLoopshipFastflowAdapters();
      const action = {
        call: LOOPSHIP_AFN_CALLS.systemApplyUpdate,
        with: {
          body: {
            repo: fixture.repo,
            update: {
              schema_version: 1,
              mode: "replace",
              summary: "Verify Native effect redelivery.",
              root,
              external_docs: [],
            },
          },
        },
      };
      const identity = {
        executionId: "loopship-effect-redelivery",
        effectKey: "loopship-effect-redelivery-system-update",
      };
      const first = await executeLoopshipAfn(adapters, { action }, identity);
      const signaturePath = join(fixture.repo, ".loopship", "signature.yaml");
      const firstSignature = readFileSync(signaturePath, "utf8");
      const second = await executeLoopshipAfn(adapters, { action }, identity);

      expect(second).toEqual(first);
      expect(readFileSync(signaturePath, "utf8")).toBe(firstSignature);
      const receiptDir = join(fixture.repo, ".loopship", "runtime", "afn-effects");
      const receiptFiles = readdirSync(receiptDir).filter((name) => name.endsWith(".json"));
      expect(receiptFiles).toHaveLength(1);
      const receiptPath = join(receiptDir, receiptFiles[0]!);
      expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      expect(receipt).toMatchObject({
        schemaVersion: "loopship.afn-effect-receipt/v1",
        status: "completed",
        callId: LOOPSHIP_AFN_CALLS.systemApplyUpdate,
        effectKey: identity.effectKey,
      });
      expect(receipt.requestId).toMatch(/^native-effect-[0-9a-f]{64}$/);

      // Model a process death after the update and signature were durable but
      // before the completed receipt rename reached disk.
      receipt.status = "started";
      delete receipt.output;
      writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
      chmodSync(receiptPath, 0o600);
      const recovered = await executeLoopshipAfn(adapters, { action }, identity);
      expect(recovered).toEqual(first);
      expect(readFileSync(signaturePath, "utf8")).toBe(firstSignature);
      expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
        status: "completed",
        output: first,
      });
      expect(statSync(receiptPath).mode & 0o777).toBe(0o600);

      await expect(
        executeLoopshipAfn(
          adapters,
          {
            action: {
              ...action,
              with: {
                body: {
                  ...action.with.body,
                  reason: "conflicting equivalent-effect payload",
                },
              },
            },
          },
          identity,
        ),
      ).rejects.toThrow("effect receipt conflicts");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("commits workflow-data quest mutations before lifecycle continuation", async () => {
    const fixture = createGitFixture("loopship-native-quest-manifest-commit-");
    try {
      const quest = createNativeQuest(fixture.repo, "manifest-commit");
      const state = parseTasksYaml(readFileSync(quest.files.tasks, "utf8"));
      state.stage = "planning";
      writeFileSync(quest.files.tasks, stringifyYaml(state), "utf8");
      writeFileSync(
        quest.files.events,
        `${readFileSync(quest.files.events, "utf8")}${JSON.stringify({
          event: "stage_changed",
          quest_id: "manifest-commit",
          stage: "planning",
        })}\n`,
        "utf8",
      );
      expect(verifyQuestManifest(quest.files).ok).toBe(false);

      const adapters = createLoopshipFastflowAdapters();
      const action = {
        call: LOOPSHIP_AFN_CALLS.runtimeCommitQuestState,
        with: {
          body: {
            repo: fixture.repo,
            wtree: "manifest-commit",
          },
        },
      };
      const identity = {
        executionId: "loopship-quest-manifest-commit",
        effectKey: "loopship-quest-manifest-commit-effect",
      };
      const first = await executeLoopshipAfn(adapters, { action }, identity);
      expect(first).toMatchObject({
        schema_version: "loopship.runtime.commit-quest-state/v1",
        wtree: "manifest-commit",
        committed: true,
      });
      expect(verifyQuestManifest(quest.files)).toEqual({ ok: true, errors: [] });
      const committedManifest = readFileSync(quest.files.manifest, "utf8");

      expect(await executeLoopshipAfn(adapters, { action }, identity)).toEqual(first);
      expect(readFileSync(quest.files.manifest, "utf8")).toBe(committedManifest);

      const checkIdentity = {
        executionId: "loopship-quest-manifest-check",
        effectKey: "loopship-quest-manifest-check-effect",
      };
      const checkReceiptPath = join(
        fixture.repo,
        ".loopship",
        "runtime",
        "afn-effects",
        `${createHash("sha256").update(checkIdentity.effectKey).digest("hex")}.json`,
      );
      expect(
        await executeLoopshipAfn(
          adapters,
          {
            action: {
              ...action,
              with: { body: { ...action.with.body, as_check: true } },
            },
          },
          checkIdentity,
        ),
      ).toMatchObject({
        ok: true,
        evidence: { committed: false },
      });
      expect(existsSync(checkReceiptPath)).toBe(false);
      const tamperedState = parseTasksYaml(readFileSync(quest.files.tasks, "utf8"));
      tamperedState.stage = "hostile-concurrent-edit";
      writeFileSync(quest.files.tasks, stringifyYaml(tamperedState), "utf8");
      await expect(
        executeLoopshipAfn(
          adapters,
          {
            action: {
              ...action,
              with: { body: { ...action.with.body, as_check: true } },
            },
          },
          checkIdentity,
        ),
      ).rejects.toThrow("runtime quest manifest verification failed");
      expect(existsSync(checkReceiptPath)).toBe(false);
      expect(readFileSync(quest.files.manifest, "utf8")).toBe(committedManifest);
      expect(verifyQuestManifest(quest.files).ok).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("serializes live cross-process effect claims and recovers a crashed owner with concurrent contenders", async () => {
    const fixture = createGitFixture("loopship-native-effect-lock-");
    let holder: ReturnType<typeof Bun.spawn> | null = null;
    try {
      ensureSystemScaffold(fixture.repo);
      const root = parseYaml(
        readFileSync(join(fixture.repo, ".loopship", "system.yaml"), "utf8"),
      ) as Record<string, unknown>;
      const adapters = createLoopshipFastflowAdapters();
      const action = {
        call: LOOPSHIP_AFN_CALLS.systemApplyUpdate,
        with: {
          body: {
            repo: fixture.repo,
            update: {
              schema_version: 1,
              mode: "replace",
              summary: "Serialize Native effect claims.",
              root,
              external_docs: [],
            },
          },
        },
      };
      const identity = {
        executionId: "loopship-effect-lock",
        effectKey: "loopship-effect-lock-system-update",
      };
      const receiptRoot = join(fixture.repo, ".loopship", "runtime", "afn-effects");
      mkdirSync(receiptRoot, { recursive: true });
      const digest = createHash("sha256").update(identity.effectKey).digest("hex");
      const lockPath = join(receiptRoot, `${digest}.json.lock.sqlite`);
      const readyPath = join(fixture.root, "effect-lock-ready");
      const holderScript = `
        import { writeFileSync } from "node:fs";
        import { acquireCrashSafeFileLock } from ${JSON.stringify(pathToFileURL(resolve(process.cwd(), "scripts", "loopship_utils.ts")).href)};
        const lockPath = ${JSON.stringify(lockPath)};
        const readyPath = ${JSON.stringify(readyPath)};
        const release = acquireCrashSafeFileLock(lockPath, 5_000);
        writeFileSync(readyPath, "ready\\n");
        await Bun.sleep(150);
        release();
      `;
      holder = Bun.spawn({
        cmd: [process.execPath, "--no-install", "-e", holderScript],
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const readyDeadline = Date.now() + 5_000;
      while (!existsSync(readyPath)) {
        if (Date.now() >= readyDeadline) throw new Error("effect lock holder did not start");
        await Bun.sleep(5);
      }
      const startedAt = Date.now();
      const first = await executeLoopshipAfn(adapters, { action }, identity);
      const elapsed = Date.now() - startedAt;
      expect(await holder.exited).toBe(0);
      holder = null;
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(existsSync(lockPath)).toBe(true);

      const crashedReadyPath = join(fixture.root, "effect-lock-crashed-ready");
      const crashedHolder = Bun.spawn({
        cmd: [
          process.execPath,
          "--no-install",
          "-e",
          `
            import { writeFileSync } from "node:fs";
            import { acquireCrashSafeFileLock } from ${JSON.stringify(pathToFileURL(resolve(process.cwd(), "scripts", "loopship_utils.ts")).href)};
            const release = acquireCrashSafeFileLock(${JSON.stringify(lockPath)}, 5_000);
            writeFileSync(${JSON.stringify(crashedReadyPath)}, "ready\\n");
            await Bun.sleep(30_000);
            release();
          `,
        ],
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const crashedReadyDeadline = Date.now() + 5_000;
      while (!existsSync(crashedReadyPath)) {
        if (Date.now() >= crashedReadyDeadline) throw new Error("crashed effect lock holder did not start");
        await Bun.sleep(5);
      }
      crashedHolder.kill("SIGKILL");
      expect(await crashedHolder.exited).not.toBe(0);

      const criticalSectionLog = join(fixture.root, "effect-lock-critical-sections.log");
      const spawnContender = (id: string) => Bun.spawn({
        cmd: [
          process.execPath,
          "--no-install",
          "-e",
          `
            import { appendFileSync } from "node:fs";
            import { acquireCrashSafeFileLock } from ${JSON.stringify(pathToFileURL(resolve(process.cwd(), "scripts", "loopship_utils.ts")).href)};
            const release = acquireCrashSafeFileLock(${JSON.stringify(lockPath)}, 5_000);
            appendFileSync(${JSON.stringify(criticalSectionLog)}, ${JSON.stringify(id)} + ":start\\n");
            await Bun.sleep(75);
            appendFileSync(${JSON.stringify(criticalSectionLog)}, ${JSON.stringify(id)} + ":end\\n");
            release();
          `,
        ],
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const contenders = [spawnContender("a"), spawnContender("b")];
      expect(await Promise.all(contenders.map((child) => child.exited))).toEqual([0, 0]);
      expect(readFileSync(criticalSectionLog, "utf8").trim().split("\n")).toSatisfy(
        (lines: string[]) =>
          JSON.stringify(lines) === JSON.stringify(["a:start", "a:end", "b:start", "b:end"]) ||
          JSON.stringify(lines) === JSON.stringify(["b:start", "b:end", "a:start", "a:end"]),
      );

      expect(await executeLoopshipAfn(adapters, { action }, identity)).toEqual(first);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      holder?.kill();
      if (holder) await holder.exited;
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("composes generic Loopship transition result envelopes", async () => {
    const adapters = createLoopshipFastflowAdapters();
    const result = await executeLoopshipAfn(adapters, {
      action: {
        call: LOOPSHIP_AFN_CALLS.flowComposeTransitionResult,
        with: {
          body: {
            schema_version: "loopship.stage-result.build/v1",
            flow_id: "support",
            stage_before: "triage",
            stage_after: "review",
            transition: "submitted",
            step: "intake",
            step_workflow_task: "stage_triage",
            step_payload: { status: "ok" },
            step_action: { status: "ok" },
            state_patch: { stage: "review" },
            events: [{ event: "intake_submitted", ticket_count: 3 }],
            runtime: { tasks: { stage: "triage" } },
          },
        },
      },
    });
    expect(result).toMatchObject({
      schema_version: "loopship.stage-result/v1",
      flow_id: "support",
      stage_before: "triage",
      stage_after: "review",
      transition: "submitted",
      step: "intake",
      step_workflow_task: "stage_triage",
      step_payload: { status: "ok" },
      step_action: { status: "ok" },
      state_patch: { stage: "review" },
      event_payload: {
        event: "stage_changed",
        stage: "review",
        transition: "submitted",
        step: "intake",
        stage_before: "triage",
        stage_after: "review",
      },
      runtime: { tasks: { stage: "triage" } },
    });
    expect(result.events).toEqual([
      {
        schema_version: "1.0.0",
        payload: {
          event: "intake_submitted",
          ticket_count: 3,
          transition: "submitted",
          step: "intake",
          stage_before: "triage",
          stage_after: "review",
        },
      },
      {
        schema_version: "1.0.0",
        payload: {
          event: "stage_changed",
          stage: "review",
          transition: "submitted",
          step: "intake",
          stage_before: "triage",
          stage_after: "review",
        },
      },
    ]);
  });

  test("verifies generic transition result composition inputs without inline JS checks", async () => {
    const adapters = createLoopshipFastflowAdapters();
    const result = await executeLoopshipAfn(adapters, {
      phase: "verification",
      action: {
        call: LOOPSHIP_AFN_CALLS.flowComposeTransitionResult,
        with: {
          body: {
            schema_version: "loopship.stage-result.build/v1",
            flow_id: "support",
            stage_before: "triage",
            stage_after: "review",
            transition: "submitted",
            step: "intake",
            step_workflow_task: "stage_triage",
            step_payload: {},
            step_action: {},
            state_patch: { stage: "review" },
            events: [{ event: "intake_submitted" }],
            runtime: {},
            as_check: true,
          },
        },
      },
    });
    expect(result).toEqual({
      ok: true,
      evidence: {
        schema_version: "loopship.stage-result/v1",
        flow_id: "support",
        stage_before: "triage",
        stage_after: "review",
        transition: "submitted",
        event_count: 2,
      },
    });
  });

  test("hook rejects legacy flattened decision payloads", () => {
    expect(() => nativeResumeRequest({
        sessionId: "session-123",
        nonce: "nonce-123",
        workspaceRoot: "/tmp/demo",
        decision: { approved: true },
      })).toThrow(/response envelope/u);
  });

  test("resume rejects removed compatibility wrappers", () => {
    for (const wrapper of ["fastflow", "resume"]) {
      expect(() =>
        nativeResumeRequest({
          [wrapper]: {
            sessionId: "session-123",
            nonce: "nonce-123",
            workspaceRoot: "/tmp/demo",
            response: { decision: "ok" },
          },
        }),
      ).toThrow(/compatibility wrappers are unsupported/u);
    }
  });

  test("stepper rejects legacy flattened handoff decisions", () => {
    expect(() => nativeStepperResumeRequest({
        sessionId: "session-123",
        nonce: "nonce-123",
        workspaceRoot: "/tmp/demo",
        decision: { system_update: { schema_version: 1, mode: "no_change", summary: "Covered." } },
      })).toThrow(/response envelope/u);
  });

  test("stepper prefers submitted supervisor decisions over nextCall templates", () => {
    expect(
      nativeStepperResumeRequest({
        schemaVersion: "fastflow/interaction-response/v1",
        kind: "supervisor_review",
        nextCall: {
          args: {
            sessionId: "session-123",
            nonce: "nonce-123",
            workspaceRoot: "/tmp/demo",
            response: { decision: "ok" },
          },
        },
        response: { decision: "ok" },
      }),
    ).toEqual({
      sessionId: "session-123",
      nonce: "nonce-123",
      workspaceRoot: "/tmp/demo",
      response: { decision: "ok" },
    });
  });

  test("resume hard cut requires nonce and exact response envelopes", () => {
    expect(() => nativeResumeRequest({
      sessionId: "session-123",
      response: { answer: { approved: true } },
    })).toThrow(/nonce/u);
    expect(() => nativeResumeRequest({
      sessionId: "session-123",
      nonce: "nonce-123",
      response: { answer: {}, decision: "ok" },
    })).toThrow(/exactly one/u);
    expect(() => nativeResumeRequest({
      sessionId: "session-123",
      nonce: "nonce-123",
      response: { decision: "rerun_full" },
    })).toThrow(/must be 'ok'/u);
  });

  test("hook prefers submitted handoff answers over nextCall templates", () => {
    expect(
      nativeResumeRequest({
        schemaVersion: "fastflow/interaction-response/v1",
        kind: "handoff_answer",
        nextCall: {
          args: {
            sessionId: "session-123",
            nonce: "nonce-123",
            workspaceRoot: "/tmp/demo",
            response: { answer: "{{answer}}" },
          },
        },
        response: {
          answer: {
            approved: true,
          },
        },
      }),
    ).toEqual({
      sessionId: "session-123",
      nonce: "nonce-123",
      workspaceRoot: "/tmp/demo",
      response: {
        answer: {
          approved: true,
        },
      },
    });
  });

  test("stepper prefers submitted HITL handoff answers over nextCall templates", () => {
    expect(
      nativeStepperResumeRequest({
        schemaVersion: "fastflow/interaction-response/v1",
        kind: "handoff_answer",
        context: {
          request: {
            reason: "hitl.review",
            stepId: "stage_questions_pending",
          },
        },
        nextCall: {
          args: {
            sessionId: "session-123",
            nonce: "nonce-123",
            workspaceRoot: "/tmp/demo",
            response: { answer: "{{answer}}" },
          },
        },
        response: {
          answer: {
            status: "passed",
            acceptance_trace: [
              {
                acceptance: "Browser smoke passes.",
                status: "passed",
              },
            ],
            risks: [],
          },
        },
      }),
    ).toEqual({
      sessionId: "session-123",
      nonce: "nonce-123",
      workspaceRoot: "/tmp/demo",
      response: {
        answer: {
          status: "passed",
          acceptance_trace: [
            {
              acceptance: "Browser smoke passes.",
              status: "passed",
            },
          ],
          risks: [],
        },
      },
    });
  });

  test("doctor fix excludes generated Codex hook config from git status", () => {
    const fixture = createGitFixture("loopship-native-codex-hook-exclude-");
    try {
      const proc = runLoopshipCli(fixture.repo, [
        "doctor",
        "--repo",
        fixture.repo,
        "--runtime",
        "codex",
        "--fix",
      ]);
      expect(proc.status, proc.stderr || proc.stdout).toBe(0);
      expect(existsSync(join(fixture.root, "bin", "loopship"))).toBe(true);
      const init = runLoopshipCli(fixture.repo, [
        "init",
        "--repo",
        fixture.repo,
        "--runtime",
        "codex",
      ]);
      expect(init.status, init.stderr || init.stdout).toBe(0);
      const installedSkill = readFileSync(
        join(fixture.root, "home", ".agents", "skills", "loopship", "SKILL.md"),
        "utf8",
      );
      expect(installedSkill).toContain("loopship init");
      expect(installedSkill).not.toContain("/Volumes/Projects/");
      expect(existsSync(join(fixture.repo, ".codex", "hooks.json"))).toBe(true);
      expect(runGit(fixture.repo, ["check-ignore", ".codex/hooks.json"])).toBe(
        ".codex/hooks.json",
      );
      expect(runGit(fixture.repo, ["status", "--short", "--untracked-files=all"])).toBe(
        "",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects unknown CLI arguments and missing option values", () => {
    const fixture = createGitFixture("loopship-native-cli-args-");
    try {
      const unknownDoctor = runLoopshipCli(fixture.repo, ["doctor", "--fex"]);
      expect(unknownDoctor.status).toBe(1);
      expect(unknownDoctor.stderr).toContain("unknown doctor argument: --fex");

      const missingRepo = runLoopshipCli(fixture.repo, ["doctor", "--repo"]);
      expect(missingRepo.status).toBe(1);
      expect(missingRepo.stderr).toContain("--repo requires a value");

      const emptyRepo = runLoopshipCli(fixture.repo, ["doctor", "--repo="]);
      expect(emptyRepo.status).toBe(1);
      expect(emptyRepo.stderr).toContain("--repo requires a value");

      const unknownResume = runLoopshipCli(fixture.repo, ["resume", "--fex"]);
      expect(unknownResume.status).toBe(1);
      expect(unknownResume.stderr).toContain("unknown resume argument: --fex");

      const ambiguousResume = runLoopshipCli(fixture.repo, [
        "resume",
        "--wtree",
        "task",
        "--json",
        "{}",
      ]);
      expect(ambiguousResume.status).toBe(1);
      expect(ambiguousResume.stderr).toContain(
        "loopship resume accepts either --wtree or --json, not both",
      );

      const strayStepper = runLoopshipCli(fixture.repo, [
        "stepper",
        "step",
        "unexpected",
      ]);
      expect(strayStepper.status).toBe(1);
      expect(strayStepper.stderr).toContain("unknown stepper argument: unexpected");

      const emptyStepperInitRepo = runLoopshipCli(fixture.repo, [
        "stepper",
        "init",
        "loopship: test",
        "--repo=",
      ]);
      expect(emptyStepperInitRepo.status).toBe(1);
      expect(emptyStepperInitRepo.stderr).toContain("--repo requires a value");

      const arrayHookPayload = runLoopshipCli(fixture.repo, [
        "hook",
        "--json",
        "[]",
      ]);
      expect(arrayHookPayload.status).toBe(1);
      expect(arrayHookPayload.stderr).toContain("hook requires a JSON object payload");

      const missingHandbookRepo = runLoopshipCli(fixture.repo, [
        "handbook",
        "--repo",
      ]);
      expect(missingHandbookRepo.status).toBe(1);
      expect(missingHandbookRepo.stderr).toContain("--repo requires a value");

      const invalidHandbookMinimum = runLoopshipCli(fixture.repo, [
        "handbook",
        "--duplicates",
        "--min-chars=0",
      ]);
      expect(invalidHandbookMinimum.status).toBe(1);
      expect(invalidHandbookMinimum.stderr).toContain(
        "--min-chars must be a positive integer",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("init refuses an already initialized quest worktree with resume guidance", () => {
    const fixture = createGitFixture("loopship-native-init-resume-guard-");
    try {
      createNativeQuest(fixture.repo, "resume-guard");
      const proc = runLoopshipCli(fixture.repo, [
        "init",
        "loopship: continue existing work",
        "--repo",
        fixture.repo,
        "--wtree",
        "resume-guard",
        "--runtime",
        "codex",
      ]);
      expect(proc.status).not.toBe(0);
      expect(proc.stderr).toContain("loopship init refused");
      expect(proc.stderr).toContain("already initialized");
      expect(proc.stderr).toContain(
        `loopship resume --repo ${fixture.repo} --wtree resume-guard`,
      );
      expect(proc.stderr).toContain("response.answer");
      expect(proc.stderr).toContain("sessionId, nonce, workspaceRoot");
      expect(proc.stderr).toContain("loopship stepper step --json @-");
      expect(proc.stderr).toContain("--json @-");
      expect(proc.stderr).toContain("loopship hook --repo");
      expect(proc.stderr).not.toContain("loopship stepper step --repo");
      expect(proc.stderr).toContain("pause-response-with-answer.json");
      expect(proc.stderr).toContain("pause-response-with-decision.json");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("resume recovers the canonical Native execution after a daemon restart", async () => {
    const fixture = createGitFixture("loopship-native-resume-canonical-");
    const schedulerDb = join(fixture.root, "scheduler", "native-v1.sqlite");
    let scheduler: LoopshipTestScheduler | null = null;
    try {
      scheduler = await startLoopshipTestScheduler({
        dbPath: schedulerDb,
        home: resolve(fixture.repo, "..", "home"),
      });
      const started = await startQuestStage(
        fixture.repo,
        "loopship: resume canonical native execution",
        "resume-canonical",
        [],
        scheduler.env,
      );
      const startedPause = interactionPause(started);
      expect(startedPause).not.toBeNull();
      expect(startedPause?.sessionId).toMatch(/^loopship-[0-9a-f]{64}$/);

      await scheduler.stop();
      scheduler = await startLoopshipTestScheduler({
        dbPath: schedulerDb,
        home: resolve(fixture.repo, "..", "home"),
      });

      const proc = runLoopshipCli(
        fixture.repo,
        [
          "resume",
          "--repo",
          fixture.repo,
          "--wtree",
          "resume-canonical",
        ],
        undefined,
        scheduler.env,
      );
      expect(proc.status, proc.stderr || proc.stdout).toBe(0);
      const result = parseJsonObject(proc.stdout, "resume result");
      const recoveredPause = interactionPause(result);
      expect(recoveredPause, JSON.stringify(result)).not.toBeNull();
      expect(recoveredPause?.sessionId).toBe(startedPause?.sessionId);
      const tasks = parseTasksYaml(
        readFileSync(
          join(
            fixture.repo,
            "worktrees",
            "resume-canonical",
            ".loopship",
            "runtime",
            "tasks.yaml",
          ),
          "utf8",
        ),
      );
      expect(tasks.stage).toBe("initial");
      expect(existsSync(schedulerDb)).toBe(true);
    } finally {
      await scheduler?.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 120_000);
  test(
    "records the actual coordinator branch when source branch differs",
    async () => {
      const fixture = createGitFixture("loopship-native-source-branch-state-");
      try {
        const wtree = "source-branch-state";
        await startQuestStage(fixture.repo, "loopship: build demo", wtree, [
          "--source-branch",
          "main",
        ]);
        const workspace = join(fixture.repo, "worktrees", wtree);
        expect(runGit(workspace, ["branch", "--show-current"])).toBe(wtree);
        const tasks = parseTasksYaml(
          readFileSync(join(workspace, ".loopship", "runtime", "tasks.yaml"), "utf8"),
        );
        expect(tasks.schema_version).toBe(4);
        expect(tasks.coordinator_branch).toBe(wtree);
        expect(tasks.landing_target_branch).toBe("main");
        expect(existsSync(join(workspace, ".loopship", "runtime", "manifest.yaml"))).toBe(
          true,
        );
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    { timeout: 120_000 },
  );

  test("native runtime facade does not hardcode workflow step identifiers", () => {
    const files = [
      "scripts/loopship.ts",
      "scripts/loopship_stepper.ts",
      "scripts/loopship_fastflow.ts",
      "scripts/loopship_cmdproto.ts",
    ];
    const banned = [
      "withGuidedEnvelope",
      "currentFlowStepId",
      "currentQuestions",
      "derive_transition",
      "statePatchForPayload",
      "swe",
      "plan",
      "questions",
      "archived",
      "executing",
      "planning",
      "plan_review",
      "awaiting_user_answers",
      "task_graph",
      "landing_ready",
    ];
    for (const file of files) {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      for (const token of banned) {
        expect(text, `${file} must not contain ${token}`).not.toMatch(
          new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
        );
      }
    }
  });

  test("SWE flow uses native SWF branches instead of embedded transition interpreter", () => {
    const text = readFileSync(
      join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "flows", "swe.stable.yaml"),
      "utf8",
    );
    for (const token of [
      "compute_stage_result",
      "stageTaskNames",
      "inputStepByStage",
      "defaultTransitionKey",
      "transitionKey(",
      "buildStagePatch",
      "domainEventForPayload",
      "state.steps.compute_stage_result",
    ]) {
      expect(text, `SWE flow must not contain ${token}`).not.toContain(token);
    }
    expect(text).toContain("switch:");
    expect(text).toContain("stage_result_planning");
    expect(text).toContain("fastflow.afn.data.document.patch");
    expect(text).toContain("fastflow.afn.data.event-log.append");
  });

  test("SWE cleanup is a post-persist flow AFN, not an archived step command", () => {
    const flowPath = join(
      process.cwd(),
      "call-catalog",
      "loopship",
      "workflow",
      "service",
      "flows",
      "swe.stable.yaml",
    );
    const stepPath = join(
      process.cwd(),
      "call-catalog",
      "loopship",
      "workflow",
      "service",
      "step",
      "archived.stable.yaml",
    );
    const cliPath = join(process.cwd(), "scripts", "loopship.ts");
    const readmePath = join(process.cwd(), "README.md");
    const flowText = readFileSync(flowPath, "utf8");
    const archivedText = readFileSync(stepPath, "utf8");
    const cliText = readFileSync(cliPath, "utf8");
    const readmeText = readFileSync(readmePath, "utf8");
    const appendIndex = flowText.indexOf("- append_stage_event:");
    const cleanupIndex = flowText.indexOf("- cleanup_landed_worktrees:");

    expect(appendIndex).toBeGreaterThan(0);
    expect(cleanupIndex).toBeGreaterThan(appendIndex);
    expect(flowText).toContain("then: continue_or_stop");
    expect(flowText).toContain("- persist_stage:\n      then: append_stage_event");
    expect(flowText).toContain("- continue_or_stop:");
    expect(flowText).toContain("then: stage_failure_repair_handoff");
    expect(flowText).toContain("inference: loopship_failure_repair");
    expect(flowText).toContain("const: aitl.subagent");
    expect(flowText).toContain("then: select_stage_result");
    expect(flowText).toContain("- select_stage_result:");
    expect(flowText).toContain("state.steps.select_stage_result?.action");
    expect(flowText).toContain("then: read_tasks");
    expect(flowText).toContain("then: cleanup_landed_worktrees");
    expect(flowText).toContain("if: \"${String(state.steps.build_stage_result?.action?.stage_after || '') === 'archived'}\"");
    expect(flowText).toContain("call: loopship.afn.service.landing.cleanup-landed-worktrees");
    expect(flowText).toContain("step_workflow_task: cleanup_landed_worktrees");
    expect(flowText).not.toContain("const archived = String(state.steps.build_stage_result?.action?.stage_after");
    expect(archivedText).not.toContain('args: ["cleanup"');
    expect(archivedText).not.toContain("safe_after_archive");
    expect(cliText).not.toContain('| \"cleanup\"');
    expect(cliText).not.toContain("runCleanup");
    expect(readmeText).not.toContain("loopship cleanup");
  });

  test("SWE stage call tasks are routed only by route_stage", () => {
    const text = readFileSync(
      join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "flows", "swe.stable.yaml"),
      "utf8",
    );
    for (const stage of [
      "stage_planning",
      "stage_awaiting_user_answers",
      "stage_plan_review",
      "stage_task_graph_ready",
      "stage_executing",
      "stage_validating",
      "stage_verification_pending",
      "stage_system_update_pending",
      "stage_landing_ready",
      "stage_replanning",
      "stage_archived",
      "stage_planning_terminal_child",
    ]) {
      const match = text.match(new RegExp(`  - ${stage}:\\n([\\s\\S]*?)(?=\\n  - |\\noutput:)`));
      expect(match?.[1] ?? "", `${stage} must execute after route_stage selects it`).not.toContain(
        "\n      if:",
      );
    }
  });

  test("planning route keeps terminal child quests as deterministic local leaf work", () => {
    const workflow = loadYamlWorkflow(
      join(
        process.cwd(),
        "call-catalog",
        "loopship",
        "workflow",
        "service",
        "flows",
        "swe.stable.yaml",
      ),
    );
    const text = readFileSync(
      join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "flows", "swe.stable.yaml"),
      "utf8",
    );
    const terminalRoute = text.indexOf("- planning_terminal_child:");
    const genericRoute = text.indexOf("- planning:", terminalRoute + 1);
    const terminalTask = workflowTaskDefinition(workflow, "stage_planning_terminal_child");
    const taskText = JSON.stringify(terminalTask);

    expect(terminalRoute).toBeGreaterThan(0);
    expect(genericRoute).toBeGreaterThan(terminalRoute);
    expect(text).toContain("then: stage_planning_terminal_child");
    expect(taskText).toContain("Terminal child quests are already leaf assignments");
    expect(taskText).not.toContain("loopship.workflow.service.step.plan");
  });

  test("terminal child planning result normalizes to one local pending task", () => {
    const workflow = loadYamlWorkflow(
      join(
        process.cwd(),
        "call-catalog",
        "loopship",
        "workflow",
        "service",
        "flows",
        "swe.stable.yaml",
      ),
    );
    const task = workflowTaskDefinition(workflow, "stage_result_planning");
    const readTasks = {
      wtree: "support-r1-t007",
      prompt:
        "loopship: execute child task t007: Wire fullstack integration, browser smoke tests, and local run documentation.",
      parent_wtree: "support-r1",
      parent_task_id: "t007",
      parent_context_ref: "/repo/worktrees/support-r1/.loopship/runtime/tasks.yaml",
      coordinator_branch: "codex/support-r1-t007",
      coordinator_worktree: "/repo/worktrees/support-r1-t007",
      landing_target_branch: "support-r1",
      tasks: [],
      question_rounds: [],
    };
    const result = executeWorkflowTaskScript(task, {
      steps: {
        resolve_stage: {
          action: {
            runtime: {
              tasks: readTasks,
              manifest: null,
              events: [],
            },
          },
        },
        query_events: { action: [] },
        read_tasks: { action: readTasks },
        stage_planning_terminal_child: {
          action: {
            classification: "terminal_child",
            scope:
              "execute child task t007: Wire fullstack integration, browser smoke tests, and local run documentation.",
            summary:
              "execute child task t007: Wire fullstack integration, browser smoke tests, and local run documentation.",
            assumptions: ["Parent coordinator planning already defined the task boundary."],
            constraints: ["Implement only the assigned parent task in the current child worktree."],
            defaulted_unknowns: [
              "Terminal child planning is derived from parent task metadata instead of re-asking product scope questions.",
            ],
            high_impact_unknowns: [],
            system_context: {
              relevant_object_refs: [],
              relevant_assertion_refs: [],
              relevant_resource_refs: ["/repo/worktrees/support-r1/.loopship/runtime/tasks.yaml"],
              relevant_memory_refs: [],
              durable_implications: [
                {
                  kind: "terminal_child",
                  statement: "This quest is a leaf worker for an already-planned parent task.",
                },
              ],
            },
            verification_targets: [
              "Assigned child task has local commits in the child worktree before validation.",
            ],
            decomposition_rationale:
              "Terminal child quests are already leaf assignments, so the smallest executable task graph is one local task.",
            task_graph: {
              tasks: [
                {
                  id: "t007",
                  title:
                    "execute child task t007: Wire fullstack integration, browser smoke tests, and local run documentation.",
                  type: "coding",
                  status: "pending",
                  dependencies: [],
                  context_refs: ["/repo/worktrees/support-r1/.loopship/runtime/tasks.yaml"],
                  acceptance: [
                    "Implement only the assigned parent task in the current child worktree.",
                  ],
                },
              ],
            },
          },
        },
      },
    });

    expect(result).toMatchObject({
      stage_after: "plan_review",
      transition: "planned",
      step_workflow_task: "stage_planning_terminal_child",
    });
    expect(result.state_patch).toMatchObject({
      stage: "plan_review",
      tasks: [
        {
          id: "t007",
          status: "pending",
          child_wtree: "",
          branch_ref: "codex/support-r1-t007",
          worktree_path: "/repo/worktrees/support-r1-t007",
          merge_target: "support-r1",
        },
      ],
    });
  });

  test("SWE executing route handles leaf child quests before child-result reconciliation", () => {
    const text = readFileSync(
      join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "flows", "swe.stable.yaml"),
      "utf8",
    );
    const leafRoute = text.indexOf("- executing_leaf:");
    const parentRoute = text.indexOf("- executing:", leafRoute + 1);

    expect(leafRoute).toBeGreaterThan(0);
    expect(parentRoute).toBeGreaterThan(leafRoute);
    expect(text).toContain("- task_graph_ready_leaf:");
    expect(text).toContain("then: stage_leaf_git_head");
    expect(text).toContain("- stage_leaf_target_git_head:");
    expect(text).toContain("then: stage_leaf_execution_route");
    expect(text).toContain("- stage_leaf_native_implementation:");
    expect(text).toContain("inference: loopship_child_implementation");
    expect(text).toContain("- stage_leaf_git_head_after_native:");
    expect(text).toContain("- stage_leaf_target_git_head_after_native:");
    expect(text).toContain("call: loopship.afn.service.git.resolve-commit");
    expect(text).toContain("leaf_execution_recorded");
    expect(text).toContain("actionCommit(\"stage_leaf_git_head_after_native\") || actionCommit(\"stage_leaf_git_head\")");
    expect(text).toContain("actionCommit(\"stage_leaf_target_git_head_after_native\") || actionCommit(\"stage_leaf_target_git_head\")");
    expect(text).toContain("stage_result_leaf_executing?.action || state.steps.stage_result_executing?.action");
  });

  test("planning prompts require recursive parallel decomposition for broad systems", () => {
    const stepRoot = join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "step");
    const planText = readFileSync(join(stepRoot, "plan.stable.yaml"), "utf8");
    const taskGraphText = readFileSync(join(stepRoot, "task-graph.stable.yaml"), "utf8");

    expect(planText).toContain("recursively decomposed task graph");
    expect(planText).toContain("smallest independently ownable unit tasks");
    expect(planText).toContain("all ready siblings can run");
    expect(taskGraphText).toContain("recursively");
    expect(taskGraphText).toContain("smallest independently ownable unit tasks");
    expect(taskGraphText).toContain("Reject broad feature-bundle tasks");
  });

  test("plan schema accepts decomposition rationale for planned task graphs", () => {
    const planned = {
      classification: "feature",
      scope: "Add a focused workflow improvement.",
      summary: "A focused workflow improvement is ready to execute.",
      system_context: {
        relevant_object_refs: [],
        relevant_assertion_refs: [],
        relevant_resource_refs: [],
        relevant_memory_refs: [],
        durable_implications: [],
      },
      verification_targets: ["Run the focused workflow regression."],
      decomposition_rationale:
        "The graph has one independently ownable task because the change is scoped to one workflow boundary.",
      questions: [],
      task_graph: {
        tasks: [
          {
            id: "t001",
            title: "Add the focused workflow improvement",
            type: "coding",
            status: "pending",
            dependencies: [],
            acceptance: ["The focused workflow regression passes."],
          },
        ],
      },
    };

    expect(validateV3Input(planned, "plan-input")).toEqual([]);

    const withoutRationale = { ...planned };
    delete (withoutRationale as Record<string, unknown>).decomposition_rationale;
    expect(validateV3Input(withoutRationale, "plan-input").join("\n")).toContain(
      "/decomposition_rationale",
    );
  });

  test("keeps child assignment keys compact and deterministic", () => {
    const longParent =
      "build-a-small-feature-that-intentionally-decomposes-into-frontend-and-backend-child-tasks";
    const first = taskAssignmentChildWtree(longParent, "T001");
    const second = taskAssignmentChildWtree(longParent, "T002");

    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(72);
    expect(second.length).toBeLessThanOrEqual(72);
    expect(first).toMatch(/-T001-[0-9a-f]{12}$/);
    expect(second).toMatch(/-T002-[0-9a-f]{12}$/);
  });

  test("loads the compact Loopship call catalog", async () => {
    expect(existsSync(join(resolveFastflowRoot(), "src", "catalog.mjs"))).toBe(true);
    const output = runNodeCheck(
      `
        import { validateCallCatalogRoot } from ${JSON.stringify(fastflowImport("root"))};
        const result = await validateCallCatalogRoot(process.argv[2]);
        if (!result.ok || result.calls !== 18) {
          throw new Error(JSON.stringify(result));
        }
        console.log(JSON.stringify(result));
      `,
      [LOOPSHIP_CALL_CATALOG_ROOT],
    );
    expect(JSON.parse(output).calls).toBe(18);
  });

  test("keeps static AFN call catalog descriptors in parity with adapter descriptors", async () => {
    const adapters = createLoopshipFastflowAdapters();
    for (const descriptor of LOOPSHIP_AFN_DESCRIPTORS) {
      const callId = parseCallId(descriptor.call);
      const catalogPath = join(
        LOOPSHIP_CALL_CATALOG_ROOT,
        callId.registry,
        callId.kind,
        callId.target,
        callId.scope,
        "index.yaml",
      );
      const catalog = parseYaml(readFileSync(catalogPath, "utf8")) as any;
      expect(catalog.schemaVersion).toBe("fastflow/call-catalog-scope/v2");
      expect(
        catalog.calls.filter((entry: Record<string, unknown>) => entry.call === descriptor.call),
      ).toHaveLength(1);
      const { tags: _tags, ...descriptorWithoutTags } = descriptor as unknown as Record<string, unknown>;
      expect(catalog.calls.find((entry: Record<string, unknown>) => entry.call === descriptor.call)).toEqual(
        descriptorWithoutTags,
      );
      expect(
        (adapters.resolveCallDescriptor as Function)({ call: descriptor.call }),
      ).toEqual(descriptor);
    }
  });

  test("creates Fastflow-compatible Loopship consumer adapters", async () => {
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE).toMatchObject({
      id: "loopship-supervisor",
      ref: "README.md#mocked-runtime-lifecycle-stepping",
    });
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).toContain("native Fastflow decision");
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).toContain("terminal child quests");
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).toContain("run emitted child commands for real");
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).toContain("configured native CLI routes with AITL fallback");
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).toContain("implementation receipts");
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).toContain("canonical Loopship runtime");
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).toContain("safe clarification prompts");
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).toContain(
      "instead of inventing replacement planner clarification payloads",
    );
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).not.toContain("target-app child implementation");
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).not.toContain("promotion-managed release artifacts");
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).not.toContain("*.stable.yaml workflows");
    expect("command" in LOOPSHIP_SUPERVISOR_GUIDANCE).toBe(false);
    const adapters = createLoopshipFastflowAdapters();
    expect(adapters.adapterIdentity).toBe("@omar391/loopship");
    const descriptor = await (adapters.resolveCallDescriptor as Function)({
      call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
    });
    expect(descriptor.call).toBe(LOOPSHIP_AFN_CALLS.childPrepareWorktree);
    await expect(
      (adapters.auditAfn as Function)({
        action: {
          call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
          with: { body: { repo: "/tmp/repo", wtree: "demo", dry_run: true } },
        },
      }),
    ).resolves.toMatchObject({
      schemaVersion: "fastflow.audit.proposal/v1",
      audited: true,
      call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
    });
    const dryRunChild = await executeLoopshipAfn(adapters, {
      action: {
        call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
        with: { body: { repo: "/tmp/repo", wtree: "demo", dry_run: true } },
      },
    });
    expect(dryRunChild).toMatchObject({
      schema_version: "loopship.child.prepare/v1",
      parent_wtree: "demo",
      parent_context_ref: "/tmp/repo/worktrees/demo/.loopship/runtime/tasks.yaml",
      actions: {
        init: { cmd: "loopship" },
      },
    });
    const dryRunActions = dryRunChild.actions!;
    expect(dryRunActions.init.args.join(" ")).toContain(
      "/tmp/repo/worktrees/demo/.loopship/runtime/tasks.yaml",
    );
    expect(dryRunActions.init.args).toContain("--source-branch");
    expect(dryRunActions.init.args).toContain(dryRunChild.branch_ref!);
    expect(dryRunActions.init.args).toContain("--repo");
    expect(dryRunActions.init.args).toContain("/tmp/repo");
    expect(dryRunActions.init.args).toContain("--parent-wtree");
    expect(dryRunActions.init.args).toContain("demo");
    expect(dryRunActions.init.args).toContain("--target-branch");
    expect(dryRunActions.init.args).toContain("--target-worktree");
    expect(dryRunActions.resume).toBeUndefined();
    await expect(
      executeLoopshipAfn(adapters, {
        action: {
          call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
          with: {
            body: {
              repo: "/tmp/repo",
              wtree: "demo",
              dry_run: true,
              children: [
                { id: "task-a", title: "Task A", acceptance: "done" },
                { id: "task-b", title: "Task B", acceptance: "done" },
              ],
            },
          },
        },
      }),
    ).resolves.toMatchObject({
        schema_version: "loopship.child.prepare/v1",
        count: 2,
        prepared_children: [
        {
          task_id: "task-a",
          parent_context_ref: "/tmp/repo/worktrees/demo/.loopship/runtime/tasks.yaml",
          actions: { init: { cmd: "loopship" } },
        },
        {
          task_id: "task-b",
          parent_context_ref: "/tmp/repo/worktrees/demo/.loopship/runtime/tasks.yaml",
          actions: { init: { cmd: "loopship" } },
        },
      ],
    });
  });

  test("binds lifecycle inference steps to registry-backed Codex route groups", () => {
    const stepRoot = join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "step");
    const expected = new Map([
      ["plan", ["loopship_planning", "llm.cli.codex.gpt-5.5.max"]],
      ["task-graph", ["loopship_review", "llm.cli.codex.gpt-5.3-codex-spark.max"]],
      ["child-result", ["loopship_review", "llm.cli.codex.gpt-5.3-codex-spark.max"]],
      ["validation", ["loopship_review", "llm.cli.codex.gpt-5.3-codex-spark.max"]],
      ["verification", ["loopship_review", "llm.cli.codex.gpt-5.3-codex-spark.max"]],
      ["system-update", ["loopship_review", "llm.cli.codex.gpt-5.3-codex-spark.max"]],
    ]);

    for (const [name, [groupName, routeRef]] of expected) {
      const workflow = loadYamlWorkflow(join(stepRoot, `${name}.stable.yaml`));
      const document = workflow.document as Record<string, unknown>;
      const metadata = document.metadata as Record<string, any>;
      const group = metadata?.inference?.groups?.[groupName];
      expect(group, name).toBeTruthy();
      expect(group.try, name).toEqual([routeRef, "aitl.chat"]);
      let stepUsesGroup = false;
      walk(workflow, (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const metadata = (value as Record<string, any>).metadata;
        if (metadata?.inference === groupName) stepUsesGroup = true;
      });
      expect(stepUsesGroup, name).toBe(true);
    }

    const questions = loadYamlWorkflow(join(stepRoot, "questions.stable.yaml"));
    const questionGroup = (questions.document as Record<string, any>).metadata?.inference?.groups?.loopship_planning;
    expect(questionGroup?.try, "questions").toEqual(["hitl.review"]);
    let questionsUseGroup = false;
    walk(questions, (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const metadata = (value as Record<string, any>).metadata;
      if (metadata?.inference === "loopship_planning") questionsUseGroup = true;
    });
    expect(questionsUseGroup, "questions").toBe(true);

    const validationText = readFileSync(join(stepRoot, "validation.stable.yaml"), "utf8");
    expect(validationText).toContain("Set top-level `status` to `failed` only when task acceptance");
    expect(validationText).toContain("environment constraints unrelated to");
    expect(validationText).toContain("do not require the implementation");
    expect(validationText).toContain("the landing step owns merge ancestry");

    const archivedPath = join(stepRoot, "archived.stable.yaml");
    const archivedText = readFileSync(archivedPath, "utf8");
    const archived = loadYamlWorkflow(archivedPath);
    expect((archived.document as Record<string, any>).metadata?.inference).toBeUndefined();
    expect(archivedText).not.toContain('args: ["cleanup"');
    expect(archivedText).not.toContain("safe_after_archive");
    let archivedUsesInference = false;
    let archivedUsesScript = false;
    walk(archived, (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      if ((value as Record<string, any>).call === "fastflow.afn.core.request.input") {
        archivedUsesInference = true;
      }
      if ((value as Record<string, any>).run?.script?.language === "js") {
        archivedUsesScript = true;
      }
    });
    expect(archivedUsesInference).toBe(false);
    expect(archivedUsesScript).toBe(true);
  });

  test("routes terminal-child missing implementation commits through native Codex CLI with AITL fallback", () => {
    const workflow = loadYamlWorkflow(
      join(
        process.cwd(),
        "call-catalog",
        "loopship",
        "workflow",
        "service",
        "flows",
        "swe.stable.yaml",
      ),
    );
    const document = workflow.document as Record<string, any>;
    const group = document.metadata?.inference?.groups?.loopship_child_implementation;
    expect(group?.try).toEqual(["llm.cli.codex.gpt-5.4-mini.max", "aitl.subagent"]);

    const route = workflowTaskDefinition(workflow, "stage_leaf_execution_route") as any;
    expect(route.switch?.[0]?.implementation_missing?.then).toBe("stage_leaf_native_implementation");
    expect(route.switch?.[1]?.local_commit_present?.then).toBe("stage_result_leaf_executing");

    const implementation = workflowTaskDefinition(workflow, "stage_leaf_native_implementation") as any;
    expect(implementation.metadata?.inference).toBe("loopship_child_implementation");
    expect(implementation.metadata?.validation?.post?.kind).toBe("js");
    expect(implementation.metadata?.validation?.post?.expression).toContain("implementation_receipt");
    expect(implementation.metadata?.validation?.post?.expression).not.toContain("ok: true");
    expect(implementation.call).toBe("fastflow.afn.core.request.input");
    expect(implementation.with.body.timeout_ms).toBe(1200000);
    expect(implementation.with.body.instruction).toContain("uncommitted implementation changes");
    expect(implementation.with.body.answer.schema.properties.implementation_receipt.properties.resolver.enum).toEqual(
      ["llm.cli.codex.gpt-5.4-mini.max", "aitl.subagent"],
    );
    expect(implementation.with.body.answer.schema.properties.implementation_receipt.required).toEqual(
      expect.arrayContaining([
        "agent_id",
        "worktree_path",
        "branch_ref",
        "commits",
        "checks",
        "artifacts",
      ]),
    );
  });

  test("rewrites terminal child plans into local execution state", () => {
    const fixture = createGitFixture("loopship-terminal-child-plan-");
    try {
      const childWorkspace = ensureCoordinatorWorkspace(fixture.repo, "child-terminal");
      const parentWorkspace = ensureCoordinatorWorkspace(fixture.repo, "parent");
      const { files, state } = createQuest({
        repoRoot: fixture.repo,
        wtree: "child-terminal",
        prompt: "loopship: execute child task timer-ui: implement the timer UI.",
        resolutionSource: "test",
        workspace: childWorkspace,
        flowId: "swe",
        initialStage: "planning",
        parentWtree: "parent",
        parentTaskId: "timer-ui",
        parentContextRef: join(parentWorkspace.worktree_path, ".loopship", "runtime", "tasks.yaml"),
        landingTargetBranch: "parent",
        landingTargetWorktree: parentWorkspace.worktree_path,
      });

      const planned = applyQuestPlanToTasks(files, state, {
        classification: "feature",
        scope: "Implement the assigned timer UI locally.",
        summary: "Keep the child quest local and land it back into the parent worktree.",
        system_context: {
          relevant_object_refs: [],
          relevant_assertion_refs: [],
          relevant_resource_refs: [],
          relevant_memory_refs: [],
          durable_implications: [],
        },
        verification_targets: ["Timer UI files are updated and committed in the current child worktree."],
        tasks: [
          {
            id: "implement-timer-ui",
            title: "Implement the timer UI locally",
            acceptance: "Timer UI files are updated and committed.",
            child_wtree: "nested-child",
            branch_ref: "codex/nested-child",
            worktree_path: join(fixture.repo, "worktrees", "nested-child"),
            merge_lease_id: "lease-nested-child",
          },
        ],
      });

      expect(planned.tasks).toHaveLength(1);
      expect(planned.tasks[0]).toMatchObject({
        id: "implement-timer-ui",
        status: "pending",
        branch_ref: planned.coordinator_branch,
        worktree_path: planned.coordinator_worktree,
        child_wtree: "",
        merge_target: planned.landing_target_branch,
        merge_lease_id: "",
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects terminal child child.prepare requests before synthesizing nested child worktrees", async () => {
    const fixture = createGitFixture("loopship-terminal-child-prepare-");
    try {
      const adapters = createLoopshipFastflowAdapters();
      await expect(
        executeLoopshipAfn(adapters, {
          action: {
            call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
            with: {
              body: {
                repo: fixture.repo,
                wtree: "child-terminal",
                quest: {
                  prompt: "loopship: execute child task timer-ui: implement the timer UI.",
                  parent_wtree: "parent",
                  parent_task_id: "timer-ui",
                  parent_context_ref: join(
                    fixture.repo,
                    "worktrees",
                    "parent",
                    ".loopship",
                    "runtime",
                    "tasks.yaml",
                  ),
                },
                children: [
                  {
                    id: "nested-child",
                    title: "Nested child work",
                    acceptance: "done",
                    child_wtree: "",
                  },
                ],
              },
            },
          },
        }),
      ).rejects.toThrow("terminal child quests must not prepare child worktrees");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects quest and child workspace paths outside the repository worktrees root", async () => {
    const fixture = createGitFixture("loopship-native-worktree-boundaries-");
    try {
      expect(() => ensureCoordinatorWorkspace(fixture.repo, "../escaped")).toThrow(
        "wtree must use lowercase letters",
      );
      const adapters = createLoopshipFastflowAdapters();
      await expect(
        executeLoopshipAfn(adapters, {
          action: {
            call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
            with: {
              body: {
                repo: fixture.repo,
                wtree: "parent",
                task: {
                  id: "unsafe",
                  branch_ref: "codex/unsafe",
                  worktree_path: join(fixture.root, "escaped-child"),
                },
              },
            },
          },
        }),
      ).rejects.toThrow("task worktree path must stay inside");
      const escapedRoot = join(fixture.root, "escaped-nested-root");
      mkdirSync(escapedRoot, { recursive: true });
      mkdirSync(join(fixture.repo, "worktrees"), { recursive: true });
      symlinkSync(escapedRoot, join(fixture.repo, "worktrees", "nested"), "dir");
      expect(() =>
        ensureTaskWorkspace(
          fixture.repo,
          "codex/nested-escape",
          join(fixture.repo, "worktrees", "nested", "child"),
          "main",
        ),
      ).toThrow("task worktree path must stay inside");
      const realWorkspace = join(fixture.repo, "worktrees", "real-workspace");
      mkdirSync(realWorkspace, { recursive: true });
      const aliasWorkspace = join(fixture.repo, "worktrees", "alias-workspace");
      symlinkSync(realWorkspace, aliasWorkspace, "dir");
      expect(() =>
        ensureTaskWorkspace(fixture.repo, "codex/alias", aliasWorkspace, "main"),
      ).toThrow("task worktree path must resolve to its canonical location");
      expect(() =>
        ensureTaskWorkspace(
          fixture.repo,
          "main",
          join(fixture.repo, "worktrees", "main-copy"),
        ),
      ).toThrow("already checked out outside its requested worktree");
      await expect(
        executeLoopshipAfn(adapters, {
          action: {
            call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
            with: {
              body: {
                repo: fixture.repo,
                wtree: "parent",
                dry_run: true,
                task: {
                  id: "unsafe-branch",
                  branch_ref: "--detach",
                },
              },
            },
          },
        }),
      ).rejects.toThrow("child branch is not a valid Git branch name");
      await expect(
        executeLoopshipAfn(adapters, {
          action: {
            call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
            with: {
              body: {
                repo: fixture.repo,
                wtree: "parent",
                task: {
                  id: "unsafe",
                  branch_ref: "parent",
                },
              },
            },
          },
        }),
      ).rejects.toThrow("child branch must differ from its base branch");
      rmSync(join(fixture.repo, "worktrees"), { recursive: true, force: true });
      symlinkSync(escapedRoot, join(fixture.repo, "worktrees"), "dir");
      expect(() =>
        ensureTaskWorkspace(
          fixture.repo,
          "codex/root-symlink",
          join(fixture.repo, "worktrees", "root-symlink"),
          "main",
        ),
      ).toThrow("repository worktrees root must not be a symlink");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("launches exactly one supervised child at a time and uses stepper init for child runs", async () => {
    const adapters = createLoopshipFastflowAdapters();
    const prepared = await executeLoopshipAfn(adapters, {
      action: {
        call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
        with: {
          body: {
            repo: "/tmp/repo",
            wtree: "demo",
            dry_run: true,
            quest: {
              supervise_step: true,
            },
            children: [
              { id: "task-a", title: "Task A", acceptance: "done" },
              { id: "task-b", title: "Task B", acceptance: "done" },
            ],
          },
        },
      },
    });
    expect(prepared.count).toBe(1);
    expect(prepared.prepared_children!).toHaveLength(1);
    expect(prepared.prepared_children![0]).toMatchObject({
      task_id: "task-a",
      supervise_step: true,
    });
    expect(prepared.actions!.init.args.slice(0, 2)).toEqual(["stepper", "init"]);
  });

  test("records prepared children as dispatched in task_graph_ready state", () => {
    const workflow = loadYamlWorkflow(
      join(
        process.cwd(),
        "call-catalog",
        "loopship",
        "workflow",
        "service",
        "flows",
        "swe.stable.yaml",
      ),
    );
    const task = workflowTaskDefinition(workflow, "stage_result_task_graph_ready");
    const result = executeWorkflowTaskScript(task, {
      steps: {
        resolve_stage: {
          action: {
            runtime: {
              tasks: {},
              manifest: null,
              events: [],
            },
          },
        },
        query_events: { action: [] },
        read_tasks: {
          action: {
            tasks: [
              { id: "task-a", status: "child_received", child_wtree: "root-task-a" },
              { id: "task-b", status: "pending", child_wtree: "root-task-b" },
              { id: "task-c", status: "child_archived", child_wtree: "root-task-c" },
            ],
          },
        },
        stage_task_graph_ready: {
          action: {
            ok: true,
            result: {
              output: {
                prepared_children: [
                  {
                    task_id: "task-a",
                    child_wtree: "root-task-a",
                    branch_ref: "codex/root-task-a",
                    worktree_path: "/tmp/root-task-a",
                    merge_target: "main",
                    merge_lease_id: "lease-root-task-a",
                  },
                  {
                    task_id: "task-b",
                    child_wtree: "root-task-b",
                    branch_ref: "codex/root-task-b",
                    worktree_path: "/tmp/root-task-b",
                    merge_target: "main",
                    merge_lease_id: "lease-root-task-b",
                  },
                ],
              },
            },
          },
        },
      },
    });

    expect(result.stage_after).toBe("executing");
    expect(result.state_patch).toMatchObject({
      stage: "executing",
      tasks: [
        {
          id: "task-a",
          status: "child_dispatched",
          branch_ref: "codex/root-task-a",
          worktree_path: "/tmp/root-task-a",
        },
        {
          id: "task-b",
          status: "child_dispatched",
          branch_ref: "codex/root-task-b",
          worktree_path: "/tmp/root-task-b",
        },
        {
          id: "task-c",
          status: "child_archived",
        },
      ],
    });
  });

  test("system-update stage result counts touched files from workflow output wrappers", () => {
    const workflow = loadYamlWorkflow(
      join(
        process.cwd(),
        "call-catalog",
        "loopship",
        "workflow",
        "service",
        "flows",
        "swe.stable.yaml",
      ),
    );
    const task = workflowTaskDefinition(workflow, "stage_result_system_update_pending");
    const touched = ["/repo/.loopship/system.yaml", "/repo/.loopship/signature.yaml"];
    const result = executeWorkflowTaskScript(task, {
      steps: {
        resolve_stage: {
          action: {
            runtime: {
              tasks: {},
              manifest: null,
              events: [],
            },
          },
        },
        query_events: { action: [] },
        read_tasks: { action: {} },
        stage_system_update_pending: {
          action: {
            ok: true,
            result: {
              output: {
                schema_version: "loopship.system.apply/v1",
                dry_run: false,
                touched,
              },
            },
          },
        },
      },
    });

    expect(result.step_payload).toMatchObject({ touched });
    expect(result.events).toEqual([
      {
        event: "system_update_submitted",
        stage: "landing_ready",
        touched_count: 2,
      },
    ]);
  });

  test("approved empty task graphs replan for coordinator and terminal child quests", () => {
    const workflow = loadYamlWorkflow(
      join(
        process.cwd(),
        "call-catalog",
        "loopship",
        "workflow",
        "service",
        "flows",
        "swe.stable.yaml",
      ),
    );
    const task = workflowTaskDefinition(workflow, "stage_result_plan_review");

    for (const readTasks of [
      {
        prompt: "loopship: build a customer support dashboard",
        tasks: [],
      },
      {
        prompt: "loopship: execute child task dashboard-ui: build the assigned UI",
        parent_wtree: "parent",
        parent_task_id: "dashboard-ui",
        parent_context_ref: "/tmp/repo/worktrees/parent/.loopship/runtime/tasks.yaml",
        tasks: [],
      },
    ]) {
      const result = executeWorkflowTaskScript(task, {
        steps: {
          resolve_stage: {
            action: {
              runtime: {
                tasks: readTasks,
                manifest: null,
                events: [],
              },
            },
          },
          query_events: { action: [] },
          read_tasks: { action: readTasks },
          stage_plan_review: {
            action: {
              decision: { approved: true },
            },
          },
        },
      });

      expect(result.stage_after).toBe("replanning");
      expect(result.transition).toBe("rejected");
      expect(result.state_patch).toMatchObject({
        stage: "replanning",
      });
      expect(String((result.state_patch as Record<string, unknown>).replan_reason || "")).toContain(
        "empty",
      );
    }
  });

  test("explicit task graph rejections replan through handoff wrappers", () => {
    const workflow = loadYamlWorkflow(
      join(
        process.cwd(),
        "call-catalog",
        "loopship",
        "workflow",
        "service",
        "flows",
        "swe.stable.yaml",
      ),
    );
    const task = workflowTaskDefinition(workflow, "stage_result_plan_review");
    const readTasks = {
      prompt: "loopship: create a subscription billing portal",
      tasks: [
        {
          id: "foundation",
          status: "child_received",
        },
      ],
    };

    for (const action of [
      {
        decision: {
          approved: false,
          replan_reason: "split bundled acceptance work",
        },
      },
      {
        answer: {
          approved: false,
          replan_reason: "split bundled acceptance work",
        },
      },
      {
        response: {
          answer: {
            approved: false,
            replan_reason: "split bundled acceptance work",
          },
        },
      },
    ]) {
      const result = executeWorkflowTaskScript(task, {
        steps: {
          resolve_stage: {
            action: {
              runtime: {
                tasks: readTasks,
                manifest: null,
                events: [],
              },
            },
          },
          query_events: { action: [] },
          read_tasks: { action: readTasks },
          stage_plan_review: {
            action,
          },
        },
      });

      expect(result.stage_after).toBe("replanning");
      expect(result.transition).toBe("rejected");
      expect(result.state_patch).toMatchObject({
        stage: "replanning",
        replan_reason: "split bundled acceptance work",
      });
    }
  });

  test("requeues newly unblocked children without redispatching running siblings", () => {
    const workflow = loadYamlWorkflow(
      join(
        process.cwd(),
        "call-catalog",
        "loopship",
        "workflow",
        "service",
        "flows",
        "swe.stable.yaml",
      ),
    );
    const task = workflowTaskDefinition(workflow, "stage_result_executing");
    const sharedState = {
      steps: {
        resolve_stage: {
          action: {
            runtime: {
              tasks: {},
              manifest: null,
              events: [],
            },
          },
        },
        query_events: { action: [] },
        stage_executing: {
          action: {
            task_id: "task-a",
            child_wtree: "root-task-a",
            status: "passed",
            evidence: [{ type: "git_commit", ref: "abc123" }],
            merge_commit: "abc123",
          },
        },
      },
    };

    const supervised = executeWorkflowTaskScript(task, {
      ...sharedState,
      steps: {
        ...sharedState.steps,
        read_tasks: {
          action: {
            supervise_step: true,
            tasks: [
              { id: "task-a", status: "child_dispatched", child_wtree: "root-task-a" },
              {
                id: "task-b",
                status: "child_received",
                dependencies: ["task-a"],
                child_wtree: "root-task-b",
              },
              { id: "task-c", status: "child_dispatched", child_wtree: "root-task-c" },
            ],
            child_results: [],
          },
        },
      },
    });
    expect(supervised.stage_after).toBe("task_graph_ready");
    expect(supervised.transition).toBe("next_child");
    expect(supervised.state_patch).toMatchObject({
      stage: "task_graph_ready",
      tasks: [
        {
          id: "task-a",
          status: "child_archived",
          merge_commit: "abc123",
        },
        {
          id: "task-b",
          status: "child_received",
        },
        {
          id: "task-c",
          status: "child_dispatched",
        },
      ],
    });

    const unsupervised = executeWorkflowTaskScript(task, {
      ...sharedState,
      steps: {
        ...sharedState.steps,
        read_tasks: {
          action: {
            supervise_step: false,
            tasks: [
              { id: "task-a", status: "child_dispatched", child_wtree: "root-task-a" },
              {
                id: "task-b",
                status: "child_received",
                dependencies: ["task-a"],
                child_wtree: "root-task-b",
              },
              { id: "task-c", status: "child_dispatched", child_wtree: "root-task-c" },
            ],
            child_results: [],
          },
        },
      },
    });
    expect(unsupervised.stage_after).toBe("task_graph_ready");
    expect(unsupervised.transition).toBe("next_children");
  });

  test("child-result approval does not validate while pending child tasks remain", () => {
    const workflow = loadYamlWorkflow(
      join(
        process.cwd(),
        "call-catalog",
        "loopship",
        "workflow",
        "service",
        "flows",
        "swe.stable.yaml",
      ),
    );
    const task = workflowTaskDefinition(workflow, "stage_result_executing");
    const result = executeWorkflowTaskScript(task, {
      steps: {
        resolve_stage: {
          action: {
            runtime: {
              tasks: {},
              manifest: null,
              events: [],
            },
          },
        },
        query_events: { action: [] },
        read_tasks: {
          action: {
            tasks: [
              { id: "task-a", status: "child_dispatched", child_wtree: "root-task-a" },
              {
                id: "task-b",
                status: "child_received",
                dependencies: ["task-c"],
                child_wtree: "root-task-b",
              },
            ],
            child_results: [],
          },
        },
        stage_executing: {
          action: {
            task_id: "task-a",
            child_wtree: "root-task-a",
            status: "passed",
            evidence: [{ type: "git_commit", ref: "abc123" }],
            merge_commit: "abc123",
          },
        },
      },
    });

    expect(result.stage_after).toBe("executing");
    expect(result.transition).toBe("partial");
    expect(result.state_patch).toMatchObject({
      stage: "executing",
      tasks: [
        { id: "task-a", status: "child_archived", merge_commit: "abc123" },
        { id: "task-b", status: "child_received" },
      ],
    });
  });

  test("multi-task terminal child execution records one shared local-work receipt", () => {
    const workflow = loadYamlWorkflow(
      join(
        process.cwd(),
        "call-catalog",
        "loopship",
        "workflow",
        "service",
        "flows",
        "swe.stable.yaml",
      ),
    );
    const task = workflowTaskDefinition(workflow, "stage_result_leaf_executing");
    const result = executeWorkflowTaskScript(task, {
      steps: {
        resolve_stage: {
          action: {
            runtime: {
              tasks: {},
              manifest: null,
              events: [],
            },
          },
        },
        query_events: { action: [] },
        read_tasks: {
          action: {
            parent_wtree: "parent",
            parent_task_id: "dashboard",
            parent_context_ref: "/tmp/repo/worktrees/parent/.loopship/runtime/tasks.yaml",
            coordinator_worktree: "/tmp/repo/worktrees/child-terminal",
            tasks: [
              { id: "ui", title: "Build UI", status: "pending", child_wtree: "" },
              { id: "tests", title: "Add tests", status: "done", child_wtree: "", merge_commit: "old" },
            ],
          },
        },
        stage_leaf_git_head: {
          action: {
            commit: "abc123",
          },
        },
        stage_leaf_target_git_head: {
          action: {
            commit: "parent123",
          },
        },
      },
    });

    expect(result.stage_after).toBe("validating");
    expect(JSON.stringify(result)).not.toContain("prepared_children");
    expect(result.state_patch).toMatchObject({
      stage: "validating",
      tasks: [
        { id: "ui", status: "done", merge_commit: "abc123" },
        { id: "tests", status: "done", merge_commit: "abc123" },
      ],
      local_work_receipt: {
        mode: "shared-head-commit",
        worktree_path: "/tmp/repo/worktrees/child-terminal",
        commit: "abc123",
        target_commit: "parent123",
        status: "recorded",
        covered_task_ids: ["ui", "tests"],
        pending_task_ids: [],
      },
    });
    expect(result.step_payload).toMatchObject({
      task_count: 2,
      merge_commit: "abc123",
      local_work_receipt: {
        covered_task_ids: ["ui", "tests"],
        pending_task_ids: [],
      },
    });
  });

  test("terminal child implementation records receipt with fresh local commit", () => {
    const workflow = loadYamlWorkflow(
      join(
        process.cwd(),
        "call-catalog",
        "loopship",
        "workflow",
        "service",
        "flows",
        "swe.stable.yaml",
      ),
    );
    const task = workflowTaskDefinition(workflow, "stage_result_leaf_executing");
    const implementationReceipt = {
      resolver: "llm.cli.codex.gpt-5.4-mini.max",
      agent_id: "codex",
      thread_id: "thread-123",
      worktree_path: "/tmp/repo/worktrees/child-terminal",
      branch_ref: "codex/child-terminal",
      commits: ["abc123"],
      checks: [{ name: "child-smoke", status: "passed" }],
      artifacts: [{ type: "git_commit", ref: "abc123" }],
    };
    const result = executeWorkflowTaskScript(task, {
      steps: {
        resolve_stage: {
          action: {
            runtime: {
              tasks: {},
              manifest: null,
              events: [],
            },
          },
        },
        query_events: { action: [] },
        read_tasks: {
          action: {
            parent_wtree: "parent",
            parent_task_id: "dashboard",
            parent_context_ref: "/tmp/repo/worktrees/parent/.loopship/runtime/tasks.yaml",
            coordinator_worktree: "/tmp/repo/worktrees/child-terminal",
            tasks: [{ id: "ui", title: "Build UI", status: "pending", child_wtree: "" }],
          },
        },
        stage_leaf_git_head: {
          action: {
            commit: "parent123",
          },
        },
        stage_leaf_target_git_head: {
          action: {
            commit: "parent123",
          },
        },
        stage_leaf_native_implementation: {
          action: {
            answer: {
              implementation_receipt: implementationReceipt,
            },
          },
        },
        stage_leaf_git_head_after_native: {
          action: {
            commit: "abc123",
          },
        },
        stage_leaf_target_git_head_after_native: {
          action: {
            commit: "parent123",
          },
        },
      },
    });

    expect(result.stage_after).toBe("validating");
    expect(result.events[0]).toMatchObject({
      event: "leaf_execution_recorded",
      implementation_receipt: true,
    });
    expect(result.state_patch.local_work_receipt).toMatchObject({
      commit: "abc123",
      target_commit: "parent123",
      implementation_receipt: implementationReceipt,
    });
  });

  test("terminal child execution does not complete without a new local commit", () => {
    const workflow = loadYamlWorkflow(
      join(
        process.cwd(),
        "call-catalog",
        "loopship",
        "workflow",
        "service",
        "flows",
        "swe.stable.yaml",
      ),
    );
    const task = workflowTaskDefinition(workflow, "stage_result_leaf_executing");
    const result = executeWorkflowTaskScript(task, {
      steps: {
        resolve_stage: {
          action: {
            runtime: {
              tasks: {},
              manifest: null,
              events: [],
            },
          },
        },
        query_events: { action: [] },
        read_tasks: {
          action: {
            parent_wtree: "parent",
            parent_task_id: "dashboard",
            parent_context_ref: "/tmp/repo/worktrees/parent/.loopship/runtime/tasks.yaml",
            coordinator_worktree: "/tmp/repo/worktrees/child-terminal",
            tasks: [
              { id: "ui", title: "Build UI", status: "pending", child_wtree: "" },
            ],
          },
        },
        stage_leaf_git_head: {
          action: {
            commit: "parent123",
          },
        },
        stage_leaf_target_git_head: {
          action: {
            commit: "parent123",
          },
        },
      },
    });

    expect(result.stage_after).toBe("executing");
    expect(result.transition).toBe("blocked");
    expect(result.state_patch).toMatchObject({
      stage: "executing",
      tasks: [{ id: "ui", status: "pending" }],
      local_work_receipt: {
        mode: "shared-head-commit",
        commit: "parent123",
        target_commit: "parent123",
        status: "missing_local_commit",
        covered_task_ids: [],
        pending_task_ids: ["ui"],
      },
    });
    expect(result.events[0]).toMatchObject({
      event: "leaf_execution_missing_commit",
      pending_task_ids: ["ui"],
    });
  });

  test("terminal child missing-commit approvals do not duplicate unchanged events", () => {
    const workflow = loadYamlWorkflow(
      join(
        process.cwd(),
        "call-catalog",
        "loopship",
        "workflow",
        "service",
        "flows",
        "swe.stable.yaml",
      ),
    );
    const task = workflowTaskDefinition(workflow, "stage_result_leaf_executing");
    const existingEvent = {
      event: "leaf_execution_missing_commit",
      stage: "executing",
      merge_commit: "parent123",
      target_commit: "parent123",
      pending_task_ids: ["ui"],
    };
    const result = executeWorkflowTaskScript(task, {
      steps: {
        resolve_stage: {
          action: {
            runtime: {
              tasks: {},
              manifest: null,
              events: [existingEvent],
            },
          },
        },
        query_events: { action: [existingEvent] },
        read_tasks: {
          action: {
            parent_wtree: "parent",
            parent_task_id: "dashboard",
            parent_context_ref: "/tmp/repo/worktrees/parent/.loopship/runtime/tasks.yaml",
            coordinator_worktree: "/tmp/repo/worktrees/child-terminal",
            tasks: [{ id: "ui", title: "Build UI", status: "pending", child_wtree: "" }],
          },
        },
        stage_leaf_git_head: {
          action: {
            commit: "parent123",
          },
        },
        stage_leaf_target_git_head: {
          action: {
            commit: "parent123",
          },
        },
      },
    });

    expect(result.stage_after).toBe("executing");
    expect(result.transition).toBe("blocked");
    expect(result.events).toEqual([]);
    expect(result.state_patch.local_work_receipt).toMatchObject({
      status: "missing_local_commit",
      commit: "parent123",
      target_commit: "parent123",
      pending_task_ids: ["ui"],
    });
  });

  test("failed terminal child validation returns to local execution", () => {
    const workflow = loadYamlWorkflow(
      join(
        process.cwd(),
        "call-catalog",
        "loopship",
        "workflow",
        "service",
        "flows",
        "swe.stable.yaml",
      ),
    );
    const task = workflowTaskDefinition(workflow, "stage_result_validating");
    const result = executeWorkflowTaskScript(task, {
      steps: {
        resolve_stage: {
          action: {
            runtime: {
              tasks: {},
              manifest: null,
              events: [],
            },
          },
        },
        query_events: { action: [] },
        read_tasks: {
          action: {
            prompt: "loopship: execute child task scanner-core: implement scanner core",
            parent_wtree: "parent",
            parent_task_id: "scanner-core",
            parent_context_ref: "/tmp/repo/worktrees/parent/.loopship/runtime/tasks.yaml",
            tasks: [
              {
                id: "implement-scanner-core",
                status: "done",
                child_wtree: "",
                merge_commit: "old",
              },
            ],
          },
        },
        stage_validating: {
          action: {
            status: "failed",
            checks: [
              {
                name: "implementation evidence",
                status: "failed",
              },
            ],
          },
        },
      },
    });

    expect(result.stage_after).toBe("executing");
    expect(result.transition).toBe("failed");
    expect(result.state_patch).toMatchObject({
      stage: "executing",
      validation_receipt: {
        status: "failed",
      },
    });
  });

  test(
    "terminal child quests complete local execution without emitting child init commands",
    async () => {
      const fixture = createGitFixture("loopship-terminal-child-lifecycle-");
      let scheduler: LoopshipTestScheduler | null = null;
      try {
        scheduler = await startLoopshipTestScheduler({
          dbPath: join(fixture.root, "scheduler", "native-v1.sqlite"),
          home: resolve(fixture.repo, "..", "home"),
        });
        ensureSystemScaffold(fixture.repo);
        runGit(fixture.repo, ["add", ".loopship"]);
        runGit(fixture.repo, ["commit", "-m", "scaffold"]);
        const parentWorkspace = ensureCoordinatorWorkspace(fixture.repo, "parent");
        const prompt =
          "loopship: execute child task timer-ui: implement the timer UI and local persistence.";
        const childWtree = "child-terminal";
        const extraArgs = [
          "--parent-wtree",
          "parent",
          "--parent-task-id",
          "timer-ui",
          "--parent-context-ref",
          join(parentWorkspace.worktree_path, ".loopship", "runtime", "tasks.yaml"),
          "--target-branch",
          "parent",
          "--target-worktree",
          parentWorkspace.worktree_path,
        ];

        const planReview = await startQuestStage(
          fixture.repo,
          prompt,
          childWtree,
          extraArgs,
          scheduler.env,
        );
        expect(workflowOutput(planReview)).toBeNull();
        expect(interactionPause(planReview), JSON.stringify(planReview)).not.toBeNull();

        let childState = parseTasksYaml(
          readFileSync(
            join(
              fixture.repo,
              "worktrees",
              childWtree,
              ".loopship",
              "runtime",
              "tasks.yaml",
            ),
            "utf8",
          ),
        );
        expect(childState.parent_wtree).toBe("parent");
        expect(childState.parent_task_id).toBe("timer-ui");
        expect(childState.stage).toBe("plan_review");
        expect(childState.tasks?.[0]).toMatchObject({
          id: "timer-ui",
          child_wtree: "",
        });
        expect(JSON.stringify(planReview)).not.toContain("loopship.child.prepare/v1");
        expect(JSON.stringify(planReview)).not.toContain("prepared_children");

        const implementationStarted = await resumeQuestPause(
          fixture.repo,
          interactionPause(planReview)!,
          { approved: true },
          scheduler.env,
        );
        expect(workflowOutput(implementationStarted)).toBeNull();
        expect(
          interactionPause(implementationStarted),
          JSON.stringify(implementationStarted),
        ).not.toBeNull();
        expect(JSON.stringify(implementationStarted)).toContain("implementation_receipt");

        childState = parseTasksYaml(
          readFileSync(
            join(
              fixture.repo,
              "worktrees",
              childWtree,
              ".loopship",
              "runtime",
              "tasks.yaml",
            ),
            "utf8",
          ),
        );
        const childWorktree = String(childState.coordinator_worktree || "");
        writeFileSync(join(childWorktree, "CHILD.md"), "# terminal child\n", "utf8");
        runGit(childWorktree, ["add", "CHILD.md"]);
        runGit(childWorktree, ["commit", "-m", "terminal child work"]);
        const implementationCommit = runGit(childWorktree, ["rev-parse", "HEAD"]);

        const validationStarted = await resumeQuestPause(
          fixture.repo,
          interactionPause(implementationStarted)!,
          {
            implementation_receipt: {
              resolver: "aitl.subagent",
              agent_id: "loopship-test-agent",
              session_id: "loopship-test-session",
              worktree_path: childWorktree,
              branch_ref: childWtree,
              commits: [implementationCommit],
              checks: [{ name: "terminal-child-smoke", status: "passed" }],
              artifacts: [{ type: "commit", ref: implementationCommit }],
            },
          },
          scheduler.env,
        );
        expect(workflowOutput(validationStarted)).toBeNull();
        expect(
          interactionPause(validationStarted),
          JSON.stringify(validationStarted),
        ).not.toBeNull();
        expect(JSON.stringify(validationStarted)).toContain("Loopship Validation Step");
        childState = parseTasksYaml(
          readFileSync(
            join(
              fixture.repo,
              "worktrees",
              childWtree,
              ".loopship",
              "runtime",
              "tasks.yaml",
            ),
            "utf8",
          ),
        );
        expect(childState.stage).toBe("validating");
        expect(childState.local_work_receipt).toMatchObject({
          mode: "shared-head-commit",
          covered_task_ids: ["timer-ui"],
        });
        expect(JSON.stringify(validationStarted)).not.toContain("loopship.child.prepare/v1");
        expect(JSON.stringify(validationStarted)).not.toContain("prepared_children");

        const verificationStarted = await resumeQuestPause(
          fixture.repo,
          interactionPause(validationStarted)!,
          {
            status: "passed",
            checks: [{ name: "terminal-child-smoke", status: "passed" }],
          },
          scheduler.env,
        );
        expect(workflowOutput(verificationStarted)).toBeNull();
        expect(
          interactionPause(verificationStarted),
          JSON.stringify(verificationStarted),
        ).not.toBeNull();
        expect(JSON.stringify(verificationStarted)).toContain("Loopship Verification Step");
        childState = parseTasksYaml(
          readFileSync(
            join(
              fixture.repo,
              "worktrees",
              childWtree,
              ".loopship",
              "runtime",
              "tasks.yaml",
            ),
            "utf8",
          ),
        );
        expect(childState.stage).toBe("verification_pending");
        expect(childState.validation_receipt).toMatchObject({ status: "passed" });
        const taskAcceptance = String(childState.tasks?.[0]?.acceptance || "");
        expect(taskAcceptance).toBeTruthy();

        const systemUpdateStarted = await resumeQuestPause(
          fixture.repo,
          interactionPause(verificationStarted)!,
          {
            status: "passed",
            acceptance_trace: [
              {
                acceptance: taskAcceptance,
                status: "passed",
              },
            ],
            risks: [],
          },
          scheduler.env,
        );
        expect(workflowOutput(systemUpdateStarted)).toBeNull();
        const systemUpdatePause = interactionPause(systemUpdateStarted);
        expect(systemUpdatePause, JSON.stringify(systemUpdateStarted)).not.toBeNull();
        expect(JSON.stringify(systemUpdateStarted)).toContain("system_update");
        childState = parseTasksYaml(
          readFileSync(
            join(
              fixture.repo,
              "worktrees",
              childWtree,
              ".loopship",
              "runtime",
              "tasks.yaml",
            ),
            "utf8",
          ),
        );
        expect(childState.stage).toBe("system_update_pending");
        expect(childState.verification_receipt).toMatchObject({ status: "passed" });

        const systemRootPath = join(childWorktree, ".loopship", "system.yaml");
        const systemRoot = parseYaml(readFileSync(systemRootPath, "utf8")) as Record<
          string,
          unknown
        >;
        const updatedTitle = "Terminal Child System Update";
        systemRoot.title = updatedTitle;
        const completed = await resumeQuestPause(
          fixture.repo,
          systemUpdatePause!,
          {
            system_update: {
              schema_version: 1,
              mode: "replace",
              summary:
                "Refresh the canonical Loopship root after the verified terminal child work.",
              root: systemRoot,
              external_docs: [],
            },
          },
          scheduler.env,
        );
        const landed = workflowOutput(completed);
        expect(landed, JSON.stringify(completed)).not.toBeNull();
        expect(landed?.step).toBe("landing");
        expect(landed?.stage_after).toBe("archived");

        expect(
          readFileSync(join(parentWorkspace.worktree_path, "CHILD.md"), "utf8"),
        ).toContain("terminal child");
        expect(
          readFileSync(
            join(parentWorkspace.worktree_path, ".loopship", "system.yaml"),
            "utf8",
          ),
        ).toContain(updatedTitle);
        expect(landed?.state_patch).toMatchObject({
          stage: "archived",
        });
        expect(
          String((landed?.state_patch as Record<string, unknown>)?.landed_commit || ""),
        ).toMatch(/^[0-9a-f]{40}$/);
        expect((landed?.runtime as Record<string, any>)?.tasks?.local_work_receipt).toMatchObject(
          {
            mode: "shared-head-commit",
            covered_task_ids: ["timer-ui"],
          },
        );
        expect(existsSync(join(fixture.repo, "worktrees", childWtree))).toBe(false);
      } finally {
        await scheduler?.stop();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
    { timeout: 600_000 },
  );

  test("validates committed native step workflows without legacy metadata or context.script", () => {
    const stepRoot = join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "step");
    const workflows = loadCatalogWorkflows(stepRoot);
    expect(Object.keys(workflows).length).toBeGreaterThan(0);
    for (const workflow of Object.values(workflows)) {
      walk(workflow, (item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return;
        const object = item as Record<string, unknown>;
        if (
          object.metadata &&
          typeof object.metadata === "object" &&
          !Array.isArray(object.metadata)
        ) {
          expect((object.metadata as Record<string, unknown>).loopship).toBeUndefined();
        }
        if (object.instruction && object.request && object.answer) {
          expect(object.context).toBeUndefined();
        }
        if (typeof object.call === "string") {
          expect(object.call.startsWith("loopship.internal.")).toBe(false);
        }
      });
    }
    validateNativeWorkflows(workflows);
  });

  test("request-input steps keep pause and sandbox launch budgets separate", () => {
    const stepRoot = join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "step");
    const names = [
      "plan",
      "questions",
      "task-graph",
      "system-update",
      "validation",
      "verification",
      "child-result",
    ];
    for (const name of names) {
      const workflow = loadYamlWorkflow(join(stepRoot, `${name}.stable.yaml`));
      const requestActions: Array<Record<string, any>> = [];
      walk(workflow, (item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return;
        const action = item as Record<string, any>;
        if (action.call === "fastflow.afn.core.request.input") {
          requestActions.push(action);
        }
      });
      expect(requestActions, name).toHaveLength(1);
      expect(requestActions[0]?.with?.body?.timeout_ms, name).toBe(250);
      expect(requestActions[0]?.with?.body?.request?.build?.timeout_ms, name).toBe(5_000);
    }
  });

  test("catalog flow and step workflow YAML files are Fastflow-valid", () => {
    const flowRoot = join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "flows");
    const stepRoot = join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "step");
    const flowFiles = allWorkflowFiles(flowRoot);
    const stepFiles = allWorkflowFiles(stepRoot);
    expect(flowFiles.every((name) => !name.endsWith(".yaml") || name.endsWith(".stable.yaml"))).toBe(true);
    expect(stepFiles.every((name) => !name.endsWith(".yaml") || name.endsWith(".stable.yaml"))).toBe(true);
    const workflows: Record<string, unknown> = {};
    for (const file of flowFiles) {
      workflows[`flows/${file}`] = loadYamlWorkflow(join(flowRoot, file));
    }
    for (const file of stepFiles) {
      workflows[`steps/${file}`] = loadYamlWorkflow(join(stepRoot, file));
    }
    for (const workflow of Object.values(workflows)) {
      walk(workflow, (item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return;
        const object = item as Record<string, unknown>;
        if (
          object.metadata &&
          typeof object.metadata === "object" &&
          !Array.isArray(object.metadata)
        ) {
          expect((object.metadata as Record<string, unknown>).loopship).toBeUndefined();
        }
        expect((object as Record<string, unknown>).step_input).toBeUndefined();
        if (typeof object.call === "string") {
          expect(object.call.startsWith("workflow.loopship.")).toBe(false);
          expect(object.call.startsWith("loopship.internal.")).toBe(false);
        }
      });
    }
    const serialized = JSON.stringify(workflows);
    for (const token of [
      "derive_transition",
      "statePatchForPayload",
      "loopship.flow-transition",
    ]) {
      expect(serialized).not.toContain(token);
    }
    validateNativeWorkflows(workflows);
  });

  test("validates committed flow orchestration workflows from the catalog", () => {
    const flowRoot = join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "flows");
    const workflows = loadCatalogWorkflows(flowRoot);
    expect(Object.keys(workflows).length).toBeGreaterThan(0);
    validateNativeWorkflows(workflows);
    for (const [flowId, workflow] of Object.entries(workflows)) {
      const calls = new Set<string>();
      walk(workflow, (item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return;
        const call = (item as Record<string, unknown>).call;
        if (typeof call === "string") calls.add(call);
      });
      expect(calls.has(LOOPSHIP_DATA_CALLS.documentRead), flowId).toBe(true);
      expect(calls.has(LOOPSHIP_DATA_CALLS.eventLogQuery), flowId).toBe(true);
      expect(loopshipFlowWorkflowRef(flowId)).toBe(`loopship.workflow.service.flows.${flowId.replace(/_/g, "-")}`);
    }
  });

  test("uses the packaged workflow catalog as the canonical Loopship call-id source", async () => {
    const { root, repo } = createGitFixture("loopship-fastflow-catalog-");
    try {
      const catalogRoot = await ensureLoopshipFastflowWorkflowCatalog(repo);
      expect(catalogRoot).toBe(LOOPSHIP_CALL_CATALOG_ROOT);
      expect(existsSync(join(repo, ".loopship", "call-catalog"))).toBe(false);
      expect(existsSync(join(repo, "call-catalog"))).toBe(false);
      expect(existsSync(join(repo, "tmp", "loopship-fastflow-workflow-catalog.json"))).toBe(false);
      const stepRoot = join(catalogRoot, "loopship", "workflow", "service", "step");
      const flowRoot = join(catalogRoot, "loopship", "workflow", "service", "flows");
      expect(existsSync(join(stepRoot, "index.yaml"))).toBe(true);
      expect(existsSync(join(flowRoot, "index.yaml"))).toBe(true);
      for (const id of workflowIdsFromIndex(join(stepRoot, "index.yaml"))) {
        expect(existsSync(join(stepRoot, workflowFileName(id))), id).toBe(true);
      }
      for (const id of workflowIdsFromIndex(join(flowRoot, "index.yaml"))) {
        expect(existsSync(join(flowRoot, workflowFileName(id))), id).toBe(true);
        expect(loopshipFlowWorkflowRef(id)).toBe(`loopship.workflow.service.flows.${id.replace(/_/g, "-")}`);
      }
      expect(existsSync(join(catalogRoot, "loopship", "workflow", "service", "step", "step"))).toBe(false);
      expect(existsSync(join(catalogRoot, "loopship", "workflow", "service", "flows", "flows"))).toBe(false);
      const manifest = parseYaml(readFileSync(join(catalogRoot, "index.yaml"), "utf8")) as any;
      expect(manifest.schemaVersion).toBe("fastflow/call-catalog-manifest/v3");
      expect(manifest.pathTemplate).toBe("{registry}/{kind}/{target}/{scope}/index.yaml");
      expect(manifest.release_auth?.trusted_releasers?.length).toBeGreaterThan(0);
      expect(manifest.prefixes.loopship.afn.service.flow.tags).toContain("stage-result");
      expect(manifest.prefixes.loopship.workflow.service.step.tags).toContain("step");
      expect(manifest.prefixes.loopship.workflow.service.flows.tags).toContain("flow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lifecycle promotion uses the Loopship registry directly", () => {
    const text = readFileSync(join(process.cwd(), "scripts", "loopship_fastflow_lifecycle.ts"), "utf8");
    expect(text).toContain("FASTFLOW_INDEX");
    expect(text).toContain("pathToFileURL(FASTFLOW_INDEX)");
    expect(text).toContain("systemWorkflowsDir: LOOPSHIP_CALL_CATALOG_ROOT");
    expect(text).toContain("callCatalogRoots: [LOOPSHIP_CALL_CATALOG_ROOT]");
    expect(text).not.toContain("SCRATCH_CALL_CATALOG_ROOT");
    expect(text).not.toContain("syncPromotedWorkspaceRelease");
    expect(text).not.toContain("workspace.workflow.service");
  });

  test("ships the root Fastflow call catalog", async () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      files?: unknown[];
    };
    expect(packageJson.files).toContain("call-catalog");
    expect(packageJson.files).toContain("scripts");
    expect(existsSync(join(process.cwd(), "scripts", "loopship_stepper.ts"))).toBe(true);
    const stepRoot = join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "step");
    expect(workflowIdsFromIndex(join(stepRoot, "index.yaml")).length).toBeGreaterThan(0);
    expect(existsSync(join(process.cwd(), "call-catalog", ".loopship-generator.json"))).toBe(false);
    expect(existsSync(join(process.cwd(), ".loopship", "call-catalog"))).toBe(false);
    const packageCache = join(process.cwd(), "tmp", "loopship-fastflow-workflow-catalog.json");
    rmSync(packageCache, { force: true });
    expect(await ensureLoopshipFastflowWorkflowCatalog(process.cwd())).toBe(LOOPSHIP_CALL_CATALOG_ROOT);
    expect(existsSync(packageCache)).toBe(false);
  });

  test("rejects missing required Loopship AFN fields at validation time", () => {
    const adapters = createLoopshipFastflowAdapters();
    expect(() =>
      (adapters.validateCallInvocation as Function)({
        call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
        phase: "action",
        with: { body: { repo: "/tmp/repo" } },
      }),
    ).toThrow("requires body.wtree");
  });

  test("rejects unknown Loopship AFN body fields before promotion", () => {
    const adapters = createLoopshipFastflowAdapters();
    expect(() =>
      (adapters.validateCallInvocation as Function)({
        call: LOOPSHIP_AFN_CALLS.systemApplyUpdate,
        phase: "action",
        with: {
          body: {
            repo: "/tmp/repo",
            update: {},
            unexpected: true,
          },
        },
      }),
    ).toThrow("does not allow body.unexpected");
  });

  test("rejects unknown nested Loopship AFN payload fields before promotion", () => {
    const adapters = createLoopshipFastflowAdapters();
    expect(() =>
      (adapters.validateCallInvocation as Function)({
        call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
        phase: "action",
        with: {
          body: {
            repo: "/tmp/repo",
            wtree: "demo",
            task: {
              id: "task-a",
              title: "Task A",
              acceptance: "done",
              shell: "rm -rf /",
            },
          },
        },
      }),
    ).toThrow("body.task.shell is not allowed");
    expect(() =>
      (adapters.validateCallInvocation as Function)({
        call: LOOPSHIP_AFN_CALLS.systemApplyUpdate,
        phase: "action",
        with: {
          body: {
            repo: "/tmp/repo",
            update: {
              schema_version: 1,
              mode: "replace",
              summary: "update",
              unexpected: true,
            },
          },
        },
      }),
    ).toThrow("body.update.unexpected is not allowed");
    expect(() =>
      (adapters.validateCallInvocation as Function)({
        call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
        phase: "action",
        with: {
          body: {
            repo: "/tmp/repo",
            wtree: "demo",
            receipt: {
              landed_commit: "abc",
              unsafe: true,
            },
          },
        },
      }),
    ).toThrow("body.receipt.unsafe is not allowed");
  });

  test("landing.apply preserves landing preflights and verifies recorded receipts", async () => {
    const fixture = createGitFixture("loopship-native-landing-preflight-");
    try {
      const adapters = createLoopshipFastflowAdapters();
      const { files, state } = createNativeQuest(fixture.repo, "demo");
      writeFileSync(
        files.tasks,
        renderTasksYaml({
          ...(state as QuestState),
          tasks: [
            questTaskFixture({
              id: "task-a",
              title: "Task A",
              acceptance: "done",
              status: "child_archived",
              dependencies: [],
              scope_files: [],
            }),
          ],
        }),
      );
      await expect(
        executeLoopshipAfn(adapters, {
          action: {
            call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
            with: {
              body: {
                repo: fixture.repo,
                wtree: "demo",
                next_stage: "archived",
              },
            },
          },
        }),
      ).rejects.toThrow("missing merge_commit");

      writeFileSync(files.tasks, renderTasksYaml(state));
      await expect(
        executeLoopshipAfn(adapters, {
          action: {
            call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
            with: {
              body: {
                repo: fixture.repo,
                wtree: "demo",
                receipt: {
                  landed_commit: "not-a-commit",
                },
                next_stage: "archived",
              },
            },
          },
        }),
      ).rejects.toThrow("Needed a single revision");

      writeFileSync(
        files.tasks,
        renderTasksYaml({
          ...(state as QuestState),
          coordinator_worktree: fixture.root,
        }),
      );
      await expect(
        executeLoopshipAfn(adapters, {
          action: {
            call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
            with: {
              body: {
                repo: fixture.repo,
                wtree: "demo",
                next_stage: "archived",
              },
            },
          },
        }),
      ).rejects.toThrow("coordinator worktree must be the repository or a canonical task worktree");
      writeFileSync(files.tasks, renderTasksYaml(state));

      await expect(
        executeLoopshipAfn(adapters, {
          action: {
            call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
            with: {
              body: {
                repo: fixture.repo,
                wtree: "demo",
                receipt: {
                  source_branch: "main",
                  landed_commit: "main",
                },
                next_stage: "archived",
              },
            },
          },
        }),
      ).rejects.toThrow("landing receipt source branch main does not match demo");

      const recorded = await executeLoopshipAfn(adapters, {
        action: {
          call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
          with: {
            body: {
              repo: fixture.repo,
              wtree: "demo",
              receipt: {
                landed_commit: "main",
              },
              next_stage: "archived",
            },
          },
        },
      });
      expect(recorded.landed_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(recorded.target_worktree).toBe(fixture.repo);
      expect(parseTasksYaml(readFileSync(files.tasks, "utf8"))).toMatchObject({
        stage: "archived",
        landed_commit: recorded.landed_commit,
        landing_target_worktree: fixture.repo,
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("landing.apply rejects repository-root legacy quest state without interpreting it", async () => {
    const fixture = createGitFixture("loopship-native-legacy-landing-");
    const legacyTasks = join(fixture.repo, ".loopship", "runtime", "tasks.yaml");
    const legacyState = "stage: landing_ready\nlanding_target_branch: main\n";
    try {
      mkdirSync(dirname(legacyTasks), { recursive: true });
      writeFileSync(legacyTasks, legacyState, "utf8");
      const adapters = createLoopshipFastflowAdapters();
      const action = {
        action: {
          call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
          with: {
            body: {
              repo: fixture.repo,
              wtree: "legacy-root",
              status: "blocked",
              next_stage: "landing_ready",
            },
          },
        },
      };
      const identity = {
        executionId: "loopship-legacy-root-landing",
        effectKey: "loopship-legacy-root-landing-effect",
      };
      await expect(executeLoopshipAfn(adapters, action, identity)).rejects.toThrow(
        "legacy_execution_unsupported",
      );
      await expect(
        executeLoopshipAfn(adapters, action, identity),
      ).rejects.toThrow("legacy_execution_unsupported");
      expect(readFileSync(legacyTasks, "utf8")).toBe(legacyState);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("landing.apply performs a real safe merge and archives canonical state", async () => {
    const fixture = createGitFixture("loopship-native-landing-merge-");
    try {
      const adapters = createLoopshipFastflowAdapters();
      const workspace = ensureTaskWorkspace(
        fixture.repo,
        "codex/demo",
        join(fixture.repo, "worktrees", "demo"),
        "main",
      );
      const { files, state } = createQuest({
        repoRoot: fixture.repo,
        wtree: "demo",
        prompt: "loopship: native landing",
        resolutionSource: "test",
        workspace,
        flowId: "swe",
        initialStage: "initial",
      });
      const coordinatorWorktree = String(state.coordinator_worktree);
      writeFileSync(join(coordinatorWorktree, "FEATURE.md"), "# feature\n", "utf8");
      runGit(coordinatorWorktree, ["add", "FEATURE.md"]);
      runGit(coordinatorWorktree, ["commit", "-m", "feature"]);

      const result = await executeLoopshipAfn(adapters, {
        action: {
          call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
          with: {
            body: {
              repo: fixture.repo,
              wtree: "demo",
              source_branch: "codex/demo",
              next_stage: "archived",
            },
          },
        },
      });
      expect(result).toMatchObject({
        schema_version: "loopship.landing.apply/v1",
        dry_run: false,
        source_branch: "codex/demo",
        target_branch: "main",
      });
      expect(String(result.landed_commit)).toMatch(/^[0-9a-f]{40}$/);
      expect(readFileSync(join(fixture.repo, "FEATURE.md"), "utf8")).toContain("feature");
      const landedState = parseTasksYaml(readFileSync(files.tasks, "utf8"));
      expect(landedState.stage).toBe("archived");
      expect(landedState.landed_commit).toBe(result.landed_commit);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("serializes distinct landing effect keys by canonical Git repository", async () => {
    const fixture = createGitFixture("loopship-native-landing-resource-lock-");
    const children: Array<ReturnType<typeof Bun.spawn>> = [];
    try {
      const prepareLanding = (wtree: string, file: string) => {
        const branch = `codex/${wtree}`;
        const workspace = ensureTaskWorkspace(
          fixture.repo,
          branch,
          join(fixture.repo, "worktrees", wtree),
          "main",
        );
        createQuest({
          repoRoot: fixture.repo,
          wtree,
          prompt: `loopship: land ${wtree}`,
          resolutionSource: "test",
          workspace,
          flowId: "swe",
          initialStage: "initial",
        });
        writeFileSync(join(workspace.worktree_path, file), `${wtree}\n`, "utf8");
        runGit(workspace.worktree_path, ["add", file]);
        runGit(workspace.worktree_path, ["commit", "-m", `add ${wtree}`]);
        return {
          repo: fixture.repo,
          wtree,
          source_branch: branch,
          next_stage: "archived",
        };
      };
      const bodies = [
        prepareLanding("landing-a", "LANDING_A.md"),
        prepareLanding("landing-b", "LANDING_B.md"),
      ];
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const wrapperRoot = join(fixture.root, "bin");
      const mergeLog = join(fixture.root, "landing-merges.log");
      mkdirSync(wrapperRoot, { recursive: true });
      writeFileSync(
        join(wrapperRoot, "git"),
        `#!/bin/sh
if [ "$1" = "merge" ]; then
  printf 'start:%s\\n' "$*" >> "$LOOPSHIP_LANDING_MERGE_LOG"
  sleep 0.2
  "$LOOPSHIP_REAL_GIT" "$@"
  status=$?
  printf 'end:%s:%s\\n' "$*" "$status" >> "$LOOPSHIP_LANDING_MERGE_LOG"
  exit "$status"
fi
exec "$LOOPSHIP_REAL_GIT" "$@"
`,
        { encoding: "utf8", mode: 0o755 },
      );
      const childScript = `
        import {
          createAfnInvocation,
          digestNativeContract,
          validateExecutionDecision,
        } from "@cueintent/fastflow";
        import {
          createLoopshipFastflowAdapters,
          LOOPSHIP_AFN_CALLS,
        } from ${JSON.stringify(pathToFileURL(resolve(process.cwd(), "scripts", "loopship_fastflow.ts")).href)};
        const body = JSON.parse(process.env.LOOPSHIP_LANDING_BODY);
        const effectKey = process.env.LOOPSHIP_LANDING_EFFECT_KEY;
        const executionId = process.env.LOOPSHIP_LANDING_EXECUTION_ID;
        const adapters = createLoopshipFastflowAdapters();
        const dispatch = adapters.afnDispatch;
        const route = dispatch.listRoutes().find(
          (entry) => entry.callId === LOOPSHIP_AFN_CALLS.landingApplyOutcome,
        );
        const invocation = createAfnInvocation({
          executionId,
          nodeId: route.callId,
          invocationId: digestNativeContract({ executionId, call: route.callId, attempt: 1 }),
          attempt: 1,
          call: {
            callId: route.callId,
            contractDigest: route.contractDigest,
            implementationDigest: route.implementationDigest,
          },
          input: body,
          effectKey,
          bindingRefs: [],
          affinityRefs: [],
          grants: [],
        });
        const decision = validateExecutionDecision(await dispatch.dispatch(invocation));
        if (decision.kind !== "completed") {
          throw new Error(decision.kind === "failed" ? decision.error.message : decision.kind);
        }
      `;
      const spawnLanding = (body: Record<string, unknown>, index: number) => {
        const child = Bun.spawn({
          cmd: [process.execPath, "--no-install", "-e", childScript],
          cwd: process.cwd(),
          env: {
            ...process.env,
            PATH: `${wrapperRoot}:${process.env.PATH || ""}`,
            LOOPSHIP_REAL_GIT: realGit,
            LOOPSHIP_LANDING_MERGE_LOG: mergeLog,
            LOOPSHIP_LANDING_BODY: JSON.stringify(body),
            LOOPSHIP_LANDING_EFFECT_KEY: `landing-resource-effect-${index}`,
            LOOPSHIP_LANDING_EXECUTION_ID: `landing-resource-execution-${index}`,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        children.push(child);
        return child;
      };
      const spawned = bodies.map(spawnLanding);
      const stderr = spawned.map((child) => new Response(child.stderr).text());
      const exits = await Promise.all(spawned.map((child) => child.exited));
      const errors = await Promise.all(stderr);
      expect(exits, errors.join("\n")).toEqual([0, 0]);
      const mergeRecords = readFileSync(mergeLog, "utf8").trim().split("\n");
      expect(mergeRecords).toHaveLength(4);
      expect(mergeRecords[0]).toStartWith("start:");
      expect(mergeRecords[1]).toStartWith("end:");
      expect(mergeRecords[2]).toStartWith("start:");
      expect(mergeRecords[3]).toStartWith("end:");
      expect(readFileSync(join(fixture.repo, "LANDING_A.md"), "utf8")).toBe("landing-a\n");
      expect(readFileSync(join(fixture.repo, "LANDING_B.md"), "utf8")).toBe("landing-b\n");
      const receipts = readdirSync(
        join(fixture.repo, ".loopship", "runtime", "afn-effects"),
      )
        .filter((name) => name.endsWith(".json"))
        .map((name) =>
          JSON.parse(
            readFileSync(
              join(fixture.repo, ".loopship", "runtime", "afn-effects", name),
              "utf8",
            ),
          ),
        );
      expect(receipts.map((receipt) => receipt.effectKey).sort()).toEqual([
        "landing-resource-effect-0",
        "landing-resource-effect-1",
      ]);
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("landing.apply crash recovery retains the exact merge commit after target advancement", async () => {
    const fixture = createGitFixture("loopship-native-landing-receipt-recovery-");
    try {
      const adapters = createLoopshipFastflowAdapters();
      const workspace = ensureTaskWorkspace(
        fixture.repo,
        "codex/demo",
        join(fixture.repo, "worktrees", "demo"),
        "main",
      );
      const { files, state } = createQuest({
        repoRoot: fixture.repo,
        wtree: "demo",
        prompt: "loopship: retain the exact landing receipt",
        resolutionSource: "test",
        workspace,
        flowId: "swe",
        initialStage: "initial",
      });
      const initialTasks = readFileSync(files.tasks, "utf8");
      const initialEvents = readFileSync(files.events, "utf8");
      const coordinatorWorktree = String(state.coordinator_worktree);
      writeFileSync(join(coordinatorWorktree, "FEATURE.md"), "# exact landing\n", "utf8");
      runGit(coordinatorWorktree, ["add", "FEATURE.md"]);
      runGit(coordinatorWorktree, ["commit", "-m", "exact landing feature"]);

      const action = {
        call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
        with: {
          body: {
            repo: fixture.repo,
            wtree: "demo",
            source_branch: "codex/demo",
            next_stage: "archived",
          },
        },
      };
      const identity = {
        executionId: "loopship-landing-exact-recovery",
        effectKey: "loopship-landing-exact-recovery-effect",
      };
      const landed = await executeLoopshipAfn(adapters, { action }, identity);
      const exactLandingCommit = String(landed.landed_commit);
      const mergeEvent = readFileSync(files.events, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find(
          (event) =>
            event.event === "landing_merge_recorded" &&
            event.payload?.landed_commit === exactLandingCommit,
        );
      expect(mergeEvent).toBeTruthy();

      const receiptRoot = join(fixture.repo, ".loopship", "runtime", "afn-effects");
      const receiptPath = readdirSync(receiptRoot)
        .filter((name) => name.endsWith(".json"))
        .map((name) => join(receiptRoot, name))
        .find((path) => {
          const receipt = JSON.parse(readFileSync(path, "utf8"));
          return receipt.effectKey === identity.effectKey;
        });
      expect(receiptPath).toBeTruthy();
      const receipt = JSON.parse(readFileSync(receiptPath!, "utf8"));
      receipt.status = "started";
      delete receipt.output;
      writeFileSync(receiptPath!, `${JSON.stringify(receipt)}\n`, "utf8");
      writeFileSync(files.tasks, initialTasks, "utf8");
      writeFileSync(
        files.events,
        `${initialEvents}${JSON.stringify(mergeEvent)}\n`,
        "utf8",
      );

      writeFileSync(join(fixture.repo, "AFTER.md"), "# later target work\n", "utf8");
      runGit(fixture.repo, ["add", "AFTER.md"]);
      runGit(fixture.repo, ["commit", "-m", "advance target after landing"]);
      const laterTargetCommit = runGit(fixture.repo, ["rev-parse", "HEAD"]);
      expect(laterTargetCommit).not.toBe(exactLandingCommit);

      const recovered = await executeLoopshipAfn(adapters, { action }, identity);
      expect(recovered.landed_commit).toBe(exactLandingCommit);
      expect(recovered.landed_commit).not.toBe(laterTargetCommit);
      expect(parseTasksYaml(readFileSync(files.tasks, "utf8"))).toMatchObject({
        stage: "archived",
        landed_commit: exactLandingCommit,
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("landing.apply rejects target branches checked out in external worktrees", async () => {
    const fixture = createGitFixture("loopship-native-landing-external-target-");
    try {
      const adapters = createLoopshipFastflowAdapters();
      const workspace = ensureTaskWorkspace(
        fixture.repo,
        "codex/demo",
        join(fixture.repo, "worktrees", "demo"),
        "main",
      );
      const { state } = createQuest({
        repoRoot: fixture.repo,
        wtree: "demo",
        prompt: "loopship: native landing",
        resolutionSource: "test",
        workspace,
        flowId: "swe",
        initialStage: "initial",
        landingTargetBranch: "external-target",
        landingTargetWorktree: join(
          fixture.repo,
          "worktrees",
          "landing-external-target",
        ),
      });
      const coordinatorWorktree = String(state.coordinator_worktree);
      writeFileSync(join(coordinatorWorktree, "FEATURE.md"), "# feature\n", "utf8");
      runGit(coordinatorWorktree, ["add", "FEATURE.md"]);
      runGit(coordinatorWorktree, ["commit", "-m", "feature"]);
      const externalTarget = join(fixture.root, "external-target");
      runGit(fixture.repo, [
        "worktree",
        "add",
        "-b",
        "external-target",
        externalTarget,
        "main",
      ]);

      await expect(
        executeLoopshipAfn(adapters, {
          action: {
            call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
            with: {
              body: {
                repo: fixture.repo,
                wtree: "demo",
                source_branch: "codex/demo",
                target_branch: "external-target",
                next_stage: "archived",
              },
            },
          },
        }),
      ).rejects.toThrow("checked out outside the repository worktrees");
      expect(existsSync(join(externalTarget, "FEATURE.md"))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("landing.apply rejects uncommitted durable Loopship target state", async () => {
    const fixture = createGitFixture("loopship-native-landing-dirty-target-");
    try {
      const adapters = createLoopshipFastflowAdapters();
      const workspace = ensureTaskWorkspace(
        fixture.repo,
        "codex/demo",
        join(fixture.repo, "worktrees", "demo"),
        "main",
      );
      const { state } = createQuest({
        repoRoot: fixture.repo,
        wtree: "demo",
        prompt: "loopship: native landing",
        resolutionSource: "test",
        workspace,
        flowId: "swe",
        initialStage: "initial",
      });
      const coordinatorWorktree = String(state.coordinator_worktree);
      writeFileSync(join(coordinatorWorktree, "FEATURE.md"), "# feature\n", "utf8");
      runGit(coordinatorWorktree, ["add", "FEATURE.md"]);
      runGit(coordinatorWorktree, ["commit", "-m", "feature"]);
      mkdirSync(join(fixture.repo, ".loopship"), { recursive: true });
      writeFileSync(
        join(fixture.repo, ".loopship", "system.yaml"),
        "schema_version: 2\n",
        "utf8",
      );

      await expect(
        executeLoopshipAfn(adapters, {
          action: {
            call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
            with: {
              body: {
                repo: fixture.repo,
                wtree: "demo",
                source_branch: "codex/demo",
                next_stage: "archived",
              },
            },
          },
        }),
      ).rejects.toThrow("cannot merge into dirty landing target worktree");
      expect(existsSync(join(fixture.repo, "FEATURE.md"))).toBe(false);
      expect(readFileSync(join(fixture.repo, ".loopship", "system.yaml"), "utf8")).toBe(
        "schema_version: 2\n",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("cleanup skips quests without landing evidence", async () => {
    const fixture = createGitFixture("loopship-native-cleanup-unlanded-");
    try {
      const adapters = createLoopshipFastflowAdapters();
      const workspace = ensureTaskWorkspace(
        fixture.repo,
        "codex/demo",
        join(fixture.repo, "worktrees", "demo"),
        "main",
      );
      createQuest({
        repoRoot: fixture.repo,
        wtree: "demo",
        prompt: "loopship: native cleanup",
        resolutionSource: "test",
        workspace,
        flowId: "swe",
        initialStage: "initial",
      });

      const output = await executeLoopshipAfn(adapters, {
        action: {
          call: LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees,
          with: {
            body: {
              repo: fixture.repo,
              wtree: "demo",
              dry_run: true,
            },
          },
        },
      });
      expect(output.removed_worktrees).toEqual([]);
      expect(output.removed_branches).toEqual([]);
      expect(output.skipped).toEqual([
        expect.objectContaining({
          source: "quest",
          reason: "quest_not_landed",
        }),
      ]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("cleanup rejects worktree symlinks that escape the repository", () => {
    const fixture = createGitFixture("loopship-native-cleanup-symlink-");
    try {
      const workspace = ensureTaskWorkspace(
        fixture.repo,
        "codex/demo",
        join(fixture.repo, "worktrees", "demo"),
        "main",
      );
      const { files, state } = createQuest({
        repoRoot: fixture.repo,
        wtree: "demo",
        prompt: "loopship: native cleanup",
        resolutionSource: "test",
        workspace,
        flowId: "swe",
        initialStage: "archived",
      });
      runGit(fixture.repo, ["branch", "escaped-branch", "main"]);
      const escapedWorkspace = join(fixture.root, "escaped-worktree");
      mkdirSync(escapedWorkspace, { recursive: true });
      const linkedWorkspace = join(fixture.repo, "worktrees", "escaped-link");
      symlinkSync(escapedWorkspace, linkedWorkspace, "dir");
      writeFileSync(
        files.tasks,
        renderTasksYaml({
          ...(state as QuestState),
          stage: "archived",
          landed_commit: runGit(fixture.repo, ["rev-parse", "main"]),
          tasks: [
            questTaskFixture({
              id: "escaped",
              status: "child_archived",
              branch_ref: "escaped-branch",
              worktree_path: linkedWorkspace,
            }),
          ],
        }),
      );

      const output = cleanupLandedWorktrees({
        repo: fixture.repo,
        wtree: "demo",
        dryRun: true,
      });
      expect(output.removed_branches).not.toContain("escaped-branch");
      expect(output.skipped).toContainEqual(
        expect.objectContaining({
          branch: "escaped-branch",
          reason: "outside_repo_worktrees",
        }),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("cleanup preserves a recorded path that was reused by another branch", () => {
    const fixture = createGitFixture("loopship-native-cleanup-reused-worktree-");
    try {
      const coordinator = ensureTaskWorkspace(
        fixture.repo,
        "codex/demo",
        join(fixture.repo, "worktrees", "demo"),
        "main",
      );
      const { files, state } = createQuest({
        repoRoot: fixture.repo,
        wtree: "demo",
        prompt: "loopship: preserve a substituted worktree",
        resolutionSource: "test",
        workspace: coordinator,
        flowId: "swe",
        initialStage: "archived",
      });
      const oldBranch = "codex/recorded-child";
      const reusedPath = join(fixture.repo, "worktrees", "recorded-child");
      runGit(fixture.repo, ["branch", oldBranch, "main"]);
      const unrelated = ensureTaskWorkspace(
        fixture.repo,
        "codex/unrelated-child",
        reusedPath,
        "main",
      );
      writeFileSync(join(unrelated.worktree_path, "UNRELATED.md"), "keep me\n", "utf8");
      runGit(unrelated.worktree_path, ["add", "UNRELATED.md"]);
      runGit(unrelated.worktree_path, ["commit", "-m", "unrelated worktree content"]);
      writeFileSync(
        files.tasks,
        renderTasksYaml({
          ...(state as QuestState),
          stage: "archived",
          landed_commit: runGit(fixture.repo, ["rev-parse", "main"]),
          tasks: [
            questTaskFixture({
              id: "recorded-child",
              status: "child_archived",
              branch_ref: oldBranch,
              worktree_path: reusedPath,
            }),
          ],
        }),
      );

      const dryRun = cleanupLandedWorktrees({
        repo: fixture.repo,
        wtree: "demo",
        dryRun: true,
      });
      expect(dryRun.removed_worktrees).not.toContain(reusedPath);
      expect(dryRun.skipped).toContainEqual(
        expect.objectContaining({
          branch: oldBranch,
          worktree: reusedPath,
          reason: "worktree_branch_mismatch",
        }),
      );

      cleanupLandedWorktrees({ repo: fixture.repo, wtree: "demo" });
      expect(existsSync(reusedPath)).toBe(true);
      expect(readFileSync(join(reusedPath, "UNRELATED.md"), "utf8")).toBe("keep me\n");
      expect(runGit(reusedPath, ["branch", "--show-current"])).toBe(
        "codex/unrelated-child",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("cleanup removes landed merged quest worktrees and branches", async () => {
    const fixture = createGitFixture("loopship-native-cleanup-");
    try {
      const adapters = createLoopshipFastflowAdapters();
      const workspace = ensureTaskWorkspace(
        fixture.repo,
        "codex/demo",
        join(fixture.repo, "worktrees", "demo"),
        "main",
      );
      const { files, state } = createQuest({
        repoRoot: fixture.repo,
        wtree: "demo",
        prompt: "loopship: native cleanup",
        resolutionSource: "test",
        workspace,
        flowId: "swe",
        initialStage: "initial",
      });
      const coordinatorWorktree = String(state.coordinator_worktree);
      const childWorkspace = ensureTaskWorkspace(
        fixture.repo,
        "codex/demo-child",
        join(fixture.repo, "worktrees", "demo-child"),
        "main",
      );
      writeFileSync(join(childWorkspace.worktree_path, "CHILD.md"), "# child\n", "utf8");
      runGit(childWorkspace.worktree_path, ["add", "CHILD.md"]);
      runGit(childWorkspace.worktree_path, ["commit", "-m", "child work"]);
      const childCommit = runGit(childWorkspace.worktree_path, ["rev-parse", "HEAD"]);
      runGit(coordinatorWorktree, ["merge", "--no-ff", "--no-edit", "codex/demo-child"]);
      writeFileSync(
        files.tasks,
        renderTasksYaml({
          ...(state as QuestState),
          tasks: [
            questTaskFixture({
              id: "child",
              title: "Child task",
              acceptance: "done",
              status: "child_archived",
              dependencies: [],
              scope_files: [],
              branch_ref: "codex/demo-child",
              worktree_path: childWorkspace.worktree_path,
              merge_commit: childCommit,
            }),
          ],
        }),
      );

      const landed = await executeLoopshipAfn(adapters, {
        action: {
          call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
          with: {
            body: {
              repo: fixture.repo,
              wtree: "demo",
              source_branch: "codex/demo",
              next_stage: "archived",
            },
          },
        },
      });
      expect(landed).toMatchObject({
        schema_version: "loopship.landing.apply/v1",
        status: "landed",
        next_stage: "archived",
      });

      const dryRunOutput = await executeLoopshipAfn(adapters, {
        action: {
          call: LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees,
          with: {
            body: {
              repo: fixture.repo,
              wtree: "demo",
              dry_run: true,
            },
          },
        },
      });
      expect(dryRunOutput.removed_worktrees).toEqual(
        expect.arrayContaining([childWorkspace.worktree_path, coordinatorWorktree]),
      );

      const unsavedDocs = join(childWorkspace.worktree_path, ".loopship", "docs");
      mkdirSync(unsavedDocs, { recursive: true });
      writeFileSync(join(unsavedDocs, "unsaved.yaml"), "schema_version: 1\n", "utf8");
      const dirtyDryRunOutput = await executeLoopshipAfn(adapters, {
        action: {
          call: LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees,
          with: {
            body: {
              repo: fixture.repo,
              wtree: "demo",
              dry_run: true,
            },
          },
        },
      });
      expect(dirtyDryRunOutput.removed_worktrees).not.toContain(
        childWorkspace.worktree_path,
      );
      expect(dirtyDryRunOutput.skipped).toContainEqual(
        expect.objectContaining({
          branch: "codex/demo-child",
          reason: "dirty_worktree",
        }),
      );
      expect(existsSync(join(unsavedDocs, "unsaved.yaml"))).toBe(true);
      const childGitFile = join(childWorkspace.worktree_path, ".git");
      const childGitLink = readFileSync(childGitFile, "utf8");
      try {
        writeFileSync(childGitFile, "gitdir: /missing/loopship-worktree\n", "utf8");
        await expect(
          executeLoopshipAfn(adapters, {
            action: {
              call: LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees,
              with: {
                body: {
                  repo: fixture.repo,
                  wtree: "demo",
                  dry_run: true,
                },
              },
            },
          }),
        ).rejects.toThrow("cannot inspect Git worktree");
        expect(existsSync(childWorkspace.worktree_path)).toBe(true);
        expect(existsSync(join(unsavedDocs, "unsaved.yaml"))).toBe(true);
      } finally {
        writeFileSync(childGitFile, childGitLink, "utf8");
      }
      rmSync(unsavedDocs, { recursive: true, force: true });
      const fastflowCache = join(fixture.root, "fastflow-cache");
      mkdirSync(fastflowCache, { recursive: true });
      symlinkSync(
        fastflowCache,
        join(childWorkspace.worktree_path, ".loopship", "cache"),
        "dir",
      );

      const cleanupAction = {
        call: LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees,
        with: {
          body: {
            repo: fixture.repo,
            wtree: "demo",
          },
        },
      };
      const cleanupIdentity = {
        executionId: "loopship-cleanup-crash-window",
        effectKey: "loopship-cleanup-crash-window-effect",
      };
      const preparedOutput = { ...dryRunOutput, dry_run: false };
      const receiptRoot = join(fixture.repo, ".loopship", "runtime", "afn-effects");
      mkdirSync(receiptRoot, { recursive: true });
      const cleanupReceiptPath = join(
        receiptRoot,
        `${createHash("sha256").update(cleanupIdentity.effectKey).digest("hex")}.json`,
      );
      writeFileSync(
        cleanupReceiptPath,
        `${JSON.stringify({
          schemaVersion: "loopship.afn-effect-receipt/v1",
          status: "started",
          callId: LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees,
          effectKey: cleanupIdentity.effectKey,
          inputDigest: digestNativeContract({
            callId: LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees,
            body: cleanupAction.with.body,
          }),
          requestId: null,
          preparedOutput,
        })}\n`,
        "utf8",
      );

      // Model a crash after the durable snapshot and only the first removal.
      runGit(fixture.repo, [
        "worktree",
        "remove",
        "--force",
        childWorkspace.worktree_path,
      ]);
      runGit(fixture.repo, ["branch", "-d", "--", "codex/demo-child"]);
      const output = await executeLoopshipAfn(
        adapters,
        { action: cleanupAction },
        cleanupIdentity,
      );
      expect(output).toEqual(preparedOutput);
      expect(output.removed_worktrees).toEqual(
        expect.arrayContaining([childWorkspace.worktree_path, coordinatorWorktree]),
      );
      expect(existsSync(fastflowCache)).toBe(true);
      expect(output.removed_branches).toEqual(
        expect.arrayContaining(["codex/demo-child", "codex/demo"]),
      );
      expect(existsSync(childWorkspace.worktree_path)).toBe(false);
      expect(existsSync(coordinatorWorktree)).toBe(false);
      expect(runGit(fixture.repo, ["branch", "--list", "codex/demo-child"])).toBe("");
      expect(runGit(fixture.repo, ["branch", "--list", "codex/demo"])).toBe("");
      expect(runGit(fixture.repo, ["branch", "--show-current"])).toBe("main");
      expect(JSON.parse(readFileSync(cleanupReceiptPath, "utf8"))).toMatchObject({
        status: "completed",
        output,
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("landing.apply replaces an untracked target .loopship/.gitignore when the source lands a tracked version", async () => {
    const fixture = createGitFixture("loopship-native-landing-loopship-gitignore-");
    try {
      const adapters = createLoopshipFastflowAdapters();
      const workspace = ensureTaskWorkspace(
        fixture.repo,
        "codex/demo",
        join(fixture.repo, "worktrees", "demo"),
        "main",
      );
      const { state } = createQuest({
        repoRoot: fixture.repo,
        wtree: "demo",
        prompt: "loopship: native landing",
        resolutionSource: "test",
        workspace,
        flowId: "swe",
        initialStage: "initial",
      });
      const coordinatorWorktree = String(state.coordinator_worktree);
      const targetLoopshipDir = join(fixture.repo, ".loopship");
      mkdirSync(targetLoopshipDir, { recursive: true });
      writeFileSync(
        join(targetLoopshipDir, ".gitignore"),
        ["# fastflow runtime data", "cache/", "data/", "catalog.db", "catalog.db-shm", "catalog.db-wal", ""].join("\n"),
        "utf8",
      );
      mkdirSync(join(coordinatorWorktree, ".loopship"), { recursive: true });
      writeFileSync(
        join(coordinatorWorktree, ".loopship", ".gitignore"),
        [
          "# fastflow runtime data",
          "runtime/",
          "cache/",
          "data/",
          "catalog.db",
          "catalog.db-shm",
          "catalog.db-wal",
          "",
        ].join("\n"),
        "utf8",
      );
      runGit(coordinatorWorktree, ["add", ".loopship/.gitignore"]);
      runGit(coordinatorWorktree, ["commit", "-m", "add loopship gitignore"]);

      const result = await executeLoopshipAfn(adapters, {
        action: {
          call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
          with: {
            body: {
              repo: fixture.repo,
              wtree: "demo",
              source_branch: "codex/demo",
              next_stage: "archived",
            },
          },
        },
      });

      expect(result).toMatchObject({
        schema_version: "loopship.landing.apply/v1",
        status: "landed",
        next_stage: "archived",
        strategy: "fast-forward",
      });
      expect(readFileSync(join(targetLoopshipDir, ".gitignore"), "utf8")).toContain(
        "runtime/",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("landing.apply commits only canonical Loopship docs and preserves unrelated staged state", async () => {
    const fixture = createGitFixture("loopship-native-landing-durable-loopship-");
    try {
      const adapters = createLoopshipFastflowAdapters();
      const workspace = ensureTaskWorkspace(
        fixture.repo,
        "codex/demo",
        join(fixture.repo, "worktrees", "demo"),
        "main",
      );
      const { files, state } = createQuest({
        repoRoot: fixture.repo,
        wtree: "demo",
        prompt: "loopship: native landing",
        resolutionSource: "test",
        workspace,
        flowId: "swe",
        initialStage: "initial",
      });
      const coordinatorWorktree = String(state.coordinator_worktree);
      mkdirSync(join(coordinatorWorktree, ".loopship", "docs", "software"), { recursive: true });
      mkdirSync(join(coordinatorWorktree, ".loopship", "runtime"), { recursive: true });
      writeFileSync(
        join(coordinatorWorktree, ".loopship", ".gitignore"),
        ["# fastflow runtime data", "runtime/", "cache", "data/", "catalog.db", ""].join("\n"),
      );
      writeFileSync(join(coordinatorWorktree, ".loopship", "system.yaml"), "schema_version: 1\n");
      writeFileSync(
        join(coordinatorWorktree, ".loopship", "docs", "software", "architecture.yaml"),
        "schema_version: 1\n",
      );
      writeFileSync(join(coordinatorWorktree, ".loopship", "signature.yaml"), "schema_version: 1\n");
      writeFileSync(
        join(coordinatorWorktree, ".loopship", "runtime", "transient.json"),
        "{}\n",
      );
      writeFileSync(join(coordinatorWorktree, ".loopship", "cache"), "transient\n");
      writeFileSync(
        join(coordinatorWorktree, ".loopship", "notes.yaml"),
        "owner: user\n",
      );
      writeFileSync(join(coordinatorWorktree, "FEATURE.md"), "# feature\n", "utf8");
      runGit(coordinatorWorktree, ["add", "FEATURE.md"]);
      runGit(coordinatorWorktree, ["commit", "-m", "feature"]);
      runGit(coordinatorWorktree, ["add", ".loopship/notes.yaml"]);

      const result = await executeLoopshipAfn(adapters, {
        action: {
          call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
          with: {
            body: {
              repo: fixture.repo,
              wtree: "demo",
              source_branch: "codex/demo",
              next_stage: "archived",
            },
          },
        },
      });

      expect(String(result.landed_commit)).toMatch(/^[0-9a-f]{40}$/);
      const trackedLoopship = runGit(fixture.repo, ["ls-files", "--", ".loopship"])
        .split(/\r?\n/)
        .filter(Boolean)
        .sort();
      expect(trackedLoopship).toEqual([
        ".loopship/.gitignore",
        ".loopship/docs/software/architecture.yaml",
        ".loopship/signature.yaml",
        ".loopship/system.yaml",
      ]);
      expect(existsSync(join(fixture.repo, ".loopship", "runtime", "tasks.yaml"))).toBe(false);
      expect(existsSync(join(fixture.repo, ".loopship", "cache"))).toBe(false);
      expect(existsSync(join(fixture.repo, ".loopship", "notes.yaml"))).toBe(false);
      expect(
        runGit(coordinatorWorktree, ["diff", "--cached", "--name-only"])
          .split(/\r?\n/)
          .filter(Boolean),
      ).toContain(".loopship/notes.yaml");
      expect(readFileSync(join(fixture.repo, ".loopship", "system.yaml"), "utf8")).toContain(
        "schema_version: 1",
      );
      const landedState = parseTasksYaml(readFileSync(files.tasks, "utf8"));
      expect(landedState.stage).toBe("archived");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("landing.apply skips ignored untracked Loopship gitignore while committing docs", async () => {
    const fixture = createGitFixture("loopship-native-landing-ignored-loopship-gitignore-");
    try {
      writeFileSync(
        join(fixture.repo, ".gitignore"),
        [".loopship/runtime/", ".loopship/.gitignore", ""].join("\n"),
        "utf8",
      );
      runGit(fixture.repo, ["add", ".gitignore"]);
      runGit(fixture.repo, ["commit", "-m", "ignore loopship runtime helpers"]);

      const adapters = createLoopshipFastflowAdapters();
      const workspace = ensureTaskWorkspace(
        fixture.repo,
        "codex/demo",
        join(fixture.repo, "worktrees", "demo"),
        "main",
      );
      const { files, state } = createQuest({
        repoRoot: fixture.repo,
        wtree: "demo",
        prompt: "loopship: native landing",
        resolutionSource: "test",
        workspace,
        flowId: "swe",
        initialStage: "initial",
      });
      const coordinatorWorktree = String(state.coordinator_worktree);
      mkdirSync(join(coordinatorWorktree, ".loopship", "runtime"), { recursive: true });
      writeFileSync(
        join(coordinatorWorktree, ".loopship", ".gitignore"),
        ["# fastflow runtime data", "runtime/", "cache", "data/", "catalog.db", ""].join("\n"),
      );
      writeFileSync(join(coordinatorWorktree, ".loopship", "system.yaml"), "schema_version: 1\n");
      writeFileSync(join(coordinatorWorktree, ".loopship", "signature.yaml"), "schema_version: 1\n");
      writeFileSync(
        join(coordinatorWorktree, ".loopship", "runtime", "transient.json"),
        "{}\n",
      );
      writeFileSync(join(coordinatorWorktree, "FEATURE.md"), "# feature\n", "utf8");
      runGit(coordinatorWorktree, ["add", "FEATURE.md"]);
      runGit(coordinatorWorktree, ["commit", "-m", "feature"]);

      const result = await executeLoopshipAfn(adapters, {
        action: {
          call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
          with: {
            body: {
              repo: fixture.repo,
              wtree: "demo",
              source_branch: "codex/demo",
              next_stage: "archived",
            },
          },
        },
      });

      expect(result).toMatchObject({
        schema_version: "loopship.landing.apply/v1",
        status: "landed",
        next_stage: "archived",
      });
      const trackedLoopship = runGit(fixture.repo, ["ls-files", "--", ".loopship"])
        .split(/\r?\n/)
        .filter(Boolean)
        .sort();
      expect(trackedLoopship).toEqual([
        ".loopship/signature.yaml",
        ".loopship/system.yaml",
      ]);
      expect(existsSync(join(fixture.repo, ".loopship", ".gitignore"))).toBe(false);
      const landedState = parseTasksYaml(readFileSync(files.tasks, "utf8"));
      expect(landedState.stage).toBe("archived");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 10_000);

  test("system update signs non-Loopship repo resources without requiring packaged schemas", () => {
    const fixture = createGitFixture("loopship-native-system-update-external-repo-");
    try {
      writeFileSync(join(fixture.repo, "README.md"), "# Support dashboard\n\nOpen index.html.\n");
      const root = {
        schema_version: 2,
        id: "support-dashboard",
        title: "Support Dashboard",
        kinds: ["software"],
        text: "Browser-only support dashboard fixture.\nIt proves system signatures work in repos without packaged Loopship schemas.",
        scope_in: ["Static local dashboard files."],
        scope_out: ["Packaged Loopship schema files copied into the target repo."],
        objects: [
          {
            id: "support-dashboard",
            kind: "unit",
            text: "Support dashboard application.\nThe fixture is intentionally tiny.",
            state: "active",
          },
        ],
        assertions: [
          {
            id: "external-repo-signature",
            kind: "behaviour",
            level: "must",
            text: "System update must sign target repo resources without requiring packaged schemas in that repo.\nNon-YAML resources must not be parsed as YAML.",
            links: {
              about: ["object:support-dashboard"],
              supported_by: ["resource:readme"],
            },
            state: "active",
          },
        ],
        resources: [
          {
            id: "readme",
            kind: "document",
            role: "canonical",
            location: "README.md",
            schema_ref: "loopship://schemas/docs/software-architecture.yaml",
            text: "README evidence for the support dashboard fixture.\nThis markdown file is a canonical resource but is not YAML.",
            links: { about: ["object:support-dashboard"] },
            state: "active",
          },
        ],
      };

      const touched = applySystemUpdate(
        fixture.repo,
        {
          schema_version: 1,
          mode: "replace",
          summary: "Create system root for external repo fixture.",
          root,
          external_docs: [],
        },
        "test-system-update",
      );

      expect(touched).toContain(join(fixture.repo, ".loopship", "system.yaml"));
      expect(touched).toContain(join(fixture.repo, ".loopship", "signature.yaml"));
      const manifest = parseYaml(
        readFileSync(join(fixture.repo, ".loopship", "signature.yaml"), "utf8"),
      ) as Record<string, unknown>;
      const entries = Array.isArray(manifest.entries)
        ? (manifest.entries as Array<Record<string, unknown>>)
        : [];
      expect(entries.some((entry) => entry.path === "README.md")).toBe(true);
      expect(entries.some((entry) => entry.path === "schemas/system.yaml")).toBe(false);
      expect(verifyRootManifest(fixture.repo)).toMatchObject({ ok: true, errors: [] });
      const manifestPath = join(fixture.repo, ".loopship", "signature.yaml");
      const manifestText = readFileSync(manifestPath, "utf8");
      writeFileSync(
        manifestPath,
        manifestText.replace("key_id: loopship-local-v2", "key_id: unknown-key"),
        "utf8",
      );
      expect(verifyRootManifest(fixture.repo)).toMatchObject({
        ok: false,
        errors: [expect.stringContaining("must include a system_update ed25519 signature")],
      });
      writeFileSync(
        manifestPath,
        manifestText.replace(
          /(^|\n)(\s*value:)\s*[^\n]+/,
          "$1$2 invalid-signature",
        ),
        "utf8",
      );
      expect(verifyRootManifest(fixture.repo)).toMatchObject({
        ok: false,
        errors: [expect.stringContaining("cryptographic verification failed")],
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("catalog child-preparation workflow prepares every ready child through Fastflow", async () => {
    const fixture = createGitFixture("loopship-native-fastflow-executing-");
    try {
      createNativeQuest(fixture.repo, "demo");
      const stepRoot = join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "step");
      const workflow = findWorkflowByCall(loadCatalogWorkflows(stepRoot), LOOPSHIP_AFN_CALLS.childPrepareWorktree);
      const result = await executeNativeWorkflow(workflow, {
        repo: fixture.repo,
        wtree: "demo",
        children: [
          {
            task_id: "task-a",
            title: "Task A",
            child_wtree: "demo-task-a",
            branch_ref: "codex/demo-task-a",
            worktree_path: join(fixture.repo, "worktrees", "demo-task-a"),
            acceptance: "done",
          },
          {
            task_id: "task-b",
            title: "Task B",
            child_wtree: "demo-task-b",
            branch_ref: "codex/demo-task-b",
            worktree_path: join(fixture.repo, "worktrees", "demo-task-b"),
            acceptance: "done",
          },
        ],
      });

      expect(result.output).toMatchObject({
        schema_version: "loopship.child.prepare/v1",
        count: 2,
      });
      expect(result.output.prepared_children).toHaveLength(2);
      expect(result.output.prepared_children.map((child: any) => child.task_id)).toEqual([
        "task-a",
        "task-b",
      ]);
      expect(result.output.prepared_children[0].actions.init.cmd).toBe("loopship");
      expect(result.output.prepared_children[0].actions.init.args).toContain("--repo");
      expect(result.output.prepared_children[0].actions.init.args).toContain(fixture.repo);
      expect(result.output.prepared_children[1].actions.resume).toBeUndefined();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("catalog child-preparation workflow skips blocked dependent children", async () => {
    const fixture = createGitFixture("loopship-native-fastflow-executing-deps-");
    try {
      createNativeQuest(fixture.repo, "demo");
      const stepRoot = join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "step");
      const workflow = findWorkflowByCall(loadCatalogWorkflows(stepRoot), LOOPSHIP_AFN_CALLS.childPrepareWorktree);
      const result = await executeNativeWorkflow(workflow, {
        repo: fixture.repo,
        wtree: "demo",
        children: [
          {
            task_id: "task-a",
            title: "Task A",
            status: "child_received",
            child_wtree: "demo-task-a",
            branch_ref: "codex/demo-task-a",
            worktree_path: join(fixture.repo, "worktrees", "demo-task-a"),
            acceptance: "done",
          },
          {
            task_id: "task-b",
            title: "Task B",
            status: "child_received",
            dependencies: ["task-a"],
            child_wtree: "demo-task-b",
            branch_ref: "codex/demo-task-b",
            worktree_path: join(fixture.repo, "worktrees", "demo-task-b"),
            acceptance: "done",
          },
        ],
      });

      expect(result.output).toMatchObject({
        schema_version: "loopship.child.prepare/v1",
        count: 1,
      });
      expect(result.output.prepared_children).toHaveLength(1);
      expect(result.output.prepared_children[0].task_id).toBe("task-a");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("catalog child-preparation workflow ignores dispatched siblings while launching newly ready dependents", async () => {
    const fixture = createGitFixture("loopship-native-fastflow-executing-redispatch-");
    try {
      createNativeQuest(fixture.repo, "demo");
      const stepRoot = join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "step");
      const workflow = findWorkflowByCall(loadCatalogWorkflows(stepRoot), LOOPSHIP_AFN_CALLS.childPrepareWorktree);
      const result = await executeNativeWorkflow(workflow, {
        repo: fixture.repo,
        wtree: "demo",
        children: [
          {
            task_id: "task-a",
            title: "Task A",
            status: "child_archived",
            child_wtree: "demo-task-a",
            branch_ref: "codex/demo-task-a",
            worktree_path: join(fixture.repo, "worktrees", "demo-task-a"),
            acceptance: "done",
          },
          {
            task_id: "task-b",
            title: "Task B",
            status: "child_received",
            dependencies: ["task-a"],
            child_wtree: "demo-task-b",
            branch_ref: "codex/demo-task-b",
            worktree_path: join(fixture.repo, "worktrees", "demo-task-b"),
            acceptance: "done",
          },
          {
            task_id: "task-c",
            title: "Task C",
            status: "child_dispatched",
            child_wtree: "demo-task-c",
            branch_ref: "codex/demo-task-c",
            worktree_path: join(fixture.repo, "worktrees", "demo-task-c"),
            acceptance: "done",
          },
        ],
      });

      expect(result.output).toMatchObject({
        schema_version: "loopship.child.prepare/v1",
        count: 1,
      });
      expect(result.output.prepared_children).toHaveLength(1);
      expect(result.output.prepared_children[0].task_id).toBe("task-b");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("child.prepare fast-forwards a queued child worktree to the current parent branch", async () => {
    const fixture = createGitFixture("loopship-native-child-base-sync-");
    try {
      const adapters = createLoopshipFastflowAdapters();
      const { state } = createNativeQuest(fixture.repo, "parent");
      const parentWorktree = String(state.coordinator_worktree);
      const childWtree = "parent-task-b";
      const branchRef = "codex/parent-task-b";
      const worktreePath = join(fixture.repo, "worktrees", childWtree);
      const initialParentHead = runGit(parentWorktree, ["rev-parse", "HEAD"]);
      const body = {
        repo: fixture.repo,
        wtree: "parent",
        task: {
          task_id: "task-b",
          title: "Task B",
          child_wtree: childWtree,
          branch_ref: branchRef,
          worktree_path: worktreePath,
          acceptance: "done",
        },
      };

      await executeLoopshipAfn(adapters, {
        action: {
          call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
          with: { body },
        },
      });
      expect(runGit(worktreePath, ["rev-parse", "HEAD"])).toBe(initialParentHead);

      writeFileSync(join(parentWorktree, "FOUNDATION.md"), "# foundation\n", "utf8");
      runGit(parentWorktree, ["add", "FOUNDATION.md"]);
      runGit(parentWorktree, ["commit", "-m", "foundation"]);
      const parentHead = runGit(parentWorktree, ["rev-parse", "HEAD"]);

      await executeLoopshipAfn(adapters, {
        action: {
          call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
          with: { body },
        },
      });

      expect(readFileSync(join(worktreePath, "FOUNDATION.md"), "utf8")).toContain("foundation");
      expect(runGit(worktreePath, ["rev-parse", "HEAD"])).toBe(parentHead);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("catalog landing workflow executes through Fastflow and archives state", async () => {
    const fixture = createGitFixture("loopship-native-fastflow-landing-");
    try {
      const { files, state } = createNativeQuest(fixture.repo, "demo");
      const coordinatorWorktree = String(state.coordinator_worktree);
      writeFileSync(join(coordinatorWorktree, "FASTFLOW.md"), "# fastflow\n", "utf8");
      runGit(coordinatorWorktree, ["add", "FASTFLOW.md"]);
      runGit(coordinatorWorktree, ["commit", "-m", "fastflow native landing"]);

      const stepRoot = join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "step");
      const workflow = findWorkflowByCall(loadCatalogWorkflows(stepRoot), LOOPSHIP_AFN_CALLS.landingApplyOutcome);
      const result = await executeNativeWorkflow(workflow, {
        status: "landed",
        summary: "landed through Fastflow",
        repo: fixture.repo,
        wtree: "demo",
        next_stage: "archived",
      });

      expect(result.output).toMatchObject({
        schema_version: "loopship.landing.apply/v1",
        status: "landed",
        summary: "landed through Fastflow",
        target_branch: "main",
      });
      expect(readFileSync(join(fixture.repo, "FASTFLOW.md"), "utf8")).toContain("fastflow");
      const landedState = parseTasksYaml(readFileSync(files.tasks, "utf8"));
      expect(landedState.stage).toBe("archived");
      expect(String(landedState.landed_commit || "")).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("landing.apply preserves blocked landing without merging", async () => {
    const fixture = createGitFixture("loopship-native-landing-blocked-");
    try {
      const adapters = createLoopshipFastflowAdapters();
      const { files } = createNativeQuest(fixture.repo, "demo");
      const action = {
        call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
        with: {
          body: {
            repo: fixture.repo,
            wtree: "demo",
            status: "blocked",
            summary: "not ready",
            next_stage: "landing_ready",
          },
        },
      };
      const identity = {
        executionId: "loopship-blocked-landing-crash-window",
        effectKey: "loopship-blocked-landing-crash-window-effect",
      };
      const result = await executeLoopshipAfn(adapters, { action }, identity);
      expect(result).toMatchObject({
        schema_version: "loopship.landing.apply/v1",
        dry_run: false,
        status: "blocked",
      });
      const blockedState = parseTasksYaml(readFileSync(files.tasks, "utf8"));
      expect(blockedState.stage).toBe("landing_ready");
      expect(String(blockedState.landed_commit || "")).toBe("");
      const events = readFileSync(files.events, "utf8");
      expect(events).toContain("landing_submitted");

      const receiptRoot = join(fixture.repo, ".loopship", "runtime", "afn-effects");
      const receiptPath = readdirSync(receiptRoot)
        .filter((name) => name.endsWith(".json"))
        .map((name) => join(receiptRoot, name))
        .find((path) => {
          const receipt = JSON.parse(readFileSync(path, "utf8"));
          return receipt.effectKey === identity.effectKey;
        });
      expect(receiptPath).toBeTruthy();
      const receipt = JSON.parse(readFileSync(receiptPath!, "utf8"));
      receipt.status = "started";
      delete receipt.output;
      writeFileSync(receiptPath!, `${JSON.stringify(receipt)}\n`, "utf8");

      expect(await executeLoopshipAfn(adapters, { action }, identity)).toEqual(result);
      expect(readFileSync(files.events, "utf8")).toBe(events);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("committed flow workflows use canonical workflow-data calls", () => {
    const flowRoot = join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "flows");
    for (const workflow of Object.values(loadCatalogWorkflows(flowRoot))) {
      const bodies: Array<Record<string, unknown>> = [];
      walk(workflow, (item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return;
        const object = item as Record<string, any>;
        if (
          object.call === LOOPSHIP_DATA_CALLS.documentRead ||
          object.call === LOOPSHIP_DATA_CALLS.eventLogQuery
        ) {
          bodies.push(object.with?.body ?? {});
        }
      });
      expect(bodies).toContainEqual(expect.objectContaining({
        adapter: "yaml",
        namespace: ".loopship/runtime",
        document: "tasks",
      }));
      expect(bodies).toContainEqual(expect.objectContaining({
        adapter: "jsonl",
        namespace: ".loopship/runtime",
        log: "events",
      }));
    }
  });
});
