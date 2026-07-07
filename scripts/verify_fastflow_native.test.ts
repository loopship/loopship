import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  applyQuestPlanToTasks,
  createQuest,
  ensureCoordinatorWorkspace,
  ensureTaskWorkspace,
  ensureSystemScaffold,
  applySystemUpdate,
  parseTasksYaml,
  renderTasksYaml,
  taskAssignmentChildWtree,
  verifyRootManifest,
  type QuestState,
} from "./loopship_core.ts";
import {
  LOOPSHIP_AFN_CALLS,
  LOOPSHIP_AFN_DESCRIPTORS,
  LOOPSHIP_CALL_CATALOG_ROOT,
  LOOPSHIP_DATA_CALLS,
  LOOPSHIP_SUPERVISOR_GUIDANCE,
  createLoopshipFastflowAdapters,
  ensureLoopshipFastflowWorkflowCatalog,
  loopshipFlowWorkflowRef,
} from "./loopship_fastflow.ts";
import { nativeResumeRequest, runDoctor } from "./loopship.ts";
import { nativeResumeRequest as nativeStepperResumeRequest } from "./loopship_stepper.ts";
import { runCommand } from "./loopship_utils.ts";

const LOOPSHIP_SCRIPT = resolve(process.cwd(), "scripts", "loopship.ts");
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
        resolverPath: "aitl.chat",
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
  expect(parts).toHaveLength(5);
  for (const part of parts) {
    expect(part).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
  }
  return {
    registry: parts[0],
    kind: parts[1],
    target: parts[2],
    scope: parts[3],
    name: parts[4],
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

function fastflowImport(subpath: "root" | "workflow"): string {
  const fastflowRoot = resolveFastflowRoot();
  const sourcePath =
    subpath === "root"
      ? join(fastflowRoot, "src", "index.mjs")
      : join(fastflowRoot, "src", "workflow.mjs");
  return pathToFileURL(sourcePath).href;
}

function resolveFastflowRoot(requiredFiles = ["src/index.mjs", "src/catalog.mjs"]): string {
  const installedRoot = join(process.cwd(), "node_modules", "@cueintent", "fastflow");
  if (
    existsSync(join(installedRoot, "package.json")) &&
    requiredFiles.every((file) => existsSync(join(installedRoot, file)))
  ) {
    return installedRoot;
  }

  const siblingRoots = [
    resolve(process.cwd(), "..", "..", "cueintent", "fastflow"),
    resolve(process.cwd(), "..", "..", "orgs", "cueintent", "fastflow"),
    resolve(process.cwd(), "..", "..", "..", "..", "cueintent", "fastflow"),
    resolve(process.cwd(), "..", "..", "..", "..", "orgs", "cueintent", "fastflow"),
  ];
  const fastflowRoot = siblingRoots.find((candidate) =>
    existsSync(join(candidate, "package.json")) &&
    requiredFiles.every((file) => existsSync(join(candidate, file))),
  );
  if (!fastflowRoot) {
    throw new Error("could not resolve @cueintent/fastflow from node_modules or sibling repos");
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
  const workflowFile = join(dir, "workflow.json");
  const inputsFile = join(dir, "inputs.json");
  writeFileSync(workflowFile, JSON.stringify(workflow), "utf8");
  writeFileSync(inputsFile, JSON.stringify(inputs), "utf8");
  try {
    const output = runNodeCheck(
      `
        import { readFileSync } from "node:fs";
        import { configureFastflowApp } from ${JSON.stringify(fastflowImport("root"))};
        import {
          normalizeSwfWorkflow,
          validateFastflowSwfSubset,
          validateFastflowWorkflowSchema,
        } from ${JSON.stringify(fastflowImport("workflow"))};
        import { markWorkflowRecordValidated } from ${JSON.stringify(fastflowSourceImport("src/lib/workflows.mjs"))};
        import { executeWorkflow } from ${JSON.stringify(fastflowSourceImport("src/lib/engine.mjs"))};
        import {
          LOOPSHIP_CALL_CATALOG_ROOT,
          createLoopshipFastflowAdapters,
        } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "scripts", "loopship_fastflow.ts")).href)};

        const workflow = JSON.parse(readFileSync(process.argv[2], "utf8"));
        const inputs = JSON.parse(readFileSync(process.argv[3], "utf8"));
        configureFastflowApp({
          appName: "loopship",
          systemWorkflowsDir: LOOPSHIP_CALL_CATALOG_ROOT,
          callCatalogRoots: [LOOPSHIP_CALL_CATALOG_ROOT],
          adapters: createLoopshipFastflowAdapters(),
        });
        const recordSeed = {
          filePath: "generated/loopship-native-test.yaml",
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

function executeWorkflowTaskScript(
  task: Record<string, unknown>,
  state: Record<string, unknown>,
): Record<string, unknown> {
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
  )(state) as Record<string, unknown>;
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

const FORBIDDEN_EXECUTABLE_PAYLOAD_FIELDS = new Set([
  "step",
  "state",
  "allowed_transitions",
  "commands",
  "docs",
  "flow_spec",
]);

function expectNoLoopshipEnvelopeFields(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    expect(FORBIDDEN_EXECUTABLE_PAYLOAD_FIELDS.has(key)).toBe(false);
  }
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

function runLoopshipCli(
  repo: string,
  args: string[],
  input?: Record<string, unknown>,
): { status: number | null; stdout: string; stderr: string } {
  return runCommand("bun", [LOOPSHIP_SCRIPT, ...args], {
    cwd: repo,
    env: {
      INFERENCE_CLIENT: "handoff",
      INFERENCE_PROVIDER: "",
      INFERENCE_MODEL: "",
      OPENAI_API_KEY: "",
      INFERENCE_ROUTES_JSON: TEST_INFERENCE_ROUTES_JSON,
    },
    timeoutMs: 600_000,
    input: input ? JSON.stringify(input) : undefined,
  });
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object: ${text}`);
  }
  return parsed as Record<string, unknown>;
}

async function startQuestStage(
  repo: string,
  prompt: string,
  wtree: string,
  extraArgs: string[] = [],
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
  ]);
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
  return parseJsonObject(proc.stdout, "loopship init");
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
  expect(sessionId).toBeTruthy();
  return {
    sessionId,
    nonce: String(args.nonce ?? "").trim(),
    workspaceRoot: String(args.workspaceRoot ?? "").trim(),
    kind: String(value.kind ?? ""),
  };
}

