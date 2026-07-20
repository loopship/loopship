import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, {
  chmodSync,
  cpSync,
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
  taskAssignmentBranchRef,
  taskAssignmentChildWtree,
  taskAssignmentWorktreePath,
  updateQuestStage,
  verifyQuestManifest,
  verifyRootManifest,
  type QuestState,
  type QuestTask,
} from "./loopship_core.ts";
import {
  LOOPSHIP_AFN_CALLS,
  LOOPSHIP_AFN_DESCRIPTORS,
  LOOPSHIP_AFN_HOST_ID,
  LOOPSHIP_CALL_CATALOG_ROOT,
  LOOPSHIP_DEFAULT_CHILD_MAX_CONCURRENCY,
  LOOPSHIP_DATA_CALLS,
  LOOPSHIP_SUPERVISOR_GUIDANCE,
  cleanupCompletedNativeWorkspaceResidue,
  buildLoopshipChildDagReconciliation,
  cleanupLandedWorktrees,
  createLoopshipFastflowAdapters,
  ensureLoopshipFastflowWorkflowCatalog,
  loopshipFlowWorkflowRef,
  recoverLoopshipFastflowWorkflow,
  resolveLoopshipFastflowRoot,
  resolveLoopshipFlowId,
  resumeLoopshipFastflowWorkflow,
  runLoopshipFastflowWorkflow,
  runLoopshipFastflowWorkflowRequest,
  validateLoopshipChildDag,
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
process.env.LOOPSHIP_ENABLE_FASTFLOW_DEV_ROOT = "1";
let nativeInvocationSequence = 0;

type LoopshipTestAfnOutput = Record<string, unknown> & {
  actions?: Record<string, { args: string[] }>;
  branch_ref?: string;
  landed_commit?: string;
  prepared_children?: Array<Record<string, unknown>>;
};

function loopshipHostDispatch(adapters: Record<string, unknown>) {
  const host = adapters.afnHost as {
    dispatchPort?: {
      listRoutes(): Array<{
        callId: string;
        contractDigest: string;
        implementationDigest: string;
      }>;
      dispatch(invocation: Record<string, unknown>): Promise<Record<string, unknown>>;
      cancel(request: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
  };
  if (!host?.dispatchPort) throw new Error("Loopship AFN host dispatch port is missing");
  return host.dispatchPort;
}

async function executeLoopshipAfn(
  adapters: Record<string, unknown>,
  request: Record<string, unknown> & {
    action?: { call?: string; with?: { body?: Record<string, unknown> } };
  },
  identity: { executionId?: string; effectKey?: string } = {},
): Promise<LoopshipTestAfnOutput> {
  const call = String(request.action?.call || "");
  const dispatch = loopshipHostDispatch(adapters);
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
    affinityRefs: [{ kind: "afn-host", ref: LOOPSHIP_AFN_HOST_ID }],
    grants: [],
  });
  const decision = validateExecutionDecision(
    await dispatch.dispatch(JSON.parse(JSON.stringify(invocation))),
  );
  if (decision.kind === "completed") {
    return decision.output as LoopshipTestAfnOutput;
  }
  throw Object.assign(new Error(
    decision.kind === "failed"
      ? decision.error.message
      : `Loopship AFN '${call}' returned '${decision.kind}'.`,
  ), {
    code: decision.kind === "failed" ? decision.error.code : decision.kind,
  });
}

type LandingHardKillPoint =
  | "after-started"
  | "after-source-state-commit"
  | "before-merge"
  | "after-merge";

function loopshipAfnEffectReceiptPath(repo: string, effectKey: string): string {
  return join(
    repo,
    ".loopship",
    "runtime",
    "afn-effects",
    `${createHash("sha256").update(effectKey).digest("hex")}.json`,
  );
}

async function hardKillLoopshipLandingAt(input: {
  body: Record<string, unknown>;
  executionId: string;
  effectKey: string;
  root: string;
  killPoint: LandingHardKillPoint;
}): Promise<Record<string, unknown>> {
  const wrapperRoot = join(input.root, "git-wrapper");
  mkdirSync(wrapperRoot, { recursive: true });
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapper = join(wrapperRoot, "git");
  const receiptPath = loopshipAfnEffectReceiptPath(
    String(input.body.repo),
    input.effectKey,
  );
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      'if [ "$LOOPSHIP_LANDING_KILL_POINT" = "before-merge" ] && [ "$1" = "merge" ] && grep -q \'"recoverySnapshot"\' "$LOOPSHIP_LANDING_RECEIPT"; then',
      '  kill -9 "$PPID"',
      "  exit 137",
      "fi",
      '"$LOOPSHIP_REAL_GIT" "$@"',
      "status=$?",
      'if [ "$status" -eq 0 ] && [ -f "$LOOPSHIP_LANDING_RECEIPT" ]; then',
      '  if [ "$LOOPSHIP_LANDING_KILL_POINT" = "after-started" ] && ! grep -q \'"recoverySnapshot"\' "$LOOPSHIP_LANDING_RECEIPT"; then',
      '    kill -9 "$PPID"',
      "  fi",
      '  if [ "$LOOPSHIP_LANDING_KILL_POINT" = "after-source-state-commit" ] && [ "$1" = "commit" ] && ! grep -q \'"recoverySnapshot"\' "$LOOPSHIP_LANDING_RECEIPT"; then',
      '    kill -9 "$PPID"',
      "  fi",
      'fi',
      'if [ "$LOOPSHIP_LANDING_KILL_POINT" = "after-merge" ] && [ "$1" = "merge" ] && [ "$status" -eq 0 ]; then',
      '  kill -9 "$PPID"',
      "fi",
      'exit "$status"',
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  const childScript = `
    import {
      createAfnInvocation,
      digestNativeContract,
    } from "@cueintent/fastflow";
    import {
      createLoopshipFastflowAdapters,
      LOOPSHIP_AFN_CALLS,
    } from ${JSON.stringify(pathToFileURL(resolve(process.cwd(), "scripts", "loopship_fastflow.ts")).href)};
    const body = JSON.parse(process.env.LOOPSHIP_LANDING_BODY);
    const executionId = process.env.LOOPSHIP_LANDING_EXECUTION_ID;
    const effectKey = process.env.LOOPSHIP_LANDING_EFFECT_KEY;
    const dispatch = createLoopshipFastflowAdapters().afnHost.dispatchPort;
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
    await dispatch.dispatch(invocation);
  `;
  const child = Bun.spawn({
    cmd: [process.execPath, "--no-install", "-e", childScript],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${wrapperRoot}:${process.env.PATH || ""}`,
      LOOPSHIP_REAL_GIT: realGit,
      LOOPSHIP_LANDING_BODY: JSON.stringify(input.body),
      LOOPSHIP_LANDING_EXECUTION_ID: input.executionId,
      LOOPSHIP_LANDING_EFFECT_KEY: input.effectKey,
      LOOPSHIP_LANDING_KILL_POINT: input.killPoint,
      LOOPSHIP_LANDING_RECEIPT: receiptPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const exit = await Promise.race([
    child.exited,
    Bun.sleep(30_000).then(() => {
      child.kill();
      throw new Error(`timed out waiting for the ${input.killPoint} hard kill`);
    }),
  ]);
  expect(exit, await stderr).not.toBe(0);
  expect(existsSync(receiptPath)).toBe(true);
  return JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
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
        try {
          const result = await executeWorkflow(runtime, record, inputs, {
            workspaceRoot: process.cwd(),
            schedulerMode: "test",
          });
          console.log(JSON.stringify({
            output: result.output,
            error: result.error,
            state: result.state,
            status: result.status,
          }));
        } catch (error) {
          console.log(JSON.stringify({
            thrown: {
              code: typeof error?.code === "string" ? error.code : "",
              message: error instanceof Error ? error.message : String(error),
            },
          }));
        }
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

function createLandingCrashFixture(
  prefix: string,
  mode: "fast-forward" | "merge-commit",
): {
  root: string;
  repo: string;
  files: ReturnType<typeof questFiles>;
  coordinatorWorktree: string;
  body: Record<string, unknown>;
} {
  const fixture = createGitFixture(prefix);
  const workspace = ensureTaskWorkspace(
    fixture.repo,
    "codex/demo",
    join(fixture.repo, "worktrees", "demo"),
    "main",
  );
  const { files } = createQuest({
    repoRoot: fixture.repo,
    wtree: "demo",
    prompt: `loopship: recover an exact ${mode} landing`,
    resolutionSource: "test",
    workspace,
    flowId: "swe",
    initialStage: "landing_ready",
    landingTargetBranch: "main",
    landingTargetWorktree: fixture.repo,
  });
  writeFileSync(
    join(workspace.worktree_path, "FEATURE.md"),
    `# ${mode} recovery\n`,
    "utf8",
  );
  runGit(workspace.worktree_path, ["add", "FEATURE.md"]);
  runGit(workspace.worktree_path, ["commit", "-m", `${mode} source`]);
  if (mode === "merge-commit") {
    writeFileSync(join(fixture.repo, "TARGET.md"), "# divergent target\n", "utf8");
    runGit(fixture.repo, ["add", "TARGET.md"]);
    runGit(fixture.repo, ["commit", "-m", "diverge landing target"]);
  }
  return {
    ...fixture,
    files,
    coordinatorWorktree: workspace.worktree_path,
    body: {
      repo: fixture.repo,
      wtree: "demo",
      source_branch: "codex/demo",
      target_branch: "main",
      target_worktree: fixture.repo,
      next_stage: "archived",
    },
  };
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

function copyLoopshipPackageFixture(targetRoot: string): string {
  mkdirSync(targetRoot, { recursive: true });
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
    files?: unknown;
  };
  const shippedEntries = Array.isArray(manifest.files)
    ? manifest.files.filter(
        (entry): entry is string => typeof entry === "string" && !entry.startsWith("!"),
      )
    : [];
  for (const entry of ["package.json", ...shippedEntries]) {
    const target = resolve(targetRoot, entry);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(resolve(process.cwd(), entry), target, {
      recursive: true,
    });
  }
  symlinkSync(resolve(process.cwd(), "node_modules"), resolve(targetRoot, "node_modules"), "dir");
  return realpathSync(targetRoot);
}

function runFastflowBridgeProbe(input: {
  operation: "run" | "recover";
  request: Record<string, unknown>;
  cwd: string;
  env: Record<string, string>;
}): {
  status: number | null;
  stdout: string;
  stderr: string;
  response: Record<string, unknown>;
} {
  const root = mkdtempSync(join(process.cwd(), "tmp", "loopship-bridge-probe-"));
  const scriptPath = join(root, "probe.mjs");
  const requestPath = join(root, "request.json");
  writeFileSync(requestPath, JSON.stringify(input.request), "utf8");
  writeFileSync(
    scriptPath,
    `
      import { readFileSync } from "node:fs";
      import {
        recoverLoopshipFastflowWorkflow,
        runLoopshipFastflowWorkflowRequest,
      } from ${JSON.stringify(pathToFileURL(resolve(process.cwd(), "scripts", "loopship_fastflow.ts")).href)};

      const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
      try {
        const result = ${JSON.stringify(input.operation)} === "run"
          ? await runLoopshipFastflowWorkflowRequest(request)
          : await recoverLoopshipFastflowWorkflow(request);
        process.stdout.write(JSON.stringify({ ok: true, result }));
      } catch (error) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: {
            code: typeof error?.code === "string" ? error.code : "UNKNOWN",
            message: error instanceof Error ? error.message : String(error),
            retryable: error?.retryable === true,
          },
        }));
        process.exitCode = 23;
      }
    `,
    "utf8",
  );
  try {
    const proc = runCommand(process.execPath, ["--no-install", scriptPath, requestPath], {
      cwd: input.cwd,
      env: input.env,
      timeoutMs: 120_000,
    });
    return {
      ...proc,
      response: parseJsonObject(proc.stdout, "Fastflow production bridge probe"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

describe("Loopship Fastflow-native bridge", () => {
  test("keeps internal child workflows out of the public flow selector", () => {
    expect(resolveLoopshipFlowId()).toBe("swe");
    expect(resolveLoopshipFlowId("swe")).toBe("swe");
    expect(() => resolveLoopshipFlowId("swe-child")).toThrow(
      "Unknown Loopship flow 'swe-child'. Available flows: swe",
    );
  });
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

  test("keeps the tiny SQLite host adapter portable across Bun and Node-standard APIs", () => {
    const root = mkdtempSync(join(tmpdir(), "loopship-node-sqlite-"));
    const databasePath = join(root, "adapter.sqlite");
    const modulePath = resolve(process.cwd(), "scripts", "loopship_sqlite.ts");
    const moduleUrl = pathToFileURL(modulePath).href;
    expect(readFileSync(modulePath, "utf8")).not.toContain("security-worker");
    const source = `
      import { openExclusiveSqliteTransaction } from ${JSON.stringify(moduleUrl)};
      const release = openExclusiveSqliteTransaction(${JSON.stringify(databasePath)}, 10);
      let busy = false;
      try {
        openExclusiveSqliteTransaction(${JSON.stringify(databasePath)}, 10);
      } catch (error) {
        busy = error?.code === "loopship_file_lock_busy";
      }
      release();
      const releaseAgain = openExclusiveSqliteTransaction(${JSON.stringify(databasePath)}, 10);
      releaseAgain();
      if (!busy) throw new Error("Node SQLite adapter did not preserve exclusive locking");
    `;
    try {
      execFileSync("node", ["--input-type=module", "--eval", source], {
        cwd: process.cwd(),
        stdio: "pipe",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses Bun as the sole Loopship application host", () => {
    const nodeVersion = runCommand("node", ["--version"], { cwd: process.cwd() });
    expect(nodeVersion.status).toBe(0);
    expect(nodeVersion.stdout.trim()).toMatch(/^v26\./u);

    const nodeCli = runCommand("node", ["bin/loopship", "--help"], {
      cwd: process.cwd(),
    });
    expect(nodeCli.status).toBe(1);
    expect(nodeCli.stderr).toContain("loopship_bun_runtime_required");

    const nodeRootCli = runCommand("node", ["index.ts", "--help"], {
      cwd: process.cwd(),
    });
    expect(nodeRootCli.status).toBe(1);
    expect(nodeRootCli.stderr).toContain("loopship_bun_runtime_required");

    const guardRoot = mkdtempSync(join(process.cwd(), "tmp", "loopship-bin-guard-"));
    try {
      const guardedCopy = join(guardRoot, "loopship.mjs");
      writeFileSync(
        guardedCopy,
        readFileSync("bin/loopship", "utf8").replace(
          "../scripts/loopship.ts",
          "./missing-app-module.ts",
        ),
        "utf8",
      );
      const guardedNode = runCommand("node", [guardedCopy, "--help"], {
        cwd: process.cwd(),
      });
      expect(guardedNode.status).toBe(1);
      expect(guardedNode.stderr).toContain("loopship_bun_runtime_required");
      expect(guardedNode.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    } finally {
      rmSync(guardRoot, { recursive: true, force: true });
    }

    const nodeDaemon = runCommand("node", ["bin/loopship-fastflow-daemon"], {
      cwd: process.cwd(),
    });
    expect(nodeDaemon.status).toBe(1);
    expect(nodeDaemon.stderr).toContain("loopship_bun_runtime_required");

    const nodeDaemonModule = runCommand(
      "node",
      ["scripts/loopship_fastflow_daemon.mjs"],
      { cwd: process.cwd() },
    );
    expect(nodeDaemonModule.status).toBe(1);
    expect(nodeDaemonModule.stderr).toContain("loopship_bun_runtime_required");

    const bunCli = runCommand(process.execPath, ["bin/loopship", "--help"], {
      cwd: process.cwd(),
    });
    expect(bunCli.status).toBe(0);
    expect(bunCli.stdout).toContain("Usage:");
  });

  test("keeps the Fastflow source-root override behind an explicit development opt-in", () => {
    const previousRoot = process.env.LOOPSHIP_FASTFLOW_ROOT;
    const previousOptIn = process.env.LOOPSHIP_ENABLE_FASTFLOW_DEV_ROOT;
    const fastflowRoot = resolveFastflowRoot(["src/index.mjs"]);
    const incompleteRoot = mkdtempSync(
      join(process.cwd(), "tmp", "loopship-incomplete-fastflow-root-"),
    );
    try {
      process.env.LOOPSHIP_FASTFLOW_ROOT = fastflowRoot;
      delete process.env.LOOPSHIP_ENABLE_FASTFLOW_DEV_ROOT;
      expect(() => resolveLoopshipFastflowRoot(["src/index.mjs"])).toThrow(
        "loopship_fastflow_dev_root_disabled",
      );

      const {
        LOOPSHIP_ENABLE_FASTFLOW_DEV_ROOT: _ignoredOptIn,
        ...productionEnv
      } = process.env;
      const daemon = runCommand(
        process.execPath,
        ["--no-install", "bin/loopship-fastflow-daemon"],
        {
          cwd: process.cwd(),
          env: productionEnv,
          timeoutMs: 10_000,
        },
      );
      expect(daemon.status).toBe(1);
      expect(daemon.stderr).toContain("loopship_fastflow_dev_root_disabled");

      process.env.LOOPSHIP_ENABLE_FASTFLOW_DEV_ROOT = "1";
      expect(resolveLoopshipFastflowRoot(["src/index.mjs"])).toBe(
        resolve(fastflowRoot),
      );
      process.env.LOOPSHIP_FASTFLOW_ROOT = incompleteRoot;
      expect(() => resolveLoopshipFastflowRoot(["src/index.mjs"])).toThrow(
        "configured LOOPSHIP_FASTFLOW_ROOT is not a complete Fastflow runtime",
      );
    } finally {
      if (previousRoot === undefined) delete process.env.LOOPSHIP_FASTFLOW_ROOT;
      else process.env.LOOPSHIP_FASTFLOW_ROOT = previousRoot;
      if (previousOptIn === undefined) {
        delete process.env.LOOPSHIP_ENABLE_FASTFLOW_DEV_ROOT;
      } else {
        process.env.LOOPSHIP_ENABLE_FASTFLOW_DEV_ROOT = previousOptIn;
      }
      rmSync(incompleteRoot, { recursive: true, force: true });
    }
  });

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
    expect(packageJson.version).toBe("2.0.0");
    expect(packageJson.engines.node).toBeUndefined();
    expect(packageJson.engines.bun).toBe(">=1.3.0");
    expect(packageJson.dependencies["@cueintent/fastflow"]).toBe(
      "git+https://github.com/cueintent/fastflow.git#4b080043509fa80fa15823816781eb5ff0a46072",
    );
    expect(packageJson.resolutions?.["@cueintent/fastflow"]).toBe(
      "git+https://github.com/cueintent/fastflow.git#4b080043509fa80fa15823816781eb5ff0a46072",
    );
    expect(packageJson.bundledDependencies).toEqual(["@cueintent/fastflow"]);
    expect(packageJson.dependencies.cmdproto).toBe(
      "git+https://github.com/omar391/cmdproto.git#9d2b675aba6d22c6f2b8100fedec64b7bd7a7f63",
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
    expect(readme).toContain("Node 26.x is required only");
    expect(readme).toContain("pinned, operator-approved scripts");
    expect(readme).toContain(
      "Node's permission model does not isolate arbitrary hostile code",
    );
    expect(readme).toContain("Bun may replace it only after matching this tested boundary");
    expect(readme).toContain("Node is not a second");
    expect(readme).toContain("complete executable proof of concept");
    expect(readme).toContain("CueIntent is architecture/spec-only today");
    expect(readme).toContain("future extraction");
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
      const routeDigests = loopshipHostDispatch(adapters)
        .listRoutes()
        .map((route) => route.implementationDigest);
      expect(new Set(routeDigests)).toEqual(
        new Set([String(implementation.implementation_digest)]),
      );
    },
    { timeout: 30_000 },
  );

  test(
    "starts the durable daemon and a Native session from a clean packed install",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "loopship-packed-daemon-")));
      const consumer = join(root, "consumer");
      let fixture: ReturnType<typeof createGitFixture> | null = null;
      let daemon: ReturnType<typeof Bun.spawn> | null = null;
      try {
        mkdirSync(consumer, { recursive: true });
        const loopshipHome = join(root, "home");
        mkdirSync(loopshipHome, { recursive: true });
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
          LOOPSHIP_ENABLE_FASTFLOW_DEV_ROOT: _ignoredDevRootOptIn,
          LOOPSHIP_FASTFLOW_ROOT: _ignoredFastflowRoot,
          ...baseEnv
        } = process.env;
        const schedulerDb = join(root, "scheduler", "native-v1.sqlite");
        daemon = Bun.spawn({
          cmd: [binPath],
          cwd: consumer,
          env: {
            ...baseEnv,
            HOME: loopshipHome,
            LOOPSHIP_HOME: loopshipHome,
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
          scheduler: "fastflow.scheduler.portable/v1",
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
              HOME: loopshipHome,
              LOOPSHIP_HOME: loopshipHome,
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
        expect(response).toMatchObject({
          schemaVersion: "fastflow/workflow-run-artifact/v1",
          kind: "workflow_result",
          status: "running",
          accepted: true,
          queued: true,
        });
        expect(String(response.executionId || "")).toMatch(/^loopship-[0-9a-f]{64}$/);
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

      const oldShape = ensureCoordinatorWorkspace(fixture.repo, "legacy-old-shape");
      const oldRuntime = join(oldShape.worktree_path, ".loopship", "runtime");
      mkdirSync(oldRuntime, { recursive: true });
      writeFileSync(
        join(oldRuntime, "tasks.yaml"),
        "schema_version: 3\ntree: legacy-old-shape\nstage: executing\n",
        "utf8",
      );
      await expect(
        recoverLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          wtree: "legacy-old-shape",
        }),
      ).rejects.toMatchObject({ code: "legacy_execution_unsupported" });
      await expect(
        runLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          flowId: "swe",
          inputs: {
            request: "loopship: reject old-shaped legacy state",
            repoRoot: fixture.repo,
            wtree: "legacy-old-shape",
          },
        }),
      ).rejects.toMatchObject({ code: "legacy_execution_unsupported" });

      const ledgerWtree = "legacy-schema-with-ledger";
      const ledgerPrompt = "loopship: reject old state even when a Native ledger exists";
      const ledgerWorkspace = ensureCoordinatorWorkspace(fixture.repo, ledgerWtree);
      resolveLoopshipNativeExecutionRequest(ledgerWorkspace.worktree_path, {
        workflowRef: loopshipFlowWorkflowRef("swe"),
        inputs: {
          request: ledgerPrompt,
          repo: fixture.repo,
          repoRoot: fixture.repo,
          runtime: "codex",
          wtree: ledgerWtree,
        },
      });
      const { files: ledgerFiles } = createQuest({
        repoRoot: fixture.repo,
        wtree: ledgerWtree,
        prompt: ledgerPrompt,
        resolutionSource: "fastflow",
        workspace: ledgerWorkspace,
        flowId: "swe",
        initialStage: "initial",
        landingTargetBranch: "main",
        landingTargetWorktree: fixture.repo,
      });
      writeFileSync(
        ledgerFiles.tasks,
        readFileSync(ledgerFiles.tasks, "utf8").replace(
          "schema_version: 5",
          "schema_version: 4",
        ),
        "utf8",
      );
      await expect(
        recoverLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          wtree: ledgerWtree,
        }),
      ).rejects.toMatchObject({ code: "legacy_execution_unsupported" });

      const v1LedgerWtree = "legacy-v1-ledger";
      const v1LedgerPrompt = "loopship: reject a pre-cut Native execution ledger";
      const v1LedgerWorkspace = ensureCoordinatorWorkspace(fixture.repo, v1LedgerWtree);
      resolveLoopshipNativeExecutionRequest(v1LedgerWorkspace.worktree_path, {
        workflowRef: loopshipFlowWorkflowRef("swe"),
        inputs: {
          request: v1LedgerPrompt,
          repo: fixture.repo,
          repoRoot: fixture.repo,
          runtime: "codex",
          wtree: v1LedgerWtree,
        },
      });
      createQuest({
        repoRoot: fixture.repo,
        wtree: v1LedgerWtree,
        prompt: v1LedgerPrompt,
        resolutionSource: "fastflow",
        workspace: v1LedgerWorkspace,
        flowId: "swe",
        initialStage: "initial",
        landingTargetBranch: "main",
        landingTargetWorktree: fixture.repo,
      });
      const v1LedgerPath = join(
        v1LedgerWorkspace.worktree_path,
        ".loopship",
        "runtime",
        "native-execution.json",
      );
      const v1Ledger = JSON.parse(readFileSync(v1LedgerPath, "utf8"));
      v1Ledger.schemaVersion = "loopship.native-execution-request/v1";
      writeFileSync(v1LedgerPath, `${JSON.stringify(v1Ledger)}\n`, "utf8");
      await expect(
        recoverLoopshipFastflowWorkflow({
          repoRoot: fixture.repo,
          wtree: v1LedgerWtree,
        }),
      ).rejects.toMatchObject({ code: "legacy_execution_unsupported" });
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
      for (const [field, inputs] of [
        [
          "request",
          {
            request: 42,
            prompt: "loopship: reject a malformed preferred request alias",
            repoRoot: fixture.repo,
            wtree: "malformed-request-alias",
          },
        ],
        [
          "targetBranch",
          {
            request: "loopship: reject a malformed preferred target alias",
            repoRoot: fixture.repo,
            targetBranch: 42,
            target_branch: "main",
            wtree: "malformed-target-alias",
          },
        ],
        [
          "parent_wtree",
          {
            request: "loopship: reject a malformed secondary parent alias",
            repoRoot: fixture.repo,
            parentWtree: "parent",
            parent_wtree: { invalid: true },
            wtree: "malformed-parent-alias",
          },
        ],
      ] as const) {
        await expect(
          runLoopshipFastflowWorkflow({
            repoRoot: fixture.repo,
            flowId: "swe",
            inputs,
          }),
        ).rejects.toThrow(`inputs.${field} must be a non-empty string`);
      }
      expect(existsSync(join(fixture.repo, "worktrees", "foreign-repo-root"))).toBe(false);
      expect(existsSync(join(fixture.repo, "worktrees", "foreign-repo-alias"))).toBe(false);
      expect(existsSync(join(fixture.repo, "worktrees", "conflicting-target-aliases"))).toBe(false);
      expect(existsSync(join(fixture.repo, "worktrees", "malformed-request-alias"))).toBe(false);
      expect(existsSync(join(fixture.repo, "worktrees", "malformed-target-alias"))).toBe(false);
      expect(existsSync(join(fixture.repo, "worktrees", "malformed-parent-alias"))).toBe(false);
      expect(existsSync(join(foreign.repo, ".loopship", "runtime"))).toBe(false);
    } finally {
      rmSync(foreign.root, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects malformed persisted Native aliases before recovery mutation", async () => {
    const fixture = createGitFixture("loopship-native-malformed-recovery-alias-");
    const wtree = "malformed-recovery-alias";
    const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
    try {
      resolveLoopshipNativeExecutionRequest(workspace.worktree_path, {
        workflowRef: loopshipFlowWorkflowRef("swe"),
        inputs: {
          request: "loopship: reject a malformed persisted alias",
          prompt: { invalid: true },
          repo: fixture.repo,
          repoRoot: fixture.repo,
          wtree,
        },
      });
      const { files } = createQuest({
        repoRoot: fixture.repo,
        wtree,
        prompt: "loopship: reject a malformed persisted alias",
        resolutionSource: "test",
        workspace,
        flowId: "swe",
        initialStage: "initial",
      });
      const ledgerPath = join(
        workspace.worktree_path,
        ".loopship",
        "runtime",
        "native-execution.json",
      );
      const before = new Map(
        [ledgerPath, files.tasks, files.events, files.manifest, files.hook_state].map(
          (path) => [path, readFileSync(path, "utf8")],
        ),
      );

      await expect(
        recoverLoopshipFastflowWorkflow({ repoRoot: fixture.repo, wtree }),
      ).rejects.toThrow("inputs.prompt must be a non-empty string");

      for (const [path, content] of before) {
        expect(readFileSync(path, "utf8"), path).toBe(content);
      }
    } finally {
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

  test("rejects an unsupported scheduler database before claiming quest state", async () => {
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
      process.env.FASTFLOW_SCHEDULER_DB = join(schedulerRoot, "native-v1.sqlite");
      process.env.LOOPSHIP_HOME = join(fixture.root, "loopship-home");
      process.env.FASTFLOW_SCHEDULER_MODE = " local-durable ";

      const daemon = runCommand(
        process.execPath,
        ["--no-install", resolve(process.cwd(), "bin", "loopship-fastflow-daemon")],
        { cwd: fixture.repo, timeoutMs: 10_000 },
      );
      expect(daemon.status).not.toBe(0);
      expect(daemon.stderr).toContain("FASTFLOW_UNSUPPORTED_DURABLE_FILESYSTEM");
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
      ).rejects.toThrow("is registered to a detached HEAD");
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

  test("rejects quest state without a Native v1 ledger before inspecting a tampered document", async () => {
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
      ).rejects.toMatchObject({ code: "legacy_execution_unsupported" });
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

      expect(
        await recoverLoopshipFastflowWorkflow({ repoRoot: fixture.repo, wtree }),
      ).toMatchObject({
        schemaVersion: "fastflow/workflow-run-artifact/v1",
        kind: "workflow_result",
        status: "running",
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
          schemaVersion: "loopship.afn-effect-receipt/v2",
          status: "completed",
          callId: LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees,
          effectKey: "effect:cleanup",
          inputDigest: digestNativeContract({ fixture: "cleanup" }),
          requestId: null,
          preparedOutput: {
            repo: fixture.repo,
            wtree: "residue",
            removed_worktrees: [workspaceRoot],
            removed_branches: [],
          },
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
          schemaVersion: "loopship.afn-effect-receipt/v2",
          status: "completed",
          callId: LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees,
          effectKey: "effect:terminal-cleanup",
          inputDigest: digestNativeContract({ fixture: "terminal-cleanup" }),
          requestId: null,
          preparedOutput: {
            repo: fixture.repo,
            wtree: "terminal-residue",
            removed_worktrees: [workspaceRoot],
            removed_branches: [],
          },
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
          schemaVersion: "loopship.afn-effect-receipt/v2",
          status: "completed",
          callId: LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees,
          effectKey: "effect:cleanup-race",
          inputDigest: digestNativeContract({ fixture: "cleanup-race" }),
          requestId: null,
          preparedOutput: {
            repo: fixture.repo,
            wtree: "cleanup-race",
            removed_worktrees: [workspaceRoot],
            removed_branches: [],
          },
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
      LOOPSHIP_AFN_CALLS.childBuildDagReconciliation,
      LOOPSHIP_AFN_CALLS.childPrepareWorktree,
      LOOPSHIP_AFN_CALLS.childRecordLifecycle,
      LOOPSHIP_AFN_CALLS.childValidateDag,
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

  test("exposes exact Native Loopship routes only through its host session", () => {
    const adapters = createLoopshipFastflowAdapters();
    const dispatch = loopshipHostDispatch(adapters);
    const bindingPort = adapters.afnBindingPort as {
      listRoutes(): Array<{ callId: string }>;
    };
    const host = adapters.afnHost as Record<string, unknown>;
    const routes = dispatch.listRoutes();
    expect(adapters.executeAfn).toBeUndefined();
    expect(adapters.afnDispatch).toBeUndefined();
    expect(adapters.runtimeOffer).toBeUndefined();
    expect(host.hostId).toBe(LOOPSHIP_AFN_HOST_ID);
    expect(host.acceptedGrantKinds).toEqual(["filesystem", "git", "process"]);
    expect(host.affinity).toEqual([{ kind: "git-worktree", refs: ["*"] }]);
    expect(routes.map((route) => route.callId).sort()).toEqual(
      LOOPSHIP_AFN_DESCRIPTORS.map((descriptor) => descriptor.call).sort(),
    );
    expect(bindingPort.listRoutes()).toEqual(routes);
  });

  test("pins one stable host and an opaque canonical worktree affinity", async () => {
    const fixture = createGitFixture("loopship-native-host-binding-");
    try {
      const adapters = createLoopshipFastflowAdapters();
      const resolveBinding = adapters.resolveExecutionBinding as (
        input: Record<string, unknown>,
      ) => Record<string, unknown>;
      const binding = resolveBinding({
        inputs: {
          repoRoot: fixture.repo,
          wtree: "host-binding",
        },
      });
      expect(binding).toMatchObject({
        schemaVersion: "loopship.execution-binding/v1",
        affinityRefs: [
          { kind: "afn-host", ref: LOOPSHIP_AFN_HOST_ID },
          { kind: "git-worktree" },
        ],
      });
      expect(JSON.stringify(binding)).not.toContain(fixture.repo);

      const bindingPort = adapters.afnBindingPort as {
        bind(input: Record<string, unknown>): Promise<Record<string, unknown>>;
      };
      const route = loopshipHostDispatch(adapters).listRoutes()[0]!;
      expect(await bindingPort.bind({
        executionId: "loopship-binding-test",
        nodeId: "afn",
        effectKey: "loopship-binding-effect",
        call: route,
        input: {},
        bindingContext: {},
      })).toEqual({
        affinityRefs: [{ kind: "afn-host", ref: LOOPSHIP_AFN_HOST_ID }],
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
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
        schemaVersion: "loopship.afn-effect-receipt/v2",
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

  test("rejects released v1 AFN effect receipts without interpreting or rewriting them", async () => {
    const fixture = createGitFixture("loopship-native-legacy-effect-receipt-");
    try {
      ensureSystemScaffold(fixture.repo);
      const systemPath = join(fixture.repo, ".loopship", "system.yaml");
      const signaturePath = join(fixture.repo, ".loopship", "signature.yaml");
      const systemBefore = readFileSync(systemPath, "utf8");
      const signatureBefore = readFileSync(signaturePath, "utf8");
      const root = parseYaml(systemBefore) as Record<string, unknown>;
      const adapters = createLoopshipFastflowAdapters();
      for (const status of ["started", "completed"] as const) {
        const identity = {
          executionId: `loopship-legacy-effect-${status}`,
          effectKey: `loopship-legacy-effect-${status}-key`,
        };
        const body = {
          repo: fixture.repo,
          request_id: `legacy-effect-${status}`,
          update: {
            schema_version: 1,
            mode: "replace",
            summary: `Legacy ${status} receipt must fail closed.`,
            root,
            external_docs: [],
          },
        };
        const receiptPath = loopshipAfnEffectReceiptPath(fixture.repo, identity.effectKey);
        mkdirSync(dirname(receiptPath), { recursive: true });
        const receiptText = `${JSON.stringify({
          schemaVersion: "loopship.afn-effect-receipt/v1",
          status,
          callId: LOOPSHIP_AFN_CALLS.systemApplyUpdate,
          effectKey: identity.effectKey,
          inputDigest: digestNativeContract({
            callId: LOOPSHIP_AFN_CALLS.systemApplyUpdate,
            body,
          } as unknown as JsonValue),
          requestId: body.request_id,
          ...(status === "completed"
            ? {
                output: {
                  schema_version: "loopship.system.apply/v1",
                  dry_run: false,
                  touched: [systemPath, signaturePath],
                },
              }
            : {}),
        })}\n`;
        writeFileSync(receiptPath, receiptText, "utf8");

        await expect(
          executeLoopshipAfn(
            adapters,
            {
              action: {
                call: LOOPSHIP_AFN_CALLS.systemApplyUpdate,
                with: { body },
              },
            },
            identity,
          ),
        ).rejects.toMatchObject({ code: "legacy_execution_unsupported" });
        expect(readFileSync(receiptPath, "utf8")).toBe(receiptText);
        expect(existsSync(`${receiptPath}.lock.sqlite`)).toBe(false);
        expect(readFileSync(systemPath, "utf8")).toBe(systemBefore);
        expect(readFileSync(signaturePath, "utf8")).toBe(signatureBefore);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("fails closed on malformed, unknown, or structurally corrupt v2 AFN receipts", async () => {
    const fixture = createGitFixture("loopship-native-invalid-effect-receipt-");
    try {
      ensureSystemScaffold(fixture.repo);
      const systemPath = join(fixture.repo, ".loopship", "system.yaml");
      const systemBefore = readFileSync(systemPath, "utf8");
      const root = parseYaml(systemBefore) as Record<string, unknown>;
      const adapters = createLoopshipFastflowAdapters();
      for (const invalid of [
        "malformed",
        "unknown-version",
        "completed-without-output",
        "started-with-output",
        "invalid-call-id",
        "invalid-effect-key",
        "invalid-input-digest",
        "invalid-request-id",
        "unknown-field",
        "foreign-prepared-output",
        "foreign-recovery-snapshot",
      ] as const) {
        const identity = {
          executionId: `loopship-invalid-effect-${invalid}`,
          effectKey: `loopship-invalid-effect-${invalid}-key`,
        };
        const body = {
          repo: fixture.repo,
          request_id: `invalid-effect-${invalid}`,
          update: {
            schema_version: 1,
            mode: "replace",
            summary: `Invalid ${invalid} receipt must fail closed.`,
            root,
            external_docs: [],
          },
        };
        const receiptPath = loopshipAfnEffectReceiptPath(fixture.repo, identity.effectKey);
        mkdirSync(dirname(receiptPath), { recursive: true });
        const baseReceipt: Record<string, unknown> = {
          schemaVersion: "loopship.afn-effect-receipt/v2",
          status: "started",
          callId: LOOPSHIP_AFN_CALLS.systemApplyUpdate,
          effectKey: identity.effectKey,
          inputDigest: digestNativeContract({
            callId: LOOPSHIP_AFN_CALLS.systemApplyUpdate,
            body,
          } as unknown as JsonValue),
          requestId: body.request_id,
        };
        if (invalid === "unknown-version") {
          baseReceipt.schemaVersion = "loopship.afn-effect-receipt/v999";
        } else if (invalid === "completed-without-output") {
          baseReceipt.status = "completed";
        } else if (invalid === "started-with-output") {
          baseReceipt.output = {};
        } else if (invalid === "invalid-call-id") {
          baseReceipt.callId = 42;
        } else if (invalid === "invalid-effect-key") {
          baseReceipt.effectKey = 42;
        } else if (invalid === "invalid-input-digest") {
          baseReceipt.inputDigest = "sha256:not-a-contract-digest";
        } else if (invalid === "invalid-request-id") {
          baseReceipt.requestId = {};
        } else if (invalid === "unknown-field") {
          baseReceipt.unexpected = true;
        } else if (invalid === "foreign-prepared-output") {
          baseReceipt.preparedOutput = {};
        } else if (invalid === "foreign-recovery-snapshot") {
          baseReceipt.recoverySnapshot = {};
        }
        const receiptText = invalid === "malformed"
          ? "{not-json\n"
          : `${JSON.stringify(baseReceipt)}\n`;
        writeFileSync(receiptPath, receiptText, "utf8");

        await expect(
          executeLoopshipAfn(
            adapters,
            {
              action: {
                call: LOOPSHIP_AFN_CALLS.systemApplyUpdate,
                with: { body },
              },
            },
            identity,
          ),
        ).rejects.toThrow(
          invalid === "malformed"
            ? "invalid Loopship AFN effect receipt"
            : invalid === "unknown-version"
              ? "unsupported Loopship AFN effect receipt schema"
              : "invalid Loopship AFN effect receipt",
        );
        expect(readFileSync(receiptPath, "utf8")).toBe(receiptText);
        expect(existsSync(`${receiptPath}.lock.sqlite`)).toBe(false);
        expect(readFileSync(systemPath, "utf8")).toBe(systemBefore);
      }

      const quest = createNativeQuest(fixture.repo, "corrupt-receipt-snapshots");
      const questBytes = {
        tasks: readFileSync(quest.files.tasks, "utf8"),
        events: readFileSync(quest.files.events, "utf8"),
        manifest: readFileSync(quest.files.manifest, "utf8"),
      };
      for (const invalid of ["cleanup-missing-snapshot", "landing-invalid-snapshot"] as const) {
        const callId = invalid === "cleanup-missing-snapshot"
          ? LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees
          : LOOPSHIP_AFN_CALLS.landingApplyOutcome;
        const identity = {
          executionId: `loopship-${invalid}`,
          effectKey: `loopship-${invalid}-effect`,
        };
        const body: Record<string, unknown> = {
          repo: fixture.repo,
          wtree: "corrupt-receipt-snapshots",
          ...(invalid === "landing-invalid-snapshot"
            ? { status: "blocked", next_stage: "initial", request_id: invalid }
            : {}),
        };
        const receiptPath = loopshipAfnEffectReceiptPath(fixture.repo, identity.effectKey);
        const receiptText = `${JSON.stringify({
          schemaVersion: "loopship.afn-effect-receipt/v2",
          status: "started",
          callId,
          effectKey: identity.effectKey,
          inputDigest: digestNativeContract({ callId, body } as unknown as JsonValue),
          requestId: invalid === "cleanup-missing-snapshot" ? null : body.request_id,
          ...(invalid === "landing-invalid-snapshot" ? { recoverySnapshot: {} } : {}),
        })}\n`;
        writeFileSync(receiptPath, receiptText, "utf8");

        await expect(
          executeLoopshipAfn(
            adapters,
            { action: { call: callId, with: { body } } },
            identity,
          ),
        ).rejects.toThrow(
          invalid === "landing-invalid-snapshot"
            ? "invalid Loopship landing recovery snapshot"
            : "invalid Loopship AFN effect receipt",
        );
        expect(readFileSync(receiptPath, "utf8")).toBe(receiptText);
        expect(existsSync(`${receiptPath}.lock.sqlite`)).toBe(false);
        expect(readFileSync(quest.files.tasks, "utf8")).toBe(questBytes.tasks);
        expect(readFileSync(quest.files.events, "utf8")).toBe(questBytes.events);
        expect(readFileSync(quest.files.manifest, "utf8")).toBe(questBytes.manifest);
      }
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
      const contenderResults = await Promise.all(contenders.map(async (child) => {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      }));
      expect(
        contenderResults.map((result) => result.exitCode),
        JSON.stringify(contenderResults),
      ).toEqual([0, 0]);
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

      const removedFullHook = runLoopshipCli(fixture.repo, ["hook", "--full"]);
      expect(removedFullHook.status).toBe(1);
      expect(removedFullHook.stderr).toContain("unknown hook argument: --full");

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

      const removedFullStepper = runLoopshipCli(fixture.repo, [
        "stepper",
        "init",
        "loopship: test",
        "--full",
      ]);
      expect(removedFullStepper.status).toBe(1);
      expect(removedFullStepper.stderr).toContain("Unknown option for init: --full");

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
      expect(scheduler.env.LOOPSHIP_HOME).toBeTruthy();
      expect(
        existsSync(
          join(String(scheduler.env.LOOPSHIP_HOME), "scheduler", "native-v1.runtime.json"),
        ),
      ).toBe(true);
      const started = await startQuestStage(
        fixture.repo,
        "loopship: resume canonical native execution",
        "resume-canonical",
        [],
        scheduler.env,
      );
      expect(started).toMatchObject({
        schemaVersion: "fastflow/workflow-run-artifact/v1",
        kind: "workflow_result",
        status: "running",
        accepted: true,
        queued: true,
      });
      const startedExecutionId = String(started.executionId || "");
      expect(startedExecutionId).toMatch(/^loopship-[0-9a-f]{64}$/);

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
      const recoveredExecutionId = recoveredPause?.sessionId || String(result.executionId || "");
      expect(recoveredExecutionId, JSON.stringify(result)).toBe(startedExecutionId);
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

  test("production daemon Connect preserves legacy_execution_unsupported", async () => {
    const fixture = createGitFixture("loopship-native-connect-legacy-");
    const schedulerDb = join(fixture.root, "scheduler", "native-v1.sqlite");
    let scheduler: LoopshipTestScheduler | null = null;
    try {
      scheduler = await startLoopshipTestScheduler({
        dbPath: schedulerDb,
        home: resolve(fixture.repo, "..", "home"),
      });
      const wtree = "connect-legacy";
      const prompt = "loopship: reject a persisted legacy execution";
      const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
      const targetWorktree = landingTargetWorktreePath(fixture.repo, "main");
      const inputs = {
        request: prompt,
        prompt,
        repo: fixture.repo,
        repoRoot: fixture.repo,
        runtime: "codex",
        wtree,
        sourceBranch: workspace.branch_ref,
        source_branch: workspace.branch_ref,
        targetBranch: "main",
        target_branch: "main",
        targetWorktree,
        target_worktree: targetWorktree,
      };
      const request = {
        workflowRef: loopshipFlowWorkflowRef("swe"),
        inputs,
      };
      const native = resolveLoopshipNativeExecutionRequest(
        workspace.worktree_path,
        request,
      );
      createFastflowQuest(fixture.repo, wtree, prompt);

      const database = new Database(schedulerDb);
      try {
        database.exec("PRAGMA busy_timeout = 5000");
        database.run(
          `insert into scheduler_execution_children
            (parent_execution_id, child_execution_id, schema_version)
           values (?, ?, ?)`,
          [
            "legacy-parent",
            native.executionId,
            "fastflow.scheduler-child/legacy-v1",
          ],
        );
      } finally {
        database.close();
      }

      const probe = runFastflowBridgeProbe({
        operation: "run",
        request: {
          repoRoot: fixture.repo,
          workspaceRoot: workspace.worktree_path,
          request,
        },
        cwd: workspace.worktree_path,
        env: scheduler.env,
      });
      expect(probe.status, probe.stderr || probe.stdout).toBe(23);
      expect(probe.response).toMatchObject({
        ok: false,
        error: {
          code: "legacy_execution_unsupported",
          retryable: false,
        },
      });
      expect(String((probe.response.error as Record<string, unknown>).message)).toContain(
        "must be resubmitted as new Native v1 executions",
      );
      expect(readLoopshipNativeExecutionRequest(workspace.worktree_path)).toMatchObject({
        executionId: native.executionId,
        status: "pending",
      });
    } finally {
      await scheduler?.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 120_000);

  test("production daemon Connect preserves incompatible-plan recovery guidance", async () => {
    const fixture = createGitFixture("loopship-native-connect-plan-incompatible-");
    const schedulerDb = join(fixture.root, "scheduler", "native-v1.sqlite");
    const packageRoot = copyLoopshipPackageFixture(
      join(fixture.root, "loopship-package"),
    );
    const schedulerHome = resolve(fixture.repo, "..", "home");
    let scheduler: LoopshipTestScheduler | null = null;
    try {
      scheduler = await startLoopshipTestScheduler({
        dbPath: schedulerDb,
        home: schedulerHome,
        loopshipRoot: packageRoot,
      });
      const wtree = "connect-plan-incompatible";
      const started = await startQuestStage(
        fixture.repo,
        "loopship: keep incompatible pinned plans fail closed",
        wtree,
        [],
        scheduler.env,
      );
      expect(started).toMatchObject({
        schemaVersion: "fastflow/workflow-run-artifact/v1",
        kind: "workflow_result",
        status: "running",
      });
      const executionId = String(started.executionId || "");
      expect(executionId).toMatch(/^loopship-[0-9a-f]{64}$/);

      await scheduler.stop();
      scheduler = null;
      const copiedReadme = join(packageRoot, "README.md");
      writeFileSync(
        copiedReadme,
        `${readFileSync(copiedReadme, "utf8")}\nPinned route drift fixture.\n`,
        "utf8",
      );
      scheduler = await startLoopshipTestScheduler({
        dbPath: schedulerDb,
        home: schedulerHome,
        loopshipRoot: packageRoot,
      });

      const workspaceRoot = join(fixture.repo, "worktrees", wtree);
      const probe = runFastflowBridgeProbe({
        operation: "recover",
        request: { repoRoot: fixture.repo, wtree },
        cwd: workspaceRoot,
        env: scheduler.env,
      });
      expect(probe.status, probe.stderr || probe.stdout).toBe(23);
      expect(probe.response).toMatchObject({
        ok: false,
        error: {
          code: "FASTFLOW_PLAN_INCOMPATIBLE",
          retryable: false,
        },
      });
      const message = String((probe.response.error as Record<string, unknown>).message);
      expect(message).toContain(executionId);
      expect(message).toContain("Restore the exact prior Loopship/Fastflow release");
      expect(message).toContain("resubmit as a new Native execution");
      expect(readLoopshipNativeExecutionRequest(workspaceRoot)).toMatchObject({
        executionId,
        status: "pending",
      });
    } finally {
      await scheduler?.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 180_000);

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
        expect(tasks.schema_version).toBe(5);
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
      "plan",
      "questions",
      "archived",
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
    ]) {
      const match = text.match(new RegExp(`  - ${stage}:\\n([\\s\\S]*?)(?=\\n  - |\\noutput:)`));
      expect(match?.[1] ?? "", `${stage} must execute after route_stage selects it`).not.toContain(
        "\n      if:",
      );
    }
  });

  test("SWE legacy coordinator state exposes the structured hard-cut error code", () => {
    const path = join(
      process.cwd(),
      "call-catalog",
      "loopship",
      "workflow",
      "service",
      "flows",
      "swe.stable.yaml",
    );
    const promoted = loadYamlWorkflow(path);
    const legacyTask = workflowTaskDefinition(promoted, "stage_executing");
    const workflow = structuredClone(promoted);
    workflow.do = [{ stage_executing: legacyTask }];
    workflow.output = {
      schema: { document: { type: "object", additionalProperties: true } },
      as: "${state}",
    };

    const result = executeNativeWorkflow(workflow, {});

    expect(result.thrown).toMatchObject({
      code: "legacy_execution_unsupported",
      message: expect.stringContaining("resubmit as a new Native DAG execution"),
    });
  });

  test("SWE coordinator owns child execution through a Native all-settled DAG", () => {
    const path = join(
      process.cwd(),
      "call-catalog",
      "loopship",
      "workflow",
      "service",
      "flows",
      "swe.stable.yaml",
    );
    const workflow = loadYamlWorkflow(path);
    const task = workflowTaskDefinition(workflow, "stage_task_graph_ready") as any;
    const fastflow = task.metadata?.extensions?.fastflow;

    expect(task.for).toMatchObject({
      each: "childTask",
    });
    expect(task.for.in).toContain("validate_child_dag");
    expect(Array.isArray(task.do)).toBe(true);
    expect(fastflow).toMatchObject({
      schemaVersion: "fastflow.task/v2",
      dag: {
        id: expect.stringContaining("childTask.id"),
        dependsOn: expect.stringContaining("childTask.dependencies"),
        join: "all_settled",
      },
    });
    expect(String(fastflow.dag.maxConcurrency)).toContain("validate_child_dag");

    const validation = workflowTaskDefinition(workflow, "validate_child_dag") as any;
    expect(String(validation.with.body.max_concurrency)).toContain(
      "inputs.maxConcurrency === undefined",
    );

    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("- child_dispatch:");
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
        if (!result.ok || result.calls !== 20) {
          throw new Error(JSON.stringify(result));
        }
        console.log(JSON.stringify(result));
      `,
      [LOOPSHIP_CALL_CATALOG_ROOT],
    );
    expect(JSON.parse(output).calls).toBe(20);
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
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).toContain("pinned Native child DAG");
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
    expect("runtimeOffer" in adapters).toBe(false);
    expect("afnDispatch" in adapters).toBe(false);
    const host = adapters.afnHost as {
      hostId: string;
      dispatchPort: { listRoutes(): unknown[] };
    };
    expect(host.hostId).toBe(LOOPSHIP_AFN_HOST_ID);
    expect(host.dispatchPort.listRoutes()).toHaveLength(LOOPSHIP_AFN_DESCRIPTORS.length);
    const descriptor = await (adapters.resolveCallDescriptor as Function)({
      call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
    });
    expect(descriptor.call).toBe(LOOPSHIP_AFN_CALLS.childPrepareWorktree);
    await expect(
      (adapters.auditAfn as Function)({
        action: {
          call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
          with: {
            body: {
              repo: "/tmp/repo",
              wtree: "demo",
              task: { id: "task-a", title: "Task A", acceptance: "done" },
              dry_run: true,
            },
          },
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
        with: {
          body: {
            repo: "/tmp/repo",
            wtree: "demo",
            task: { id: "task-a", title: "Task A", acceptance: "done" },
            dry_run: true,
          },
        },
      },
    });
    expect(dryRunChild).toMatchObject({
      schema_version: "loopship.child.prepare/v2",
      task_id: "task-a",
      parent_wtree: "demo",
      parent_context_ref: "/tmp/repo/worktrees/demo/.loopship/runtime/tasks.yaml",
      count: 1,
    });
    expect(dryRunChild.actions).toBeUndefined();
    expect(dryRunChild.prepared_children).toHaveLength(1);
  });

  test("reports live AFN effects as non-cancellable and returns their late decision", async () => {
    const adapters = createLoopshipFastflowAdapters();
    const dispatch = loopshipHostDispatch(adapters);
    const route = dispatch.listRoutes().find(
      (entry) => entry.callId === LOOPSHIP_AFN_CALLS.childValidateDag,
    );
    expect(route).toBeDefined();
    const invocation = createAfnInvocation({
      executionId: "loopship-cancel-live",
      nodeId: "validate-child-dag",
      invocationId: "loopship-cancel-live:validate-child-dag:1",
      attempt: 1,
      call: {
        callId: route!.callId,
        contractDigest: route!.contractDigest,
        implementationDigest: route!.implementationDigest,
      },
      input: {
        tasks: [{ id: "task-a", dependencies: [], scope_files: ["src/a"] }],
      },
      effectKey: "loopship-cancel-live:validate-child-dag:effect",
      bindingRefs: [],
      affinityRefs: [],
      grants: [],
    });
    const cancellationRequest = {
      executionId: invocation.executionId,
      nodeId: invocation.nodeId,
      invocationId: invocation.invocationId,
      attempt: invocation.attempt,
      effectKey: invocation.effectKey,
      call: invocation.call,
      bindingRefs: invocation.bindingRefs,
      affinityRefs: invocation.affinityRefs,
      reason: "cancel the Native execution",
    };
    const pendingDecision = dispatch.dispatch(
      invocation as unknown as Record<string, unknown>,
    );
    const cancellation = await dispatch.cancel(cancellationRequest);
    expect(cancellation).toMatchObject({ accepted: false });
    expect(String(cancellation.reason)).toContain("non-cancellable after dispatch");
    expect(String(cancellation.reason)).toContain("late result");

    const decision = validateExecutionDecision(await pendingDecision);
    expect(decision).toMatchObject({
      invocationId: invocation.invocationId,
      kind: "completed",
    });
    expect(
      await dispatch.cancel({
        ...cancellationRequest,
        reason: "cancel after the late decision",
      }),
    ).toMatchObject({ accepted: false, reason: expect.stringContaining("not active") });
  });

  test("binds lifecycle inference steps to registry-backed Codex route groups", () => {
    const stepRoot = join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "step");
    const expected = new Map([
      ["plan", ["loopship_planning", "llm.cli.codex.gpt-5.5.max"]],
      ["task-graph", ["loopship_review", "llm.cli.codex.gpt-5.3-codex-spark.max"]],
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

  test("routes the pinned Native child implementation through Codex CLI with AITL fallback", () => {
    const workflow = loadYamlWorkflow(
      join(
        process.cwd(),
        "call-catalog",
        "loopship",
        "workflow",
        "service",
        "flows",
        "swe-child.stable.yaml",
      ),
    );
    const document = workflow.document as Record<string, any>;
    const group = document.metadata?.inference?.groups?.loopship_child_implementation;
    expect(group?.try).toEqual(["llm.cli.codex.gpt-5.4-mini.max", "aitl.subagent"]);

    const route = workflowTaskDefinition(workflow, "implementation_route") as any;
    expect(route.switch?.[0]?.recovered_commit?.then).toBe("record_implementation");
    expect(route.switch?.[1]?.implementation_required?.then).toBe("implement_child");

    const commitRoute = workflowTaskDefinition(workflow, "implementation_commit_route") as any;
    expect(commitRoute.switch?.[0]?.advanced?.then).toBe("record_implementation");
    expect(commitRoute.switch?.[1]?.no_commit?.then).toBe("fail_implementation");

    const implementation = workflowTaskDefinition(workflow, "implement_child") as any;
    expect(implementation.metadata?.inference).toBe("loopship_child_implementation");
    expect(implementation.metadata?.validation?.post?.kind).toBe("js");
    expect(implementation.metadata?.validation?.post?.expression).toContain("implementation_receipt");
    expect(implementation.metadata?.validation?.post?.expression).not.toContain("ok: true");
    expect(implementation.call).toBe("fastflow.afn.core.request.input");
    expect(implementation.with.body.timeout_ms).toBe(1200000);
    expect(implementation.with.body.instruction).toContain("commit the implementation");
    expect(implementation.with.body.answer.schema.required).toEqual(["implementation_receipt"]);
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
                task: {
                  id: "nested-child",
                  title: "Nested child work",
                  acceptance: "done",
                  child_wtree: "",
                },
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
                  worktree_path: join(fixture.root, "escaped-child"),
                },
              },
            },
          },
        }),
      ).rejects.toThrow("Native child task unsafe has non-canonical worktree_path");
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
      const ownedWorkspace = join(fixture.repo, "worktrees", "owned");
      ensureTaskWorkspace(fixture.repo, "codex/owned", ownedWorkspace, "main");
      expect(() =>
        ensureTaskWorkspace(fixture.repo, "codex/other", ownedWorkspace, "main"),
      ).toThrow("is registered to codex/owned, not codex/other");
      expect(() =>
        ensureTaskWorkspace(
          fixture.repo,
          "codex/owned",
          join(fixture.repo, "worktrees", "other-path"),
          "main",
        ),
      ).toThrow("task branch codex/owned is already checked out outside its requested worktree");
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
      ).rejects.toThrow("Native child task unsafe-branch has non-canonical branch_ref");
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
      ).rejects.toThrow("Native child task unsafe has non-canonical branch_ref");
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

  test("prepares exactly one Native DAG child without emitting a scheduler command", async () => {
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
            task: { id: "task-a", title: "Task A", acceptance: "done" },
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
    expect(prepared.schema_version).toBe("loopship.child.prepare/v2");
    expect(prepared.children).toBeUndefined();
    expect(JSON.stringify(prepared)).not.toContain("actions");
    expect(JSON.stringify(prepared)).not.toContain("stepper");
  });

  test("repairs a child lifecycle manifest after the event-before-manifest crash gap", async () => {
    const fixture = createGitFixture("loopship-child-lifecycle-manifest-recovery-");
    try {
      createNativeQuest(fixture.repo, "parent");
      const adapters = createLoopshipFastflowAdapters();
      const prepared = await executeLoopshipAfn(adapters, {
        action: {
          call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
          with: {
            body: {
              repo: fixture.repo,
              wtree: "parent",
              task: { id: "task-a", title: "Task A", acceptance: "done" },
            },
          },
        },
      });
      const childWtree = String(prepared.child_wtree);
      const childWorktree = String(prepared.worktree_path);
      const mergeCommit = runGit(childWorktree, ["rev-parse", "HEAD"]);
      const body = {
        repo: fixture.repo,
        wtree: childWtree,
        task_id: "task-a",
        status: "implemented",
        request_id: "child-lifecycle:task-a:implementation",
        merge_commit: mergeCommit,
        implementation_receipt: {
          status: "implemented",
          ref: "event-before-manifest",
        },
      };
      const files = questFiles(fixture.repo, childWtree);
      const priorTasks = readFileSync(files.tasks, "utf8");
      const priorManifest = readFileSync(files.manifest, "utf8");
      await executeLoopshipAfn(
        adapters,
        {
          action: {
            call: LOOPSHIP_AFN_CALLS.childRecordLifecycle,
            with: { body },
          },
        },
        {
          executionId: "child-lifecycle-first",
          effectKey: "child-lifecycle-first-effect",
        },
      );

      const recordedTasks = readFileSync(files.tasks, "utf8");
      writeFileSync(files.tasks, priorTasks, "utf8");
      writeFileSync(files.manifest, priorManifest, "utf8");
      expect(verifyQuestManifest(files).ok).toBe(false);

      const eventOnlyRecovered = await executeLoopshipAfn(
        adapters,
        {
          action: {
            call: LOOPSHIP_AFN_CALLS.childRecordLifecycle,
            with: { body },
          },
        },
        {
          executionId: "child-lifecycle-event-only-recovery",
          effectKey: "child-lifecycle-event-only-recovery-effect",
        },
      );
      expect(eventOnlyRecovered).toMatchObject({
        status: "implemented",
        stage: "validating",
        task_id: "task-a",
        merge_commit: mergeCommit,
      });
      expect(verifyQuestManifest(files)).toMatchObject({ ok: true, errors: [] });
      expect(readFileSync(files.tasks, "utf8")).toBe(recordedTasks);

      writeFileSync(files.manifest, priorManifest, "utf8");
      expect(verifyQuestManifest(files).ok).toBe(false);
      const stateAndEventRecovered = await executeLoopshipAfn(
        adapters,
        {
          action: {
            call: LOOPSHIP_AFN_CALLS.childRecordLifecycle,
            with: { body },
          },
        },
        {
          executionId: "child-lifecycle-state-event-recovery",
          effectKey: "child-lifecycle-state-event-recovery-effect",
        },
      );
      expect(stateAndEventRecovered).toEqual(eventOnlyRecovered);
      expect(verifyQuestManifest(files)).toMatchObject({ ok: true, errors: [] });
      const recoveredManifest = readFileSync(files.manifest, "utf8");
      await executeLoopshipAfn(
        adapters,
        {
          action: {
            call: LOOPSHIP_AFN_CALLS.childRecordLifecycle,
            with: { body },
          },
        },
        {
          executionId: "child-lifecycle-stable-replay",
          effectKey: "child-lifecycle-stable-replay-effect",
        },
      );
      expect(readFileSync(files.manifest, "utf8")).toBe(recoveredManifest);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("fails closed on Native child preparation and lifecycle replay tamper", async () => {
    const fixture = createGitFixture("loopship-child-replay-tamper-");
    try {
      createNativeQuest(fixture.repo, "parent");
      const adapters = createLoopshipFastflowAdapters();
      const prepareBody = {
        repo: fixture.repo,
        wtree: "parent",
        task: { id: "task-a", title: "Task A", acceptance: "done" },
      };
      const prepared = await executeLoopshipAfn(adapters, {
        action: {
          call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
          with: { body: prepareBody },
        },
      });
      const childWtree = String(prepared.child_wtree);
      const childWorktree = String(prepared.worktree_path);
      const files = questFiles(fixture.repo, childWtree);
      const preparedManifest = readFileSync(files.manifest, "utf8");

      await executeLoopshipAfn(
        adapters,
        {
          action: {
            call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
            with: { body: prepareBody },
          },
        },
        { executionId: "prepare-replay", effectKey: "prepare-replay-effect" },
      );
      expect(readFileSync(files.manifest, "utf8")).toBe(preparedManifest);

      writeFileSync(files.hook_state, '{"unexpected":true}\n', "utf8");
      await expect(
        executeLoopshipAfn(
          adapters,
          {
            action: {
              call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
              with: { body: prepareBody },
            },
          },
          { executionId: "prepare-hook-tamper", effectKey: "prepare-hook-tamper-effect" },
        ),
      ).rejects.toThrow("unexpected hook state");
      expect(readFileSync(files.manifest, "utf8")).toBe(preparedManifest);
      writeFileSync(files.hook_state, "{}\n", "utf8");

      const preparedEvents = readFileSync(files.events, "utf8");
      writeFileSync(
        files.events,
        `${preparedEvents}${JSON.stringify({
          ts: new Date().toISOString(),
          event: "unrelated_event",
        })}\n`,
        "utf8",
      );
      await expect(
        executeLoopshipAfn(
          adapters,
          {
            action: {
              call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
              with: { body: prepareBody },
            },
          },
          { executionId: "prepare-event-tamper", effectKey: "prepare-event-tamper-effect" },
        ),
      ).rejects.toThrow("unexpected preparation events");
      expect(readFileSync(files.manifest, "utf8")).toBe(preparedManifest);
      writeFileSync(files.events, preparedEvents, "utf8");

      const mergeCommit = runGit(childWorktree, ["rev-parse", "HEAD"]);
      const lifecycleBody = {
        repo: fixture.repo,
        wtree: childWtree,
        task_id: "task-a",
        status: "implemented",
        request_id: "child-lifecycle:task-a:implementation",
        merge_commit: mergeCommit,
        implementation_receipt: { status: "implemented", ref: "original" },
      };
      await executeLoopshipAfn(
        adapters,
        {
          action: {
            call: LOOPSHIP_AFN_CALLS.childRecordLifecycle,
            with: { body: lifecycleBody },
          },
        },
        { executionId: "lifecycle-original", effectKey: "lifecycle-original-effect" },
      );
      const lifecycleManifest = readFileSync(files.manifest, "utf8");
      const lifecycleTasks = readFileSync(files.tasks, "utf8");
      const lifecycleEvents = readFileSync(files.events, "utf8");

      await expect(
        executeLoopshipAfn(
          adapters,
          {
            action: {
              call: LOOPSHIP_AFN_CALLS.childRecordLifecycle,
              with: {
                body: {
                  ...lifecycleBody,
                  implementation_receipt: { status: "implemented", ref: "conflict" },
                },
              },
            },
          },
          { executionId: "lifecycle-conflict", effectKey: "lifecycle-conflict-effect" },
        ),
      ).rejects.toThrow();
      expect(readFileSync(files.manifest, "utf8")).toBe(lifecycleManifest);

      const tamperedState = parseTasksYaml(lifecycleTasks) as QuestState;
      tamperedState.local_work_receipt = { status: "implemented", ref: "tampered" };
      writeFileSync(files.tasks, renderTasksYaml(tamperedState), "utf8");
      await expect(
        executeLoopshipAfn(
          adapters,
          {
            action: {
              call: LOOPSHIP_AFN_CALLS.childRecordLifecycle,
              with: { body: lifecycleBody },
            },
          },
          { executionId: "lifecycle-receipt-tamper", effectKey: "lifecycle-receipt-tamper-effect" },
        ),
      ).rejects.toThrow();
      expect(readFileSync(files.manifest, "utf8")).toBe(lifecycleManifest);
      writeFileSync(files.tasks, lifecycleTasks, "utf8");

      writeFileSync(
        files.events,
        `${lifecycleEvents}${JSON.stringify({
          ts: new Date().toISOString(),
          event: "unrelated_event",
        })}\n`,
        "utf8",
      );
      await expect(
        executeLoopshipAfn(
          adapters,
          {
            action: {
              call: LOOPSHIP_AFN_CALLS.childRecordLifecycle,
              with: { body: lifecycleBody },
            },
          },
          { executionId: "lifecycle-event-tamper", effectKey: "lifecycle-event-tamper-effect" },
        ),
      ).rejects.toThrow("duplicated or not the latest event");
      expect(readFileSync(files.manifest, "utf8")).toBe(lifecycleManifest);
      writeFileSync(files.events, lifecycleEvents, "utf8");

      writeFileSync(files.manifest, "{}\n", "utf8");
      await expect(
        executeLoopshipAfn(
          adapters,
          {
            action: {
              call: LOOPSHIP_AFN_CALLS.childRecordLifecycle,
              with: { body: lifecycleBody },
            },
          },
          { executionId: "lifecycle-manifest-tamper", effectKey: "lifecycle-manifest-tamper-effect" },
        ),
      ).rejects.toThrow("invalid recovery manifest");
      expect(readFileSync(files.manifest, "utf8")).toBe("{}\n");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("validates explicit child DAG ordering and serializes superviseStep", () => {
    const ordered = validateLoopshipChildDag({
      max_concurrency: 6,
      tasks: [
        {
          id: "task-a",
          title: "A",
          acceptance: "done",
          dependencies: [],
          scope_files: ["src/shared"],
          concurrency_group: "repo-write",
        },
        {
          id: "task-b",
          title: "B",
          acceptance: "done",
          depends_on: ["task-a"],
          scope_files: ["src/shared/file.ts"],
          concurrency_group: "repo-write",
        },
        {
          id: "task-c",
          title: "C",
          acceptance: "done",
          dependencies: [],
          scope_files: ["docs"],
        },
      ],
    });
    expect(ordered.ok).toBe(true);
    expect(ordered.max_concurrency).toBe(6);
    expect(ordered.tasks[1]?.dependencies).toEqual(["task-a"]);

    const supervised = validateLoopshipChildDag({
      supervise_step: true,
      tasks: ordered.tasks,
    });
    expect(supervised.ok).toBe(true);
    expect(supervised.max_concurrency).toBe(1);

    const conflicting = validateLoopshipChildDag({
      tasks: [
        {
          id: "task-a",
          title: "A",
          acceptance: "done",
          dependencies: [],
          scope_files: ["src/shared"],
        },
        {
          id: "task-b",
          title: "B",
          acceptance: "done",
          dependencies: [],
          scope_files: ["src/shared/file.ts"],
        },
      ],
    });
    expect(conflicting.ok).toBe(false);
    expect(conflicting.max_concurrency).toBe(LOOPSHIP_DEFAULT_CHILD_MAX_CONCURRENCY);
    expect(conflicting.errors).toEqual([
      "unordered child DAG tasks task-a and task-b conflict by overlapping scope",
    ]);

    const canonicalEquivalentConflict = validateLoopshipChildDag({
      tasks: [
        {
          id: "task-a",
          dependencies: [],
          scope_files: ["././src//shared/file.ts"],
        },
        {
          id: "task-b",
          dependencies: [],
          scope_files: ["src/shared/file.ts"],
        },
      ],
    });
    expect(canonicalEquivalentConflict.ok).toBe(false);
    expect(canonicalEquivalentConflict.errors).toEqual([
      "unordered child DAG tasks task-a and task-b conflict by overlapping scope",
    ]);

    const globConflict = validateLoopshipChildDag({
      tasks: [
        {
          id: "task-a",
          title: "A",
          acceptance: "done",
          dependencies: [],
          scope_files: ["src/**"],
        },
        {
          id: "task-b",
          title: "B",
          acceptance: "done",
          dependencies: [],
          scope_files: ["src/file.ts"],
        },
      ],
    });
    expect(globConflict.ok).toBe(false);
    expect(globConflict.errors[0]).toContain("overlapping scope");

    const lexicalPrefixOnly = validateLoopshipChildDag({
      tasks: [
        {
          id: "task-a",
          title: "A",
          acceptance: "done",
          dependencies: [],
          scope_files: ["src/a"],
        },
        {
          id: "task-b",
          title: "B",
          acceptance: "done",
          dependencies: [],
          scope_files: ["src/another"],
        },
      ],
    });
    expect(lexicalPrefixOnly.ok).toBe(true);

    const malformed = validateLoopshipChildDag({
      tasks: [
        {
          id: "task-a",
          title: "A",
          acceptance: "done",
          dependencies: [""],
        },
        null,
      ],
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.errors).toContain(
      "child DAG task task-a dependencies must contain only non-empty strings",
    );
    expect(malformed.errors).toContain("child DAG task at index 1 must be an object");
    const conflictingAliases = validateLoopshipChildDag({
      tasks: [
        {
          id: "task-a",
          task_id: "task-b",
          dependencies: [],
          depends_on: ["task-c"],
          scope_files: ["src/a"],
          scope: ["src/b"],
        },
        { id: "task-c", dependencies: [] },
      ],
    });
    expect(conflictingAliases.ok).toBe(false);
    expect(conflictingAliases.errors).toContain(
      "child DAG task task-b has conflicting id and task_id",
    );
    expect(conflictingAliases.errors).toContain(
      "child DAG task task-b has conflicting dependencies and depends_on",
    );
    expect(conflictingAliases.errors).toContain(
      "child DAG task task-b has conflicting scope_files and scope",
    );
    const malformedAlias = validateLoopshipChildDag({
      tasks: [{
        id: "task-a",
        dependencies: [],
        depends_on: "task-b",
        scope_files: "src/a",
      }],
    });
    expect(malformedAlias.errors).toContain(
      "child DAG task task-a depends_on must be an array of strings",
    );
    expect(malformedAlias.errors).toContain(
      "child DAG task task-a scope_files must be an array of strings",
    );
    expect(malformedAlias.errors).toContain(
      "child DAG task task-a must declare a non-empty scope_files or scope list",
    );
    const escapingScope = validateLoopshipChildDag({
      tasks: [
        { id: "task-a", dependencies: [], scope_files: ["../outside"] },
        { id: "task-b", dependencies: [], scope_files: ["/absolute/path"] },
        { id: "task-c", dependencies: [], scope_files: ["file:///tmp/outside"] },
        { id: "task-d", dependencies: [], scope_files: ["./C:/outside"] },
      ],
    });
    expect(escapingScope.errors).toContain(
      "child DAG task task-a scope_files must contain only repository-relative paths",
    );
    expect(escapingScope.errors).toContain(
      "child DAG task task-b scope_files must contain only repository-relative paths",
    );
    expect(escapingScope.errors).toContain(
      "child DAG task task-c scope_files must contain only repository-relative paths",
    );
    expect(escapingScope.errors).toContain(
      "child DAG task task-d scope_files must contain only repository-relative paths",
    );
    expect(validateLoopshipChildDag({ tasks: [] }).ok).toBe(false);
    expect(validateLoopshipChildDag({ tasks: ordered.tasks, max_concurrency: 0 }).ok).toBe(
      false,
    );
  });

  test("rejects conflicting planner aliases before task-state persistence", () => {
    const fixture = createGitFixture("loopship-plan-alias-conflict-");
    try {
      const wtree = "plan-alias-conflict";
      const workspace = ensureCoordinatorWorkspace(fixture.repo, wtree);
      const { files, state } = createQuest({
        repoRoot: fixture.repo,
        wtree,
        prompt: "loopship: reject conflicting task aliases",
        resolutionSource: "test",
        workspace,
        flowId: "swe",
        initialStage: "planning",
      });
      const originalTasks = readFileSync(files.tasks, "utf8");
      const cases = [
        {
          task: {
            id: "task-a",
            task_id: "task-b",
            title: "Conflicting identity",
            acceptance: "Rejected",
            scope_files: ["src/a.ts"],
          },
          message: "child DAG task task-b has conflicting id and task_id",
        },
        {
          task: {
            id: "task-a",
            title: "Conflicting dependencies",
            acceptance: "Rejected",
            dependencies: ["task-b"],
            depends_on: ["task-c"],
            scope_files: ["src/a.ts"],
          },
          message:
            "child DAG task task-a has conflicting dependencies and depends_on",
        },
        {
          task: {
            id: "task-a",
            title: "Conflicting scope",
            acceptance: "Rejected",
            dependencies: [],
            scope_files: ["src/a.ts"],
            scope: ["src/b.ts"],
          },
          message: "child DAG task task-a has conflicting scope_files and scope",
        },
        {
          task: {
            id: 42,
            task_id: "task-a",
            title: "Malformed primary identity",
            acceptance: "Rejected",
            scope_files: ["src/a.ts"],
          },
          message: "child DAG task task-a id must be a non-empty string",
        },
        {
          task: {
            id: "task-a",
            title: "Malformed primary dependencies",
            acceptance: "Rejected",
            dependencies: "task-b",
            depends_on: ["task-c"],
            scope_files: ["src/a.ts"],
          },
          message: "child DAG task task-a dependencies must be an array of strings",
        },
        {
          task: {
            id: "task-a",
            title: "Malformed secondary scope",
            acceptance: "Rejected",
            dependencies: [],
            scope_files: ["src/a.ts"],
            scope: "src/b.ts",
          },
          message: "child DAG task task-a scope must be an array of strings",
        },
        {
          task: {
            id: "task-a",
            title: "Malformed dependency member",
            acceptance: "Rejected",
            dependencies: [42],
            scope_files: ["src/a.ts"],
          },
          message:
            "child DAG task task-a dependencies must contain only non-empty strings",
        },
      ];
      for (const testCase of cases) {
        expect(() =>
          applyQuestPlanToTasks(files, state, {
            classification: "feature",
            scope: "Reject ambiguous task identity",
            tasks: [testCase.task],
          }),
        ).toThrow(testCase.message);
        expect(readFileSync(files.tasks, "utf8")).toBe(originalTasks);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("reconciles all-settled child outcomes once in canonical task order", () => {
    const tasks = [
      { id: "task-a", title: "A", acceptance: "done", scope_files: ["src/a"], child_wtree: "root-task-a" },
      { id: "task-b", title: "B", acceptance: "done", scope_files: ["src/b"], child_wtree: "root-task-b" },
      { id: "task-c", title: "C", acceptance: "done", scope_files: ["src/c"], child_wtree: "root-task-c" },
      { id: "task-d", title: "D", acceptance: "done", scope_files: ["src/d"], child_wtree: "root-task-d" },
    ];
    const result = buildLoopshipChildDagReconciliation({
      tasks,
      dag_result: {
        scheduler: {
          schemaVersion: "fastflow.scheduler.result/v2",
          nodes: [
          {
            id: "task-c",
            status: "failed",
            error: { code: "child-failed", message: "verification failed" },
          },
          {
            id: "task-a",
            status: "passed",
            result: {
              ok: true,
              iteration: {
                steps: {
                  run_child_lifecycle: {
                    action: {
                      schema_version: "loopship.child-result/v2",
                      task_id: "task-a",
                      child_wtree: "root-task-a",
                      status: "child_archived",
                      branch_ref: "codex/root-task-a",
                      worktree_path: "/repo/worktrees/root-task-a",
                      merge_target: "root",
                      merge_lease_id: "lease-a",
                      merge_commit: "a".repeat(40),
                    },
                  },
                },
              },
            },
          },
          {
            id: "task-b",
            status: "blocked",
            error: { code: "dependency-failed", message: "task-c failed" },
          },
          {
            id: "task-d",
            status: "cancelled",
            error: { code: "cancelled", message: "execution cancelled" },
          },
          ],
        },
      },
      runtime: { tasks: {} },
    }) as any;

    expect(result).toMatchObject({
      stage_after: "replanning",
      transition: "failed",
      step_workflow_task: "stage_task_graph_ready",
      step_payload: { total: 4, passed: 1, failed: 1, blocked: 1, cancelled: 1 },
    });
    expect(result.state_patch.tasks.map((task: any) => [task.id, task.status])).toEqual([
      ["task-a", "child_archived"],
      ["task-b", "blocked"],
      ["task-c", "failed"],
      ["task-d", "cancelled"],
    ]);
    expect(result.state_patch.child_results.map((child: any) => child.task_id)).toEqual([
      "task-a",
      "task-b",
      "task-c",
      "task-d",
    ]);
  });

  test("fails closed on invalid child DAG reconciliation identities", () => {
    expect(() =>
      buildLoopshipChildDagReconciliation({
        tasks: [],
        dag_result: { scheduler: { nodes: [] } },
      }),
    ).toThrow("must contain at least one approved task");
    expect(() =>
      buildLoopshipChildDagReconciliation({
        tasks: [{ title: "Missing identity" }],
        dag_result: { scheduler: { nodes: [] } },
      }),
    ).toThrow("must have a non-empty id");
    expect(() =>
      buildLoopshipChildDagReconciliation({
        tasks: [{ id: "task-a" }, { id: "task-a" }],
        dag_result: { scheduler: { nodes: [{ id: "task-a", status: "failed" }] } },
      }),
    ).toThrow("duplicate child DAG task id: task-a");
    expect(() =>
      buildLoopshipChildDagReconciliation({
        tasks: [{ id: "task-a", scope_files: ["src/a"] }],
        dag_result: {
          scheduler: {
            nodes: [
              { id: "task-a", status: "failed" },
              { id: "task-a", status: "failed" },
            ],
          },
        },
      }),
    ).toThrow("duplicate node id task-a");
    expect(() =>
      buildLoopshipChildDagReconciliation({
        tasks: [{ id: "task-a", scope_files: ["src/a"] }],
        dag_result: { scheduler: { nodes: [{ status: "failed" }] } },
      }),
    ).toThrow("must have a non-empty id");
    expect(() =>
      buildLoopshipChildDagReconciliation({
        tasks: [
          { id: "task-a", scope_files: ["src/a"] },
          { id: "task-b", scope_files: ["src/b"] },
        ],
        dag_result: { scheduler: { nodes: [{ id: "task-a", status: "failed" }] } },
      }),
    ).toThrow("missing node for task task-b");
    expect(() =>
      buildLoopshipChildDagReconciliation({
        tasks: [{ id: "task-a", scope_files: ["src/a"] }],
        dag_result: {
          scheduler: {
            nodes: [
              { id: "task-a", status: "failed" },
              { id: "task-b", status: "failed" },
            ],
          },
        },
      }),
    ).toThrow("unexpected node id task-b");
  });

  test("fails reconciliation when a passed child receipt tampers with stable identities", () => {
    const task = {
      id: "task-a",
      scope_files: ["src/a"],
      child_wtree: "root-task-a",
      branch_ref: "codex/root-task-a",
      worktree_path: "/repo/worktrees/root-task-a",
      merge_target: "root",
      merge_lease_id: "lease-root-task-a",
    };
    const receipt = {
      schema_version: "loopship.child-result/v2",
      task_id: "task-a",
      child_wtree: task.child_wtree,
      status: "child_archived",
      branch_ref: task.branch_ref,
      worktree_path: task.worktree_path,
      merge_target: task.merge_target,
      merge_lease_id: task.merge_lease_id,
      merge_commit: "a".repeat(40),
    };
    const reconcile = (overrides: Record<string, unknown>) =>
      buildLoopshipChildDagReconciliation({
        tasks: [task],
        dag_result: {
          scheduler: {
            nodes: [
              {
                id: task.id,
                status: "passed",
                result: {
                  iteration: {
                    steps: {
                      run_child_lifecycle: {
                        action: { ...receipt, ...overrides },
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      }) as any;

    for (const [field, value] of [
      ["task_id", "task-b"],
      ["child_wtree", "root-task-b"],
      ["branch_ref", "codex/root-task-b"],
      ["worktree_path", "/repo/worktrees/root-task-b"],
      ["merge_target", "other"],
      ["merge_lease_id", "lease-root-task-b"],
      ["merge_commit", "not-a-commit"],
    ] as const) {
      const result = reconcile({ [field]: value });
      expect(result).toMatchObject({
        stage_after: "replanning",
        transition: "failed",
        step_payload: { passed: 0, failed: 1 },
      });
      expect(result.state_patch.child_results[0].evidence[0].summary).toContain(field);
    }
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

  test("approved empty coordinator task graphs replan", () => {
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
      prompt: "loopship: build a customer support dashboard",
      tasks: [],
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
      if (flowId === "swe-child") {
        expect(calls.has(LOOPSHIP_AFN_CALLS.childRecordLifecycle), flowId).toBe(true);
        expect(calls.has(LOOPSHIP_AFN_CALLS.gitResolveCommit), flowId).toBe(true);
        expect(calls.has("loopship.workflow.service.step.landing"), flowId).toBe(true);
      } else {
        expect(calls.has(LOOPSHIP_DATA_CALLS.documentRead), flowId).toBe(true);
        expect(calls.has(LOOPSHIP_DATA_CALLS.eventLogQuery), flowId).toBe(true);
      }
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
    expect(() =>
      (adapters.validateCallInvocation as Function)({
        call: LOOPSHIP_AFN_CALLS.childRecordLifecycle,
        phase: "action",
        with: {
          body: {
            repo: "/tmp/repo",
            wtree: "child",
            task_id: "task-a",
            status: "implemented",
            request_id: "",
          },
        },
      }),
    ).toThrow("body.request_id");
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
      await expect(executeLoopshipAfn(adapters, action, identity)).rejects.toMatchObject({
        code: "legacy_execution_unsupported",
      });
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
        const dispatch = adapters.afnHost.dispatchPort;
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

  test("landing.apply recovers across the started, source preparation, and pre-merge receipt seams", async () => {
    for (const killPoint of [
      "after-started",
      "after-source-state-commit",
      "before-merge",
    ] as const) {
      const fixture = createLandingCrashFixture(
        `loopship-native-landing-${killPoint}-`,
        "fast-forward",
      );
      try {
        if (killPoint === "after-source-state-commit") {
          mkdirSync(join(fixture.coordinatorWorktree, ".loopship"), { recursive: true });
          writeFileSync(
            join(fixture.coordinatorWorktree, ".loopship", "system.yaml"),
            "schema_version: 2\n",
            "utf8",
          );
        }
        const sourceBefore = runGit(fixture.repo, ["rev-parse", "codex/demo"]);
        const targetBefore = runGit(fixture.repo, ["rev-parse", "main"]);
        const identity = {
          executionId: `loopship-landing-${killPoint}`,
          effectKey: `loopship-landing-${killPoint}-effect`,
        };
        const started = await hardKillLoopshipLandingAt({
          body: fixture.body,
          root: fixture.root,
          killPoint,
          ...identity,
        });
        expect(started).toMatchObject({
          status: "started",
          callId: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
          effectKey: identity.effectKey,
        });
        if (killPoint === "before-merge") {
          expect(started.recoverySnapshot).toMatchObject({
            mode: "fast-forward",
            sourceBranch: "codex/demo",
            targetBranch: "main",
            targetCommit: targetBefore,
          });
        } else {
          expect(started.recoverySnapshot).toBeUndefined();
        }
        const sourceAfterKill = runGit(fixture.repo, ["rev-parse", "codex/demo"]);
        expect(runGit(fixture.repo, ["rev-parse", "main"])).toBe(targetBefore);
        if (killPoint === "after-source-state-commit") {
          expect(sourceAfterKill).not.toBe(sourceBefore);
          expect(
            runGit(fixture.repo, ["show", "-s", "--format=%s", sourceAfterKill]),
          ).toBe("chore(loopship): record codex/demo durable state");
        } else {
          expect(sourceAfterKill).toBe(sourceBefore);
        }

        const adapters = createLoopshipFastflowAdapters();
        const recovered = await executeLoopshipAfn(
          adapters,
          {
            action: {
              call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
              with: { body: fixture.body },
            },
          },
          identity,
        );
        expect(recovered).toMatchObject({
          status: "landed",
          strategy: "fast-forward",
          next_stage: "archived",
        });
        expect(runGit(fixture.repo, ["rev-parse", "main"])).toBe(
          runGit(fixture.repo, ["rev-parse", "codex/demo"]),
        );
        const completed = JSON.parse(
          readFileSync(loopshipAfnEffectReceiptPath(fixture.repo, identity.effectKey), "utf8"),
        );
        expect(completed).toMatchObject({
          status: "completed",
          recoverySnapshot: {
            mode: "fast-forward",
            sourceCommit: recovered.landed_commit,
          },
          output: { landed_commit: recovered.landed_commit },
        });
        const events = readFileSync(fixture.files.events, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          events.filter(
            (event) =>
              event.event === "landing_merge_recorded" &&
              event.request_id === completed.requestId,
          ),
        ).toHaveLength(1);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  }, 60_000);

  test("landing.apply recovers an exact fast-forward or merge commit after a post-merge hard kill", async () => {
    for (const mode of ["fast-forward", "merge-commit"] as const) {
      const fixture = createLandingCrashFixture(
        `loopship-native-landing-post-merge-${mode}-`,
        mode,
      );
      try {
        const identity = {
          executionId: `loopship-landing-post-merge-${mode}`,
          effectKey: `loopship-landing-post-merge-${mode}-effect`,
        };
        const started = await hardKillLoopshipLandingAt({
          body: fixture.body,
          root: fixture.root,
          killPoint: "after-merge",
          ...identity,
        });
        expect(started).toMatchObject({
          status: "started",
          recoverySnapshot: { mode },
        });
        const snapshot = started.recoverySnapshot as Record<string, unknown>;
        const landedCommit = runGit(fixture.repo, ["rev-parse", "main"]);
        if (mode === "fast-forward") {
          expect(landedCommit).toBe(String(snapshot.sourceCommit));
        } else {
          expect(
            runGit(fixture.repo, ["show", "-s", "--format=%P", landedCommit]).split(" "),
          ).toEqual([String(snapshot.targetCommit), String(snapshot.sourceCommit)]);
        }
        expect(
          readFileSync(fixture.files.events, "utf8").includes("landing_merge_recorded"),
        ).toBe(false);

        const recovered = await executeLoopshipAfn(
          createLoopshipFastflowAdapters(),
          {
            action: {
              call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
              with: { body: fixture.body },
            },
          },
          identity,
        );
        expect(recovered).toMatchObject({
          status: "landed",
          strategy: mode,
          landed_commit: landedCommit,
        });
        const completed = JSON.parse(
          readFileSync(loopshipAfnEffectReceiptPath(fixture.repo, identity.effectKey), "utf8"),
        );
        expect(completed).toMatchObject({
          status: "completed",
          output: { landed_commit: landedCommit },
        });
        const mergeEvents = readFileSync(fixture.files.events, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter(
            (event) =>
              event.event === "landing_merge_recorded" &&
              event.request_id === completed.requestId,
          );
        expect(mergeEvents).toHaveLength(1);
        expect(mergeEvents[0].payload.landed_commit).toBe(landedCommit);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  }, 60_000);

  test("landing.apply rejects source or target movement after the prepared merge", async () => {
    for (const movedBranch of ["source", "target"] as const) {
      const fixture = createLandingCrashFixture(
        `loopship-native-landing-moved-${movedBranch}-`,
        "fast-forward",
      );
      try {
        const identity = {
          executionId: `loopship-landing-moved-${movedBranch}`,
          effectKey: `loopship-landing-moved-${movedBranch}-effect`,
        };
        const started = await hardKillLoopshipLandingAt({
          body: fixture.body,
          root: fixture.root,
          killPoint: "after-merge",
          ...identity,
        });
        expect(started.recoverySnapshot).toMatchObject({ mode: "fast-forward" });
        const mutationRoot = movedBranch === "source"
          ? fixture.coordinatorWorktree
          : fixture.repo;
        const mutationFile = movedBranch === "source" ? "SOURCE_AFTER.md" : "TARGET_AFTER.md";
        writeFileSync(join(mutationRoot, mutationFile), `# moved ${movedBranch}\n`, "utf8");
        runGit(mutationRoot, ["add", mutationFile]);
        runGit(mutationRoot, ["commit", "-m", `move ${movedBranch} after prepared merge`]);

        const recovery = executeLoopshipAfn(
          createLoopshipFastflowAdapters(),
          {
            action: {
              call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
              with: { body: fixture.body },
            },
          },
          identity,
        );
        await expect(recovery).rejects.toThrow(
          movedBranch === "source"
            ? "source branch moved after the prepared merge"
            : "target branch moved outside the prepared fast-forward",
        );
        const receipt = JSON.parse(
          readFileSync(loopshipAfnEffectReceiptPath(fixture.repo, identity.effectKey), "utf8"),
        );
        expect(receipt.status).toBe("started");
        expect(
          readFileSync(fixture.files.events, "utf8").includes("landing_merge_recorded"),
        ).toBe(false);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  }, 60_000);

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
      const escapedBranch = taskAssignmentBranchRef("demo", "escaped");
      const escapedChild = taskAssignmentChildWtree("demo", "escaped");
      runGit(fixture.repo, ["branch", escapedBranch, "main"]);
      const escapedWorkspace = join(fixture.root, "escaped-worktree");
      mkdirSync(escapedWorkspace, { recursive: true });
      const linkedWorkspace = taskAssignmentWorktreePath(
        fixture.repo,
        "demo",
        "escaped",
      );
      expect(linkedWorkspace).toContain(escapedChild);
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
              branch_ref: escapedBranch,
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
      expect(output.removed_branches).not.toContain(escapedBranch);
      expect(output.skipped).toContainEqual(
        expect.objectContaining({
          branch: escapedBranch,
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
      const oldBranch = taskAssignmentBranchRef("demo", "recorded-child");
      const reusedPath = taskAssignmentWorktreePath(
        fixture.repo,
        "demo",
        "recorded-child",
      );
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
      const childBranch = taskAssignmentBranchRef("demo", "child");
      const childPath = taskAssignmentWorktreePath(fixture.repo, "demo", "child");
      const childWorkspace = ensureTaskWorkspace(
        fixture.repo,
        childBranch,
        childPath,
        "main",
      );
      writeFileSync(join(childWorkspace.worktree_path, "CHILD.md"), "# child\n", "utf8");
      runGit(childWorkspace.worktree_path, ["add", "CHILD.md"]);
      runGit(childWorkspace.worktree_path, ["commit", "-m", "child work"]);
      const childCommit = runGit(childWorkspace.worktree_path, ["rev-parse", "HEAD"]);
      runGit(coordinatorWorktree, ["merge", "--no-ff", "--no-edit", childBranch]);
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
              branch_ref: childBranch,
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
          branch: childBranch,
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
          schemaVersion: "loopship.afn-effect-receipt/v2",
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
      runGit(fixture.repo, ["branch", "-d", "--", childBranch]);
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
        expect.arrayContaining([childBranch, "codex/demo"]),
      );
      expect(existsSync(childWorkspace.worktree_path)).toBe(false);
      expect(existsSync(coordinatorWorktree)).toBe(false);
      expect(runGit(fixture.repo, ["branch", "--list", childBranch])).toBe("");
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
        request_id: "catalog-native-landing",
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
      expect(readFileSync(files.events, "utf8")).toContain('"request_id":"catalog-native-landing"');
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

  test("the coordinator flow reads canonical workflow data", () => {
    const flowRoot = join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "flows");
    const workflows = loadCatalogWorkflows(flowRoot);
    expect(Object.keys(workflows).sort()).toEqual(["swe", "swe-child"].sort());
    const bodies: Array<Record<string, unknown>> = [];
    walk(workflows.swe, (item) => {
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
  });
});
