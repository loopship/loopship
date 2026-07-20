import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertCanonicalWtreeName,
  assertValidGitBranchRef,
  appendJsonl,
  buildQuestPlanState,
  createQuest,
  createQuestInitialState,
  ensureTaskWorkspace,
  isTerminalChildQuestState,
  parseTasksYaml,
  questFiles,
  renderTasksYaml,
  taskAssignmentBranchRef,
  taskAssignmentChildWtree,
  taskAssignmentMergeLeaseId,
  taskAssignmentWorktreePath,
  verifyQuestManifest,
  writeQuestManifest,
  type QuestState,
} from "./loopship_core.ts";
import {
  childDagTaskId,
  normalizeLoopshipChildDagTask,
} from "./loopship_child_dag.ts";
import { parse as parseYaml } from "yaml";
import { hashText, readText, writeText } from "./loopship_utils.ts";

const LOOPSHIP_RUNTIME_NAMESPACE = ".loopship/runtime";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requireString(value: unknown, field: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`${field} must be a non-empty string`);
  return result;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isPlainObject(value)) return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function childQuestPlan(input: {
  task: Record<string, unknown>;
  taskId: string;
}): Record<string, unknown> {
  const rawAcceptance = input.task.acceptance ?? input.task.acceptance_criteria;
  return {
    classification: "child",
    scope: optionalString(input.task.title) || input.taskId,
    summary: `Execute parent task ${input.taskId}.`,
    decomposition_rationale: "Native DAG child iterations are terminal leaf assignments.",
    verification_targets: Array.isArray(rawAcceptance)
      ? rawAcceptance.filter((value): value is string => typeof value === "string")
      : [optionalString(rawAcceptance)].filter(Boolean),
    tasks: [
      {
        ...input.task,
        id: input.taskId,
        status: "pending",
        dependencies: [],
      },
    ],
  };
}

function isExactQuestStartedEvent(
  event: Record<string, unknown>,
  wtree: string,
): boolean {
  const keys = Object.keys(event).sort();
  return (
    sameJson(keys, ["event", "quest_id", "stage", "ts"]) &&
    typeof event.ts === "string" &&
    Number.isFinite(Date.parse(event.ts)) &&
    event.event === "quest_started" &&
    event.quest_id === wtree &&
    event.stage === "executing"
  );
}

function hookStateIsEmpty(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readText(path));
    return isPlainObject(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
}

function assertExactPreparedArtifacts(input: {
  files: ReturnType<typeof questFiles>;
  state: QuestState;
  expectedState: QuestState;
  childWtree: string;
}): Array<Record<string, unknown>> {
  if (
    readText(input.files.tasks) !== renderTasksYaml(input.state) ||
    renderTasksYaml(input.state) !== renderTasksYaml(input.expectedState)
  ) {
    throw new Error(
      `existing child quest ${input.childWtree} has unexpected prepared task state`,
    );
  }
  const events = readJsonlRecords(input.files.events);
  if (events.length !== 1 || !isExactQuestStartedEvent(events[0]!, input.childWtree)) {
    throw new Error(
      `existing child quest ${input.childWtree} has unexpected preparation events`,
    );
  }
  if (!hookStateIsEmpty(input.files.hook_state)) {
    throw new Error(
      `existing child quest ${input.childWtree} has unexpected hook state`,
    );
  }
  return events;
}

function assertVerifiedQuestManifest(
  files: ReturnType<typeof questFiles>,
  context: string,
): void {
  const verification = verifyQuestManifest(files);
  if (!verification.ok) {
    throw new Error(`${context}: ${verification.errors.join("; ")}`);
  }
}

