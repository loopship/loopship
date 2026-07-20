import { describe, expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyQuestPlanToTasks,
  createQuest,
  ensureCoordinatorWorkspace,
  taskAssignmentChildWtree,
  taskAssignmentWorktreePath,
  writeQuestManifest,
} from "./loopship_core.ts";

const PARENT_WTREE = "live-parent";
const TASK_ID = "task-a";
const EXECUTION_ID = "loopship-live-swe-restart";

function resolveFastflowRoot(requiredFiles: string[]): string {
  const candidates = [
    process.env.LOOPSHIP_FASTFLOW_ROOT,
    join(process.cwd(), "node_modules", "@cueintent", "fastflow"),
  ].filter(Boolean) as string[];
  const root = candidates.find((candidate) =>
    existsSync(join(candidate, "package.json")) &&
    requiredFiles.every((file) => existsSync(join(candidate, file))),
  );
  if (!root) throw new Error("could not resolve the Fastflow local-durable runtime");
  return root;
}

function sourceImport(root: string, relativePath: string): string {
  return pathToFileURL(join(root, relativePath)).href;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createLiveSweFixture(): {
  root: string;
  repo: string;
  coordinatorWorktree: string;
  childWtree: string;
  childWorktree: string;
} {
  const root = realpathSync(mkdtempSync(join(process.cwd(), "tmp", "loopship-live-swe-")));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "--initial-branch=main", repo], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  git(repo, ["config", "user.email", "loopship-test@example.invalid"]);
  git(repo, ["config", "user.name", "Loopship Fastflow Test"]);
  writeFileSync(
    join(repo, ".gitignore"),
    "/worktrees/*\n/.loopship/runtime/\n",
    "utf8",
  );
  writeFileSync(join(repo, "README.md"), "# live SWE restart fixture\n", "utf8");
  git(repo, ["add", ".gitignore", "README.md"]);
  git(repo, ["commit", "-m", "fixture"]);

  const workspace = ensureCoordinatorWorkspace(repo, PARENT_WTREE);
  const { files, state } = createQuest({
    repoRoot: repo,
    wtree: PARENT_WTREE,
    prompt: "loopship: verify durable Native child recovery",
    resolutionSource: "test",
    workspace,
    flowId: "swe",
    initialStage: "task_graph_ready",
    landingTargetBranch: "main",
    landingTargetWorktree: repo,
  });
  applyQuestPlanToTasks(files, state, {
    classification: "feature",
    scope: "Durable Native child recovery",
    summary: "Land one child after a scheduler hard restart.",
    decomposition_rationale: "One terminal child proves the durable lifecycle boundary.",
    verification_targets: ["FEATURE.md is landed into the coordinator branch."],
    tasks: [
      {
        id: TASK_ID,
        title: "Add the durable recovery fixture",
        type: "coding",
        status: "pending",
        dependencies: [],
        scope_files: ["FEATURE.md"],
        acceptance: "FEATURE.md is landed into the coordinator branch.",
      },
    ],
  });
  writeQuestManifest(files, "live-swe-plan", "loopship test fixture");
  return {
    root,
    repo,
    coordinatorWorktree: workspace.worktree_path,
    childWtree: taskAssignmentChildWtree(PARENT_WTREE, TASK_ID),
    childWorktree: taskAssignmentWorktreePath(repo, PARENT_WTREE, TASK_ID),
  };
}