async function resumeQuestPause(
  repo: string,
  pause: Record<string, unknown>,
  decision: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const payload = {
    sessionId: String(pause.sessionId),
    ...(String(pause.nonce ?? "").trim() ? { nonce: String(pause.nonce) } : {}),
    ...(String(pause.workspaceRoot ?? "").trim()
      ? { workspaceRoot: String(pause.workspaceRoot) }
      : {}),
    ...(pause.kind === "supervisor_review"
      ? { supervisorDecision: "ok" }
      : { decision }),
  };
  const proc = runLoopshipCli(repo, ["hook", "--repo", repo, "--json", "@-"], payload);
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
  return parseJsonObject(proc.stdout, "loopship hook");
}

async function completeQuestStage(
  repo: string,
  started: Record<string, unknown>,
  decision?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const direct = workflowOutput(started);
  if (direct) return direct;
  const pause = interactionPause(started);
  expect(pause, JSON.stringify(started)).not.toBeNull();
  if (!decision && pause?.kind !== "supervisor_review") {
    throw new Error(`quest stage pause requires a decision: ${JSON.stringify(started)}`);
  }
  const resumed = await resumeQuestPause(repo, pause!, decision ?? {});
  const output = workflowOutput(resumed);
  expect(output, JSON.stringify(resumed)).not.toBeNull();
  return output!;
}