function manifestHasOnlyExpectedDelta(input: {
  files: ReturnType<typeof questFiles>;
  priorTasks: string;
  priorEvents: string;
  changed: Array<"tasks" | "events">;
}): boolean {
  const verification = verifyQuestManifest(input.files);
  const expectedErrors = input.changed.map((kind) =>
    `unauthorized/tampered quest file: ${input.files[kind]}`,
  ).sort();
  if (!sameJson([...verification.errors].sort(), expectedErrors)) return false;
  let manifest: Record<string, unknown>;
  try {
    const parsed = parseYaml(readText(input.files.manifest));
    if (!isPlainObject(parsed)) return false;
    manifest = parsed;
  } catch {
    return false;
  }
  if (
    manifest.schema_version !== 1 ||
    manifest.canonicalization !== "loopship-canonical-json-v1" ||
    manifest.generated_by !== "loopship" ||
    manifest.hash_algorithm !== "sha256" ||
    !optionalString(manifest.request_id) ||
    !optionalString(manifest.writer_command) ||
    !optionalString(manifest.receipt_head) ||
    !isPlainObject(manifest.files)
  ) {
    return false;
  }
  const hashes = Object.entries(manifest.files);
  if (hashes.length !== 2) return false;
  const taskEntry = hashes.find(([key]) => key.endsWith(".loopship/runtime/tasks.yaml"));
  const eventEntry = hashes.find(([key]) => key.endsWith(".loopship/runtime/events.jsonl"));
  return (
    optionalString(taskEntry?.[1]) === hashText(input.priorTasks) &&
    optionalString(eventEntry?.[1]) === hashText(input.priorEvents)
  );
}

function childQuestGuardState(
  body: Record<string, unknown>,
): Partial<
  Pick<
    QuestState,
    "prompt" | "parent_wtree" | "parent_task_id" | "parent_context_ref" | "supervise_step"
  >
> {
  const quest = isPlainObject(body.quest) ? body.quest : {};
  const parent = isPlainObject(body.parent) ? body.parent : {};
  return {
    prompt: optionalString(body.prompt) || optionalString(quest.prompt),
    parent_wtree:
      optionalString(parent.parent_wtree) || optionalString(quest.parent_wtree),
    parent_task_id:
      optionalString(parent.task_id) || optionalString(quest.parent_task_id),
    parent_context_ref:
      optionalString(parent.parent_context_ref) || optionalString(quest.parent_context_ref),
    supervise_step:
      body.supervise_step === true ||
      body.superviseStep === true ||
      quest.supervise_step === true ||
      quest.superviseStep === true,
  };
}