function renderWorker(input: {
  fastflowRoot: string;
  loopshipRoot: string;
}): string {
  const fastflow = input.fastflowRoot;
  const loopshipAdapters = pathToFileURL(
    join(input.loopshipRoot, "scripts", "loopship_fastflow.ts"),
  ).href;
  return `
    import { readFileSync, writeFileSync } from "node:fs";
    import { monitorEventLoopDelay } from "node:perf_hooks";
    import { Database } from "bun:sqlite";
    import { parse as parseYaml } from "yaml";
    import {
      configureFastflowApp,
      resetFastflowAdapters,
    } from ${JSON.stringify(sourceImport(fastflow, "src/lib/consumer-adapters.mjs"))};
    import {
      digestNativeContract,
    } from ${JSON.stringify(sourceImport(fastflow, "src/lib/native-contracts.mjs"))};
    import { createLocalDurableSchedulerAuthority } from ${JSON.stringify(sourceImport(fastflow, "src/lib/local-durable-scheduler-authority.mjs"))};
    import { createSchedulerControlClient } from ${JSON.stringify(sourceImport(fastflow, "src/lib/scheduler-control-client.mjs"))};
    import {
      executeNativeWorkflow,
      recoverNativeWorkflow,
      resumeNativeWorkflow,
    } from ${JSON.stringify(sourceImport(fastflow, "src/lib/native-workflow-runtime.mjs"))};
    import {
      normalizeSwfWorkflow,
      validateFastflowSwfSubset,
      validateFastflowWorkflowSchema,
    } from ${JSON.stringify(sourceImport(fastflow, "src/lib/swf-workflow.mjs"))};
    import { markWorkflowRecordValidated } from ${JSON.stringify(sourceImport(fastflow, "src/lib/workflows.mjs"))};
    import {
      LOOPSHIP_CALL_CATALOG_ROOT,
      cleanupCompletedNativeWorkspaceResidue,
      createLoopshipFastflowAdapters,
    } from ${JSON.stringify(loopshipAdapters)};

    const mode = process.argv[2];
    const config = JSON.parse(readFileSync(process.argv[3], "utf8"));
    const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
    eventLoopDelay.enable();
    const rawWorkflow = parseYaml(readFileSync(config.workflowPath, "utf8"));
    const recordSeed = { filePath: config.workflowPath, store: "project" };
    const errors = [];
    validateFastflowWorkflowSchema(rawWorkflow, errors);
    validateFastflowSwfSubset(rawWorkflow, recordSeed, errors);
    const normalized = normalizeSwfWorkflow(rawWorkflow, recordSeed, errors);
    if (errors.length || !normalized) throw new Error(errors.join("; ") || "SWE did not normalize");
    const digest = digestNativeContract(normalized);
    const record = markWorkflowRecordValidated({
      ...recordSeed,
      digest,
      rawWorkflow,
      reference: "loopship.workflow.service.flows.swe",
      workflow_call_id: "loopship.workflow.service.flows.swe",
      summary: {
        id: "loopship.workflow.service.flows.swe",
        name: normalized.name,
        namespace: normalized.namespace,
        version: normalized.version,
        dsl: normalized.dsl,
        filePath: recordSeed.filePath,
        store: recordSeed.store,
        reference: "loopship.workflow.service.flows.swe",
        digest,
        target: normalized.target,
      },
      workflow: normalized,
    });
    const binding = {
      kind: "fixture",
      ref: "loopship-live-swe-restart",
      inference: {
        registry: {
          version: 1,
          protocols: { "local-process": { kind: "process" } },
          providers: { openai: { protocols: ["local-process"] } },
          connectors: {
            codex: {
              interface: "cli",
              provider: "openai",
              protocol: "local-process",
              command: config.missingInferenceCommand,
              args: [
                "exec",
                "--json",
                "--model",
                "{model}",
                "-c",
                'model_reasoning_effort="{nativeThinking}"',
              ],
            },
          },
          models: {
            "gpt-5.4-mini": {
              connectors: {
                codex: {
                  capabilities: { vision: true, tools: true },
                  thinking: {
                    default: { level: "medium" },
                    max: { level: "xhigh" },
                  },
                },
              },
            },
          },
          resolvers: { "aitl.subagent": {} },
        },
      },
    };
    const createRuntime = () => ({
      target: "service",
      executionBinding: binding,
      options: { executionBinding: binding },
      async ensureReady() {},
      async close() {},
    });
    const adapters = createLoopshipFastflowAdapters();
    configureFastflowApp({
      appName: "loopship",
      systemWorkflowsDir: LOOPSHIP_CALL_CATALOG_ROOT,
      callCatalogRoots: [LOOPSHIP_CALL_CATALOG_ROOT],
      adapters: { ...adapters, createExecutionContext: createRuntime },
    });
    const authority = createLocalDurableSchedulerAuthority({
      dbPath: config.dbPath,
      // Exercise the production default while keeping SIGKILL, rather than an
      // artificially tiny expiry, as the restart boundary under test.
      leaseMs: 30_000,
      ownerId: mode === "before" ? "loopship-live-before" : "loopship-live-after",
    });
    const serializeError = (error) => ({
      name: error?.name || "Error",
      code: error?.code || "",
      message: error instanceof Error ? error.message : String(error),
      stack: error?.stack || "",
      cause: error?.cause ? serializeError(error.cause) : null,
      errors: Array.isArray(error?.errors) ? error.errors.map(serializeError) : [],
    });
    void authority.failed.then((error) => {
      writeFileSync(config.authorityFailurePath, JSON.stringify(serializeError(error)));
    });
    const control = createSchedulerControlClient();
    const options = {
      schedulerMode: "local-durable",
      executionId: config.executionId,
      artifactMode: "minimal",
      workspaceRoot: config.coordinatorWorktree,
    };
    const inputs = {
      repo: config.repo,
      repoRoot: config.repo,
      wtree: config.parentWtree,
      request: "loopship: verify durable Native child recovery",
      runtime: "codex",
      maxConcurrency: 1,
    };
    async function readEvents(executionId) {
      const events = [];
      let afterSequence = 0;
      while (true) {
        const page = await control.readEvents({ executionId, afterSequence, limit: 1 });
        events.push(...page.events.map((entry) => entry.event));
        if (!page.hasMore) return events;
        afterSequence = Number(page.nextSequence);
      }
    }
    function durableChildExecutionIds(parentExecutionId) {
      const database = new Database(config.dbPath, { readonly: true });
      try {
        return database.query(
          "select child_execution_id, schema_version from scheduler_execution_children where parent_execution_id = ? order by child_execution_id",
        ).all(parentExecutionId).map((row) => {
          if (row.schema_version !== "fastflow.scheduler-child/v1") {
            throw new Error(
              "unexpected durable child schema: " + String(row.schema_version || "missing"),
            );
          }
          return String(row.child_execution_id);
        });
      } finally {
        database.close();
      }
    }
    async function executionTree(rootId, seedExecutionIds = [rootId]) {
      const seen = new Set();
      const queue = [...seedExecutionIds];
      const rows = [];
      while (queue.length) {
        const executionId = queue.shift();
        if (!executionId || seen.has(executionId)) continue;
        seen.add(executionId);
        const events = await readEvents(executionId);
        const submitted = events.find((event) => event.type === "execution.submitted");
        const dispatches = events
          .filter((event) => event.type === "node.dispatch_intended")
          .map((event) => event.data?.invocation)
          .filter(Boolean);
        rows.push({
          executionId,
          sourceRef: submitted?.data?.plan?.source?.ref || "",
          dispatches: dispatches.map((invocation) => ({
            invocationId: invocation.invocationId,
            effectKey: invocation.effectKey,
            attempt: invocation.attempt,
            callId: invocation.call?.callId || "",
            requestId: invocation.input?.request_id || "",
          })),
        });
        queue.push(...durableChildExecutionIds(executionId));
      }
      return rows;
    }
    async function terminalSnapshot(executionId) {
      const handle = await control.inspect({ executionId });
      if (handle.status !== "completed") {
        throw new Error("expected completed execution handle: " + JSON.stringify(handle));
      }
      const afterSequence = Math.max(0, Number(handle.cursor) - 1);
      const page = await control.readEvents({ executionId, afterSequence, limit: 1 });
      const event = page.events[0]?.event;
      if (event?.type !== "execution.completed" || Number(event.sequence) !== Number(handle.cursor)) {
        throw new Error(
          "completed handle does not point at one terminal event: " +
          JSON.stringify({ handle, event }),
        );
      }
      return {
        cursor: Number(handle.cursor),
        eventId: event.eventId,
        eventType: event.type,
      };
    }
    async function waitForWorkflowResult() {
      const deadline = Date.now() + 180_000;
      while (true) {
        const result = await recoverNativeWorkflow({
          executionId: config.executionId,
          options,
        });
        if (!["pending", "queued", "running"].includes(result.status)) return result;
        if (Date.now() >= deadline) {
          throw new Error("timed out waiting for the local-durable workflow result");
        }
        await Bun.sleep(20);
      }
    }
    const reportPhase = (phase) => writeFileSync(
      config.phasePath,
      JSON.stringify({ mode, phase, at: new Date().toISOString() }),
    );
    reportPhase("configured");
    await authority.start();
    reportPhase("authority_started");
    if (mode === "before") {
      reportPhase("executing_before_restart");
      await executeNativeWorkflow(createRuntime(), record, inputs, options);
      const paused = await waitForWorkflowResult();
      if (paused.status !== "paused") {
        throw new Error(
          "live SWE must pause at child implementation before the hard kill: " +
          JSON.stringify(paused),
        );
      }
      const tree = await executionTree(config.executionId);
      const child = tree.find((row) => row.sourceRef === "native-dag:${TASK_ID}");
      if (!child) throw new Error("live SWE did not create its stable Native child execution");
      const firstDispatch = child.dispatches[0];
      if (!firstDispatch?.effectKey) throw new Error("Native child effect identity is missing");
      writeFileSync(config.markerPath, JSON.stringify({
        status: paused.status,
        nonce: paused.pause?.nonce || "",
        childExecutionId: child.executionId,
        childEffectKey: firstDispatch.effectKey,
        childInvocationId: firstDispatch.invocationId,
        childAttempt: firstDispatch.attempt,
      }));
      await new Promise(() => {});
    } else if (mode === "after") {
      try {
        let result = await waitForWorkflowResult();
        const decisions = [
          { implementation_receipt: { status: "implemented", ref: "hard-restart-test" } },
          { status: "passed", checks: [{ name: "fixture", status: "passed", summary: "Focused fixture check passed." }] },
          {
            status: "passed",
            acceptance_trace: [{
              acceptance: "FEATURE.md is landed into the coordinator branch.",
              status: "passed",
              evidence: [{ type: "git", ref: "FEATURE.md", status: "passed" }],
            }],
            risks: [],
          },
          { status: "passed", checks: [{ name: "fixture", status: "passed", summary: "Coordinator validation passed." }] },
          {
            status: "passed",
            acceptance_trace: [{
              acceptance: "FEATURE.md is landed into the coordinator branch.",
              status: "passed",
              evidence: [{ type: "git", ref: "FEATURE.md", status: "passed" }],
            }],
            risks: [],
          },
          {
            system_update: {
              schema_version: 1,
              mode: "no_change",
              summary: "The fixture does not change durable Loopship system knowledge.",
            },
          },
        ];
        const pauseTrace = [];
        for (const [index, decision] of decisions.entries()) {
          if (result.status !== "paused" || !result.pause?.nonce) {
            throw new Error(
              "live SWE did not expose pause " + (index + 1) + ": " + JSON.stringify(result),
            );
          }
          const trace = {
            response: index + 1,
            stepId: result.pause.step_id || "",
            stage: result.state?.steps?.resolve_stage?.action?.current_stage || "",
            dagReconciliation: result.state?.steps?.stage_result_task_graph_ready?.action || null,
            stageResult: result.state?.steps?.build_stage_result?.action || null,
            childNode: result.state?.steps?.stage_task_graph_ready?.action?.scheduler?.nodes?.[0] || null,
          };
          pauseTrace.push(trace);
          writeFileSync(config.pauseTracePath, JSON.stringify(pauseTrace));
          reportPhase("resuming_response_" + (index + 1) + ":" + (trace.stepId || "unknown"));
          if (trace.stepId === "stage_failure_repair_handoff") {
            throw new Error("live SWE entered failure repair: " + JSON.stringify(trace));
          }
          try {
            await resumeNativeWorkflow({
              executionId: config.executionId,
              nonce: result.pause.nonce,
              signalId: "loopship-live-swe-response-" + (index + 1),
              decision,
              options,
            });
            reportPhase("waiting_response_" + (index + 1));
            result = await waitForWorkflowResult();
            reportPhase("received_response_" + (index + 1) + ":" + (result.pause?.step_id || result.status));
          } catch (error) {
            throw new Error(
              "live SWE response " + (index + 1) + " failed at " + trace.stepId + ": " +
              (error instanceof Error ? error.message : String(error)) + ": " + JSON.stringify({
                response: trace.response,
                stepId: trace.stepId,
                stage: trace.stage,
              }),
            );
          }
        }
        if (result.status === "paused") throw new Error("live SWE remained paused after its complete lifecycle response sequence");
        const stableChild = JSON.parse(readFileSync(config.markerPath, "utf8"));
        const childExecutionId = String(stableChild.childExecutionId || "");
        const dagExecutionId = childExecutionId.replace(/-iteration-[0-9a-f]{24}$/, "");
        const childTreeExecutionIds = [...new Set([dagExecutionId, childExecutionId])];
        reportPhase("collecting_completed_tree");
        const completedTree = await executionTree(
          config.executionId,
          [config.executionId, ...childTreeExecutionIds],
        );
        const terminalBeforeReplay = await terminalSnapshot(config.executionId);
        reportPhase("recovering_completed_execution");
        const replay = await recoverNativeWorkflow({
          executionId: config.executionId,
          options,
        });
        reportPhase("collecting_replay_tree");
        const replayTree = await executionTree(
          config.executionId,
          [config.executionId, ...childTreeExecutionIds],
        );
        const terminalAfterReplay = await terminalSnapshot(config.executionId);
        const child = replayTree.find((row) => row.sourceRef === "native-dag:${TASK_ID}");
        const landingDispatches = (tree) => tree.flatMap((row) => row.dispatches)
          .filter((dispatch) =>
            dispatch.callId === "loopship.afn.service.landing.apply-outcome" &&
            dispatch.requestId === "child-landing:${TASK_ID}"
          );
        const dagAction = result.state?.steps?.stage_task_graph_ready?.action || {};
        const reconciliation = result.state?.steps?.stage_result_task_graph_ready?.action || {};
        const childReceipt = dagAction.scheduler?.nodes?.[0]?.result?.iteration?.steps
          ?.run_child_lifecycle?.action || {};
        const cleanupReceipt = result.state?.steps?.cleanup_landed_worktrees?.action || {};
        const residueRemoved = cleanupCompletedNativeWorkspaceResidue({
          repo: config.repo,
          workspaceRoot: config.coordinatorWorktree,
        });
        reportPhase("writing_completed_evidence");
        writeFileSync(config.outputPath, JSON.stringify({
          status: result.status,
          output: result.output,
          replayStatus: replay.status,
          replayOutput: replay.output,
          completedTree,
          replayTree,
          child,
          landingBeforeReplay: landingDispatches(completedTree),
          landingAfterReplay: landingDispatches(replayTree),
          childReceipt,
          cleanupReceipt,
          residueRemoved,
          reconciliation,
          reconciliationEventCount: Array.isArray(reconciliation.events)
            ? reconciliation.events.filter((event) => event?.event === "child_dag_reconciled").length
            : 0,
          terminalBeforeReplay,
          terminalAfterReplay,
          eventLoopDelayMaxMs: Number(eventLoopDelay.max) / 1_000_000,
        }));
      } finally {
        await authority.stop();
        resetFastflowAdapters();
      }
    } else {
      throw new Error("unknown live SWE worker mode: " + mode);
    }
  `;
}

