import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  buildLoopshipChildDagReconciliation,
  validateLoopshipChildDag,
} from "./loopship_child_dag.ts";

function resolveFastflowRoot(requiredFiles: string[]): string {
  const candidates = [
    process.env.LOOPSHIP_FASTFLOW_ROOT,
    join(process.cwd(), "node_modules", "@cueintent", "fastflow"),
  ].filter(Boolean) as string[];
  const root = candidates.find((candidate) =>
    existsSync(join(candidate, "package.json")) &&
    requiredFiles.every((file) => existsSync(join(candidate, file))),
  );
  if (!root) throw new Error("could not resolve the Fastflow Native runtime");
  return root;
}

function sourceImport(root: string, relativePath: string): string {
  return pathToFileURL(join(root, relativePath)).href;
}

function executeNativeDagFixture(input: {
  tasks: Array<Record<string, unknown>>;
  maxConcurrency: number;
  executionId: string;
}): Record<string, unknown> {
  const fastflowRoot = resolveFastflowRoot([
    "src/lib/afn-dispatch.mjs",
    "src/lib/native-workflow-runtime.mjs",
    "src/lib/execution-store.mjs",
  ]);
  const tempRoot = mkdtempSync(join(process.cwd(), "tmp", "loopship-native-dag-"));
  const inputPath = join(tempRoot, "input.json");
  const scriptPath = join(tempRoot, "fixture.mjs");
  writeFileSync(inputPath, JSON.stringify(input), "utf8");
  writeFileSync(
    scriptPath,
    `
      import { readFileSync } from "node:fs";
      import {
        configureFastflowApp,
        resetFastflowAdapters,
      } from ${JSON.stringify(sourceImport(fastflowRoot, "src/lib/consumer-adapters.mjs"))};
      import { createAfnDispatchPort } from ${JSON.stringify(sourceImport(fastflowRoot, "src/lib/afn-dispatch.mjs"))};
      import { createMemoryExecutionStore } from ${JSON.stringify(sourceImport(fastflowRoot, "src/lib/execution-store.mjs"))};
      import {
        completedDecision,
        failedDecision,
        digestCallContract,
        digestNativeContract,
      } from ${JSON.stringify(sourceImport(fastflowRoot, "src/lib/native-contracts.mjs"))};
      import { executeNativeWorkflow } from ${JSON.stringify(sourceImport(fastflowRoot, "src/lib/native-workflow-runtime.mjs"))};

      const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
      const callId = "fixture.afn.service.loopship.child-lifecycle";
      const descriptor = {
        call: callId,
        metadata: { allowed_phases: ["action"] },
      };
      const contractDigest = digestCallContract(descriptor);
      const implementationDigest = digestNativeContract({ implementation: callId, version: 1 });
      const events = [];
      let active = 0;
      let maxActive = 0;
      let dispatchCount = 0;
      const dispatch = createAfnDispatchPort({
        routes: [{
          callId,
          contractDigest,
          implementationDigest,
          routeId: "fixture:loopship-child-lifecycle",
          async handler(invocation) {
            const task = invocation.input?.task || {};
            const taskId = String(task.id || "");
            dispatchCount += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            events.push({ taskId, phase: "start", at: Date.now(), invocationId: invocation.invocationId, effectKey: invocation.effectKey });
            await new Promise((resolveDelay) => setTimeout(resolveDelay, Number(task.delay_ms || 50)));
            active -= 1;
            events.push({ taskId, phase: "end", at: Date.now(), invocationId: invocation.invocationId, effectKey: invocation.effectKey });
            if (task.fail === true) {
              return failedDecision({
                invocationId: invocation.invocationId,
                error: { code: "loopship_child_failed", message: taskId + " failed", retryable: false },
              });
            }
            return completedDecision({
              invocationId: invocation.invocationId,
              output: {
                schema_version: "loopship.child-result/v2",
                task_id: taskId,
                child_wtree: "root-" + taskId,
                status: "child_archived",
                branch_ref: "codex/root-" + taskId,
                worktree_path: "/repo/worktrees/root-" + taskId,
                merge_target: "root",
                merge_commit: String(task.commit_char || "a").repeat(40),
              },
            });
          },
        }],
      });
      const binding = { kind: "fixture", ref: "loopship-native-dag" };
      const createRuntime = () => ({
        target: "service",
        executionBinding: binding,
        options: { executionBinding: binding },
        async ensureReady() {},
        async close() {},
      });
      configureFastflowApp({
        appName: "loopship-native-dag-test",
        adapters: {
          adapterIdentity: "loopship.native-dag-test",
          adapterVersion: "1.0.0",
          registeredCalls: [descriptor],
          afnDispatch: dispatch,
          createExecutionContext: createRuntime,
        },
      });
      const step = (id, action) => ({
        id,
        description: id,
        mode: "headless_ok",
        action,
        pre_condition_check: { kind: "none" },
        post_condition_check: { kind: "none" },
        verification: { assertions: [] },
      });
      const loop = step("stage_task_graph_ready", {
        kind: "for",
        in: "\${inputs.tasks}",
        each: "childTask",
        at: "childIndex",
        while: null,
        dag: {
          id: "\${state.vars.childTask.id}",
          dependsOn: "\${state.vars.childTask.dependencies || []}",
          maxConcurrency: input.maxConcurrency,
          join: "all_settled",
        },
        steps: [step("run_child_lifecycle", {
          kind: "extension",
          call: callId,
          with: { body: { task: "\${state.vars.childTask}" } },
        })],
      });
      const workflow = {
        name: "loopship-native-dag",
        version: "1.0.0",
        target: "service",
        steps: [loop],
        output_as: { ok: true },
      };
      const digest = digestNativeContract(workflow);
      const record = {
        channel: "stable",
        digest,
        reference: "fixture.workflow.service.loopship.native-dag",
        workflow_call_id: "fixture.workflow.service.loopship.native-dag",
        summary: { ref: "fixture.workflow.service.loopship.native-dag", digest },
        rawWorkflow: workflow,
        workflow,
      };
      const store = createMemoryExecutionStore();
      const options = {
        schedulerMode: "test",
        schedulerStore: store,
        executionId: input.executionId,
        allowUnvalidatedRecord: true,
        artifactMode: "minimal",
      };
      const first = await executeNativeWorkflow(createRuntime(), record, { tasks: input.tasks }, options);
      const firstDispatchCount = dispatchCount;
      const replay = await executeNativeWorkflow(createRuntime(), record, { tasks: input.tasks }, options);
      const rootChildren = await store.listChildExecutions(input.executionId);
      const iterationChildren = rootChildren.length === 1
        ? await store.listChildExecutions(rootChildren[0])
        : [];
      resetFastflowAdapters();
      process.stdout.write(JSON.stringify({
        action: first.state.steps.stage_task_graph_ready.action,
        replayAction: replay.state.steps.stage_task_graph_ready.action,
        events,
        maxActive,
        dispatchCount,
        firstDispatchCount,
        rootChildren,
        iterationChildren,
      }));
    `,
    "utf8",
  );
  try {
    return JSON.parse(
      execFileSync(process.execPath, ["--no-install", scriptPath, inputPath], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as Record<string, unknown>;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(join(process.cwd(), ".loopship-native-dag-test"), {
      recursive: true,
      force: true,
    });
  }
}

describe("Loopship Native dynamic child DAG", () => {
  test("unwraps pinned nested child workflow outputs before lifecycle checks and reconciliation", () => {
    const flowsRoot = join(
      process.cwd(),
      "call-catalog",
      "loopship",
      "workflow",
      "service",
      "flows",
    );
    const child = parseYaml(
      readFileSync(join(flowsRoot, "swe-child.stable.yaml"), "utf8"),
    ) as any;
    const parent = parseYaml(
      readFileSync(join(flowsRoot, "swe.stable.yaml"), "utf8"),
    ) as any;
    const landing = parseYaml(
      readFileSync(
        join(flowsRoot, "..", "step", "landing.stable.yaml"),
        "utf8",
      ),
    ) as any;
    const index = parseYaml(readFileSync(join(flowsRoot, "index.yaml"), "utf8")) as any;
    const step = (workflow: any, id: string) =>
      workflow.do.find((entry: any) => entry[id])?.[id];

    expect(step(child, "validate_child").output.as).toBe(
      "${action.result.output.decision || action.result.output}",
    );
    expect(step(child, "verify_child").output.as).toBe(
      "${action.result.output.decision || action.result.output}",
    );
    expect(step(child, "land_child").output.as).toBe("${action.result.output}");
    expect(step(child, "archive_child").output.as).toBe("${action.result.output}");
    expect(step(child, "resolve_child_head_after").then).toBe(
      "implementation_commit_route",
    );
    expect(
      step(child, "implementation_commit_route").switch[0].advanced.when,
    ).toContain("!== state.steps.resolve_target_head.action.commit");
    expect(step(child, "implementation_commit_route").switch[1].no_commit.then).toBe(
      "fail_implementation",
    );
    expect(landing.input.schema.document.properties.request_id).toMatchObject({
      type: "string",
      minLength: 1,
    });
    expect(
      step(landing, "landing").input.schema.document.properties.request_id,
    ).toMatchObject({
      type: "string",
      minLength: 1,
    });

    const childCall = step(parent, "stage_task_graph_ready").do.find(
      (entry: any) => entry.run_child_lifecycle,
    ).run_child_lifecycle;
    expect(childCall.output.as).toBe("${action.result.output}");
    expect(childCall.metadata.ref.digest).toBe(index.workflows["swe-child"].stable.digest);
  });

  test("executes every terminal child run branch with the Fastflow run-script ABI", async () => {
    const fastflowRoot = resolveFastflowRoot([
      "src/lib/workflow-script-runner.mjs",
    ]);
    const { runSandboxedWorkflowScript } = await import(
      sourceImport(fastflowRoot, "src/lib/workflow-script-runner.mjs")
    );
    const catalogRoot = join(
      process.cwd(),
      "call-catalog",
      "loopship",
      "workflow",
      "service",
    );
    const child = parseYaml(
      readFileSync(join(catalogRoot, "flows", "swe-child.stable.yaml"), "utf8"),
    ) as any;
    const archived = parseYaml(
      readFileSync(join(catalogRoot, "step", "archived.stable.yaml"), "utf8"),
    ) as any;
    const step = (workflow: any, id: string) =>
      workflow.do.find((entry: any) => entry[id])?.[id];
    const run = (workflow: any, id: string, args: unknown, state: unknown) =>
      runSandboxedWorkflowScript({
        source: step(workflow, id).run.script.code,
        argNames: ["args", "state", "env"],
        args: [args, state, {}],
        label: `${id} run.script`,
      });
    const prepared = {
      task_id: "task-a",
      child_wtree: "live-parent-task-a",
      branch_ref: "codex/live-parent-task-a",
      worktree_path: "/repo/worktrees/live-parent-task-a",
      merge_target: "live-parent",
      merge_lease_id: "lease-live-parent-task-a",
      request_id: "child-landing:task-a",
    };

    await expect(run(child, "build_result", { prepared }, {
      steps: {
        land_child: {
          action: { landed_commit: "a".repeat(40), strategy: "fast-forward" },
        },
      },
    })).resolves.toMatchObject({
      schema_version: "loopship.child-result/v2",
      task_id: "task-a",
      child_wtree: "live-parent-task-a",
      merge_commit: "a".repeat(40),
      landing_strategy: "fast-forward",
    });
    await expect(run(child, "fail_child", { prepared }, {
      steps: {
        validate_child: { action: { status: "failed" } },
      },
    })).rejects.toThrow("loopship_child_lifecycle_failed:task-a:failed");
    await expect(run(child, "fail_implementation", { prepared }, { steps: {} }))
      .rejects.toThrow("loopship_child_implementation_commit_required:task-a");
    await expect(run(archived, "archived", {
      wtree: "live-parent-task-a",
      summary: "Archived through Native v1.",
      tasks: [{ status: "child_archived" }],
      parent_wtree: "live-parent",
      landing_target_branch: "live-parent",
    }, { steps: {} })).resolves.toMatchObject({
      status: "archived",
      wtree: "live-parent-task-a",
      task_count: 1,
      done_task_count: 1,
    });
  });

  test("keeps every catalog run script on the args/state/env ABI", () => {
    const workflowRoot = join(
      process.cwd(),
      "call-catalog",
      "loopship",
      "workflow",
    );
    const stableFiles = readdirSync(workflowRoot, { recursive: true })
      .map(String)
      .filter((path) => path.endsWith(".stable.yaml"))
      .sort();
    let runScriptCount = 0;
    const inspect = (value: unknown, label: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => inspect(item, `${label}[${index}]`));
        return;
      }
      if (!value || typeof value !== "object") return;
      const object = value as Record<string, any>;
      const script = object.run?.script;
      if (script) {
        runScriptCount += 1;
        expect(script.using, label).toBeUndefined();
        expect(String(script.code || ""), label).not.toMatch(/\binputs\b/);
      }
      for (const [key, item] of Object.entries(object)) {
        inspect(item, `${label}.${key}`);
      }
    };
    for (const relativePath of stableFiles) {
      const path = join(workflowRoot, relativePath);
      const workflow = parseYaml(readFileSync(path, "utf8")) as any;
      inspect(workflow, relativePath);
    }
    expect(stableFiles.length).toBeGreaterThan(0);
    expect(runScriptCount).toBeGreaterThan(0);
    const child = parseYaml(
      readFileSync(
        join(workflowRoot, "service", "flows", "swe-child.stable.yaml"),
        "utf8",
      ),
    ) as any;
    expect(child.do.find((entry: any) => entry.build_result)?.build_result?.then).toBe("end");
  });

  test("rejects whole-tree scope aliases and shared child resource identities", () => {
    for (const rootScope of [".", "./"]) {
      const validation = validateLoopshipChildDag({
        tasks: [
          { id: "root", dependencies: [], scope_files: [rootScope] },
          { id: "nested", dependencies: [], scope_files: ["src/**"] },
        ],
      });
      expect(validation.ok, rootScope).toBe(false);
      expect(validation.errors.join("\n"), rootScope).toContain("overlapping scope");
    }

    const sharedIdentity = validateLoopshipChildDag({
      tasks: [
        {
          id: "task-a",
          dependencies: [],
          scope_files: ["a/**"],
          child_wtree: "shared-child",
          branch_ref: "codex/shared",
          worktree_path: "/tmp/shared",
          merge_lease_id: "lease-shared",
        },
        {
          id: "task-b",
          dependencies: [],
          scope_files: ["b/**"],
          child_wtree: "shared-child",
          branch_ref: "codex/shared",
          worktree_path: "/tmp/shared",
          merge_lease_id: "lease-shared",
        },
      ],
    });
    expect(sharedIdentity.ok).toBe(false);
    for (const field of ["child_wtree", "branch_ref", "worktree_path", "merge_lease_id"]) {
      expect(sharedIdentity.errors.join("\n")).toContain(`share ${field}`);
    }
  });

  test("runs independent children concurrently, orders dependencies, and reconciles a real scheduler result", () => {
    const tasks = [
      { id: "task-a", dependencies: [], scope_files: ["src/a"], delay_ms: 80, commit_char: "a" },
      { id: "task-b", dependencies: [], scope_files: ["src/b"], delay_ms: 80, fail: true },
      { id: "task-c", dependencies: ["task-a"], scope_files: ["src/c"], delay_ms: 10, commit_char: "c" },
      { id: "task-d", dependencies: ["task-b"], scope_files: ["src/d"], delay_ms: 10, commit_char: "d" },
    ];
    const validation = validateLoopshipChildDag({ tasks, max_concurrency: 2 });
    expect(validation).toMatchObject({ ok: true, max_concurrency: 2 });
    const fixture = executeNativeDagFixture({
      tasks: validation.tasks,
      maxConcurrency: validation.max_concurrency,
      executionId: "loopship-native-dag-behavior",
    }) as any;

    expect(fixture.maxActive).toBe(2);
    const start = (taskId: string) =>
      fixture.events.find((event: any) => event.taskId === taskId && event.phase === "start");
    const end = (taskId: string) =>
      fixture.events.find((event: any) => event.taskId === taskId && event.phase === "end");
    const eventIndex = (event: Record<string, unknown>) => fixture.events.indexOf(event);
    expect(eventIndex(start("task-c"))).toBeGreaterThan(eventIndex(end("task-a")));
    expect(start("task-d")).toBeUndefined();

    expect(
      fixture.action.scheduler.nodes.map((node: any) => [node.id ?? node.nodeId, node.status]),
    ).toEqual([
      ["task-a", "passed"],
      ["task-b", "failed"],
      ["task-c", "passed"],
      ["task-d", "blocked"],
    ]);
    expect(
      fixture.action.scheduler.nodes[0].result.iteration.steps.run_child_lifecycle.action,
    ).toMatchObject({
      schema_version: "loopship.child-result/v2",
      task_id: "task-a",
      status: "child_archived",
    });

    const reconciliation = buildLoopshipChildDagReconciliation({
      tasks: validation.tasks,
      dag_result: fixture.action,
      runtime: {},
    }) as any;
    expect(reconciliation.step_payload).toMatchObject({
      total: 4,
      passed: 2,
      failed: 1,
      blocked: 1,
      cancelled: 0,
    });
    expect(reconciliation.state_patch.tasks.map((task: any) => [task.id, task.status])).toEqual([
      ["task-a", "child_archived"],
      ["task-b", "failed"],
      ["task-c", "child_archived"],
      ["task-d", "blocked"],
    ]);
    expect(fixture.dispatchCount).toBe(fixture.firstDispatchCount);
    expect(fixture.replayAction).toEqual(fixture.action);
    expect(fixture.rootChildren).toHaveLength(1);
    expect(fixture.iterationChildren).toHaveLength(3);
  }, 20_000);

  test("serializes the same Native DAG when superviseStep lowers the ceiling to one", () => {
    const validation = validateLoopshipChildDag({
      supervise_step: true,
      max_concurrency: 8,
      tasks: [
        { id: "task-a", dependencies: [], scope_files: ["src/a"], delay_ms: 30, commit_char: "a" },
        { id: "task-b", dependencies: [], scope_files: ["src/b"], delay_ms: 30, commit_char: "b" },
      ],
    });
    expect(validation).toMatchObject({ ok: true, max_concurrency: 1 });
    const fixture = executeNativeDagFixture({
      tasks: validation.tasks,
      maxConcurrency: validation.max_concurrency,
      executionId: "loopship-native-dag-supervised",
    }) as any;
    expect(fixture.maxActive).toBe(1);
    expect(fixture.action.scheduler.nodes.every((node: any) => node.status === "passed")).toBe(
      true,
    );
  }, 20_000);
});