function ensurePreparedChildQuest(input: {
  repo: string;
  task: Record<string, unknown>;
  taskId: string;
  childWtree: string;
  branchRef: string;
  worktreePath: string;
  request: string;
  parentWtree: string;
  parentContextRef: string;
  targetBranch: string;
  targetWorktree: string;
  superviseStep: boolean;
}): void {
  const files = questFiles(input.repo, input.childWtree);
  const createInput = {
    repoRoot: input.repo,
    wtree: input.childWtree,
    prompt: input.request,
    resolutionSource: "fastflow-native-dag",
    superviseStep: input.superviseStep,
    workspace: {
      branch_ref: input.branchRef,
      worktree_path: input.worktreePath,
      mode: "git" as const,
    },
    flowId: "swe-child",
    initialStage: "executing",
    parentWtree: input.parentWtree,
    parentTaskId: input.taskId,
    parentContextRef: input.parentContextRef,
    landingTargetBranch: input.targetBranch,
    landingTargetWorktree: input.targetWorktree,
  };
  if (!existsSync(files.tasks)) {
    if (existsSync(files.events) || existsSync(files.manifest) || existsSync(files.hook_state)) {
      throw new Error(
        `partial child quest ${input.childWtree} is missing its authoritative task state`,
      );
    }
    createQuest(createInput);
  }
  const rawTasks = readText(files.tasks);
  const state = parseTasksYaml(rawTasks) as QuestState;
  const identity = {
    wtree: optionalString(state.wtree),
    flowId: optionalString(state.flow_id),
    parentWtree: optionalString(state.parent_wtree),
    parentTaskId: optionalString(state.parent_task_id),
    branchRef: optionalString(state.coordinator_branch),
    worktreePath: resolve(optionalString(state.coordinator_worktree) || input.worktreePath),
  };
  if (
    identity.wtree !== input.childWtree ||
    identity.flowId !== "swe-child" ||
    identity.parentWtree !== input.parentWtree ||
    identity.parentTaskId !== input.taskId ||
    identity.branchRef !== input.branchRef ||
    identity.worktreePath !== resolve(input.worktreePath)
  ) {
    throw new Error(`existing child quest ${input.childWtree} conflicts with its Native DAG identity`);
  }
  const expectedInitial = createQuestInitialState(createInput);
  const expectedPrepared = buildQuestPlanState(
    files,
    expectedInitial,
    childQuestPlan({ task: input.task, taskId: input.taskId }),
  );
  const initialTasks = renderTasksYaml(expectedInitial);
  const preparedTasks = renderTasksYaml(expectedPrepared);

  if (rawTasks === preparedTasks) {
    assertExactPreparedArtifacts({
      files,
      state,
      expectedState: expectedPrepared,
      childWtree: input.childWtree,
    });
    if (verifyQuestManifest(files).ok) return;
    if (!manifestHasOnlyExpectedDelta({
      files,
      priorTasks: initialTasks,
      priorEvents: readText(files.events),
      changed: ["tasks"],
    })) {
      throw new Error(
        `existing child quest ${input.childWtree} has an invalid prepared manifest`,
      );
    }
    writeQuestManifest(
      files,
      `native-child-prepare-${input.taskId}`,
      "loopship fastflow native child prepare recovery",
    );
    assertVerifiedQuestManifest(
      files,
      `child preparation recovery could not restore ${input.childWtree}`,
    );
    return;
  }

  if (rawTasks !== initialTasks) {
    throw new Error(
      `existing child quest ${input.childWtree} is not the exact Native child preparation state`,
    );
  }

  if (existsSync(files.manifest)) {
    assertExactPreparedArtifacts({
      files,
      state,
      expectedState: expectedInitial,
      childWtree: input.childWtree,
    });
    assertVerifiedQuestManifest(
      files,
      `existing child quest ${input.childWtree} has an invalid initial manifest`,
    );
  } else {
    const events = readJsonlRecords(files.events);
    if (
      events.length > 1 ||
      (events.length === 1 && !isExactQuestStartedEvent(events[0]!, input.childWtree))
    ) {
      throw new Error(
        `partial child quest ${input.childWtree} has unexpected preparation events`,
      );
    }
    if (existsSync(files.hook_state) && !hookStateIsEmpty(files.hook_state)) {
      throw new Error(`partial child quest ${input.childWtree} has unexpected hook state`);
    }
    if (!existsSync(files.events)) writeText(files.events, "");
    if (events.length === 0) {
      appendJsonl(files.events, {
        event: "quest_started",
        quest_id: input.childWtree,
        stage: "executing",
      });
    }
    if (!existsSync(files.hook_state)) writeText(files.hook_state, "{}\n");
    writeQuestManifest(
      files,
      `start-${input.childWtree}`,
      "loopship fastflow native child create recovery",
    );
    assertVerifiedQuestManifest(
      files,
      `child creation recovery could not restore ${input.childWtree}`,
    );
  }

  writeText(files.tasks, preparedTasks);
  writeQuestManifest(
    files,
    `native-child-prepare-${input.taskId}`,
    "loopship fastflow native child prepare",
  );
  assertVerifiedQuestManifest(
    files,
    `child preparation could not finalize ${input.childWtree}`,
  );
}