async function waitForMarker(
  path: string,
  child: ChildProcess,
  diagnostics: () => string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!existsSync(path)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`live SWE worker exited before pause: ${diagnostics()}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for live SWE pause: ${diagnostics()}`);
    }
    await Bun.sleep(25);
  }
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
  diagnostics: (stdout: string, stderr: string) => string,
): Promise<void> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let timeout: NodeJS.Timeout | null = null;
  const outcome = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    }),
    new Promise<"timeout">((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (outcome === "timeout") {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      child.kill("SIGKILL");
      await exited;
    }
    throw new Error(`live SWE worker timed out: ${diagnostics(stdout, stderr)}`);
  }
  if (outcome.code !== 0) {
    throw new Error(
      `live SWE worker exited code=${String(outcome.code)} signal=${String(outcome.signal)}: ${diagnostics(stdout, stderr)}`,
    );
  }
}

function readLiveDiagnostics(input: {
  authorityFailurePath: string;
  phasePath: string;
  pauseTracePath: string;
  stdout: string;
  stderr: string;
}): string {
  let phase = "unreported";
  if (existsSync(input.phasePath)) {
    phase = readFileSync(input.phasePath, "utf8").trim() || phase;
  }
  const authorityFailure = existsSync(input.authorityFailurePath)
    ? readFileSync(input.authorityFailurePath, "utf8").trim()
    : "";
  const pauseTrace = existsSync(input.pauseTracePath)
    ? readFileSync(input.pauseTracePath, "utf8").trim()
    : "";
  let pauseSummary: unknown = [];
  try {
    const parsed = JSON.parse(pauseTrace || "[]");
    pauseSummary = Array.isArray(parsed)
      ? parsed.map((entry) => ({
          response: entry?.response,
          stepId: entry?.stepId,
          stage: entry?.stage,
        }))
      : parsed;
  } catch {
    pauseSummary = pauseTrace.slice(-2_000);
  }
  return JSON.stringify({
    stderr: input.stderr.slice(-12_000),
    stdout: input.stdout.slice(-12_000),
    phase,
    authorityFailure,
    pauseTrace: pauseSummary,
  });
}