describe("Loopship Fastflow-native bridge", () => {
  test("requires focused native lifecycle release verification", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
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
    expect(packageJson.scripts.prepublishOnly).toBe("bun run verify:release");
  });

  test("registers exactly the minimal Loopship side-effect AFNs", () => {
    const calls = LOOPSHIP_AFN_DESCRIPTORS.map((descriptor) => descriptor.call).sort();
    expect(calls).toEqual([
      LOOPSHIP_AFN_CALLS.childPrepare,
      LOOPSHIP_AFN_CALLS.gitHead,
      LOOPSHIP_AFN_CALLS.landingApply,
      LOOPSHIP_AFN_CALLS.systemApply,
    ].sort());
    for (const call of calls) {
      expect(parseCallId(call)).toMatchObject({
        registry: "loopship",
        kind: "afn",
        target: "service",
      });
    }
  });

  test("hook normalizes legacy decision payloads into response answers", () => {
    expect(
      nativeResumeRequest({
        sessionId: "session-123",
        nonce: "nonce-123",
        workspaceRoot: "/tmp/demo",
        decision: { approved: true },
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

  test("stepper normalizes handoff decisions into response answers", () => {
    expect(
      nativeStepperResumeRequest({
        sessionId: "session-123",
        nonce: "nonce-123",
        workspaceRoot: "/tmp/demo",
        decision: { system_update: { schema_version: 1, mode: "no_change", summary: "Covered." } },
      }),
    ).toEqual({
      sessionId: "session-123",
      nonce: "nonce-123",
      workspaceRoot: "/tmp/demo",
      response: {
        answer: {
          system_update: {
            schema_version: 1,
            mode: "no_change",
            summary: "Covered.",
          },
        },
      },
    });
  });

  test("doctor fix excludes generated Codex hook config from git status", () => {
    const fixture = createGitFixture("loopship-native-codex-hook-exclude-");
    try {
      const status = runDoctor(["--repo", fixture.repo, "--runtime", "codex", "--fix"]);
      expect(status).toBe(0);
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

  test(
    "records the actual coordinator branch when source branch differs",
    { timeout: 60_000 },
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
        expect(tasks.coordinator_branch).toBe(wtree);
        expect(tasks.landing_target_branch).toBe("main");
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
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
      "loopship resume",
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
    expect(text).toContain("call: loopship.afn.service.git.head");
    expect(text).toContain("leaf_execution_recorded");
    expect(text).toContain("state.steps.stage_leaf_git_head?.action).commit");
    expect(text).toContain("state.steps.stage_leaf_target_git_head?.action).commit");
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
        if (!result.ok || result.calls !== 15) {
          throw new Error(JSON.stringify(result));
        }
        console.log(JSON.stringify(result));
      `,
      [LOOPSHIP_CALL_CATALOG_ROOT],
    );
    expect(JSON.parse(output).calls).toBe(15);
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
      expect(catalog.calls).toHaveLength(1);
      const { tags: _tags, ...descriptorWithoutTags } = descriptor as Record<string, unknown>;
      expect(catalog.calls[0]).toEqual(descriptorWithoutTags);
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
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).toContain(
      "must not author, patch, or correct target-app child implementation inline",
    );
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).toContain(
      "workflow-native CLI/inference agents to own child code generation and fixes",
    );
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).toContain("*.stable.yaml workflows");
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).toContain(".dev.yaml plus Fastflow promotion");
    expect(LOOPSHIP_SUPERVISOR_GUIDANCE.summary).toContain("restore the stable artifact");
    expect("command" in LOOPSHIP_SUPERVISOR_GUIDANCE).toBe(false);
    const adapters = createLoopshipFastflowAdapters();
    expect(adapters.adapterIdentity).toBe("@omar391/loopship");
    const descriptor = await (adapters.resolveCallDescriptor as Function)({
      call: LOOPSHIP_AFN_CALLS.childPrepare,
    });
    expect(descriptor.call).toBe(LOOPSHIP_AFN_CALLS.childPrepare);
    await expect(
      (adapters.auditAfn as Function)({
        action: {
          call: LOOPSHIP_AFN_CALLS.childPrepare,
          with: { body: { repo: "/tmp/repo", wtree: "demo", dry_run: true } },
        },
      }),
    ).resolves.toMatchObject({
      schemaVersion: "fastflow.audit.proposal/v1",
      audited: true,
      call: LOOPSHIP_AFN_CALLS.childPrepare,
    });
    const dryRunChild = await (adapters.executeAfn as Function)({
      action: {
        call: LOOPSHIP_AFN_CALLS.childPrepare,
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
    expect(dryRunChild.actions.init.args.join(" ")).toContain(
      "/tmp/repo/worktrees/demo/.loopship/runtime/tasks.yaml",
    );
    expect(dryRunChild.actions.init.args).toContain("--source-branch");
    expect(dryRunChild.actions.init.args).toContain(dryRunChild.branch_ref);
    expect(dryRunChild.actions.init.args).toContain("--repo");
    expect(dryRunChild.actions.init.args).toContain("/tmp/repo");
    expect(dryRunChild.actions.init.args).toContain("--parent-wtree");
    expect(dryRunChild.actions.init.args).toContain("demo");
    expect(dryRunChild.actions.init.args).toContain("--target-branch");
    expect(dryRunChild.actions.init.args).toContain("--target-worktree");
    expect(dryRunChild.actions.resume).toBeUndefined();
    await expect(
      (adapters.executeAfn as Function)({
        action: {
          call: LOOPSHIP_AFN_CALLS.childPrepare,
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
      ["questions", ["loopship_planning", "llm.cli.codex.gpt-5.5.max"]],
      ["task-graph", ["loopship_review", "llm.cli.codex.gpt-5.3-codex-spark.max"]],
      ["child-result", ["loopship_review", "llm.cli.codex.gpt-5.3-codex-spark.max"]],
      ["validation", ["loopship_review", "llm.cli.codex.gpt-5.3-codex-spark.max"]],
      ["verification", ["loopship_review", "llm.cli.codex.gpt-5.3-codex-spark.max"]],
      ["system-update", ["loopship_review", "llm.cli.codex.gpt-5.3-codex-spark.max"]],
      ["archived", ["loopship_mechanical", "llm.cli.codex.gpt-5.3-codex-spark.high"]],
    ]);

    for (const [name, [groupName, routeRef]] of expected) {
      const workflow = loadYamlWorkflow(join(stepRoot, `${name}.stable.yaml`));
      const document = workflow.document as Record<string, unknown>;
      const metadata = document.metadata as Record<string, any>;
      const group = metadata?.inference?.groups?.[groupName];
      expect(group, name).toBeTruthy();
      expect(group.try, name).toEqual(expect.arrayContaining([routeRef, "aitl.chat", "hitl.review"]));
      let stepUsesGroup = false;
      walk(workflow, (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const metadata = (value as Record<string, any>).metadata;
        if (metadata?.inference === groupName) stepUsesGroup = true;
      });
      expect(stepUsesGroup, name).toBe(true);
    }
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
        (adapters.executeAfn as Function)({
          action: {
            call: LOOPSHIP_AFN_CALLS.childPrepare,
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

  test("launches exactly one supervised child at a time and uses stepper init for child runs", async () => {
    const adapters = createLoopshipFastflowAdapters();
    const prepared = await (adapters.executeAfn as Function)({
      action: {
        call: LOOPSHIP_AFN_CALLS.childPrepare,
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
    expect(prepared.prepared_children).toHaveLength(1);
    expect(prepared.prepared_children[0]).toMatchObject({
      task_id: "task-a",
      supervise_step: true,
    });
    expect(prepared.actions.init.args.slice(0, 2)).toEqual(["stepper", "init"]);
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
    expect(result.events[0].payload).toMatchObject({
      event: "leaf_execution_missing_commit",
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
    { timeout: 600_000 },
    async () => {
    const fixture = createGitFixture("loopship-terminal-child-lifecycle-");
    try {
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

      const planOutput = await completeQuestStage(
        fixture.repo,
        await startQuestStage(fixture.repo, prompt, childWtree, extraArgs),
        {
          classification: "feature",
          scope: "Implement the assigned timer UI locally in the current child worktree.",
          summary: "Finish the assigned child task locally and land it back into the parent worktree.",
          assumptions: [],
          constraints: ["Do not create child worktrees."],
          system_context: {
            relevant_object_refs: [],
            relevant_assertion_refs: [],
            relevant_resource_refs: [],
            relevant_memory_refs: [],
            durable_implications: [],
          },
          verification_targets: ["Timer UI files are updated and committed in the current child worktree."],
          task_graph: {
            tasks: [
              {
                id: "implement-timer-ui",
                title: "Implement the timer UI locally",
                acceptance: [
                  "Timer UI files are updated and committed in the current child worktree.",
                ],
              },
            ],
          },
        },
      );
      expect(planOutput.step).toBe("plan");
      expect(planOutput.stage_after).toBe("plan_review");

      let childState = parseTasksYaml(
        readFileSync(
          join(fixture.repo, "worktrees", childWtree, ".loopship", "runtime", "tasks.yaml"),
          "utf8",
        ),
      );
      expect(childState.parent_wtree).toBe("parent");
      expect(childState.parent_task_id).toBe("timer-ui");
      expect(childState.tasks?.[0]).toMatchObject({
        child_wtree: "",
      });

      const approved = await completeQuestStage(
        fixture.repo,
        await startQuestStage(fixture.repo, prompt, childWtree, extraArgs),
        { approved: true },
      );
      expect(approved.step).toBe("task_graph");
      expect(approved.stage_after).toBe("executing");

      childState = parseTasksYaml(
        readFileSync(
          join(fixture.repo, "worktrees", childWtree, ".loopship", "runtime", "tasks.yaml"),
          "utf8",
        ),
      );
      const childWorktree = String(childState.coordinator_worktree || "");
      writeFileSync(join(childWorktree, "CHILD.md"), "# terminal child\n", "utf8");
      runGit(childWorktree, ["add", "CHILD.md"]);
      runGit(childWorktree, ["commit", "-m", "terminal child work"]);

      const executing = await completeQuestStage(
        fixture.repo,
        await startQuestStage(fixture.repo, prompt, childWtree, extraArgs),
      );
      expect(executing.step).toBe("executing");
      expect(executing.stage_after).toBe("validating");
      expect(JSON.stringify(executing)).not.toContain("loopship.child.prepare/v1");
      expect(JSON.stringify(executing)).not.toContain("prepared_children");

      const validated = await completeQuestStage(
        fixture.repo,
        await startQuestStage(fixture.repo, prompt, childWtree, extraArgs),
        {
          status: "passed",
          checks: [{ name: "terminal-child-smoke", status: "passed" }],
        },
      );
      expect(validated.step).toBe("validation");
      expect(validated.stage_after).toBe("verification_pending");

      const verified = await completeQuestStage(
        fixture.repo,
        await startQuestStage(fixture.repo, prompt, childWtree, extraArgs),
        {
          status: "passed",
          acceptance_trace: [
            {
              acceptance: "Timer UI files are updated and committed in the current child worktree.",
              status: "passed",
            },
          ],
          risks: [],
        },
      );
      expect(verified.step).toBe("verification");
      expect(verified.stage_after).toBe("system_update_pending");

      const systemRootPath = join(childWorktree, ".loopship", "system.yaml");
      const systemRoot = parseYaml(readFileSync(systemRootPath, "utf8")) as Record<string, unknown>;
      const updatedTitle = "Terminal Child System Update";
      systemRoot.title = updatedTitle;
      const systemUpdateStarted = await startQuestStage(fixture.repo, prompt, childWtree, extraArgs);
      expect(workflowOutput(systemUpdateStarted)).toBeNull();
      const systemUpdatePause = interactionPause(systemUpdateStarted);
      expect(systemUpdatePause, JSON.stringify(systemUpdateStarted)).not.toBeNull();
      const updated = await completeQuestStage(
        fixture.repo,
        systemUpdateStarted,
        {
          system_update: {
            schema_version: 1,
            mode: "replace",
            summary: "Refresh the canonical Loopship root after the verified terminal child work.",
            root: systemRoot,
            external_docs: [],
          },
        },
      );
      expect(updated.step).toBe("system_update");
      expect(updated.stage_after).toBe("landing_ready");
      expect(readFileSync(systemRootPath, "utf8")).toContain(updatedTitle);

      const landed = await completeQuestStage(
        fixture.repo,
        await startQuestStage(fixture.repo, prompt, childWtree, extraArgs),
      );
      expect(landed.step).toBe("landing");
      expect(landed.stage_after).toBe("archived");

      expect(readFileSync(join(parentWorkspace.worktree_path, "CHILD.md"), "utf8")).toContain(
        "terminal child",
      );
      expect(
        readFileSync(join(parentWorkspace.worktree_path, ".loopship", "system.yaml"), "utf8"),
      ).toContain(updatedTitle);
      childState = parseTasksYaml(
        readFileSync(
          join(fixture.repo, "worktrees", childWtree, ".loopship", "runtime", "tasks.yaml"),
          "utf8",
        ),
      );
      expect(childState.stage).toBe("archived");
      expect(String(childState.landed_commit || "")).toMatch(/^[0-9a-f]{40}$/);
      expect(childState.local_work_receipt).toMatchObject({
        mode: "shared-head-commit",
        covered_task_ids: ["implement-timer-ui"],
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
    },
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
      expect(manifest.prefixes.loopship.workflow.service.step.tags).toContain("step");
      expect(manifest.prefixes.loopship.workflow.service.flows.tags).toContain("flow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lifecycle promotion uses the Loopship registry directly", () => {
    const text = readFileSync(join(process.cwd(), "scripts", "loopship_fastflow_lifecycle.ts"), "utf8");
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
        call: LOOPSHIP_AFN_CALLS.landingApply,
        phase: "action",
        with: { body: { repo: "/tmp/repo" } },
      }),
    ).toThrow("requires body.wtree");
  });

  test("rejects unknown Loopship AFN body fields before promotion", () => {
    const adapters = createLoopshipFastflowAdapters();
    expect(() =>
      (adapters.validateCallInvocation as Function)({
        call: LOOPSHIP_AFN_CALLS.systemApply,
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
        call: LOOPSHIP_AFN_CALLS.childPrepare,
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
        call: LOOPSHIP_AFN_CALLS.systemApply,
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
        call: LOOPSHIP_AFN_CALLS.landingApply,
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
            {
              id: "task-a",
              title: "Task A",
              acceptance: "done",
              status: "child_archived",
              dependencies: [],
              scope_files: [],
            },
          ],
        }),
      );
      await expect(
        (adapters.executeAfn as Function)({
          action: {
            call: LOOPSHIP_AFN_CALLS.landingApply,
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
        (adapters.executeAfn as Function)({
          action: {
            call: LOOPSHIP_AFN_CALLS.landingApply,
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

      const result = await (adapters.executeAfn as Function)({
        action: {
          call: LOOPSHIP_AFN_CALLS.landingApply,
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

      const result = await (adapters.executeAfn as Function)({
        action: {
          call: LOOPSHIP_AFN_CALLS.landingApply,
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

  test("landing.apply commits canonical Loopship docs without transient runtime artifacts", async () => {
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
      writeFileSync(join(coordinatorWorktree, ".loopship", "runtime", "tasks.yaml"), "stage: demo\n");
      writeFileSync(join(coordinatorWorktree, ".loopship", "cache"), "transient\n");
      writeFileSync(join(coordinatorWorktree, "FEATURE.md"), "# feature\n", "utf8");
      runGit(coordinatorWorktree, ["add", "FEATURE.md"]);
      runGit(coordinatorWorktree, ["commit", "-m", "feature"]);

      const result = await (adapters.executeAfn as Function)({
        action: {
          call: LOOPSHIP_AFN_CALLS.landingApply,
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
      writeFileSync(join(coordinatorWorktree, ".loopship", "runtime", "tasks.yaml"), "stage: demo\n");
      writeFileSync(join(coordinatorWorktree, "FEATURE.md"), "# feature\n", "utf8");
      runGit(coordinatorWorktree, ["add", "FEATURE.md"]);
      runGit(coordinatorWorktree, ["commit", "-m", "feature"]);

      const result = await (adapters.executeAfn as Function)({
        action: {
          call: LOOPSHIP_AFN_CALLS.landingApply,
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
  });

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
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("catalog child-preparation workflow prepares every ready child through Fastflow", async () => {
    const fixture = createGitFixture("loopship-native-fastflow-executing-");
    try {
      createNativeQuest(fixture.repo, "demo");
      const stepRoot = join(process.cwd(), "call-catalog", "loopship", "workflow", "service", "step");
      const workflow = findWorkflowByCall(loadCatalogWorkflows(stepRoot), LOOPSHIP_AFN_CALLS.childPrepare);
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
      const workflow = findWorkflowByCall(loadCatalogWorkflows(stepRoot), LOOPSHIP_AFN_CALLS.childPrepare);
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
      const workflow = findWorkflowByCall(loadCatalogWorkflows(stepRoot), LOOPSHIP_AFN_CALLS.childPrepare);
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

      await (adapters.executeAfn as Function)({
        action: {
          call: LOOPSHIP_AFN_CALLS.childPrepare,
          with: { body },
        },
      });
      expect(runGit(worktreePath, ["rev-parse", "HEAD"])).toBe(initialParentHead);

      writeFileSync(join(parentWorktree, "FOUNDATION.md"), "# foundation\n", "utf8");
      runGit(parentWorktree, ["add", "FOUNDATION.md"]);
      runGit(parentWorktree, ["commit", "-m", "foundation"]);
      const parentHead = runGit(parentWorktree, ["rev-parse", "HEAD"]);

      await (adapters.executeAfn as Function)({
        action: {
          call: LOOPSHIP_AFN_CALLS.childPrepare,
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
      const workflow = findWorkflowByCall(loadCatalogWorkflows(stepRoot), LOOPSHIP_AFN_CALLS.landingApply);
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
      const result = await (adapters.executeAfn as Function)({
        action: {
          call: LOOPSHIP_AFN_CALLS.landingApply,
          with: {
            body: {
              repo: fixture.repo,
              wtree: "demo",
              status: "blocked",
              summary: "not ready",
              next_stage: "landing_ready",
            },
          },
        },
      });
      expect(result).toMatchObject({
        schema_version: "loopship.landing.apply/v1",
        dry_run: false,
        status: "blocked",
      });
      const blockedState = parseTasksYaml(readFileSync(files.tasks, "utf8"));
      expect(blockedState.stage).toBe("landing_ready");
      expect(String(blockedState.landed_commit || "")).toBe("");
      expect(readFileSync(files.events, "utf8")).toContain("landing_submitted");
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