function prepareChild(
  body: Record<string, unknown>,
  task: Record<string, unknown>,
): Record<string, unknown> {
  const repo = requireString(body.repo, "repo");
  const parentWtree = assertCanonicalWtreeName(requireString(body.wtree, "wtree"));
  const taskId = requireString(childDagTaskId(task), "task.id");
  for (const field of ["branch", "base_branch", "child_wtree", "worktree_path"] as const) {
    if (optionalString(body[field])) {
      throw new Error(`Native child preparation rejects caller-supplied ${field}`);
    }
  }
  const childWtree = taskAssignmentChildWtree(parentWtree, taskId);
  assertCanonicalWtreeName(childWtree, "child_wtree");
  const branchRef = taskAssignmentBranchRef(parentWtree, taskId);
  assertValidGitBranchRef(branchRef, "child branch");
  const worktreePath = taskAssignmentWorktreePath(repo, parentWtree, taskId);
  const mergeLeaseId = taskAssignmentMergeLeaseId(parentWtree, taskId);
  for (const [field, expected] of [
    ["child_wtree", childWtree],
    ["branch_ref", branchRef],
    ["worktree_path", worktreePath],
    ["merge_lease_id", mergeLeaseId],
  ] as const) {
    const supplied = optionalString(task[field]);
    const matches = field === "worktree_path"
      ? resolve(supplied) === resolve(expected)
      : supplied === expected;
    if (supplied && !matches) {
      throw new Error(`Native child task ${taskId} has non-canonical ${field}`);
    }
  }
  const baseBranch = optionalString(body.target_branch) || parentWtree;
  if (branchRef === baseBranch) {
    throw new Error(`child branch must differ from its base branch: ${branchRef}`);
  }
  const workspace = body.dry_run === true
    ? { branch_ref: branchRef, worktree_path: worktreePath, mode: "dry-run" }
    : ensureTaskWorkspace(repo, branchRef, worktreePath, baseBranch);
  const runtime = optionalString(body.runtime) || "codex";
  const superviseStep = childQuestGuardState(body).supervise_step === true;
  const parentContextRef = `${repo}/worktrees/${parentWtree}/${LOOPSHIP_RUNTIME_NAMESPACE}/tasks.yaml`;
  const request = `loopship: execute child task ${taskId}: ${optionalString(task.title) || taskId}. Read parent context at ${parentContextRef}. Implement only this assigned task. Do not split into child worktrees. Land into ${parentWtree} and return the merge_commit.`;
  const targetBranch = optionalString(body.target_branch) || parentWtree;
  const targetWorktree =
    optionalString(body.target_worktree) || `${repo}/worktrees/${parentWtree}`;
  if (body.dry_run !== true) {
    ensurePreparedChildQuest({
      repo,
      task,
      taskId,
      childWtree,
      branchRef: workspace.branch_ref,
      worktreePath: workspace.worktree_path,
      request,
      parentWtree,
      parentContextRef,
      targetBranch,
      targetWorktree,
      superviseStep,
    });
  }
  return {
    schema_version: "loopship.child.prepare/v2",
    repo,
    task_id: taskId,
    task: normalizeLoopshipChildDagTask(task),
    request,
    child_wtree: childWtree,
    parent_wtree: parentWtree,
    parent_context_ref: parentContextRef,
    branch_ref: workspace.branch_ref,
    worktree_path: workspace.worktree_path,
    merge_target: targetBranch,
    merge_target_worktree: targetWorktree,
    merge_lease_id: mergeLeaseId,
    runtime,
    supervise_step: superviseStep,
  };
}

export function prepareLoopshipNativeChild(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const task = isPlainObject(body.task) ? body.task : null;
  if (isTerminalChildQuestState(childQuestGuardState(body))) {
    const childId = task ? childDagTaskId(task) || optionalString(task.title) : "";
    throw new Error(
      `terminal child quests must not prepare child worktrees${
        childId ? ` (${childId})` : ""
      }; keep the assigned work local in the current child worktree`,
    );
  }
  if (!task || !childDagTaskId(task)) {
    throw new Error("Native child preparation requires one identified canonical task");
  }
  const preparedChild = prepareChild(body, task);
  return {
    ...preparedChild,
    prepared_children: [preparedChild],
    count: 1,
  };
}

