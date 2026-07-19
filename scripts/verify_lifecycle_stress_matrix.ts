#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  applySystemUpdate,
  ensureSystemScaffold,
  verifyRootManifest,
} from "./loopship_core.ts";
import { runCommand } from "./loopship_utils.ts";

type Status = "pass" | "fail";

type StressTask = {
  id: string;
  title: string;
  status: string;
  dependencies: string[];
  branch: string;
  worktree: string;
  base_commit: string;
  head_commit: string;
  merge_commit: string;
  blocker: string;
  validation_receipt?: Record<string, unknown>;
  verification_receipt?: Record<string, unknown>;
};

type StressState = {
  schema_version: "loopship.lifecycle-stress/v1";
  scenario: string;
  stage: string;
  tasks: StressTask[];
  validation_receipts: Array<Record<string, unknown>>;
  verification_receipts: Array<Record<string, unknown>>;
  landing_receipts: Array<Record<string, unknown>>;
  archive_receipt: Record<string, unknown> | null;
  cleanup_receipt: Record<string, unknown> | null;
  system_update_receipts: Array<Record<string, unknown>>;
};

type Fixture = {
  root: string;
  repo: string;
  statePath: string;
  eventsPath: string;
};

type ScenarioResult = {
  id: string;
  status: Status;
  proves: string;
  checks: string;
  cost: string;
  metrics: string;
  error?: string;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
let activeGitOps = 0;
let activeCheckMs = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function runGit(cwd: string, args: string[]): string {
  activeGitOps += 1;
  const result = runCommand("git", args, { cwd, timeoutMs: 30_000 });
  assert(result.status === 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function runGitMayFail(cwd: string, args: string[]) {
  activeGitOps += 1;
  return runCommand("git", args, { cwd, timeoutMs: 30_000 });
}

function writeYaml(path: string, value: unknown): void {
  writeFileSync(path, stringifyYaml(value, { lineWidth: 0 }), "utf8");
}

function readYaml<T>(path: string): T {
  return parseYaml(readFileSync(path, "utf8")) as T;
}

function appendEvent(fixture: Fixture, event: Record<string, unknown>): void {
  writeFileSync(
    fixture.eventsPath,
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    { flag: "a" },
  );
}

function readEvents(fixture: Fixture): Array<Record<string, unknown>> {
  return readFileSync(fixture.eventsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function saveState(fixture: Fixture, state: StressState): void {
  writeYaml(fixture.statePath, state);
}

function loadState(fixture: Fixture): StressState {
  return readYaml<StressState>(fixture.statePath);
}

function commitAll(cwd: string, message: string): string {
  runGit(cwd, ["add", "."]);
  const status = runGit(cwd, ["status", "--short"]);
  if (!status) return runGit(cwd, ["rev-parse", "HEAD"]);
  runGit(cwd, ["commit", "-m", message]);
  return runGit(cwd, ["rev-parse", "HEAD"]);
}

function createFixture(scenario: string): Fixture {
  const root = realpathTemp(`loopship-stress-${scenario}-`);
  const repo = join(root, "repo");
  const init = runCommand("git", ["init", "-b", "main", repo], { timeoutMs: 30_000 });
  assert(init.status === 0, init.stderr || init.stdout);
  runGit(repo, ["config", "user.email", "loopship-stress@example.invalid"]);
  runGit(repo, ["config", "user.name", "Loopship Stress"]);

  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  mkdirSync(join(repo, ".loopship", "runtime"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "worktrees/\ntmp/\n.loopship/runtime/\n", "utf8");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify(
      {
        type: "module",
        scripts: {
          check: "bun test",
          health: "bun run src/cli.ts health",
          migrate: "bun run src/cli.ts migrate",
          seed: "bun run src/cli.ts seed",
          reset: "bun run src/cli.ts reset",
          smoke: "bun run src/cli.ts smoke",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(repo, "src", "shared.ts"),
    'export const sharedValue = "base";\n',
    "utf8",
  );
  writeFileSync(join(repo, "src", "domain-a.ts"), "export const domainA = 1;\n", "utf8");
  writeFileSync(join(repo, "src", "domain-b.ts"), "export const domainB = 1;\n", "utf8");
  writeFileSync(
    join(repo, "src", "cli.ts"),
    [
      "const command = process.argv[2] || 'health';",
      "if (command === 'health') console.log(JSON.stringify({ ok: true }));",
      "else if (command === 'migrate') console.log(JSON.stringify({ ok: true, schemaVersion: 1 }));",
      "else if (command === 'seed') console.log(JSON.stringify({ ok: true, seeded: true }));",
      "else if (command === 'reset') console.log(JSON.stringify({ ok: true, reset: true }));",
      "else if (command === 'smoke') console.log(JSON.stringify({ ok: true, smoke: true }));",
      "else { console.error('unknown command'); process.exit(1); }",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(repo, "test", "smoke.test.ts"),
    [
      'import { expect, test } from "bun:test";',
      'import { existsSync } from "node:fs";',
      'import { sharedValue } from "../src/shared";',
      'test("fixture remains healthy", () => {',
      '  expect(sharedValue.length).toBeGreaterThan(0);',
      '  expect(existsSync("FAIL_VALIDATION")).toBe(false);',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(repo, ".env.example"), "LOOPSHIP_STRESS_MODE=local\n", "utf8");
  ensureSystemScaffold(repo);
  commitAll(repo, "fixture baseline");

  const fixture = {
    root,
    repo,
    statePath: join(repo, ".loopship", "runtime", "tasks.yaml"),
    eventsPath: join(repo, ".loopship", "runtime", "events.jsonl"),
  };
  writeFileSync(fixture.eventsPath, "", "utf8");
  saveState(fixture, {
    schema_version: "loopship.lifecycle-stress/v1",
    scenario,
    stage: "planned",
    tasks: [],
    validation_receipts: [],
    verification_receipts: [],
    landing_receipts: [],
    archive_receipt: null,
    cleanup_receipt: null,
    system_update_receipts: [],
  });
  appendEvent(fixture, { type: "fixture_created", scenario, repo });
  return fixture;
}

function realpathTemp(prefix: string): string {
  return runCommand("python3", [
    "-c",
    [
      "import os, sys, tempfile",
      "path = tempfile.mkdtemp(prefix=sys.argv[1])",
      "print(os.path.realpath(path))",
    ].join("; "),
    prefix,
  ], { timeoutMs: 30_000 }).stdout.trim() || mkdtempSync(join(tmpdir(), prefix));
}

function createTasks(fixture: Fixture, count: number, dependencies: string[][] = []): StressState {
  const state = loadState(fixture);
  state.tasks = Array.from({ length: count }, (_, index) => {
    const id = `t${String(index + 1).padStart(2, "0")}`;
    return {
      id,
      title: `Stress task ${id}`,
      status: "pending",
      dependencies: dependencies[index] ?? [],
      branch: `codex/stress-${state.scenario}-${id}`,
      worktree: join(fixture.repo, "worktrees", `stress-${state.scenario}-${id}`),
      base_commit: "",
      head_commit: "",
      merge_commit: "",
      blocker: "",
    };
  });
  saveState(fixture, state);
  appendEvent(fixture, { type: "tasks_planned", count });
  return state;
}

function readyTasks(state: StressState): StressTask[] {
  const passed = new Set(
    state.tasks.filter((task) => task.status === "landed").map((task) => task.id),
  );
  return state.tasks.filter(
    (task) =>
      task.status === "pending" &&
      task.dependencies.every((dependency) => passed.has(dependency)),
  );
}

function prepareChild(fixture: Fixture, task: StressTask): void {
  mkdirSync(join(fixture.repo, "worktrees"), { recursive: true });
  runGit(fixture.repo, ["worktree", "add", "-b", task.branch, task.worktree, "main"]);
  task.base_commit = runGit(task.worktree, ["rev-parse", "HEAD"]);
  task.status = "running";
  appendEvent(fixture, {
    type: "child_prepared",
    task_id: task.id,
    branch: task.branch,
    worktree: task.worktree,
    base_commit: task.base_commit,
  });
}

function workerCommit(
  task: StressTask,
  mode: "assigned" | "conflict" | "fail-validation" | "verification-target" = "assigned",
): Record<string, unknown> {
  if (mode === "conflict") {
    writeFileSync(
      join(task.worktree, "src", "shared.ts"),
      `export const sharedValue = "${task.id}";\n`,
      "utf8",
    );
  } else if (mode === "fail-validation") {
    writeFileSync(join(task.worktree, "FAIL_VALIDATION"), task.id, "utf8");
  } else if (mode === "verification-target") {
    writeFileSync(join(task.worktree, "src", "verified.ts"), "export const verified = true;\n", "utf8");
  } else {
    writeFileSync(
      join(task.worktree, "src", `${task.id}.ts`),
      `export const ${task.id.replace(/-/g, "_")} = ${JSON.stringify(task.id)};\n`,
      "utf8",
    );
  }
  task.head_commit = commitAll(task.worktree, `worker ${task.id}`);
  return {
    task_id: task.id,
    status: "passed",
    branch: task.branch,
    worktree_path: task.worktree,
    base_commit: task.base_commit,
    head_commit: task.head_commit,
    evidence: [{ type: "commit", ref: task.head_commit }],
  };
}

function acceptReceipt(
  fixture: Fixture,
  state: StressState,
  task: StressTask,
  receipt: Record<string, unknown>,
): boolean {
  const actualHead = runGit(task.worktree, ["rev-parse", "HEAD"]);
  const receiptHead = String(receipt.head_commit ?? "");
  if (receiptHead !== actualHead) {
    task.status = "blocked";
    task.blocker = "stale_receipt";
    appendEvent(fixture, {
      type: "stale_receipt_rejected",
      task_id: task.id,
      receipt_head: receiptHead,
      actual_head: actualHead,
    });
    saveState(fixture, state);
    return false;
  }
  if (receiptHead === task.base_commit) {
    task.status = "blocked";
    task.blocker = "missing_commit";
    appendEvent(fixture, {
      type: "missing_commit_blocked",
      task_id: task.id,
      base_commit: task.base_commit,
    });
    saveState(fixture, state);
    return false;
  }
  task.head_commit = receiptHead;
  task.status = "ready_to_merge";
  appendEvent(fixture, { type: "child_receipt_accepted", task_id: task.id, head: receiptHead });
  saveState(fixture, state);
  return true;
}

function mergeTask(fixture: Fixture, state: StressState, task: StressTask): boolean {
  const result = runGitMayFail(fixture.repo, ["merge", "--no-edit", task.branch]);
  if (result.status !== 0) {
    runGitMayFail(fixture.repo, ["merge", "--abort"]);
    task.status = "blocked";
    task.blocker = "merge_conflict";
    appendEvent(fixture, {
      type: "merge_conflict_blocked",
      task_id: task.id,
      branch: task.branch,
      error: result.stderr || result.stdout,
    });
    saveState(fixture, state);
    return false;
  }
  task.merge_commit = runGit(fixture.repo, ["rev-parse", "HEAD"]);
  task.status = "landed";
  appendEvent(fixture, {
    type: "child_landed",
    task_id: task.id,
    branch: task.branch,
    merge_commit: task.merge_commit,
  });
  saveState(fixture, state);
  return true;
}

function runPackageCommand(repo: string, script: string): Record<string, unknown> {
  const started = performance.now();
  const result = runCommand("bun", ["run", script], { cwd: repo, timeoutMs: 60_000 });
  activeCheckMs += performance.now() - started;
  return {
    name: script,
    status: result.status === 0 ? "passed" : "failed",
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    cwd: repo,
  };
}

function validateFixture(fixture: Fixture, state: StressState, names = ["check"]): boolean {
  const checks = names.map((name) => runPackageCommand(fixture.repo, name));
  const receipt = {
    schema_version: "loopship.validation.receipt/v1",
    status: checks.every((check) => check.status === "passed") ? "passed" : "failed",
    checks,
    cwd: fixture.repo,
  };
  state.validation_receipts.push(receipt);
  appendEvent(fixture, { type: "validation_finished", receipt });
  saveState(fixture, state);
  return receipt.status === "passed";
}

function verifyFixture(
  fixture: Fixture,
  state: StressState,
  targets: Array<{ name: string; path: string }>,
): boolean {
  const started = performance.now();
  const acceptance_trace = targets.map((target) => ({
    acceptance: target.name,
    status: existsSync(join(fixture.repo, target.path)) ? "passed" : "failed",
    path: target.path,
  }));
  const receipt = {
    schema_version: "loopship.verification.receipt/v1",
    status: acceptance_trace.every((item) => item.status === "passed") ? "passed" : "failed",
    acceptance_trace,
    cwd: fixture.repo,
  };
  state.verification_receipts.push(receipt);
  appendEvent(fixture, { type: "verification_finished", receipt });
  saveState(fixture, state);
  activeCheckMs += performance.now() - started;
  return receipt.status === "passed";
}

function archiveAndCleanup(fixture: Fixture, state: StressState): void {
  state.stage = "archived";
  state.archive_receipt = {
    schema_version: "loopship.archive.receipt/v1",
    landed_commit: runGit(fixture.repo, ["rev-parse", "HEAD"]),
  };
  appendEvent(fixture, { type: "archived", receipt: state.archive_receipt });
  saveState(fixture, state);
  cleanupAfterArchive(fixture, state);
}

function cleanupAfterArchive(fixture: Fixture, state: StressState): void {
  const removedWorktrees: string[] = [];
  const removedBranches: string[] = [];
  if (state.stage !== "archived" || !state.archive_receipt) {
    state.cleanup_receipt = {
      schema_version: "loopship.cleanup.receipt/v1",
      status: "skipped",
      reason: "missing_archive_evidence",
      removed_worktrees: [],
      removed_branches: [],
    };
    appendEvent(fixture, { type: "cleanup_skipped", reason: "missing_archive_evidence" });
    saveState(fixture, state);
    return;
  }
  for (const task of state.tasks) {
    if (existsSync(task.worktree)) {
      runGit(fixture.repo, ["worktree", "remove", "--force", task.worktree]);
      removedWorktrees.push(task.worktree);
    }
    const deleteBranch = runGitMayFail(fixture.repo, ["branch", "-d", task.branch]);
    if (deleteBranch.status === 0) removedBranches.push(task.branch);
  }
  state.cleanup_receipt = {
    schema_version: "loopship.cleanup.receipt/v1",
    status: "passed",
    removed_worktrees: removedWorktrees,
    removed_branches: removedBranches,
    validation_cwd: fixture.repo,
  };
  appendEvent(fixture, { type: "cleanup_finished", receipt: state.cleanup_receipt });
  saveState(fixture, state);
}

async function executeFastflowNativeProbe(
  id: string,
  items: Array<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const fastflowRoot = resolveFastflowRoot();
  const tempDir = mkdtempSync(join(tmpdir(), "loopship-stress-fastflow-"));
  const inputsPath = join(tempDir, "inputs.json");
  const scriptPath = join(tempDir, "probe.mjs");
  writeFileSync(inputsPath, JSON.stringify({ items }), "utf8");
  writeFileSync(
    scriptPath,
    `
      import { readFileSync } from "node:fs";
      import {
        completedDecision,
        createAfnDispatchPort,
        createEmbeddedSchedulerProfile,
        createMemoryExecutionStore,
        createNativeSchedulerBackend,
        digestCallContract,
        digestNativeContract,
        failedDecision,
        pinPlan,
      } from ${JSON.stringify(pathToFileURL(join(fastflowRoot, "src", "native-scheduler.mjs")).href)};

      const { items } = JSON.parse(readFileSync(process.argv[2], "utf8"));
      const callId = "loopship.afn.service.stress.capture";
      const contractDigest = digestCallContract({
        call: callId,
        inputs: { required: ["id"], optional: ["dependencies"] },
      });
      const implementationDigest = digestNativeContract({
        implementation: "loopship.lifecycle-stress.capture/v1",
      });
      const call = { callId, contractDigest, implementationDigest };
      const dependencyById = new Map(
        items.map((item) => [String(item.id), Array.isArray(item.dependencies) ? item.dependencies : []]),
      );
      const completed = new Set();
      const dispatchOrder = [];
      const dispatchPort = createAfnDispatchPort({
        routes: [{
          ...call,
          routeId: "loopship:stress:capture",
          async handler(invocation) {
            const missing = (dependencyById.get(invocation.nodeId) || [])
              .filter((dependency) => !completed.has(dependency));
            dispatchOrder.push(invocation.nodeId);
            if (missing.length) {
              return failedDecision({
                invocationId: invocation.invocationId,
                error: {
                  code: "loopship-stress-dependency-violation",
                  message: "dispatched before dependencies: " + missing.join(","),
                  retryable: false,
                },
              });
            }
            completed.add(invocation.nodeId);
            return completedDecision({
              invocationId: invocation.invocationId,
              output: { id: invocation.nodeId },
            });
          },
        }],
      });
      const plan = pinPlan({
        planId: ${JSON.stringify(`loopship-stress-${id}`)},
        source: {
          kind: "workflow",
          ref: ${JSON.stringify(`loopship.workflow.service.stress.${id}`)},
          digest: digestNativeContract({ id: ${JSON.stringify(id)}, items }),
        },
        nodes: items.map((item) => ({
          nodeId: String(item.id),
          dependencies: Array.isArray(item.dependencies) ? item.dependencies.map(String) : [],
          call,
          input: item,
        })),
      });
      const backend = createNativeSchedulerBackend({
        store: createMemoryExecutionStore(),
        dispatchPort,
        profile: createEmbeddedSchedulerProfile({ mode: "test" }),
      });
      const handle = await backend.submit({
        executionId: ${JSON.stringify(`loopship-stress-${id}`)},
        idempotencyKey: ${JSON.stringify(`loopship-stress-${id}`)},
        plan,
      });
      console.log(JSON.stringify({
        ok: handle.status === "completed",
        count: handle.nodes.length,
        passed: handle.nodes.filter((node) => node.status === "passed").length,
        dispatch_order: dispatchOrder,
        plan_digest: plan.planDigest,
      }));
    `,
    "utf8",
  );
  try {
    const result = runCommand("node", [scriptPath, inputsPath], {
      cwd: PACKAGE_ROOT,
      timeoutMs: 60_000,
    });
    assert(result.status === 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function resolveFastflowRoot(): string {
  const candidates = [
    process.env.LOOPSHIP_FASTFLOW_ROOT,
    resolve(PACKAGE_ROOT, "node_modules", "@cueintent", "fastflow"),
  ].filter(Boolean) as string[];
  const found = candidates.find((candidate) =>
    existsSync(join(candidate, "src", "index.mjs")) &&
    existsSync(join(candidate, "schemas", "fastflow.workflow.ext.yaml")),
  );
  assert(found, "could not resolve the Native v1 Fastflow root");
  return found;
}

function assertOnlyMainWorktree(fixture: Fixture): void {
  const worktrees = runGit(fixture.repo, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
  assert(worktrees.length === 1 && resolve(worktrees[0]) === resolve(fixture.repo), "cleanup left extra worktrees");
}

async function scenarioParallelClean(): Promise<void> {
  const fixture = createFixture("parallel-20-clean");
  try {
    const state = createTasks(fixture, 20);
    const scheduler = await executeFastflowNativeProbe(
      "parallel-20-clean",
      state.tasks.map((task) => ({ id: task.id, dependencies: [] })),
    );
    assert(scheduler.ok === true && scheduler.count === 20 && scheduler.passed === 20, "Fastflow scheduler did not pass 20 clean nodes");
    for (const task of state.tasks) {
      prepareChild(fixture, task);
      const receipt = workerCommit(task);
      assert(acceptReceipt(fixture, state, task, receipt), `receipt rejected for ${task.id}`);
    }
    for (const task of state.tasks) assert(mergeTask(fixture, state, task), `merge failed for ${task.id}`);
    assert(validateFixture(fixture, state, ["migrate", "seed", "health", "smoke", "check"]), "validation failed");
    assert(verifyFixture(fixture, state, [{ name: "task artifact", path: "src/t01.ts" }]), "verification failed");
    const manifest = verifyRootManifest(fixture.repo);
    assert(manifest.ok, manifest.errors.join("; "));
    archiveAndCleanup(fixture, state);
    assertOnlyMainWorktree(fixture);
    assert(readEvents(fixture).some((event) => event.type === "cleanup_finished"), "cleanup event missing");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function scenarioParallelConflict(): Promise<void> {
  const fixture = createFixture("parallel-20-conflict");
  try {
    const state = createTasks(fixture, 4);
    for (const task of state.tasks) {
      prepareChild(fixture, task);
      assert(acceptReceipt(fixture, state, task, workerCommit(task, "conflict")), "receipt rejected");
    }
    assert(mergeTask(fixture, state, state.tasks[0]), "first merge should pass");
    assert(!mergeTask(fixture, state, state.tasks[1]), "second merge should conflict");
    const blocked = state.tasks[1];
    runGit(blocked.worktree, ["reset", "--hard", "main"]);
    writeFileSync(
      join(blocked.worktree, "src", "shared.ts"),
      'export const sharedValue = "recovered-conflict-sequence";\n',
      "utf8",
    );
    blocked.head_commit = commitAll(blocked.worktree, "recover conflict deterministically");
    blocked.status = "ready_to_merge";
    blocked.blocker = "";
    appendEvent(fixture, { type: "merge_conflict_recovered", task_id: blocked.id });
    assert(mergeTask(fixture, state, blocked), "recovered merge should pass");
    archiveAndCleanup(fixture, state);
    const events = readEvents(fixture).map((event) => event.type);
    assert(events.includes("merge_conflict_blocked") && events.includes("merge_conflict_recovered"), "conflict evidence missing");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function scenarioDagUnblock(): Promise<void> {
  const fixture = createFixture("dag-unblock");
  try {
    const state = createTasks(fixture, 3, [[], ["t01"], ["t02"]]);
    const scheduler = await executeFastflowNativeProbe(
      "dag-unblock",
      state.tasks.map((task) => ({ id: task.id, dependencies: task.dependencies })),
    );
    assert(scheduler.ok === true && scheduler.passed === 3, "Fastflow scheduler did not pass DAG");
    const observedReady: string[][] = [];
    while (state.tasks.some((task) => task.status !== "landed")) {
      const ready = readyTasks(state);
      observedReady.push(ready.map((task) => task.id));
      assert(ready.length === 1, "DAG should unblock exactly one task at a time");
      const task = ready[0];
      prepareChild(fixture, task);
      assert(acceptReceipt(fixture, state, task, workerCommit(task)), "receipt rejected");
      assert(mergeTask(fixture, state, task), "merge failed");
    }
    assert(JSON.stringify(observedReady) === JSON.stringify([["t01"], ["t02"], ["t03"]]), "dependency order was not deterministic");
    archiveAndCleanup(fixture, state);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function scenarioStaleReceipt(): Promise<void> {
  const fixture = createFixture("stale-receipt");
  try {
    const state = createTasks(fixture, 1);
    const task = state.tasks[0];
    prepareChild(fixture, task);
    const receipt = workerCommit(task);
    receipt.head_commit = task.base_commit;
    assert(!acceptReceipt(fixture, state, task, receipt), "stale receipt was accepted");
    assert(task.status === "blocked" && task.blocker === "stale_receipt", "stale receipt did not block task");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function scenarioMissingCommit(): Promise<void> {
  const fixture = createFixture("missing-commit");
  try {
    const state = createTasks(fixture, 1);
    const task = state.tasks[0];
    prepareChild(fixture, task);
    const receipt = {
      task_id: task.id,
      status: "passed",
      branch: task.branch,
      worktree_path: task.worktree,
      base_commit: task.base_commit,
      head_commit: runGit(task.worktree, ["rev-parse", "HEAD"]),
    };
    assert(!acceptReceipt(fixture, state, task, receipt), "missing commit was accepted");
    assert(task.status === "blocked" && task.blocker === "missing_commit", "missing commit did not route back/block");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function scenarioValidationFailRetry(): Promise<void> {
  const fixture = createFixture("validation-fail-retry");
  try {
    const state = createTasks(fixture, 1);
    const task = state.tasks[0];
    prepareChild(fixture, task);
    assert(acceptReceipt(fixture, state, task, workerCommit(task, "fail-validation")), "receipt rejected");
    assert(mergeTask(fixture, state, task), "merge failed");
    assert(!validateFixture(fixture, state, ["check"]), "validation should fail");
    rmSync(join(fixture.repo, "FAIL_VALIDATION"), { force: true });
    commitAll(fixture.repo, "repair validation failure");
    appendEvent(fixture, { type: "validation_repair_ran", task_id: task.id });
    assert(validateFixture(fixture, state, ["check"]), "validation did not pass after repair");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function scenarioVerificationFailRetry(): Promise<void> {
  const fixture = createFixture("verification-fail-retry");
  try {
    const state = createTasks(fixture, 1);
    const task = state.tasks[0];
    prepareChild(fixture, task);
    assert(acceptReceipt(fixture, state, task, workerCommit(task)), "receipt rejected");
    assert(mergeTask(fixture, state, task), "merge failed");
    assert(validateFixture(fixture, state, ["check"]), "validation failed");
    assert(!verifyFixture(fixture, state, [{ name: "verified artifact", path: "src/verified.ts" }]), "verification should fail");
    writeFileSync(join(fixture.repo, "src", "verified.ts"), "export const verified = true;\n", "utf8");
    commitAll(fixture.repo, "repair verification failure");
    appendEvent(fixture, { type: "verification_repair_ran", task_id: task.id });
    assert(verifyFixture(fixture, state, [{ name: "verified artifact", path: "src/verified.ts" }]), "verification did not pass after repair");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function scenarioSystemUpdateMalformed(): Promise<void> {
  const fixture = createFixture("system-update-malformed");
  try {
    const beforeSystem = readFileSync(join(fixture.repo, ".loopship", "system.yaml"), "utf8");
    const beforeSignature = readFileSync(join(fixture.repo, ".loopship", "signature.yaml"), "utf8");
    let rejected = false;
    try {
      applySystemUpdate(fixture.repo, { mode: "replace", root: { schema_version: "bad" } }, "malformed");
    } catch {
      rejected = true;
    }
    assert(rejected, "malformed system update was not rejected");
    assert(readFileSync(join(fixture.repo, ".loopship", "system.yaml"), "utf8") === beforeSystem, "system doc was corrupted");
    assert(readFileSync(join(fixture.repo, ".loopship", "signature.yaml"), "utf8") === beforeSignature, "signature was corrupted");
    const state = loadState(fixture);
    state.system_update_receipts.push({
      schema_version: "loopship.system-update.receipt/v1",
      status: "rejected",
      reason: "malformed_payload",
    });
    saveState(fixture, state);
    appendEvent(fixture, { type: "system_update_rejected", reason: "malformed_payload" });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function scenarioLandingBlocked(): Promise<void> {
  const fixture = createFixture("landing-blocked");
  try {
    const state = createTasks(fixture, 1);
    const task = state.tasks[0];
    prepareChild(fixture, task);
    assert(acceptReceipt(fixture, state, task, workerCommit(task)), "receipt rejected");
    state.stage = "landing_ready";
    state.landing_receipts.push({
      schema_version: "loopship.landing.receipt/v1",
      status: "blocked",
      reason: "policy_hold",
      branch: task.branch,
      evidence: [{ type: "receipt", ref: task.head_commit }],
    });
    appendEvent(fixture, { type: "landing_blocked", task_id: task.id, reason: "policy_hold" });
    saveState(fixture, state);
    assert(!existsSync(join(fixture.repo, "src", `${task.id}.ts`)), "blocked landing merged files");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function scenarioResumeAfterInterrupt(): Promise<void> {
  const fixture = createFixture("resume-after-interrupt");
  try {
    const state = createTasks(fixture, 4);
    for (const task of state.tasks.slice(0, 2)) {
      prepareChild(fixture, task);
      assert(acceptReceipt(fixture, state, task, workerCommit(task)), "receipt rejected");
      assert(mergeTask(fixture, state, task), "merge failed");
    }
    appendEvent(fixture, { type: "interrupt_simulated", landed: 2 });
    saveState(fixture, state);
    const resumed = loadState(fixture);
    assert(resumed.tasks.filter((task) => task.status === "landed").length === 2, "resume did not read canonical state");
    for (const task of resumed.tasks.filter((item) => item.status === "pending")) {
      prepareChild(fixture, task);
      assert(acceptReceipt(fixture, resumed, task, workerCommit(task)), "receipt rejected after resume");
      assert(mergeTask(fixture, resumed, task), "merge failed after resume");
    }
    archiveAndCleanup(fixture, resumed);
    assertOnlyMainWorktree(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function scenarioCleanupAfterArchive(): Promise<void> {
  const fixture = createFixture("cleanup-after-archive");
  try {
    const state = createTasks(fixture, 2);
    for (const task of state.tasks) {
      prepareChild(fixture, task);
      assert(acceptReceipt(fixture, state, task, workerCommit(task)), "receipt rejected");
      assert(mergeTask(fixture, state, task), "merge failed");
    }
    cleanupAfterArchive(fixture, state);
    assert(state.cleanup_receipt?.status === "skipped", "cleanup should skip before archive");
    assert(validateFixture(fixture, state, ["check"]), "target-root validation failed before archive");
    archiveAndCleanup(fixture, state);
    assertOnlyMainWorktree(fixture);
    assert(state.cleanup_receipt?.validation_cwd === fixture.repo, "cleanup did not preserve target-root validation evidence");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function scenarioParallel100Clean(): Promise<void> {
  const fixture = createFixture("parallel-100-clean");
  try {
    const state = createTasks(fixture, 100);
    const scheduler = await executeFastflowNativeProbe(
      "parallel-100-clean",
      state.tasks.map((task) => ({ id: task.id, dependencies: [] })),
    );
    assert(scheduler.ok === true && scheduler.count === 100 && scheduler.passed === 100, "Fastflow scheduler did not pass 100 clean nodes");
    for (const task of state.tasks) {
      prepareChild(fixture, task);
      assert(acceptReceipt(fixture, state, task, workerCommit(task)), `receipt rejected for ${task.id}`);
    }
    for (const task of state.tasks) assert(mergeTask(fixture, state, task), `merge failed for ${task.id}`);
    assert(validateFixture(fixture, state, ["check"]), "validation failed");
    assert(verifyFixture(fixture, state, [{ name: "hundredth artifact", path: "src/t100.ts" }]), "verification failed");
    archiveAndCleanup(fixture, state);
    assertOnlyMainWorktree(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function scenarioDagDepth20(): Promise<void> {
  const fixture = createFixture("dag-depth-20");
  try {
    const dependencies = Array.from({ length: 20 }, (_, index) =>
      index === 0 ? [] : [`t${String(index).padStart(2, "0")}`],
    );
    const state = createTasks(fixture, 20, dependencies);
    const scheduler = await executeFastflowNativeProbe(
      "dag-depth-20",
      state.tasks.map((task) => ({ id: task.id, dependencies: task.dependencies })),
    );
    assert(scheduler.ok === true && scheduler.passed === 20, "Fastflow scheduler did not pass depth-20 DAG");
    const readyWidths: number[] = [];
    while (state.tasks.some((task) => task.status !== "landed")) {
      const ready = readyTasks(state);
      readyWidths.push(ready.length);
      assert(ready.length === 1, "depth-20 DAG should expose one ready task per level");
      const task = ready[0];
      prepareChild(fixture, task);
      assert(acceptReceipt(fixture, state, task, workerCommit(task)), "receipt rejected");
      assert(mergeTask(fixture, state, task), "merge failed");
    }
    assert(readyWidths.length === 20 && readyWidths.every((width) => width === 1), "depth-20 ready widths were not deterministic");
    archiveAndCleanup(fixture, state);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function scenarioWideAndDeepMixedDag(): Promise<void> {
  const fixture = createFixture("wide-and-deep-mixed-dag");
  try {
    const dependencies = Array.from({ length: 40 }, (_, index) => {
      if (index < 10) return [];
      if (index < 20) return [`t${String(index - 9).padStart(2, "0")}`];
      if (index < 30) return [`t${String(index - 9).padStart(2, "0")}`, `t${String(index - 19).padStart(2, "0")}`];
      return ["t21", "t22", "t23", "t24", "t25", "t26", "t27", "t28", "t29", "t30"];
    });
    const state = createTasks(fixture, 40, dependencies);
    const scheduler = await executeFastflowNativeProbe(
      "wide-and-deep-mixed-dag",
      state.tasks.map((task) => ({ id: task.id, dependencies: task.dependencies })),
    );
    assert(scheduler.ok === true && scheduler.passed === 40, "Fastflow scheduler did not pass mixed DAG");
    const observedWidths: number[] = [];
    while (state.tasks.some((task) => task.status !== "landed")) {
      const ready = readyTasks(state);
      observedWidths.push(ready.length);
      assert(ready.length > 0, "mixed DAG stalled");
      for (const task of ready) {
        prepareChild(fixture, task);
        assert(acceptReceipt(fixture, state, task, workerCommit(task)), "receipt rejected");
        assert(mergeTask(fixture, state, task), "merge failed");
      }
    }
    assert(JSON.stringify(observedWidths) === JSON.stringify([10, 10, 10, 10]), `unexpected mixed DAG widths: ${observedWidths.join(",")}`);
    archiveAndCleanup(fixture, state);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function scenarioLockContentionManyReady(): Promise<void> {
  const fixture = createFixture("lock-contention-many-ready");
  try {
    const state = createTasks(fixture, 50);
    const scheduler = await executeFastflowNativeProbe(
      "lock-contention-many-ready",
      state.tasks.map((task) => ({ id: task.id, dependencies: [] })),
    );
    assert(scheduler.ok === true && scheduler.passed === 50, "Fastflow Native plan did not pass 50 ready nodes");
    const serializedOrder: string[] = [];
    while (state.tasks.some((task) => task.status !== "landed")) {
      const [task] = readyTasks(state);
      assert(task, "lock contention sequencing stalled");
      serializedOrder.push(task.id);
      prepareChild(fixture, task);
      assert(acceptReceipt(fixture, state, task, workerCommit(task)), "receipt rejected");
      assert(mergeTask(fixture, state, task), "merge failed");
    }
    assert(serializedOrder.length === 50 && serializedOrder[0] === "t01" && serializedOrder[49] === "t50", "lock contention order was not deterministic");
    archiveAndCleanup(fixture, state);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function scenarioConcurrentCoordinatorResumeSmoke(): Promise<void> {
  const fixture = createFixture("concurrent-coordinator-resume-smoke");
  try {
    const state = createTasks(fixture, 12);
    const firstWave = readyTasks(state).slice(0, 6);
    for (const task of firstWave) {
      prepareChild(fixture, task);
      assert(acceptReceipt(fixture, state, task, workerCommit(task)), "receipt rejected before interrupt");
      assert(mergeTask(fixture, state, task), "merge failed before interrupt");
    }
    appendEvent(fixture, { type: "coordinator_interrupt_simulated", landed: firstWave.length });
    saveState(fixture, state);
    const resumed = loadState(fixture);
    assert(resumed.tasks.filter((task) => task.status === "landed").length === 6, "resume did not preserve first wave");
    for (const task of resumed.tasks.filter((item) => item.status === "pending")) {
      prepareChild(fixture, task);
      assert(acceptReceipt(fixture, resumed, task, workerCommit(task)), "receipt rejected after resume");
      assert(mergeTask(fixture, resumed, task), "merge failed after resume");
    }
    assert(validateFixture(fixture, resumed, ["check"]), "validation failed after resume");
    archiveAndCleanup(fixture, resumed);
    assertOnlyMainWorktree(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

const SCENARIOS: Array<{
  id: string;
  proves: string;
  checks: string;
  run: () => Promise<void>;
}> = [
  {
    id: "parallel-20-clean",
    proves: "ready batching, scripted child execution, ordered merges, validation, archive, cleanup",
    checks: "20 git worktrees, Fastflow scheduler result, receipts, validation, manifest, cleanup",
    run: scenarioParallelClean,
  },
  {
    id: "parallel-20-conflict",
    proves: "shared-file merge conflict detection and deterministic recovery",
    checks: "merge conflict event, blocked state, recovery commit, recovered merge",
    run: scenarioParallelConflict,
  },
  {
    id: "dag-unblock",
    proves: "dependency ordering and no premature dispatch",
    checks: "Fastflow scheduler DAG, ready queue snapshots, landed order",
    run: scenarioDagUnblock,
  },
  {
    id: "stale-receipt",
    proves: "old commit receipts are rejected",
    checks: "actual branch HEAD comparison, blocked state, stale event",
    run: scenarioStaleReceipt,
  },
  {
    id: "missing-commit",
    proves: "terminal child with no new work cannot complete",
    checks: "base/head equality, blocked state, missing-commit event",
    run: scenarioMissingCommit,
  },
  {
    id: "validation-fail-retry",
    proves: "validation failure routes to repair and passes after retry",
    checks: "failed Bun test receipt, repair commit, passing validation receipt",
    run: scenarioValidationFailRetry,
  },
  {
    id: "verification-fail-retry",
    proves: "verification failure preserves evidence and passes after repair",
    checks: "failed acceptance trace, repair commit, passing acceptance trace",
    run: scenarioVerificationFailRetry,
  },
  {
    id: "system-update-malformed",
    proves: "malformed system updates are rejected without doc corruption",
    checks: "applySystemUpdate rejection, unchanged system.yaml/signature.yaml",
    run: scenarioSystemUpdateMalformed,
  },
  {
    id: "landing-blocked",
    proves: "landing can record blocked state without merging",
    checks: "landing receipt, blocked event, target root lacks child file",
    run: scenarioLandingBlocked,
  },
  {
    id: "resume-after-interrupt",
    proves: "resume durability from canonical state without process memory",
    checks: "state reload after interrupt, remaining child execution, archive, cleanup",
    run: scenarioResumeAfterInterrupt,
  },
  {
    id: "cleanup-after-archive",
    proves: "cleanup only after durable archive evidence and target-root validation",
    checks: "pre-archive skip, post-archive worktree/branch removal, validation cwd",
    run: scenarioCleanupAfterArchive,
  },
  {
    id: "parallel-100-clean",
    proves: "deterministic scripted worker ceiling above prior parallel-20 baseline",
    checks: "100 git worktrees, Fastflow scheduler result, receipts, merge sequence, validation, verification, cleanup",
    run: scenarioParallel100Clean,
  },
  {
    id: "dag-depth-20",
    proves: "deep dependency unblocking without premature dispatch",
    checks: "20-level DAG scheduler result, one-ready-task sequencing, archive evidence",
    run: scenarioDagDepth20,
  },
  {
    id: "wide-and-deep-mixed-dag",
    proves: "mixed width/depth DAG waves preserve deterministic ready batches",
    checks: "40-node DAG scheduler result, observed ready widths, merge/archive evidence",
    run: scenarioWideAndDeepMixedDag,
  },
  {
    id: "lock-contention-many-ready",
    proves: "many Native-ready tasks can feed deterministic consumer-owned landing serialization",
    checks: "50-node PinnedPlan, consumer merge serialization order, landing/archive evidence",
    run: scenarioLockContentionManyReady,
  },
  {
    id: "concurrent-coordinator-resume-smoke",
    proves: "coordinator resume after an interrupted ready wave preserves canonical state",
    checks: "12 tasks, first-wave interrupt, state reload, remaining wave, validation, archive, cleanup",
    run: scenarioConcurrentCoordinatorResumeSmoke,
  },
];

async function main(): Promise<void> {
  const results: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    activeGitOps = 0;
    activeCheckMs = 0;
    const started = performance.now();
    try {
      await scenario.run();
      const runtimeMs = Math.round(performance.now() - started);
      results.push({
        id: scenario.id,
        status: "pass",
        proves: scenario.proves,
        checks: scenario.checks,
        cost: "tiny fixture repo + scripted workers; no live child agents",
        metrics: `runtime_ms=${runtimeMs}; git_ops=${activeGitOps}; check_ms=${Math.round(activeCheckMs)}`,
      });
    } catch (error) {
      const runtimeMs = Math.round(performance.now() - started);
      results.push({
        id: scenario.id,
        status: "fail",
        proves: scenario.proves,
        checks: scenario.checks,
        cost: "tiny fixture repo + scripted workers; no live child agents",
        metrics: `runtime_ms=${runtimeMs}; git_ops=${activeGitOps}; check_ms=${Math.round(activeCheckMs)}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const lines = [
    "# Lifecycle Stress Matrix",
    "",
    "| Scenario | Status | Proves | Checks | Cost Control | Metrics |",
    "| --- | --- | --- | --- | --- | --- |",
    ...results.map(
      (result) =>
        `| ${result.id} | ${result.status} | ${result.proves} | ${result.checks}${result.error ? `; error: ${result.error.replace(/\|/g, "/")}` : ""} | ${result.cost} | ${result.metrics} |`,
    ),
    "",
  ];
  process.stdout.write(lines.join("\n"));
  if (results.some((result) => result.status !== "pass")) {
    process.exitCode = 1;
  }
}

await main();
