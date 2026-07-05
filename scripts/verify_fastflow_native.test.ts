import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  createQuest,
  ensureCoordinatorWorkspace,
  parseTasksYaml,
  renderTasksYaml,
  taskAssignmentChildWtree,
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
import { runCommand } from "./loopship_utils.ts";

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
  const init = runCommand("git", ["init", repo], { timeoutMs: 15_000 });
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
        if (!result.ok || result.calls !== 14) {
          throw new Error(JSON.stringify(result));
        }
        console.log(JSON.stringify(result));
      `,
      [LOOPSHIP_CALL_CATALOG_ROOT],
    );
    expect(JSON.parse(output).calls).toBe(14);
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
      expect(manifest.prefixes.loopship.workflow.service.step.tags).toContain("step");
      expect(manifest.prefixes.loopship.workflow.service.flows.tags).toContain("flow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      const { files, state } = createNativeQuest(fixture.repo, "demo");
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
              next_stage: "archived",
            },
          },
        },
      });
      expect(result).toMatchObject({
        schema_version: "loopship.landing.apply/v1",
        dry_run: false,
        source_branch: "demo",
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
      expect(result.output.prepared_children[1].actions.resume).toBeUndefined();
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
