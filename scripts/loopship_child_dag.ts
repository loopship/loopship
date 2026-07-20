export const LOOPSHIP_DEFAULT_CHILD_MAX_CONCURRENCY = 4;
export const LOOPSHIP_MAX_CHILD_MAX_CONCURRENCY = 32;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    : [];
}

export function childDagTaskId(task: Record<string, unknown>): string {
  return optionalString(task.task_id) || optionalString(task.id);
}

export function childDagTaskDependencies(task: Record<string, unknown>): string[] {
  return stringList(
    Array.isArray(task.dependencies) ? task.dependencies : task.depends_on,
  );
}

export function normalizeLoopshipChildDagTask(
  task: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...task,
    id: childDagTaskId(task),
    dependencies: childDagTaskDependencies(task),
  };
}

function normalizeLoopshipScopePath(value: string): string {
  const segments = value.trim().replaceAll("\\", "/").split("/");
  const normalized = segments
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
  return normalized || "**";
}

function isRepositoryRelativeScope(value: string): boolean {
  const normalized = value.trim().replaceAll("\\", "/");
  const withoutLeadingDotSegments = normalized.replace(/^(?:\.\/)+/u, "");
  return (
    !withoutLeadingDotSegments.startsWith("/") &&
    !/^[A-Za-z]:/u.test(withoutLeadingDotSegments) &&
    !/(?:^|\/)[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(withoutLeadingDotSegments) &&
    !normalized.includes("\0") &&
    !normalized.split("/").includes("..")
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

export function loopshipChildDagTaskAliasErrors(
  sourceTask: Record<string, unknown>,
  index = 0,
): string[] {
  const errors: string[] = [];
  const taskId = childDagTaskId(sourceTask);
  const label = taskId || `at index ${index}`;
  for (const field of ["id", "task_id"] as const) {
    const value = sourceTask[field];
    if (value !== undefined && !isNonEmptyString(value)) {
      errors.push(`child DAG task ${label} ${field} must be a non-empty string`);
    }
  }
  const sourceId = optionalString(sourceTask.id);
  const sourceTaskId = optionalString(sourceTask.task_id);
  if (sourceId && sourceTaskId && sourceId !== sourceTaskId) {
    errors.push(`child DAG task ${label} has conflicting id and task_id`);
  }
  for (const field of ["dependencies", "depends_on"] as const) {
    const value = sourceTask[field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      errors.push(`child DAG task ${label} ${field} must be an array of strings`);
    } else if (!value.every(isNonEmptyString)) {
      errors.push(
        `child DAG task ${label} ${field} must contain only non-empty strings`,
      );
    }
  }
  if (
    Array.isArray(sourceTask.dependencies) &&
    sourceTask.dependencies.every(isNonEmptyString) &&
    Array.isArray(sourceTask.depends_on) &&
    sourceTask.depends_on.every(isNonEmptyString)
  ) {
    const dependencies = [...stringList(sourceTask.dependencies)].sort();
    const dependsOn = [...stringList(sourceTask.depends_on)].sort();
    if (JSON.stringify(dependencies) !== JSON.stringify(dependsOn)) {
      errors.push(`child DAG task ${label} has conflicting dependencies and depends_on`);
    }
  }
  for (const field of ["scope_files", "scope"] as const) {
    const value = sourceTask[field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      errors.push(`child DAG task ${label} ${field} must be an array of strings`);
    } else if (!value.every(isNonEmptyString)) {
      errors.push(
        `child DAG task ${label} ${field} must contain only non-empty strings`,
      );
    } else if (!value.every(isRepositoryRelativeScope)) {
      errors.push(
        `child DAG task ${label} ${field} must contain only repository-relative paths`,
      );
    }
  }
  if (
    Array.isArray(sourceTask.scope_files) &&
    sourceTask.scope_files.every(isNonEmptyString) &&
    Array.isArray(sourceTask.scope) &&
    sourceTask.scope.every(isNonEmptyString)
  ) {
    const scopeFiles = stringList(sourceTask.scope_files)
      .map(normalizeLoopshipScopePath)
      .sort();
    const scope = stringList(sourceTask.scope)
      .map(normalizeLoopshipScopePath)
      .sort();
    if (JSON.stringify(scopeFiles) !== JSON.stringify(scope)) {
      errors.push(`child DAG task ${label} has conflicting scope_files and scope`);
    }
  }
  return errors;
}

function staticScopePrefix(value: string): string {
  const normalized = normalizeLoopshipScopePath(value);
  const globIndex = normalized.search(/[*?\[{]/u);
  return globIndex < 0 ? normalized : normalized.slice(0, globIndex);
}

function hasScopeGlob(value: string): boolean {
  return /[*?\[{]/u.test(value);
}

function pathContains(parent: string, child: string): boolean {
  return parent === child || child.startsWith(`${parent}/`);
}

function childTaskScopes(task: Record<string, unknown>): string[] {
  return stringList(
    Array.isArray(task.scope_files) ? task.scope_files : task.scope,
  ).map(normalizeLoopshipScopePath).filter(Boolean);
}

function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((leftPath) =>
    right.some((rightPath) => {
      const leftGlob = hasScopeGlob(leftPath);
      const rightGlob = hasScopeGlob(rightPath);
      const leftPrefix = staticScopePrefix(leftPath);
      const rightPrefix = staticScopePrefix(rightPath);
      if (!leftPrefix || !rightPrefix) return true;
      if (!leftGlob && !rightGlob) {
        return pathContains(leftPath, rightPath) || pathContains(rightPath, leftPath);
      }
      if (leftGlob && rightGlob) {
        return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
      }
      if (leftGlob) {
        return rightPath.startsWith(leftPrefix) || pathContains(rightPath, leftPrefix);
      }
      return leftPath.startsWith(rightPrefix) || pathContains(leftPath, rightPrefix);
    }),
  );
}

export type LoopshipChildDagValidation = {
  schema_version: "loopship.child-dag.validation/v1";
  ok: boolean;
  tasks: Array<Record<string, unknown>>;
  max_concurrency: number;
  errors: string[];
};

export function validateLoopshipChildDag(
  body: Record<string, unknown>,
): LoopshipChildDagValidation {
  const errors: string[] = [];
  const rawTaskValues = Array.isArray(body.tasks) ? body.tasks : [];
  if (!Array.isArray(body.tasks)) {
    errors.push("child DAG tasks must be a finite array");
  } else if (body.tasks.length === 0) {
    errors.push("Loopship child DAG must contain at least one approved task");
  }
  const rawTasks: Array<Record<string, unknown>> = [];
  rawTaskValues.forEach((task, index) => {
    if (!isPlainObject(task)) {
      errors.push(`child DAG task at index ${index} must be an object`);
      return;
    }
    rawTasks.push(task);
  });
  const tasks = rawTasks.map(normalizeLoopshipChildDagTask);
  const requestedMax = body.max_concurrency === undefined
    ? LOOPSHIP_DEFAULT_CHILD_MAX_CONCURRENCY
    : Number(body.max_concurrency);
  if (
    !Number.isInteger(requestedMax) ||
    requestedMax < 1 ||
    requestedMax > LOOPSHIP_MAX_CHILD_MAX_CONCURRENCY
  ) {
    errors.push(
      `max_concurrency must be an integer from 1 to ${LOOPSHIP_MAX_CHILD_MAX_CONCURRENCY}`,
    );
  }
  const maxConcurrency = body.supervise_step === true
    ? 1
    : Number.isInteger(requestedMax) &&
        requestedMax >= 1 &&
        requestedMax <= LOOPSHIP_MAX_CHILD_MAX_CONCURRENCY
      ? requestedMax
      : LOOPSHIP_DEFAULT_CHILD_MAX_CONCURRENCY;

  const taskById = new Map<string, Record<string, unknown>>();
  const identityOwners = new Map<string, string>();
  for (const [taskIndex, task] of tasks.entries()) {
    const sourceTask = rawTasks[taskIndex]!;
    errors.push(...loopshipChildDagTaskAliasErrors(sourceTask, taskIndex));
    const id = childDagTaskId(task);
    if (!id) {
      errors.push("every child DAG task must have a non-empty id");
      continue;
    }
    if (taskById.has(id)) {
      errors.push(`duplicate child DAG task id: ${id}`);
      continue;
    }
    taskById.set(id, task);
    if (childTaskScopes(task).length === 0) {
      errors.push(
        `child DAG task ${id} must declare a non-empty scope_files or scope list`,
      );
    }
    const dependencies = childDagTaskDependencies(task);
    if (new Set(dependencies).size !== dependencies.length) {
      errors.push(`child DAG task ${id} has duplicate dependencies`);
    }
    if (dependencies.includes(id)) {
      errors.push(`child DAG task ${id} cannot depend on itself`);
    }
    for (const field of [
      "child_wtree",
      "branch_ref",
      "worktree_path",
      "merge_lease_id",
    ] as const) {
      const value = optionalString(task[field]);
      if (!value) continue;
      const identity = `${field}:${value}`;
      const owner = identityOwners.get(identity);
      if (owner && owner !== id) {
        errors.push(`child DAG tasks ${owner} and ${id} share ${field} ${value}`);
      } else {
        identityOwners.set(identity, id);
      }
    }
  }
  for (const task of tasks) {
    const id = childDagTaskId(task);
    if (!id) continue;
    for (const dependencyId of childDagTaskDependencies(task)) {
      if (!taskById.has(dependencyId)) {
        errors.push(`child DAG task ${id} depends on missing task ${dependencyId}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      cyclic.add(id);
      return;
    }
    visiting.add(id);
    const task = taskById.get(id);
    for (const dependencyId of task ? childDagTaskDependencies(task) : []) {
      if (!taskById.has(dependencyId)) continue;
      visit(dependencyId);
      if (cyclic.has(dependencyId)) cyclic.add(id);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of taskById.keys()) visit(id);
  if (cyclic.size) {
    errors.push(`child DAG contains a dependency cycle: ${[...cyclic].sort().join(", ")}`);
  }

  const reachability = new Map<string, Set<string>>();
  const dependenciesOf = (id: string, active = new Set<string>()): Set<string> => {
    const cached = reachability.get(id);
    if (cached) return cached;
    if (active.has(id)) return new Set();
    const nextActive = new Set(active).add(id);
    const result = new Set<string>();
    const task = taskById.get(id);
    for (const dependencyId of task ? childDagTaskDependencies(task) : []) {
      if (!taskById.has(dependencyId)) continue;
      result.add(dependencyId);
      for (const transitiveId of dependenciesOf(dependencyId, nextActive)) {
        result.add(transitiveId);
      }
    }
    reachability.set(id, result);
    return result;
  };
  for (const id of taskById.keys()) dependenciesOf(id);

  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    const left = tasks[leftIndex]!;
    const leftId = childDagTaskId(left);
    if (!leftId) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
      const right = tasks[rightIndex]!;
      const rightId = childDagTaskId(right);
      if (!rightId) continue;
      const ordered =
        dependenciesOf(leftId).has(rightId) ||
        dependenciesOf(rightId).has(leftId);
      if (ordered) continue;
      const leftGroup = optionalString(left.concurrency_group);
      const rightGroup = optionalString(right.concurrency_group);
      const groupConflict = Boolean(leftGroup && leftGroup === rightGroup);
      const scopeConflict = scopesOverlap(childTaskScopes(left), childTaskScopes(right));
      if (groupConflict || scopeConflict) {
        const reasons = [
          ...(groupConflict ? [`concurrency_group ${leftGroup}`] : []),
          ...(scopeConflict ? ["overlapping scope"] : []),
        ];
        errors.push(
          `unordered child DAG tasks ${leftId} and ${rightId} conflict by ${reasons.join(" and ")}`,
        );
      }
    }
  }

  return {
    schema_version: "loopship.child-dag.validation/v1",
    ok: errors.length === 0,
    tasks,
    max_concurrency: maxConcurrency,
    errors,
  };
}

function childLifecycleReceiptFromNodeResult(value: unknown): Record<string, unknown> {
  const result = isPlainObject(value) ? value : {};
  const iteration = isPlainObject(result.iteration) ? result.iteration : {};
  const steps = isPlainObject(iteration.steps) ? iteration.steps : {};
  const lifecycle = isPlainObject(steps.run_child_lifecycle)
    ? steps.run_child_lifecycle
    : {};
  const action = isPlainObject(lifecycle.action) ? lifecycle.action : {};
  return action.schema_version === "loopship.child-result/v2" ? action : {};
}

function dagNodeError(node: Record<string, unknown>): string {
  const error = isPlainObject(node.error) ? node.error : {};
  return optionalString(error.message) || optionalString(node.message) || "Native child node did not pass";
}

const CHILD_RECEIPT_IDENTITY_FIELDS = [
  "child_wtree",
  "branch_ref",
  "worktree_path",
  "merge_target",
  "merge_lease_id",
] as const;

function validateChildLifecycleReceipt(
  task: Record<string, unknown>,
  taskId: string,
  receipt: Record<string, unknown>,
): { ok: boolean; error: string; mergeCommit: string } {
  const errors: string[] = [];
  if (optionalString(receipt.task_id) !== taskId) {
    errors.push("task_id does not match the scheduled task");
  }
  if (optionalString(receipt.status) !== "child_archived") {
    errors.push("status is not child_archived");
  }
  for (const field of CHILD_RECEIPT_IDENTITY_FIELDS) {
    const expected = optionalString(task[field]);
    if (expected && optionalString(receipt[field]) !== expected) {
      errors.push(`${field} does not match the scheduled task`);
    }
  }
  const mergeCommit = optionalString(receipt.merge_commit);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(mergeCommit)) {
    errors.push("merge_commit is not a Git object identity");
  }
  return {
    ok: errors.length === 0,
    error: errors.join("; "),
    mergeCommit,
  };
}

export function buildLoopshipChildDagReconciliation(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const validation = validateLoopshipChildDag({ tasks: body.tasks });
  if (!validation.ok) {
    throw new Error(
      `invalid Native child DAG reconciliation tasks: ${validation.errors.join("; ")}`,
    );
  }
  const tasks = validation.tasks.map((task) => ({ ...task }));
  if (!isPlainObject(body.dag_result)) {
    throw new Error("invalid Native child DAG reconciliation result: dag_result must be an object");
  }
  const dagResult = body.dag_result;
  if (
    Object.prototype.hasOwnProperty.call(dagResult, "scheduler") &&
    !isPlainObject(dagResult.scheduler)
  ) {
    throw new Error(
      "invalid Native child DAG reconciliation result: scheduler must be an object",
    );
  }
  const schedulerResult = isPlainObject(dagResult.scheduler)
    ? dagResult.scheduler
    : dagResult;
  if (!Array.isArray(schedulerResult.nodes)) {
    throw new Error(
      "invalid Native child DAG reconciliation result: nodes must be an array",
    );
  }
  const nodesById = new Map<string, Record<string, unknown>>();
  for (const [index, value] of schedulerResult.nodes.entries()) {
    if (!isPlainObject(value)) {
      throw new Error(
        `invalid Native child DAG reconciliation result: node at index ${index} must be an object`,
      );
    }
    const id = optionalString(value.id);
    const nodeId = optionalString(value.nodeId);
    if (id && nodeId && id !== nodeId) {
      throw new Error(
        `invalid Native child DAG reconciliation result: node at index ${index} has conflicting id and nodeId`,
      );
    }
    const canonicalId = id || nodeId;
    if (!canonicalId) {
      throw new Error(
        `invalid Native child DAG reconciliation result: node at index ${index} must have a non-empty id`,
      );
    }
    if (nodesById.has(canonicalId)) {
      throw new Error(
        `invalid Native child DAG reconciliation result: duplicate node id ${canonicalId}`,
      );
    }
    nodesById.set(canonicalId, value);
  }
  const expectedTaskIds = new Set(tasks.map(childDagTaskId));
  for (const taskId of expectedTaskIds) {
    if (!nodesById.has(taskId)) {
      throw new Error(
        `invalid Native child DAG reconciliation result: missing node for task ${taskId}`,
      );
    }
  }
  for (const nodeId of nodesById.keys()) {
    if (!expectedTaskIds.has(nodeId)) {
      throw new Error(
        `invalid Native child DAG reconciliation result: unexpected node id ${nodeId}`,
      );
    }
  }
  const childResults: Array<Record<string, unknown>> = [];
  let passed = 0;
  let failed = 0;
  let blocked = 0;
  let cancelled = 0;

  const nextTasks = tasks.map((task) => {
    const taskId = childDagTaskId(task);
    const node = nodesById.get(taskId);
    const nodeStatus = optionalString(node?.status);
    const receipt = nodeStatus === "passed"
      ? childLifecycleReceiptFromNodeResult(node?.result)
      : {};
    const receiptValidation = validateChildLifecycleReceipt(task, taskId, receipt);
    const mergeCommit = receiptValidation.mergeCommit;
    const childPassed = nodeStatus === "passed" && receiptValidation.ok;
    const status = childPassed
      ? "child_archived"
      : nodeStatus === "blocked"
        ? "blocked"
        : nodeStatus === "cancelled"
          ? "cancelled"
        : "failed";
    if (status === "child_archived") passed += 1;
    else if (status === "blocked") blocked += 1;
    else if (status === "cancelled") cancelled += 1;
    else failed += 1;
    const error = childPassed
      ? ""
      : nodeStatus === "passed" && receiptValidation.error
        ? `invalid Native child lifecycle receipt: ${receiptValidation.error}`
      : node
        ? dagNodeError(node)
        : "Native child DAG result is missing this task";
    const result = {
      task_id: taskId,
      child_wtree: optionalString(receipt.child_wtree) || optionalString(task.child_wtree),
      status,
      evidence: [
        {
          type: "native_child_dag",
          ref: `native-dag:${taskId}`,
          status: childPassed ? "passed" : status,
          summary: childPassed ? "Child lifecycle passed and landed." : error,
        },
      ],
      branch_ref: optionalString(receipt.branch_ref) || optionalString(task.branch_ref),
      worktree_path: optionalString(receipt.worktree_path) || optionalString(task.worktree_path),
      merge_target: optionalString(receipt.merge_target) || optionalString(task.merge_target),
      merge_lease_id: optionalString(receipt.merge_lease_id) || optionalString(task.merge_lease_id),
      merge_commit: mergeCommit,
    };
    childResults.push(result);
    return {
      ...task,
      status,
      child_wtree: result.child_wtree,
      branch_ref: result.branch_ref,
      worktree_path: result.worktree_path,
      merge_target: result.merge_target,
      merge_lease_id: result.merge_lease_id,
      merge_commit: result.merge_commit,
    };
  });
  const allPassed = passed === tasks.length;
  const stageAfter = allPassed ? "validating" : "replanning";
  const transition = allPassed ? "complete" : "failed";
  const payload = {
    schema_version: "loopship.child-dag.reconciliation/v1",
    status: allPassed ? "passed" : "failed",
    total: tasks.length,
    passed,
    failed,
    blocked,
    cancelled,
    child_results: childResults,
  };
  return {
    schema_version: "loopship.stage-result.build/v1",
    flow_id: "swe",
    stage_before: "task_graph_ready",
    stage_after: stageAfter,
    transition,
    step: "executing",
    step_workflow_task: "stage_task_graph_ready",
    step_payload: payload,
    step_action: payload,
    state_patch: {
      stage: stageAfter,
      tasks: nextTasks,
      child_results: childResults,
      ...(allPassed ? {} : { replan_reason: "Native child DAG did not fully pass and land." }),
    },
    events: [
      {
        event: "child_dag_reconciled",
        stage: stageAfter,
        total: tasks.length,
        passed,
        failed,
        blocked,
        cancelled,
      },
    ],
    runtime: isPlainObject(body.runtime) ? body.runtime : {},
  };
}