type JsonlDocument = {
  raw: string;
  lines: string[];
  records: Array<Record<string, unknown>>;
};

function readJsonlDocument(path: string): JsonlDocument {
  if (!existsSync(path)) return { raw: "", lines: [], records: [] };
  const raw = readFileSync(path, "utf8");
  if (raw && !raw.endsWith("\n")) {
    throw new Error(`non-canonical JSONL file is missing its final newline: ${path}`);
  }
  const lines = raw ? raw.slice(0, -1).split("\n") : [];
  const records = lines.map((line, index) => {
    if (!line || line.includes("\r")) {
      throw new Error(`non-canonical JSONL record ${index + 1}: ${path}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`invalid JSONL record ${index + 1}: ${path}`);
    }
    if (!isPlainObject(parsed) || JSON.stringify(parsed) !== line) {
      throw new Error(`non-canonical JSONL record ${index + 1}: ${path}`);
    }
    return parsed;
  });
  return { raw, lines, records };
}

function readJsonlRecords(path: string): Array<Record<string, unknown>> {
  return readJsonlDocument(path).records;
}

const CHILD_LIFECYCLE_STATUSES = [
  "implemented",
  "validation_passed",
  "validation_failed",
  "verification_passed",
  "verification_failed",
] as const;

type ChildLifecycleStatus = (typeof CHILD_LIFECYCLE_STATUSES)[number];

function requireChildLifecycleStatus(value: unknown): ChildLifecycleStatus {
  const status = requireString(value, "status");
  if (!(CHILD_LIFECYCLE_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`unsupported Native child lifecycle status: ${status}`);
  }
  return status as ChildLifecycleStatus;
}

function lifecycleStage(status: ChildLifecycleStatus): string {
  if (status === "implemented") return "validating";
  if (status === "validation_passed") return "verification_pending";
  if (status === "verification_passed") return "landing_ready";
  if (status === "verification_failed") return "verification_pending";
  return "validating";
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  keys: string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!sameJson(actual, expected)) {
    throw new Error(`${field} must contain exactly ${expected.join(", ")}`);
  }
}

function normalizeLifecycleReceipt(
  body: Record<string, unknown>,
  status: ChildLifecycleStatus,
): {
  implementation?: Record<string, unknown>;
  validation?: QuestState["validation_receipt"];
  verification?: QuestState["verification_receipt"];
} {
  const implementation = body.implementation_receipt;
  const validation = body.validation_receipt;
  const verification = body.verification_receipt;
  if (status === "implemented") {
    if (!isPlainObject(implementation)) {
      throw new Error("implemented lifecycle checkpoints require implementation_receipt");
    }
    if (validation !== undefined || verification !== undefined) {
      throw new Error("implemented lifecycle checkpoints reject unrelated phase receipts");
    }
    return { implementation };
  }
  if (status.startsWith("validation_")) {
    if (!isPlainObject(validation)) {
      throw new Error("validation lifecycle checkpoints require validation_receipt");
    }
    if (implementation !== undefined || verification !== undefined) {
      throw new Error("validation lifecycle checkpoints reject unrelated phase receipts");
    }
    assertOnlyKeys(validation, ["status", "checks"], "validation_receipt");
    const expectedStatus = status === "validation_passed" ? "passed" : "failed";
    if (validation.status !== expectedStatus || !Array.isArray(validation.checks)) {
      throw new Error(`validation_receipt must record ${expectedStatus} with checks`);
    }
    if (!validation.checks.every(isPlainObject)) {
      throw new Error("validation_receipt.checks must contain objects");
    }
    return {
      validation: {
        status: expectedStatus,
        checks: validation.checks as Array<Record<string, unknown>>,
      },
    };
  }
  if (!isPlainObject(verification)) {
    throw new Error("verification lifecycle checkpoints require verification_receipt");
  }
  if (implementation !== undefined || validation !== undefined) {
    throw new Error("verification lifecycle checkpoints reject unrelated phase receipts");
  }
  assertOnlyKeys(
    verification,
    ["status", "acceptance_trace", "risks"],
    "verification_receipt",
  );
  const expectedStatus = status === "verification_passed" ? "passed" : "failed";
  if (
    verification.status !== expectedStatus ||
    !Array.isArray(verification.acceptance_trace) ||
    !Array.isArray(verification.risks)
  ) {
    throw new Error(
      `verification_receipt must record ${expectedStatus} with acceptance_trace and risks`,
    );
  }
  if (
    !verification.acceptance_trace.every(isPlainObject) ||
    !verification.risks.every(isPlainObject)
  ) {
    throw new Error("verification receipt evidence must contain objects");
  }
  return {
    verification: {
      status: expectedStatus,
      acceptance_trace: verification.acceptance_trace as Array<Record<string, unknown>>,
      risks: verification.risks as Array<Record<string, unknown>>,
    },
  };
}

function isGitCommit(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(value);
}

function assertCanonicalChildState(input: {
  files: ReturnType<typeof questFiles>;
  state: QuestState;
  raw: string;
  wtree: string;
  taskId: string;
}): void {
  if (input.raw !== renderTasksYaml(input.state)) {
    throw new Error(`Native child quest ${input.wtree} has non-canonical task state`);
  }
  const tasks = Array.isArray(input.state.tasks) ? input.state.tasks : [];
  if (
    input.state.schema_version !== 5 ||
    optionalString(input.state.wtree) !== input.wtree ||
    optionalString(input.state.quest_id) !== input.wtree ||
    optionalString(input.state.flow_id) !== "swe-child" ||
    optionalString(input.state.parent_task_id) !== input.taskId ||
    tasks.length !== 1 ||
    optionalString(tasks[0]?.id) !== input.taskId ||
    optionalString(tasks[0]?.child_wtree)
  ) {
    throw new Error(`Native child quest ${input.wtree} does not own terminal task ${input.taskId}`);
  }
  if (!hookStateIsEmpty(input.files.hook_state)) {
    throw new Error(`Native child quest ${input.wtree} has unexpected hook state`);
  }
}

function assertLifecyclePriorState(
  state: QuestState,
  status: ChildLifecycleStatus,
  taskId: string,
): void {
  const task = state.tasks[0]!;
  const mergeCommit = optionalString(task.merge_commit);
  if (status === "implemented") {
    if (
      optionalString(state.stage) !== "executing" ||
      optionalString(task.status) !== "pending" ||
      mergeCommit ||
      state.local_work_receipt !== undefined
    ) {
      throw new Error(`Native child task ${taskId} is not awaiting implementation`);
    }
    return;
  }
  if (
    optionalString(task.status) !== "done" ||
    !isGitCommit(mergeCommit) ||
    !isPlainObject(state.local_work_receipt)
  ) {
    throw new Error(`Native child task ${taskId} lacks its implementation checkpoint`);
  }
  if (status.startsWith("validation_")) {
    if (
      optionalString(state.stage) !== "validating" ||
      !sameJson(state.validation_receipt, { status: "", checks: [] })
    ) {
      throw new Error(`Native child task ${taskId} is not awaiting validation`);
    }
    return;
  }
  if (
    optionalString(state.stage) !== "verification_pending" ||
    optionalString(state.validation_receipt?.status) !== "passed" ||
    !sameJson(state.verification_receipt, {
      status: "",
      acceptance_trace: [],
      risks: [],
    })
  ) {
    throw new Error(`Native child task ${taskId} is not awaiting verification`);
  }
}

function buildLifecycleNextState(input: {
  state: QuestState;
  status: ChildLifecycleStatus;
  mergeCommit: string;
  receipt: ReturnType<typeof normalizeLifecycleReceipt>;
}): QuestState {
  return {
    ...input.state,
    stage: lifecycleStage(input.status),
    tasks: input.state.tasks.map((task) =>
      input.status === "implemented"
        ? { ...task, status: "done", merge_commit: input.mergeCommit }
        : task,
    ),
    ...(input.receipt.implementation !== undefined
      ? { local_work_receipt: input.receipt.implementation }
      : {}),
    ...(input.receipt.validation !== undefined
      ? { validation_receipt: input.receipt.validation }
      : {}),
    ...(input.receipt.verification !== undefined
      ? { verification_receipt: input.receipt.verification }
      : {}),
  };
}

function reconstructLifecyclePriorState(
  state: QuestState,
  status: ChildLifecycleStatus,
): QuestState {
  if (status === "implemented") {
    const { local_work_receipt: _removed, ...prior } = state;
    return {
      ...prior,
      stage: "executing",
      tasks: state.tasks.map((task) => ({
        ...task,
        status: "pending",
        merge_commit: "",
      })),
    };
  }
  if (status.startsWith("validation_")) {
    return {
      ...state,
      stage: "validating",
      validation_receipt: { status: "", checks: [] },
    };
  }
  return {
    ...state,
    stage: "verification_pending",
    verification_receipt: { status: "", acceptance_trace: [], risks: [] },
  };
}

function isExactLifecycleEvent(input: {
  event: Record<string, unknown>;
  wtree: string;
  taskId: string;
  requestId: string;
  status: ChildLifecycleStatus;
  stage: string;
  mergeCommit: string;
}): boolean {
  const expectedKeys = [
    "event",
    "merge_commit",
    "quest_id",
    "request_id",
    "stage",
    "status",
    "task_id",
    "ts",
  ];
  return (
    sameJson(Object.keys(input.event).sort(), expectedKeys) &&
    typeof input.event.ts === "string" &&
    Number.isFinite(Date.parse(input.event.ts)) &&
    input.event.event === "child_lifecycle_recorded" &&
    input.event.quest_id === input.wtree &&
    input.event.request_id === input.requestId &&
    input.event.task_id === input.taskId &&
    input.event.status === input.status &&
    input.event.stage === input.stage &&
    input.event.merge_commit === input.mergeCommit
  );
}

function lifecycleResult(input: {
  status: ChildLifecycleStatus;
  stage: string;
  taskId: string;
  wtree: string;
  mergeCommit: string;
}): Record<string, unknown> {
  return {
    schema_version: "loopship.child-lifecycle.record/v1",
    status: input.status,
    stage: input.stage,
    task_id: input.taskId,
    wtree: input.wtree,
    merge_commit: input.mergeCommit,
  };
}

export function recordLoopshipNativeChildLifecycle(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const repo = resolve(requireString(body.repo, "repo"));
  const wtree = assertCanonicalWtreeName(requireString(body.wtree, "wtree"));
  const taskId = requireString(body.task_id, "task_id");
  const status = requireChildLifecycleStatus(body.status);
  const requestId = requireString(body.request_id, "request_id");
  const receipt = normalizeLifecycleReceipt(body, status);
  const mergeCommit = optionalString(body.merge_commit);
  if (status === "implemented" ? !isGitCommit(mergeCommit) : Boolean(mergeCommit)) {
    throw new Error(
      status === "implemented"
        ? "implemented lifecycle checkpoints require a Git merge_commit"
        : `${status} lifecycle checkpoints must not replace merge_commit`,
    );
  }
  const stage = lifecycleStage(status);
  const files = questFiles(repo, wtree);
  if (!existsSync(files.tasks)) {
    throw new Error(`missing Native child quest state for ${wtree}`);
  }
  const rawTasks = readText(files.tasks);
  const state = parseTasksYaml(rawTasks) as QuestState;
  assertCanonicalChildState({ files, state, raw: rawTasks, wtree, taskId });
  const events = readJsonlDocument(files.events);
  const requestIndexes = events.records
    .map((event, index) => event.request_id === requestId ? index : -1)
    .filter((index) => index >= 0);

  if (requestIndexes.length > 0) {
    if (requestIndexes.length !== 1 || requestIndexes[0] !== events.records.length - 1) {
      throw new Error(
        `child lifecycle checkpoint ${requestId} is duplicated or not the latest event`,
      );
    }
    const event = events.records[requestIndexes[0]!]!;
    if (!isExactLifecycleEvent({
      event,
      wtree,
      taskId,
      requestId,
      status,
      stage,
      mergeCommit,
    })) {
      throw new Error(`child lifecycle checkpoint ${requestId} conflicts with its recorded event`);
    }
    const priorEvents = events.lines.length > 1
      ? `${events.lines.slice(0, -1).join("\n")}\n`
      : "";
    const manifest = verifyQuestManifest(files);

    const priorFromRecorded = reconstructLifecyclePriorState(state, status);
    assertLifecyclePriorState(priorFromRecorded, status, taskId);
    const expectedRecorded = buildLifecycleNextState({
      state: priorFromRecorded,
      status,
      mergeCommit,
      receipt,
    });
    if (rawTasks === renderTasksYaml(expectedRecorded)) {
      if (manifest.ok) {
        return lifecycleResult({ status, stage, taskId, wtree, mergeCommit });
      }
      if (!manifestHasOnlyExpectedDelta({
        files,
        priorTasks: renderTasksYaml(priorFromRecorded),
        priorEvents,
        changed: ["tasks", "events"],
      })) {
        throw new Error(
          `child lifecycle checkpoint ${requestId} has an invalid recovery manifest`,
        );
      }
      writeQuestManifest(
        files,
        requestId,
        "loopship fastflow native child lifecycle recovery",
      );
      assertVerifiedQuestManifest(
        files,
        `child lifecycle recovery could not restore ${requestId}`,
      );
      return lifecycleResult({ status, stage, taskId, wtree, mergeCommit });
    }

    assertLifecyclePriorState(state, status, taskId);
    if (
      manifest.ok ||
      !manifestHasOnlyExpectedDelta({
        files,
        priorTasks: rawTasks,
        priorEvents,
        changed: ["events"],
      })
    ) {
      throw new Error(
        `child lifecycle checkpoint ${requestId} conflicts with quest state`,
      );
    }
    const recoveredState = buildLifecycleNextState({
      state,
      status,
      mergeCommit,
      receipt,
    });
    writeText(files.tasks, renderTasksYaml(recoveredState));
    writeQuestManifest(
      files,
      requestId,
      "loopship fastflow native child lifecycle recovery",
    );
    assertVerifiedQuestManifest(
      files,
      `child lifecycle recovery could not restore ${requestId}`,
    );
    return lifecycleResult({ status, stage, taskId, wtree, mergeCommit });
  }

  assertLifecyclePriorState(state, status, taskId);
  assertVerifiedQuestManifest(
    files,
    `Native child quest ${wtree} has an invalid pre-checkpoint manifest`,
  );
  const nextState = buildLifecycleNextState({ state, status, mergeCommit, receipt });
  appendJsonl(files.events, {
    event: "child_lifecycle_recorded",
    quest_id: wtree,
    request_id: requestId,
    task_id: taskId,
    status,
    stage,
    merge_commit: mergeCommit,
  });
  writeText(files.tasks, renderTasksYaml(nextState));
  writeQuestManifest(files, requestId, "loopship fastflow native child lifecycle");
  assertVerifiedQuestManifest(files, `child lifecycle checkpoint ${requestId} did not persist`);
  return lifecycleResult({ status, stage, taskId, wtree, mergeCommit });
}