describe("Loopship live SWE durable restart", () => {
  test("hard-kills and restarts the daemon without changing child or landing identity", async () => {
    const fixture = createLiveSweFixture();
    const fastflowRoot = resolveFastflowRoot([
      "src/lib/native-workflow-runtime.mjs",
      "src/lib/native-scheduler-backend.mjs",
      "src/lib/scheduler-daemon.mjs",
      "src/lib/sqlite-execution-store.mjs",
    ]);
    const workerPath = join(fixture.root, "live-swe-worker.mjs");
    const configPath = join(fixture.root, "live-swe-config.json");
    const markerPath = join(fixture.root, "paused.json");
    const outputPath = join(fixture.root, "completed.json");
    const phasePath = join(fixture.root, "worker-phase.json");
    const authorityFailurePath = join(fixture.root, "authority-failure.json");
    const pauseTracePath = join(fixture.root, "pause-trace.json");
    const dbPath = join(fixture.root, "scheduler.sqlite");
    const missingInferenceCommand = join(fixture.root, "missing-codex-cli");
    mkdirSync(join(fixture.root, "home"), { recursive: true });
    writeFileSync(
      workerPath,
      renderWorker({ fastflowRoot, loopshipRoot: process.cwd() }),
      "utf8",
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        repo: fixture.repo,
        coordinatorWorktree: fixture.coordinatorWorktree,
        parentWtree: PARENT_WTREE,
        executionId: EXECUTION_ID,
        workflowPath: join(
          process.cwd(),
          "call-catalog",
          "loopship",
          "workflow",
          "service",
          "flows",
          "swe.stable.yaml",
        ),
        dbPath,
        markerPath,
        outputPath,
        phasePath,
        authorityFailurePath,
        pauseTracePath,
        missingInferenceCommand,
      }),
      "utf8",
    );
    expect(existsSync(missingInferenceCommand)).toBe(false);
    const env = {
      ...process.env,
      HOME: join(fixture.root, "home"),
      FASTFLOW_SCHEDULER_MODE: "local-durable",
      FASTFLOW_SCHEDULER_DB: dbPath,
    };
    let stdout = "";
    let stderr = "";
    const before = spawn(process.execPath, ["--no-install", workerPath, "before", configPath], {
      cwd: fixture.coordinatorWorktree,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    before.stderr.setEncoding("utf8");
    before.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    before.stdout.setEncoding("utf8");
    before.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    try {
      await waitForMarker(markerPath, before, () =>
        readLiveDiagnostics({
          authorityFailurePath,
          phasePath,
          pauseTracePath,
          stdout,
          stderr,
        }),
      );
      const paused = JSON.parse(readFileSync(markerPath, "utf8")) as {
        status: string;
        childExecutionId: string;
        childEffectKey: string;
        childInvocationId: string;
        childAttempt: number;
      };
      expect(paused.status).toBe("paused");
      expect(paused.childExecutionId).toBeTruthy();
      expect(paused.childEffectKey).toBeTruthy();
      expect(existsSync(fixture.childWorktree)).toBe(true);

      const killed = before.kill("SIGKILL");
      expect(killed).toBe(true);
      const signal = await new Promise<NodeJS.Signals | null>((resolveExit) => {
        before.once("exit", (_code, exitSignal) => resolveExit(exitSignal));
      });
      expect(signal).toBe("SIGKILL");

      writeFileSync(
        join(fixture.childWorktree, "FEATURE.md"),
        "# recovered after a hard scheduler restart\n",
        "utf8",
      );
      git(fixture.childWorktree, ["add", "FEATURE.md"]);
      git(fixture.childWorktree, ["commit", "-m", "add durable recovery fixture"]);

      const after = spawn(process.execPath, ["--no-install", workerPath, "after", configPath], {
        cwd: fixture.coordinatorWorktree,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      await waitForChildExit(after, 420_000, (afterStdout, afterStderr) =>
        readLiveDiagnostics({
          authorityFailurePath,
          phasePath,
          pauseTracePath,
          stdout: `${stdout}${afterStdout}`,
          stderr: `${stderr}${afterStderr}`,
        }),
      );
      const completed = JSON.parse(readFileSync(outputPath, "utf8")) as any;
      expect(completed.status).not.toBe("paused");
      expect(completed.replayStatus).toBe(completed.status);
      expect(completed.child.executionId).toBe(paused.childExecutionId);
      const childDispatches = completed.child.dispatches as Array<{
        invocationId: string;
        effectKey: string;
        attempt: number;
      }>;
      expect(childDispatches.length).toBeGreaterThan(1);
      expect(childDispatches[0]?.invocationId).toBe(paused.childInvocationId);
      expect(childDispatches[0]?.attempt).toBe(paused.childAttempt);
      expect(childDispatches.every((item) => item.effectKey === paused.childEffectKey)).toBe(true);
      const invocationIds = childDispatches.map((item) => item.invocationId);
      expect(invocationIds.every((invocationId) => typeof invocationId === "string" && invocationId.length > 0)).toBe(true);
      expect(new Set(invocationIds).size).toBe(invocationIds.length);
      const attempts = childDispatches.map((item) => item.attempt);
      expect(attempts.every((attempt) => Number.isSafeInteger(attempt) && attempt > 0)).toBe(true);
      expect(new Set(attempts).size).toBe(attempts.length);
      expect(attempts.every((attempt, index) => index === 0 || attempt > attempts[index - 1]!)).toBe(true);
      expect(completed.replayTree).toEqual(completed.completedTree);
      expect(completed.landingBeforeReplay).toHaveLength(1);
      expect(completed.landingAfterReplay).toEqual(completed.landingBeforeReplay);
      expect(completed.landingBeforeReplay[0]).toMatchObject({
        requestId: `child-landing:${TASK_ID}`,
      });
      expect(completed.landingBeforeReplay[0].invocationId).toBeTruthy();
      expect(completed.landingBeforeReplay[0].effectKey).toBeTruthy();
      expect(completed.childReceipt).toMatchObject({
        schema_version: "loopship.child-result/v2",
        task_id: TASK_ID,
        child_wtree: fixture.childWtree,
        status: "child_archived",
      });
      expect(completed.childReceipt.merge_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(completed.reconciliation).toMatchObject({
        schema_version: "loopship.stage-result.build/v1",
        stage_after: "validating",
        transition: "complete",
        step_payload: { total: 1, passed: 1, failed: 0, blocked: 0, cancelled: 0 },
      });
      expect(completed.reconciliationEventCount).toBe(1);
      expect(completed.terminalBeforeReplay.eventType).toBe("execution.completed");
      expect(completed.terminalAfterReplay).toEqual(completed.terminalBeforeReplay);
      expect(completed.replayOutput).toEqual(completed.output);
      console.info(`live restart max event-loop delay: ${completed.eventLoopDelayMaxMs}ms`);
      expect(completed.eventLoopDelayMaxMs).toBeGreaterThanOrEqual(0);
      expect(completed.eventLoopDelayMaxMs).toBeLessThan(30_000);

      expect(completed.cleanupReceipt).toMatchObject({
        schema_version: "loopship.landing.cleanup/v1",
        removed_worktrees: expect.arrayContaining([
          fixture.childWorktree,
          fixture.coordinatorWorktree,
        ]),
        removed_branches: expect.arrayContaining([
          `codex/${fixture.childWtree}`,
          PARENT_WTREE,
        ]),
        skipped: [],
      });
      expect(completed.residueRemoved).toBe(true);
      expect(existsSync(fixture.childWorktree)).toBe(false);
      expect(existsSync(fixture.coordinatorWorktree)).toBe(false);
      expect(git(fixture.repo, ["branch", "--list", PARENT_WTREE])).toBe("");
      expect(git(fixture.repo, ["branch", "--list", `codex/${fixture.childWtree}`])).toBe("");
      expect(git(fixture.repo, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
      expect(git(fixture.repo, ["merge-base", "--is-ancestor", completed.childReceipt.merge_commit, "main"])).toBe("");
      expect(readFileSync(join(fixture.repo, "FEATURE.md"), "utf8")).toContain(
        "hard scheduler restart",
      );
    } finally {
      if (before.exitCode === null && before.signalCode === null) before.kill("SIGKILL");
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 480_000);
});
