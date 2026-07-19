import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  completedDecision,
  createAfnDispatchPort,
  createRuntimeOffer,
  digestCallContract,
  digestNativeContract,
  failedDecision,
  type CallDescriptor,
  type ExecutionDecision,
  type JsonValue,
} from "@cueintent/fastflow";
import { parse as parseYaml } from "yaml";
import {
  applyLandingReceipt,
  applySystemUpdate,
  assertCanonicalWtreeName,
  assertValidGitBranchRef,
  appendJsonl,
  createQuest,
  createQuestInitialState,
  ensureCoordinatorWorkspace,
  ensureTaskWorkspace,
  isTerminalChildQuestState,
  landingTargetWorktreePath,
  parseGitWorktrees,
  parseTasksYaml,
  questFiles,
  taskAssignmentBranchRef,
  taskAssignmentChildWtree,
  taskAssignmentWorktreePath,
  updateQuestStage,
  verifyQuestManifest,
  verifyRootManifest,
  writeQuestManifest,
} from "./loopship_core.ts";
import type { CreateQuestInput, QuestState } from "./loopship_core.ts";
import {
  readHookRouteForWorkspace,
  recordHookRoute,
  runtimeIdentityFromEnv,
  updateHookRouteForWorkspace,
} from "./loopship_hook_state.ts";
import {
  loopshipNativeResultIsTerminal as nativeWorkflowResultIsTerminal,
  markLoopshipNativeExecutionCompleted as markNativeExecutionCompleted,
  readLoopshipNativeExecutionRequest as readNativeExecutionRequest,
  resolveLoopshipNativeExecutionRequest as resolveNativeExecutionRequest,
} from "./loopship_native_execution.ts";
import {
  acquireCrashSafeFileLock,
  readText,
  runCommand,
  writeText,
} from "./loopship_utils.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const LOOPSHIP_ROOT = resolve(SCRIPT_DIR, "..");
export const LOOPSHIP_CALL_CATALOG_ROOT = resolve(LOOPSHIP_ROOT, "call-catalog");
const PACKAGE_JSON = JSON.parse(
  readFileSync(resolve(LOOPSHIP_ROOT, "package.json"), "utf8"),
) as { name?: string; version?: string; files?: string[] };
const LOOPSHIP_RUNTIME_NAMESPACE = ".loopship/runtime";
const LOOPSHIP_QUEST_INIT_LOCK_WAIT_MS = 30_000;
const LOOPSHIP_WORKFLOW_REGISTRY = "loopship";
const LOOPSHIP_WORKFLOW_TARGET = "service";
const LOOPSHIP_STEP_SCOPE = "step";
const LOOPSHIP_FLOW_SCOPE = "flows";
const LOOPSHIP_FLOW_INDEX = resolve(
  LOOPSHIP_CALL_CATALOG_ROOT,
  LOOPSHIP_WORKFLOW_REGISTRY,
  "workflow",
  LOOPSHIP_WORKFLOW_TARGET,
  LOOPSHIP_FLOW_SCOPE,
  "index.yaml",
);
export const LOOPSHIP_SUPERVISOR_GUIDANCE = Object.freeze({
  id: "loopship-supervisor",
  version: PACKAGE_JSON.version || "0.0.0",
  summary:
    "Judge each Loopship flow before every native Fastflow decision: require the current step to match its declared lifecycle purpose; root/coordinator quests may decompose, but terminal child quests identified by parent_wtree, parent_task_id, parent_context_ref, or an execute child task prompt must stay local and never prepare child worktrees; run emitted child commands for real when the flow delegates work; route terminal-child implementation gaps through configured native CLI routes with AITL fallback implementation receipts instead of supervisor inline edits; and require canonical Loopship runtime, worktree, task, validation, verification, explicit system_update, landing, or archive evidence before approving completion. Answer safe clarification prompts as the human supervisor; when upfront scoping misses material clarification, reject or re-run scoping instead of inventing replacement planner clarification payloads. Improve weak Loopship prompts, schemas, bindings, transitions, or verification rules within scope.",
  ref: "README.md#mocked-runtime-lifecycle-stepping",
});
export const LOOPSHIP_WORKFLOW_RESUME_COMMAND =
  "loopship stepper step --json @-";

const TASK_PAYLOAD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    task_id: { type: "string" },
    title: { type: "string" },
    name: { type: "string" },
    type: { enum: ["coding", "general"] },
    status: { type: "string" },
    dependencies: { type: "array", items: { type: "string" } },
    depends_on: { type: "array", items: { type: "string" } },
    scope_files: { type: "array", items: { type: "string" } },
    scope: { type: "array", items: { type: "string" } },
    spec_refs: { type: "array", items: { type: "string" } },
    specs: { type: "array", items: { type: "string" } },
    context_refs: { type: "array", items: { type: "string" } },
    context: { type: "array", items: { type: "string" } },
    branch_ref: { type: "string" },
    worktree_path: { type: "string" },
    child_wtree: { type: "string" },
    parent_wtree: { type: "string" },
    parent_task_id: { type: "string" },
    parent_context_ref: { type: "string" },
    concurrency_group: { type: "string" },
    merge_target: { type: "string" },
    merge_target_worktree: { type: "string" },
    merge_lease_id: { type: "string" },
    merge_commit: { type: "string" },
    system_impact_ref: { type: "string" },
    acceptance: {
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    },
    acceptance_criteria: {
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    },
  },
} as const;

const PARENT_PAYLOAD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    task_id: { type: "string" },
    parent_wtree: { type: "string" },
    parent_context_ref: { type: "string" },
    landing_target_branch: { type: "string" },
    landing_target_worktree: { type: "string" },
    merge_lease_id: { type: "string" },
  },
} as const;

const QUEST_CHILD_PREPARE_GUARD_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    prompt: { type: "string" },
    parent_wtree: { type: "string" },
    parent_task_id: { type: "string" },
    parent_context_ref: { type: "string" },
  },
} as const;

const SYSTEM_UPDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "mode", "summary"],
  properties: {
    schema_version: { const: 1 },
    mode: { enum: ["no_change", "replace"] },
    summary: { type: "string", minLength: 1 },
    root: { type: "object", additionalProperties: true },
    external_docs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op", "resource_ref"],
        properties: {
          op: { enum: ["upsert", "delete"] },
          resource_ref: { type: "string", minLength: 1 },
          document: { type: "object", additionalProperties: true },
        },
      },
    },
  },
} as const;

const LANDING_RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["landed_commit"],
  properties: {
    source_branch: { type: "string" },
    target_branch: { type: "string" },
    target_worktree: { type: "string" },
    landed_commit: { type: "string", minLength: 1 },
    strategy: {
      enum: ["already-up-to-date", "fast-forward", "merge-commit", "recorded"],
    },
  },
} as const;

const LANDING_STATUS_SCHEMA = {
  enum: ["landed", "blocked"],
} as const;

const STAGE_RESULT_BUILD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "flow_id",
    "stage_before",
    "stage_after",
    "transition",
    "step",
    "step_workflow_task",
    "step_payload",
    "step_action",
    "state_patch",
    "events",
    "runtime",
  ],
  properties: {
    schema_version: { const: "loopship.stage-result.build/v1" },
    flow_id: { type: "string", minLength: 1 },
    stage_before: { type: "string", minLength: 1 },
    stage_after: { type: "string", minLength: 1 },
    transition: { type: "string", minLength: 1 },
    step: { type: "string", minLength: 1 },
    step_workflow_task: { type: "string", minLength: 1 },
    step_payload: { type: "object", additionalProperties: true },
    step_action: { type: "object", additionalProperties: true },
    state_patch: { type: "object", additionalProperties: true },
    events: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
    runtime: { type: "object", additionalProperties: true },
    as_check: { type: "boolean" },
  },
} as const;

export const LOOPSHIP_AFN_CALLS = Object.freeze({
  childPrepareWorktree: "loopship.afn.service.child.prepare-worktree",
  flowComposeTransitionResult: "loopship.afn.service.flow.compose-transition-result",
  runtimeCommitQuestState: "loopship.afn.service.runtime.commit-quest-state",
  gitResolveCommit: "loopship.afn.service.git.resolve-commit",
  systemApplyUpdate: "loopship.afn.service.system.apply-update",
  landingApplyOutcome: "loopship.afn.service.landing.apply-outcome",
  landingCleanupLandedWorktrees: "loopship.afn.service.landing.cleanup-landed-worktrees",
});

export const LOOPSHIP_DATA_CALLS = Object.freeze({
  documentRead: "fastflow.afn.data.document.read",
  documentWrite: "fastflow.afn.data.document.write",
  documentPatch: "fastflow.afn.data.document.patch",
  eventLogAppend: "fastflow.afn.data.event-log.append",
  eventLogQuery: "fastflow.afn.data.event-log.query",
});

export const LOOPSHIP_AFN_DESCRIPTORS: CallDescriptor[] = [
  {
    call: LOOPSHIP_AFN_CALLS.childPrepareWorktree,
    summary: "Prepare Loopship child quest/worktree launch context without running the child agent.",
    inputs: {
      required: ["repo", "wtree"],
      optional: [
        "task_id",
        "task",
        "children",
        "quest",
        "parent",
        "runtime",
        "branch",
        "base_branch",
        "child_wtree",
        "worktree_path",
        "dry_run",
      ],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["repo", "wtree"],
        properties: {
          repo: { type: "string", minLength: 1 },
          wtree: { type: "string", minLength: 1 },
          child_wtree: { type: "string" },
          task_id: { type: "string" },
          task: TASK_PAYLOAD_SCHEMA,
          children: {
            type: "array",
            items: TASK_PAYLOAD_SCHEMA,
          },
          quest: QUEST_CHILD_PREPARE_GUARD_SCHEMA,
          parent: PARENT_PAYLOAD_SCHEMA,
          runtime: { type: "string" },
          branch: { type: "string" },
          base_branch: { type: "string" },
          worktree_path: { type: "string" },
          dry_run: { type: "boolean" },
        },
      },
    },
    tags: ["loopship", "child", "worktree", "quest"],
    preferWhen: ["A Loopship workflow needs to prepare child quest/worktree launch metadata."],
    avoidWhen: ["The workflow only needs reasoning, validation, verification, or model output."],
    metadata: {
      allowed_phases: ["action"],
      effects: ["worktree.prepare", "quest.prepare"],
    },
  },
  {
    call: LOOPSHIP_AFN_CALLS.flowComposeTransitionResult,
    summary: "Compose the standard Loopship transition result envelope from flow-owned transition data.",
    inputs: {
      required: [
        "schema_version",
        "flow_id",
        "stage_before",
        "stage_after",
        "transition",
        "step",
        "step_workflow_task",
        "step_payload",
        "step_action",
        "state_patch",
        "events",
        "runtime",
      ],
      optional: ["as_check"],
      schema: STAGE_RESULT_BUILD_SCHEMA,
    },
    tags: ["loopship", "flow", "stage-result", "envelope"],
    preferWhen: ["A Loopship flow needs to compose flow-owned transition data into the standard result envelope."],
    avoidWhen: ["The workflow needs to decide stage transitions, interpret task graphs, or mutate runtime state."],
    metadata: {
      allowed_phases: ["action", "verification"],
    },
  },
  {
    call: LOOPSHIP_AFN_CALLS.runtimeCommitQuestState,
    summary: "Commit workflow-data quest mutations to the canonical quest manifest.",
    inputs: {
      required: ["repo", "wtree"],
      optional: ["request_id", "as_check"],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["repo", "wtree"],
        properties: {
          repo: { type: "string", minLength: 1 },
          wtree: { type: "string", minLength: 1 },
          request_id: { type: "string" },
          as_check: { type: "boolean" },
        },
      },
    },
    tags: ["loopship", "runtime", "quest", "manifest"],
    preferWhen: ["A Loopship flow has durably written canonical quest tasks and events."],
    avoidWhen: ["The workflow has not changed canonical quest state."],
    metadata: {
      allowed_phases: ["action", "verification"],
      effects: ["quest.manifest.write"],
    },
  },
  {
    call: LOOPSHIP_AFN_CALLS.gitResolveCommit,
    summary: "Resolve a git ref to a commit for Loopship lifecycle evidence.",
    inputs: {
      required: ["repo"],
      optional: ["cwd", "ref"],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["repo"],
        properties: {
          repo: { type: "string", minLength: 1 },
          cwd: { type: "string" },
          ref: { type: "string" },
        },
      },
    },
    tags: ["loopship", "git", "commit", "evidence"],
    preferWhen: ["A Loopship workflow needs a concrete commit as lifecycle evidence."],
    avoidWhen: ["The workflow only needs to inspect non-git validation or verification output."],
    metadata: {
      allowed_phases: ["action"],
      effects: ["git.read"],
    },
  },
  {
    call: LOOPSHIP_AFN_CALLS.systemApplyUpdate,
    summary: "Apply a schema-valid Loopship system document update and refresh managed signatures.",
    inputs: {
      required: ["repo", "update"],
      optional: ["request_id", "actor", "reason", "dry_run"],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["repo", "update"],
        properties: {
          repo: { type: "string", minLength: 1 },
          update: SYSTEM_UPDATE_SCHEMA,
          request_id: { type: "string" },
          actor: { type: "string" },
          reason: { type: "string" },
          dry_run: { type: "boolean" },
        },
      },
    },
    tags: ["loopship", "system", "docs", "signature"],
    preferWhen: ["A Loopship workflow needs to apply schema-aware system document changes."],
    avoidWhen: ["The workflow only needs to read or draft system document updates."],
    metadata: {
      allowed_phases: ["action"],
      effects: ["file.write", "signature.write"],
    },
  },
  {
    call: LOOPSHIP_AFN_CALLS.landingApplyOutcome,
    summary: "Apply the Loopship landing outcome: block, record a receipt, or merge and persist landed state.",
    inputs: {
      required: ["repo", "wtree"],
      optional: [
        "status",
        "receipt",
        "summary",
        "target_branch",
        "target_worktree",
        "source_branch",
        "next_stage",
        "request_id",
        "dry_run",
      ],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["repo", "wtree"],
        properties: {
          repo: { type: "string", minLength: 1 },
          wtree: { type: "string", minLength: 1 },
          status: LANDING_STATUS_SCHEMA,
          receipt: LANDING_RECEIPT_SCHEMA,
          summary: { type: "string" },
          target_branch: { type: "string" },
          target_worktree: { type: "string" },
          source_branch: { type: "string" },
          next_stage: { type: "string" },
          request_id: { type: "string" },
          dry_run: { type: "boolean" },
        },
      },
    },
    tags: ["loopship", "landing", "git", "merge"],
    preferWhen: ["A Loopship workflow needs to apply landing policy and record landed state."],
    avoidWhen: ["The workflow only needs to inspect validation, verification, or review output."],
    metadata: {
      allowed_phases: ["action"],
      effects: ["git.merge", "quest.land"],
    },
  },
  {
    call: LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees,
    summary: "Clean up landed Loopship quest worktrees and branches after durable landing evidence exists.",
    inputs: {
      required: ["repo", "wtree"],
      optional: ["dry_run"],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["repo", "wtree"],
        properties: {
          repo: { type: "string", minLength: 1 },
          wtree: { type: "string", minLength: 1 },
          dry_run: { type: "boolean" },
        },
      },
    },
    tags: ["loopship", "landing", "cleanup", "worktree"],
    preferWhen: ["A Loopship flow needs to clean up landed quest worktrees and branches."],
    avoidWhen: ["The quest has not recorded durable landing evidence."],
    metadata: {
      allowed_phases: ["action"],
      effects: ["git.worktree.remove", "git.branch.delete"],
    },
  },
];

const DESCRIPTOR_BY_CALL = new Map(
  LOOPSHIP_AFN_DESCRIPTORS.map((descriptor) => [descriptor.call, descriptor]),
);

const LOOPSHIP_FASTFLOW_SESSION_TIMEOUT_MS = 3_600_000;

export type LoopshipFastflowRunInput = {
  repoRoot: string;
  workspaceRoot?: string;
  flowId?: string | null;
  inputs?: Record<string, unknown>;
  superviseStep?: boolean;
  progressMode?: string;
};

export type LoopshipFastflowRecoverInput = {
  repoRoot: string;
  wtree: string;
  progressMode?: string;
};

export type LoopshipFastflowWorkflowRequestInput = {
  repoRoot: string;
  workspaceRoot?: string;
  request: Record<string, unknown>;
};

export type LoopshipFastflowResumeInput = {
  repoRoot: string;
  workspaceRoot?: string;
  request: Record<string, unknown>;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestExistingFile(path: string): string {
  return existsSync(path) ? sha256(readFileSync(path)) : sha256("");
}

function writeJsonAtomically(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value)}\n`);
}

function normalizePackagePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function collectPackageFiles(path: string, files: Set<string>): void {
  const packagePath = normalizePackagePath(relative(LOOPSHIP_ROOT, path));
  if (!packagePath || packagePath.startsWith("../")) {
    throw new Error(`package file escapes Loopship root: ${path}`);
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = resolve(path, entry.name);
    if (entry.isDirectory()) collectPackageFiles(entryPath, files);
    else if (entry.isFile()) files.add(normalizePackagePath(relative(LOOPSHIP_ROOT, entryPath)));
  }
}

function shippedLoopshipImplementationFiles(): string[] {
  const manifestEntries = Array.isArray(PACKAGE_JSON.files) ? PACKAGE_JSON.files : [];
  const included = new Set<string>(["package.json"]);
  const exclusions = manifestEntries
    .filter((entry) => entry.startsWith("!"))
    .map((entry) => normalizePackagePath(entry.slice(1)));
  for (const rawEntry of manifestEntries.filter((entry) => !entry.startsWith("!"))) {
    const entry = normalizePackagePath(rawEntry);
    if (/[*?{}[\]]/.test(entry)) {
      throw new Error(`package.json files entry must name a file or directory: ${rawEntry}`);
    }
    const absolute = resolve(LOOPSHIP_ROOT, entry);
    if (!existsSync(absolute)) {
      throw new Error(`package.json files entry does not exist: ${rawEntry}`);
    }
    const statFiles = new Set<string>();
    if (statSync(absolute).isDirectory()) collectPackageFiles(absolute, statFiles);
    else statFiles.add(entry);
    for (const file of statFiles) included.add(file);
  }
  return [...included]
    .filter((file) => !exclusions.some((pattern) => matchesGlob(file, pattern)))
    .sort();
}

function loopshipAfnImplementationEvidence(call: string): Record<string, unknown> {
  const implementationFiles = shippedLoopshipImplementationFiles();
  const dependencyLockDigest = digestExistingFile(resolve(LOOPSHIP_ROOT, "bun.lock"));
  const implementationDigest = sha256(
    [
      "loopship.package-implementation/v1",
      ...implementationFiles.map(
        (file) => `${file}\n${digestExistingFile(resolve(LOOPSHIP_ROOT, file))}`,
      ),
    ].join("\n"),
  );
  return {
    mode: "direct",
    implementation_ref: `${PACKAGE_JSON.name || "@omar391/loopship"}:${PACKAGE_JSON.version || "0.0.0"}:${call}`,
    implementation_digest: implementationDigest,
    implementation_manifest: "package.json#files+bun.lock",
    dependency_lock_digest: dependencyLockDigest,
    runtime_ref: loopshipApplicationRuntimeRef(),
    implementation_files: implementationFiles,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function loopshipApplicationRuntimeRef(): string {
  if (!process.versions.bun) {
    throw new Error(
      "Loopship application adapters require Bun; Node 26 is reserved for the workflow-script security worker.",
    );
  }
  return `bun:${process.versions.bun}`;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function canonicalRepositoryRoot(value: unknown, field: string): string {
  const requested = resolve(requireString(value, field));
  if (!existsSync(requested)) {
    throw new Error(`Loopship Native execution repository does not exist: ${requested}`);
  }
  const identity = realpathSync(requested);
  const commonDir = runCommand(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: identity, timeoutMs: 10_000 },
  );
  if (commonDir.status !== 0 || !commonDir.stdout.trim()) {
    throw new Error(`Loopship Native execution requires a Git repository: ${identity}`);
  }
  const commonPath = resolve(identity, commonDir.stdout.trim());
  const candidate = basename(commonPath) === ".git" ? dirname(commonPath) : identity;
  if (!existsSync(candidate)) {
    throw new Error(`Loopship Native execution Git authority does not exist: ${candidate}`);
  }
  return realpathSync(candidate);
}

function legacyExecutionUnsupported(message: string): Error {
  return Object.assign(
    new Error(`legacy_execution_unsupported: ${message}`),
    { code: "legacy_execution_unsupported" },
  );
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const RUN_INPUT_ALIAS_PAIRS = [
  ["request", "prompt"],
  ["sourceBranch", "source_branch"],
  ["targetBranch", "target_branch"],
  ["targetWorktree", "target_worktree"],
  ["parentWtree", "parent_wtree"],
  ["parentTaskId", "parent_task_id"],
  ["parentContextRef", "parent_context_ref"],
] as const;

function normalizeRunInputAliases(inputs: Record<string, unknown>): void {
  for (const [preferred, alias] of RUN_INPUT_ALIAS_PAIRS) {
    const preferredValue = optionalString(inputs[preferred]);
    const aliasValue = optionalString(inputs[alias]);
    if (preferredValue && aliasValue && preferredValue !== aliasValue) {
      throw new Error(
        `Native execution inputs.${preferred} conflicts with inputs.${alias}`,
      );
    }
    const value = preferredValue || aliasValue;
    if (!value) continue;
    inputs[preferred] = value;
    inputs[alias] = value;
  }
}

function defaultLoopshipFlowIdFromCatalog(): string {
  const workflowIds = catalogWorkflowIds(LOOPSHIP_FLOW_INDEX);
  const [first] = workflowIds.sort();
  if (!first) {
    throw new Error(`Loopship flow catalog is empty: ${LOOPSHIP_FLOW_INDEX}`);
  }
  return first;
}

export function resolveLoopshipFlowId(flowId?: string | null): string {
  const explicit = String(flowId ?? "").trim();
  if (!explicit) return defaultLoopshipFlowIdFromCatalog();
  const available = catalogWorkflowIds(LOOPSHIP_FLOW_INDEX);
  if (!available.includes(explicit)) {
    throw new Error(`Unknown Loopship flow '${explicit}'. Available flows: ${available.sort().join(", ")}`);
  }
  return explicit;
}

function defaultWtreeName(request: string): string {
  const normalized = request
    .toLowerCase()
    .replace(/^loopship:\s*/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || `loopship-${Date.now().toString(36)}`;
}

function requireCanonicalRegisteredWorktree(input: {
  repoRoot: string;
  workspaceRoot: string;
  wtree: string;
  operation: string;
}): { workspaceRoot: string; wtree: string; branch?: string | null } {
  const worktreesRoot = resolve(input.repoRoot, "worktrees");
  const wtree = assertCanonicalWtreeName(input.wtree, "wtree");
  const expectedWorkspaceRoot = resolve(worktreesRoot, wtree);
  const workspaceRoot = resolve(input.workspaceRoot);
  if (
    workspaceRoot !== expectedWorkspaceRoot ||
    !existsSync(worktreesRoot) ||
    realpathSync(worktreesRoot) !== resolve(realpathSync(input.repoRoot), "worktrees") ||
    !existsSync(workspaceRoot) ||
    realpathSync(workspaceRoot) !== workspaceRoot
  ) {
    throw new Error(
      `${input.operation} requires canonical worktree ${expectedWorkspaceRoot}`,
    );
  }
  const registered = parseGitWorktrees(input.repoRoot).find(
    (entry) => resolve(entry.worktree) === workspaceRoot,
  );
  if (!registered) {
    throw new Error(
      `${input.operation} requires a registered Git worktree: ${workspaceRoot}`,
    );
  }
  if (!registered.branch) {
    throw new Error(
      `${input.operation} requires an attached Git branch: ${workspaceRoot}`,
    );
  }
  return { workspaceRoot, wtree, branch: registered.branch };
}

function ensureLoopshipRuntimeDocument(input: {
  repoRoot: string;
  workspaceRoot: string;
  flowId: string;
  inputs: Record<string, unknown>;
  superviseStep?: boolean;
  write?: boolean;
}): void {
  const repoRoot = resolve(input.repoRoot);
  const runtimeDir = resolve(input.workspaceRoot, LOOPSHIP_RUNTIME_NAMESPACE);
  const tasksPath = resolve(runtimeDir, "tasks.yaml");
  const request = String(input.inputs.request ?? input.inputs.prompt ?? "").trim();
  if (!request && !existsSync(tasksPath)) {
    throw new Error("Native execution requires inputs.request before creating canonical quest state");
  }
  const wtree =
    String(input.inputs.wtree ?? "").trim() ||
    (request ? defaultWtreeName(request) : basename(input.workspaceRoot));
  const expectedWorkspace = resolve(repoRoot, "worktrees", assertCanonicalWtreeName(wtree));
  if (resolve(input.workspaceRoot) !== expectedWorkspace) {
    throw new Error(
      `workflow workspace must match its canonical worktree path: ${expectedWorkspace}`,
    );
  }
  const coordinatorBranch =
    gitCurrentBranch(input.workspaceRoot) ||
    wtree ||
    optionalString(input.inputs.sourceBranch) ||
    optionalString(input.inputs.source_branch);
  const landingTargetBranch =
    optionalString(input.inputs.targetBranch) ||
    optionalString(input.inputs.target_branch) ||
    "main";
  const landingTargetWorktree =
    optionalString(input.inputs.targetWorktree) ||
    optionalString(input.inputs.target_worktree) ||
    landingTargetWorktreePath(repoRoot, landingTargetBranch);
  const questInput: CreateQuestInput = {
    repoRoot,
    wtree,
    prompt: request,
    resolutionSource: "fastflow",
    superviseStep: input.superviseStep === true,
    workspace: {
      branch_ref: coordinatorBranch,
      worktree_path: input.workspaceRoot,
      mode: gitCurrentBranch(input.workspaceRoot) ? "git" : "directory",
    },
    flowId: input.flowId,
    initialStage: "initial",
    parentWtree:
      optionalString(input.inputs.parentWtree) || optionalString(input.inputs.parent_wtree),
    parentTaskId:
      optionalString(input.inputs.parentTaskId) || optionalString(input.inputs.parent_task_id),
    parentContextRef:
      optionalString(input.inputs.parentContextRef) ||
      optionalString(input.inputs.parent_context_ref),
    landingTargetBranch,
    landingTargetWorktree,
  };
  const expectedInitialState = createQuestInitialState(questInput);
  if (existsSync(tasksPath)) {
    const state = parseTasksYaml(readText(tasksPath));
    const stateWtree = assertCanonicalWtreeName(
      requireString(state.wtree || state.quest_id, "tasks.wtree"),
      "tasks.wtree",
    );
    const files = questFiles(repoRoot, stateWtree);
    if (
      stateWtree !== wtree ||
      resolve(input.workspaceRoot) !== files.workspace_root ||
      resolve(requireString(state.context_root, "tasks.context_root")) !== repoRoot ||
      resolve(requireString(state.coordinator_worktree, "tasks.coordinator_worktree")) !==
        files.workspace_root ||
      requireString(state.flow_id, "tasks.flow_id") !== input.flowId
    ) {
      throw new Error(`Loopship Native quest state does not match canonical workspace ${files.workspace_root}`);
    }
    const eventsExist = existsSync(files.events);
    let events: Array<Record<string, unknown>> = [];
    try {
      events = readText(files.events)
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch (error) {
      throw new Error(
        `Loopship Native quest events are corrupt at ${files.events}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const manifestExists = existsSync(files.manifest);
    const hookStateExists = existsSync(files.hook_state);
    const partial = !eventsExist || events.length === 0 || !manifestExists || !hookStateExists;
    if (partial) {
      let hookState: unknown = null;
      if (hookStateExists) {
        try {
          hookState = JSON.parse(readText(files.hook_state));
        } catch (error) {
          throw new Error(
            `Loopship Native hook state is corrupt at ${files.hook_state}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const stateIsPristine =
        digestNativeContract(state as unknown as JsonValue) ===
        digestNativeContract(expectedInitialState as unknown as JsonValue);
      const hookIsPristine =
        !hookStateExists ||
        (isPlainObject(hookState) && Object.keys(hookState).length === 0);
      const hasStartedEvent =
        events.length === 1 &&
        events[0]?.event === "quest_started" &&
        events[0]?.quest_id === wtree &&
        events[0]?.stage === "initial";
      const recognizablePrefix =
        !manifestExists &&
        stateIsPristine &&
        hookIsPristine &&
        ((!eventsExist && !hookStateExists && events.length === 0) ||
          (eventsExist && events.length === 0) ||
          (eventsExist && hookStateExists && hasStartedEvent));
      if (!recognizablePrefix) {
        throw new Error(`Loopship Native quest state is not a pristine initialization prefix: ${files.dir}`);
      }
      if (input.write === false) return;
      if (events.length === 0) {
        appendJsonl(files.events, {
          event: "quest_started",
          quest_id: wtree,
          stage: "initial",
        });
        events = readText(files.events)
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      }
      if (!hookStateExists) writeJsonAtomically(files.hook_state, {});
      writeQuestManifest(files, `start-${wtree}`, "loopship fastflow");
    }
    if (
      events[0]?.event !== "quest_started" ||
      events[0]?.quest_id !== wtree
    ) {
      throw new Error(`Loopship Native quest events do not start with canonical quest identity ${wtree}`);
    }
    const manifest = verifyQuestManifest(files);
    if (!manifest.ok) {
      throw new Error(`Loopship Native quest manifest is corrupt: ${manifest.errors.join("; ")}`);
    }
    return;
  }
  const files = questFiles(repoRoot, wtree);
  if (existsSync(files.events) || existsSync(files.hook_state) || existsSync(files.manifest)) {
    throw new Error(
      `Loopship Native quest state has stale initialization siblings without tasks: ${files.dir}`,
    );
  }
  if (input.write === false) return;
  createQuest(questInput);
}

function ensureLoopshipRuntimeDocumentSerialized(
  input: Parameters<typeof ensureLoopshipRuntimeDocument>[0],
): void {
  const path = resolve(
    input.workspaceRoot,
    LOOPSHIP_RUNTIME_NAMESPACE,
    "quest-init.lock.sqlite",
  );
  let release: (() => void) | null = null;
  try {
    release = acquireCrashSafeFileLock(path, LOOPSHIP_QUEST_INIT_LOCK_WAIT_MS);
  } catch (error) {
    if ((error as { code?: string }).code === "loopship_file_lock_busy") {
      throw new Error(`Loopship quest initialization is already in progress: ${path}`);
    }
    throw error;
  }
  try {
    ensureLoopshipRuntimeDocument(input);
  } finally {
    release();
  }
}

function resolveRunWorkspace(input: LoopshipFastflowRunInput): {
  repoRoot: string;
  inputs: Record<string, unknown>;
  workspaceRoot: string;
} {
  const repoRoot = canonicalRepositoryRoot(input.repoRoot, "repoRoot");
  const inputs = { ...(input.inputs || {}) };
  normalizeRunInputAliases(inputs);
  for (const field of ["repo", "repoRoot"] as const) {
    if (inputs[field] === undefined || inputs[field] === null || inputs[field] === "") continue;
    const identity = canonicalRepositoryRoot(inputs[field], `inputs.${field}`);
    if (identity !== repoRoot) {
      throw new Error(
        `Native execution inputs.${field} ${identity} conflicts with canonical repository ${repoRoot}`,
      );
    }
  }
  inputs.repo = repoRoot;
  inputs.repoRoot = repoRoot;
  let canonical: ReturnType<typeof requireCanonicalRegisteredWorktree>;
  if (input.workspaceRoot) {
    canonical = requireCanonicalRegisteredWorktree({
      repoRoot,
      workspaceRoot: input.workspaceRoot,
      wtree: requireString(inputs.wtree, "inputs.wtree"),
      operation: "Native execution",
    });
  } else {
    const request = optionalString(inputs.request);
    const wtree = optionalString(inputs.wtree) || (request ? defaultWtreeName(request) : "");
    if (!wtree) {
      throw new Error(
        "Native execution requires inputs.wtree or inputs.request to select a canonical registered worktree",
      );
    }
    const workspace = ensureCoordinatorWorkspace(repoRoot, wtree);
    inputs.wtree = wtree;
    canonical = requireCanonicalRegisteredWorktree({
      repoRoot,
      workspaceRoot: workspace.worktree_path,
      wtree,
      operation: "Native execution",
    });
  }
  inputs.sourceBranch = canonical.branch;
  inputs.source_branch = canonical.branch;
  const targetBranch = optionalString(inputs.targetBranch) || "main";
  inputs.targetBranch = targetBranch;
  inputs.target_branch = targetBranch;
  const targetWorktree = optionalString(inputs.targetWorktree) ||
    landingTargetWorktreePath(repoRoot, targetBranch);
  inputs.targetWorktree = resolve(targetWorktree);
  inputs.target_worktree = resolve(targetWorktree);
  return { repoRoot, inputs, workspaceRoot: canonical.workspaceRoot };
}

function schemaAllowsType(schema: Record<string, unknown>, value: unknown): boolean {
  const type = schema.type;
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("object")) return isPlainObject(value);
  if (types.includes("array")) return Array.isArray(value);
  if (types.includes("string")) return typeof value === "string";
  if (types.includes("boolean")) return typeof value === "boolean";
  if (types.includes("number")) return typeof value === "number";
  if (types.includes("integer")) return Number.isInteger(value);
  return true;
}

function isFastflowExpression(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim().startsWith("${") &&
    value.trim().endsWith("}")
  );
}

function validateValueAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
): void {
  if (isFastflowExpression(value)) return;
  if (Array.isArray(schema.oneOf)) {
    const errors: string[] = [];
    for (const option of schema.oneOf) {
      if (!isPlainObject(option)) continue;
      try {
        validateValueAgainstSchema(option, value, path);
        return;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`${path} does not match any allowed shape: ${errors.join("; ")}`);
  }
  if ("const" in schema && value !== schema.const) {
    throw new Error(`${path} must be ${JSON.stringify(schema.const)}.`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    throw new Error(`${path} must be one of ${schema.enum.map(String).join(", ")}.`);
  }
  if (!schemaAllowsType(schema, value)) {
    throw new Error(`${path} has invalid type.`);
  }
  if (
    schema.type === "string" &&
    schema.minLength === 1 &&
    typeof value === "string" &&
    !value.trim()
  ) {
    throw new Error(`${path} must be non-empty.`);
  }
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    value.forEach((item, index) =>
      validateValueAgainstSchema(schema.items as Record<string, unknown>, item, `${path}[${index}]`),
    );
  }
  if (!isPlainObject(value)) return;
  const properties = isPlainObject(schema.properties)
    ? (schema.properties as Record<string, Record<string, unknown>>)
    : {};
  if (schema.additionalProperties === false) {
    for (const field of Object.keys(value)) {
      if (!(field in properties)) {
        throw new Error(`${path}.${field} is not allowed.`);
      }
    }
  }
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  for (const field of required) {
    if (!(field in value)) throw new Error(`${path}.${field} is required.`);
  }
  for (const [field, nestedValue] of Object.entries(value)) {
    const nestedSchema = properties[field];
    if (nestedSchema) validateValueAgainstSchema(nestedSchema, nestedValue, `${path}.${field}`);
  }
  if (schema === SYSTEM_UPDATE_SCHEMA && value.mode === "replace" && !isPlainObject(value.root)) {
    throw new Error(`${path}.root is required when mode is replace.`);
  }
  if (schema === SYSTEM_UPDATE_SCHEMA && Array.isArray(value.external_docs)) {
    value.external_docs.forEach((entry, index) => {
      if (isPlainObject(entry) && entry.op === "upsert" && !isPlainObject(entry.document)) {
        throw new Error(`${path}.external_docs[${index}].document is required for upsert.`);
      }
    });
  }
}

function validateBodyAgainstDescriptor(
  descriptor: CallDescriptor,
  body: Record<string, unknown>,
): void {
  const schema = descriptor.inputs.schema as Record<string, unknown>;
  const properties = isPlainObject(schema.properties)
    ? (schema.properties as Record<string, Record<string, unknown>>)
    : {};
  if (schema.additionalProperties === false) {
    for (const field of Object.keys(body)) {
      if (!(field in properties)) {
        throw new Error(`Loopship call '${descriptor.call}' does not allow body.${field}.`);
      }
    }
  }
  for (const field of descriptor.inputs.required) {
    if (!(field in body)) {
      throw new Error(`Loopship call '${descriptor.call}' requires body.${field}.`);
    }
  }
  for (const [field, value] of Object.entries(body)) {
    const fieldSchema = properties[field];
    if (!fieldSchema) continue;
    validateValueAgainstSchema(fieldSchema, value, `body.${field}`);
  }
}

function resolveFastflowRoot(requiredFiles = ["src/index.mjs", "src/catalog.mjs"]): string {
  const overrideRoot = process.env.LOOPSHIP_FASTFLOW_ROOT
    ? resolve(process.env.LOOPSHIP_FASTFLOW_ROOT)
    : "";
  const candidates = [
    overrideRoot,
    resolve(LOOPSHIP_ROOT, "node_modules", "@cueintent", "fastflow"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (
      existsSync(resolve(candidate, "package.json")) &&
      requiredFiles.every((file) => existsSync(resolve(candidate, file)))
    ) {
      return candidate;
    }
  }
  throw new Error("could not resolve @cueintent/fastflow runtime");
}

function assertAbsoluteSchedulerDatabase(): void {
  const schedulerDb = optionalString(process.env.FASTFLOW_SCHEDULER_DB);
  if (schedulerDb && !isAbsolute(schedulerDb)) {
    throw new Error("FASTFLOW_SCHEDULER_DB must be an absolute path for Loopship");
  }
  if (schedulerDb) process.env.FASTFLOW_SCHEDULER_DB = schedulerDb;
  else delete process.env.FASTFLOW_SCHEDULER_DB;
}

function workflowCatalogScopeRoot(root: string, scope: string): string {
  return resolve(root, LOOPSHIP_WORKFLOW_REGISTRY, "workflow", LOOPSHIP_WORKFLOW_TARGET, scope);
}

function catalogWorkflowIds(indexPath: string): string[] {
  if (!existsSync(indexPath)) return [];
  const parsed = parseYaml(readFileSync(indexPath, "utf8"));
  const workflows =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).workflows
      : null;
  if (!workflows || typeof workflows !== "object" || Array.isArray(workflows)) return [];
  return Object.keys(workflows);
}

function workflowFileName(id: string): string {
  return `${id.replace(/_/g, "-")}.stable.yaml`;
}

function catalogScopeIsComplete(root: string, scope: string): boolean {
  const scopeRoot = workflowCatalogScopeRoot(root, scope);
  const indexPath = resolve(scopeRoot, "index.yaml");
  const workflowIds = catalogWorkflowIds(indexPath);
  return workflowIds.length > 0 && workflowIds.every((id) => existsSync(resolve(scopeRoot, workflowFileName(id))));
}

function catalogIsComplete(root: string): boolean {
  return (
    existsSync(resolve(root, "index.yaml")) &&
    catalogScopeIsComplete(root, LOOPSHIP_STEP_SCOPE) &&
    catalogScopeIsComplete(root, LOOPSHIP_FLOW_SCOPE)
  );
}

function workflowRefFor(scope: string, name: string): string {
  return [
    LOOPSHIP_WORKFLOW_REGISTRY,
    "workflow",
    LOOPSHIP_WORKFLOW_TARGET,
    scope,
    name,
  ].join(".");
}

export function loopshipFlowWorkflowRef(flowId: string): string {
  return workflowRefFor(LOOPSHIP_FLOW_SCOPE, flowId.replace(/_/g, "-"));
}

function loopshipFlowIdFromWorkflowRef(workflowRef: string): string {
  const prefix = workflowRefFor(LOOPSHIP_FLOW_SCOPE, "");
  if (!workflowRef.startsWith(prefix)) {
    throw new Error(`Loopship workflow request must target ${prefix}<flow-id>.`);
  }
  return resolveLoopshipFlowId(workflowRef.slice(prefix.length).replace(/-/g, "_"));
}

export async function ensureLoopshipFastflowWorkflowCatalog(
  _repoRoot: string,
): Promise<string> {
  if (!catalogIsComplete(LOOPSHIP_CALL_CATALOG_ROOT)) {
    throw new Error(`Loopship Fastflow call catalog is incomplete: ${LOOPSHIP_CALL_CATALOG_ROOT}`);
  }
  return LOOPSHIP_CALL_CATALOG_ROOT;
}

function runFastflowSession(input: {
  repoRoot: string;
  workspaceRoot?: string;
  catalogRoot: string;
  operation: "run" | "recover" | "resume";
  request: Record<string, unknown>;
}): Record<string, unknown> {
  assertAbsoluteSchedulerDatabase();
  if (!process.versions.bun) {
    throw new Error("Loopship Native application sessions require the Bun runtime.");
  }
  const tempDir = mkdtempSync(join(tmpdir(), "loopship-fastflow-session-"));
  const requestPath = join(tempDir, "request.json");
  const scriptPath = join(tempDir, "run.mjs");
  const fastflowRoot = resolveFastflowRoot();
  const workspaceRoot = resolve(input.workspaceRoot || input.repoRoot);
  writeFileSync(requestPath, JSON.stringify(input.request), "utf8");
  writeFileSync(
    scriptPath,
    `
      import { readFileSync } from "node:fs";
      import * as Fastflow from ${JSON.stringify(pathToFileURL(resolve(fastflowRoot, "src", "index.mjs")).href)};
      import {
        LOOPSHIP_CALL_CATALOG_ROOT,
        LOOPSHIP_SUPERVISOR_GUIDANCE,
        LOOPSHIP_WORKFLOW_RESUME_COMMAND,
        createLoopshipFastflowAdapters,
      } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)};

      const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
      process.env.LOOPSHIP_WORKSPACE_ROOT = ${JSON.stringify(workspaceRoot)};
      Fastflow.configureFastflowApp({
        appName: "loopship",
        systemWorkflowsDir: ${JSON.stringify(input.catalogRoot)},
        callCatalogRoots: [${JSON.stringify(input.catalogRoot)}, LOOPSHIP_CALL_CATALOG_ROOT],
        supervisorGuidance: LOOPSHIP_SUPERVISOR_GUIDANCE,
        workflowResumeCommand: LOOPSHIP_WORKFLOW_RESUME_COMMAND,
        adapters: createLoopshipFastflowAdapters(),
      });
      const operation = ${JSON.stringify(input.operation)};
      let result;
      if (operation === "run") {
        result = await Fastflow.executeFastflowWorkflowRunRequest(request);
      } else if (operation === "resume") {
        result = await Fastflow.executeFastflowWorkflowResumeRequest(request);
      } else {
        try {
          result = await Fastflow.executeFastflowWorkflowRecoverRequest({
            executionId: request.executionId,
          });
        } catch (error) {
          if (error?.code !== "FASTFLOW_EXECUTION_NOT_FOUND") throw error;
          result = await Fastflow.executeFastflowWorkflowRunRequest(request);
        }
      }
      await new Promise((resolve) => process.stdout.write(JSON.stringify(result) + "\\n", resolve));
      process.exit(0);
    `,
    "utf8",
  );
  try {
    const proc = runCommand(process.execPath, ["--no-install", scriptPath, requestPath], {
      cwd: workspaceRoot,
      timeoutMs: LOOPSHIP_FASTFLOW_SESSION_TIMEOUT_MS,
    });
    if (proc.status !== 0) {
      throw new Error(proc.stderr || proc.stdout || "Fastflow session command failed");
    }
    const lines = proc.stdout.trim().split(/\r?\n/).filter(Boolean);
    const parsed = JSON.parse(lines[lines.length - 1] || "{}");
    if (!isPlainObject(parsed)) {
      throw new Error("Fastflow session command returned a non-object result.");
    }
    assertNativePublicResponse(parsed);
    return parsed;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function assertNativePublicResponse(result: Record<string, unknown>): void {
  const interaction =
    result.schemaVersion === "fastflow/interaction-response/v1" &&
    ["inline_answer", "handoff_answer", "supervisor_review"].includes(
      String(result.kind),
    );
  const workflowResult =
    result.schemaVersion === "fastflow/workflow-run-artifact/v1" &&
    result.kind === "workflow_result" &&
    typeof result.ok === "boolean" &&
    ["running", "completed", "failed"].includes(String(result.status));
  if (!interaction && !workflowResult) {
    throw new Error(
      "Fastflow session returned a non-public Native response; expected interaction-response/v1 or workflow-run-artifact/v1.",
    );
  }
}

function finalizeLoopshipNativeExecution(input: {
  repoRoot: string;
  workspaceRoot: string;
  executionId: string;
  result: Record<string, unknown>;
}): void {
  if (!nativeWorkflowResultIsTerminal(input.result, input.executionId)) return;
  markNativeExecutionCompleted(input.workspaceRoot, input.executionId);
  cleanupCompletedNativeWorkspaceResidue({
    repo: input.repoRoot,
    workspaceRoot: input.workspaceRoot,
  });
}

function throwIfNativeExecutionFailed(
  result: Record<string, unknown>,
  executionId: string,
): void {
  const failedArtifact =
    result.schemaVersion === "fastflow/workflow-run-artifact/v1" &&
    result.kind === "workflow_result" &&
    result.status === "failed";
  const failedRecovery =
    result.executionId === executionId &&
    result.ok === false &&
    (result.status === "failed" || result.status === "cancelled");
  if (!failedArtifact && !failedRecovery) return;
  const detail = isPlainObject(result.error) ? result.error : {};
  throw Object.assign(
    new Error(
      optionalString(detail.message) ||
        `Native execution ${executionId} ended with status ${String(result.status)}`,
    ),
    { code: optionalString(detail.code) || "FASTFLOW_NATIVE_EXECUTION_FAILED" },
  );
}

function throwIfNativeExecutionUnsettled(
  result: Record<string, unknown>,
  executionId: string,
): void {
  const publicRunning =
    result.schemaVersion === "fastflow/workflow-run-artifact/v1" &&
    result.kind === "workflow_result" &&
    result.status === "running";
  const rawRunning =
    result.executionId !== executionId ||
    result.ok !== false ||
    !["queued", "running"].includes(String(result.status));
  if (!publicRunning && rawRunning) {
    return;
  }
  throw Object.assign(
    new Error(
      `Native execution ${executionId} is still ${String(result.status)}; retry canonical recovery after the durable scheduler settles it`,
    ),
    { code: "FASTFLOW_NATIVE_EXECUTION_RUNNING", retryable: true },
  );
}

function syncLoopshipHookRoute(input: {
  repoRoot: string;
  workspaceRoot: string;
  runtime: string;
  executionId: string;
  result: Record<string, unknown>;
  expectedRoute?: { sessionId: string; nonce: string };
}): void {
  let route = null;
  if (input.runtime) {
    const identity = runtimeIdentityFromEnv(input.runtime);
    route = recordHookRoute({
      repoRoot: input.repoRoot,
      runtime: identity?.runtime ?? input.runtime,
      threadId: identity?.threadId,
      workspaceRoot: input.workspaceRoot,
      result: input.result,
    });
  }
  if (!route) {
    updateHookRouteForWorkspace({
      repoRoot: input.repoRoot,
      workspaceRoot: input.workspaceRoot,
      result: input.result,
      expectedSessionId: input.expectedRoute?.sessionId || input.executionId,
      expectedNonce: input.expectedRoute?.nonce,
    });
  }
}

export async function resolveLoopshipFastflowCommandBinding(
  argv: string[],
  bindings: Array<Record<string, unknown>>,
  context: Record<string, unknown> = {},
): Promise<Record<string, unknown> | null> {
  const fastflowRoot = resolveFastflowRoot();
  const { resolveFastflowCommandBinding } = await import(
    pathToFileURL(resolve(fastflowRoot, "src", "command-bindings.mjs")).href
  );
  return resolveFastflowCommandBinding(argv, bindings, context) as Record<string, unknown> | null;
}

export async function runLoopshipFastflowWorkflowRequest(
  input: LoopshipFastflowWorkflowRequestInput,
): Promise<Record<string, unknown>> {
  assertAbsoluteSchedulerDatabase();
  const catalogRoot = await ensureLoopshipFastflowWorkflowCatalog(LOOPSHIP_ROOT);
  const workflowRef = requireString(input.request.workflowRef, "workflowRef");
  const requestInputs = isPlainObject(input.request.inputs)
    ? { ...(input.request.inputs as Record<string, unknown>) }
    : {};
  const flowId = loopshipFlowIdFromWorkflowRef(workflowRef);
  const { repoRoot, inputs, workspaceRoot } = resolveRunWorkspace({
    repoRoot: input.repoRoot,
    workspaceRoot: input.workspaceRoot,
    flowId,
    inputs: requestInputs,
  });
  const superviseStep = input.request.superviseStep === true || input.request.supervision === "step";
  ensureLoopshipRuntimeDocument({
    repoRoot,
    workspaceRoot,
    flowId,
    inputs,
    superviseStep,
    write: false,
  });
  const nativeExecution = resolveNativeExecutionRequest(
    workspaceRoot,
    {
      ...input.request,
      workflowRef,
      inputs,
    },
  );
  ensureLoopshipRuntimeDocumentSerialized({
    repoRoot,
    workspaceRoot,
    flowId,
    inputs,
    superviseStep,
  });
  const expectedRoute = readHookRouteForWorkspace({ repoRoot, workspaceRoot })?.fastflow;
  const result = runFastflowSession({
    repoRoot,
    workspaceRoot,
    catalogRoot,
    operation: "run",
    request: nativeExecution.request,
  });
  throwIfNativeExecutionUnsettled(result, nativeExecution.executionId);
  finalizeLoopshipNativeExecution({
    repoRoot,
    workspaceRoot,
    executionId: nativeExecution.executionId,
    result,
  });
  syncLoopshipHookRoute({
    repoRoot,
    workspaceRoot,
    runtime: optionalString(inputs.runtime),
    executionId: nativeExecution.executionId,
    result,
    ...(expectedRoute ? { expectedRoute } : {}),
  });
  throwIfNativeExecutionFailed(result, nativeExecution.executionId);
  return result;
}

export async function runLoopshipFastflowWorkflow(
  input: LoopshipFastflowRunInput,
): Promise<Record<string, unknown>> {
  assertAbsoluteSchedulerDatabase();
  const flowId = resolveLoopshipFlowId(input.flowId);
  const prepared = resolveRunWorkspace({
    ...input,
    flowId,
  });
  const request = {
    workflowRef: loopshipFlowWorkflowRef(flowId),
    inputs: prepared.inputs,
    ...(input.superviseStep ? { superviseStep: true } : {}),
    ...(input.progressMode ? { progressMode: input.progressMode } : {}),
  };
  return runLoopshipFastflowWorkflowRequest({
    repoRoot: prepared.repoRoot,
    workspaceRoot: prepared.workspaceRoot,
    request,
  });
}

function requireCanonicalNativeWorkspace(input: {
  repoRoot: string;
  workspaceRoot: string;
  expectedWtree?: string;
  expectedExecutionId?: string;
}): {
  repoRoot: string;
  workspaceRoot: string;
  wtree: string;
  execution: ReturnType<typeof readNativeExecutionRequest>;
} {
  const repoRoot = canonicalRepositoryRoot(input.repoRoot, "repoRoot");
  const workspaceRoot = resolve(requireString(input.workspaceRoot, "workspaceRoot"));
  const canonical = requireCanonicalRegisteredWorktree({
    repoRoot,
    workspaceRoot,
    wtree: input.expectedWtree || basename(workspaceRoot),
    operation: "Native recovery",
  });
  const { wtree, branch: registeredBranch } = canonical;
  const tasksPath = resolve(workspaceRoot, LOOPSHIP_RUNTIME_NAMESPACE, "tasks.yaml");
  let tasks: Record<string, unknown> | null = null;
  if (existsSync(tasksPath)) {
    tasks = parseTasksYaml(readText(tasksPath)) as Record<string, unknown>;
    const coordinatorWorktree = resolve(
      requireString(tasks.coordinator_worktree, "tasks.coordinator_worktree"),
    );
    const coordinatorBranch = requireString(
      tasks.coordinator_branch,
      "tasks.coordinator_branch",
    );
    if (
      coordinatorWorktree !== workspaceRoot ||
      registeredBranch !== coordinatorBranch
    ) {
      throw new Error(
        `Native recovery worktree ${workspaceRoot} does not match canonical quest branch ${coordinatorBranch}`,
      );
    }
  }
  const execution = readNativeExecutionRequest(workspaceRoot);
  const requestInputs = isPlainObject(execution.request.inputs)
    ? { ...execution.request.inputs }
    : {};
  normalizeRunInputAliases(requestInputs);
  for (const field of ["repoRoot", "repo"] as const) {
    if (!optionalString(requestInputs[field])) {
      if (field === "repo") continue;
      throw new Error(`native inputs.${field} must be a non-empty string`);
    }
    if (canonicalRepositoryRoot(requestInputs[field], `native inputs.${field}`) !== repoRoot) {
      throw new Error(
        `Native execution request ${execution.executionId} does not match canonical repository ${repoRoot}`,
      );
    }
  }
  if (requireString(requestInputs.wtree, "native inputs.wtree") !== wtree) {
    throw new Error(
      `Native execution request ${execution.executionId} does not match canonical worktree ${wtree}`,
    );
  }
  if (tasks) {
    const storedSourceBranch = optionalString(requestInputs.sourceBranch);
    const storedTargetBranch = optionalString(requestInputs.targetBranch);
    const storedTargetWorktree = optionalString(requestInputs.targetWorktree);
    const comparisons: Array<[string, string, string]> = [
      ["request", optionalString(requestInputs.request), optionalString(tasks.prompt)],
      ["sourceBranch", storedSourceBranch, optionalString(tasks.coordinator_branch)],
      ["targetBranch", storedTargetBranch, optionalString(tasks.landing_target_branch)],
      [
        "targetWorktree",
        storedTargetWorktree ? resolve(storedTargetWorktree) : "",
        optionalString(tasks.landing_target_worktree)
          ? resolve(optionalString(tasks.landing_target_worktree))
          : "",
      ],
      ["parentWtree", optionalString(requestInputs.parentWtree), optionalString(tasks.parent_wtree)],
      ["parentTaskId", optionalString(requestInputs.parentTaskId), optionalString(tasks.parent_task_id)],
      [
        "parentContextRef",
        optionalString(requestInputs.parentContextRef),
        optionalString(tasks.parent_context_ref),
      ],
    ];
    for (const [field, storedValue, canonicalValue] of comparisons) {
      if (storedValue && storedValue !== canonicalValue) {
        throw new Error(
          `Native execution request ${execution.executionId} inputs.${field} does not match canonical quest state`,
        );
      }
    }
  }
  if (
    input.expectedExecutionId &&
    execution.executionId !== input.expectedExecutionId
  ) {
    throw new Error(
      `Native resume execution ${input.expectedExecutionId} does not match current ledger ${execution.executionId}`,
    );
  }
  return { repoRoot, workspaceRoot, wtree, execution };
}

export async function recoverLoopshipFastflowWorkflow(
  input: LoopshipFastflowRecoverInput,
): Promise<Record<string, unknown>> {
  assertAbsoluteSchedulerDatabase();
  const requestedWtree = assertCanonicalWtreeName(requireString(input.wtree, "wtree"));
  const canonical = requireCanonicalNativeWorkspace({
    repoRoot: input.repoRoot,
    workspaceRoot: resolve(input.repoRoot, "worktrees", requestedWtree),
    expectedWtree: requestedWtree,
  });
  const { repoRoot, workspaceRoot } = canonical;
  const tasksPath = resolve(workspaceRoot, LOOPSHIP_RUNTIME_NAMESPACE, "tasks.yaml");
  const nativeExecutionPath = resolve(
    workspaceRoot,
    LOOPSHIP_RUNTIME_NAMESPACE,
    "native-execution.json",
  );
  if (!existsSync(tasksPath) && !existsSync(nativeExecutionPath)) {
    throw new Error(`missing canonical Loopship quest state: ${tasksPath}`);
  }
  const stored = canonical.execution;
  const storedWorkflowRef = requireString(stored.request.workflowRef, "native workflowRef");
  const storedFlowId = loopshipFlowIdFromWorkflowRef(storedWorkflowRef);
  const storedInputs = isPlainObject(stored.request.inputs)
    ? stored.request.inputs
    : {};
  if (requireString(storedInputs.wtree, "native inputs.wtree") !== requestedWtree) {
    throw new Error(
      `Native execution request ${stored.executionId} does not match requested quest ${requestedWtree}`,
    );
  }
  ensureLoopshipRuntimeDocumentSerialized({
    repoRoot,
    workspaceRoot,
    flowId: storedFlowId,
    inputs: storedInputs,
    superviseStep:
      stored.request.superviseStep === true || stored.request.supervision === "step",
  });
  const state = parseYaml(readFileSync(tasksPath, "utf8"));
  if (!isPlainObject(state)) {
    throw new Error(`canonical Loopship quest state must be an object: ${tasksPath}`);
  }
  const wtree = requireString(state.wtree, "tasks.wtree");
  if (wtree !== requestedWtree) {
    throw new Error(`canonical quest wtree '${wtree}' does not match requested wtree '${requestedWtree}'`);
  }
  const flowId = requireString(state.flow_id, "tasks.flow_id");
  if (storedWorkflowRef !== loopshipFlowWorkflowRef(flowId)) {
    throw new Error(
      `Native execution request ${stored.executionId} does not match canonical quest flow ${flowId}`,
    );
  }
  const nativeExecution = resolveNativeExecutionRequest(
    workspaceRoot,
    stored.request,
    {
      expectedExecutionId: stored.executionId,
      expectedStatus: stored.status,
    },
  );
  if (
    stored.status === "pending" &&
    nativeExecution.executionId !== stored.executionId
  ) {
    throw new Error(
      `Native recovery execution ${nativeExecution.executionId} does not match pending ledger ${stored.executionId}`,
    );
  }
  const catalogRoot = await ensureLoopshipFastflowWorkflowCatalog(LOOPSHIP_ROOT);
  const expectedRoute = readHookRouteForWorkspace({ repoRoot, workspaceRoot })?.fastflow;
  const result = runFastflowSession({
    repoRoot,
    workspaceRoot,
    catalogRoot,
    operation: stored.status === "pending" ? "recover" : "run",
    request: nativeExecution.request,
  });
  throwIfNativeExecutionUnsettled(result, nativeExecution.executionId);
  finalizeLoopshipNativeExecution({
    repoRoot,
    workspaceRoot,
    executionId: nativeExecution.executionId,
    result,
  });
  syncLoopshipHookRoute({
    repoRoot,
    workspaceRoot,
    runtime: optionalString(storedInputs.runtime),
    executionId: nativeExecution.executionId,
    result,
    ...(expectedRoute ? { expectedRoute } : {}),
  });
  throwIfNativeExecutionFailed(result, nativeExecution.executionId);
  return result;
}

export async function resumeLoopshipFastflowWorkflow(
  input: LoopshipFastflowResumeInput,
): Promise<Record<string, unknown>> {
  assertAbsoluteSchedulerDatabase();
  const explicitWorkspaceRoot = optionalString(input.workspaceRoot);
  const requestWorkspaceRoot = optionalString(input.request.workspaceRoot);
  if (
    explicitWorkspaceRoot &&
    requestWorkspaceRoot &&
    resolve(explicitWorkspaceRoot) !== resolve(requestWorkspaceRoot)
  ) {
    throw new Error("Native resume workspaceRoot conflicts with the request workspaceRoot");
  }
  const requestedWorkspaceRoot = explicitWorkspaceRoot || requestWorkspaceRoot;
  if (!requestedWorkspaceRoot) {
    throw new Error("Native resume requires the canonical workspaceRoot");
  }
  const executionId = requireString(input.request.sessionId, "sessionId");
  const canonical = requireCanonicalNativeWorkspace({
    repoRoot: input.repoRoot,
    workspaceRoot: requestedWorkspaceRoot,
    expectedExecutionId: executionId,
  });
  if (canonical.execution.status !== "pending") {
    throw new Error(`Native resume execution ${executionId} is already completed`);
  }
  const manifest = verifyQuestManifest(questFiles(canonical.repoRoot, canonical.wtree));
  if (!manifest.ok) {
    throw new Error(
      `Loopship Native quest manifest is corrupt before resume: ${manifest.errors.join("; ")}`,
    );
  }
  const catalogRoot = await ensureLoopshipFastflowWorkflowCatalog(LOOPSHIP_ROOT);
  const expectedRoute = readHookRouteForWorkspace({
    repoRoot: canonical.repoRoot,
    workspaceRoot: canonical.workspaceRoot,
  })?.fastflow;
  const result = runFastflowSession({
    repoRoot: canonical.repoRoot,
    workspaceRoot: canonical.workspaceRoot,
    catalogRoot,
    operation: "resume",
    request: input.request,
  });
  throwIfNativeExecutionUnsettled(result, executionId);
  finalizeLoopshipNativeExecution({
    repoRoot: canonical.repoRoot,
    workspaceRoot: canonical.workspaceRoot,
    executionId,
    result,
  });
  const executionInputs = isPlainObject(canonical.execution.request.inputs)
    ? canonical.execution.request.inputs
    : {};
  syncLoopshipHookRoute({
    repoRoot: canonical.repoRoot,
    workspaceRoot: canonical.workspaceRoot,
    runtime: optionalString(executionInputs.runtime),
    executionId,
    result,
    ...(expectedRoute ? { expectedRoute } : {}),
  });
  throwIfNativeExecutionFailed(result, executionId);
  return result;
}

function command(cmd: string, args: string[]): Record<string, unknown> {
  return { cmd, args };
}

const CHILD_DONE_STATUSES = new Set([
  "child_merged",
  "child_archived",
  "done",
  "merged",
]);
const CHILD_PREPARE_QUEUED_STATUSES = new Set([
  "child_received",
  "pending",
  "queued",
]);

function prepareChildLaunch(
  body: Record<string, unknown>,
  task: Record<string, unknown>,
): Record<string, unknown> {
  const repo = requireString(body.repo, "repo");
  const parentWtree = assertCanonicalWtreeName(requireString(body.wtree, "wtree"));
  const parent = isPlainObject(body.parent) ? body.parent : {};
  const taskId =
    optionalString(body.task_id) ||
    optionalString(task.id) ||
    optionalString(task.task_id) ||
    optionalString(parent.task_id) ||
    "task";
  const childWtree =
    optionalString(body.child_wtree) ||
    optionalString(task.child_wtree) ||
    taskAssignmentChildWtree(parentWtree, taskId);
  assertCanonicalWtreeName(childWtree, "child_wtree");
  const branchRef =
    optionalString(body.branch) ||
    optionalString(task.branch_ref) ||
    taskAssignmentBranchRef(parentWtree, taskId);
  assertValidGitBranchRef(branchRef, "child branch");
  const worktreePath =
    optionalString(body.worktree_path) ||
    optionalString(task.worktree_path) ||
    taskAssignmentWorktreePath(repo, parentWtree, taskId);
  const baseBranch =
    optionalString(body.base_branch) ||
    optionalString(body.target_branch) ||
    parentWtree;
  if (branchRef === baseBranch) {
    throw new Error(`child branch must differ from its base branch: ${branchRef}`);
  }
  const workspace = body.dry_run === true
    ? { branch_ref: branchRef, worktree_path: worktreePath, mode: "dry-run" }
    : ensureTaskWorkspace(repo, branchRef, worktreePath, baseBranch);
  const runtime = optionalString(body.runtime) || "codex";
  const superviseStep = childPrepareWorktreeUsesSuperviseStep(body);
  const parentContextRef = `${repo}/worktrees/${parentWtree}/${LOOPSHIP_RUNTIME_NAMESPACE}/tasks.yaml`;
  const request = `loopship: execute child task ${taskId}: ${optionalString(task.title) || taskId}. Read parent context at ${parentContextRef}. Implement only this assigned task. Do not split into child worktrees. Land into ${parentWtree} and return the merge_commit.`;
  const initArgs = [
    ...(superviseStep ? ["stepper", "init"] : ["init"]),
    request,
    "--repo",
    repo,
    "--wtree",
    childWtree,
    "--source-branch",
    workspace.branch_ref,
    "--parent-wtree",
    parentWtree,
    "--parent-task-id",
    taskId,
    "--parent-context-ref",
    parentContextRef,
    "--target-branch",
    parentWtree,
    "--target-worktree",
    `${repo}/worktrees/${parentWtree}`,
    "--runtime",
    runtime,
  ];
  return {
    schema_version: "loopship.child.prepare/v1",
    task_id: taskId,
    child_wtree: childWtree,
    parent_wtree: parentWtree,
    parent_context_ref: parentContextRef,
    branch_ref: workspace.branch_ref,
    worktree_path: workspace.worktree_path,
    runtime,
    supervise_step: superviseStep,
    actions: {
      init: command("loopship", initArgs),
    },
  };
}

function childPrepareWorktreeQuestState(
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
      optionalString((parent as Record<string, unknown>).parent_wtree) ||
      optionalString(quest.parent_wtree),
    parent_task_id:
      optionalString((parent as Record<string, unknown>).task_id) ||
      optionalString(quest.parent_task_id),
    parent_context_ref:
      optionalString((parent as Record<string, unknown>).parent_context_ref) ||
      optionalString(quest.parent_context_ref),
    supervise_step:
      body.supervise_step === true ||
      body.superviseStep === true ||
      quest.supervise_step === true ||
      quest.superviseStep === true,
  };
}

function childPrepareWorktreeUsesSuperviseStep(body: Record<string, unknown>): boolean {
  return childPrepareWorktreeQuestState(body).supervise_step === true;
}

function isQueuedChildTask(task: Record<string, unknown>): boolean {
  const status = optionalString(task.status) || "child_received";
  return CHILD_PREPARE_QUEUED_STATUSES.has(status);
}

function childTaskId(task: Record<string, unknown>): string {
  return optionalString(task.task_id) || optionalString(task.id) || "";
}

function childTaskDependencies(task: Record<string, unknown>): string[] {
  const rawDependencies = Array.isArray(task.dependencies)
    ? task.dependencies
    : Array.isArray(task.depends_on)
      ? task.depends_on
      : [];
  return rawDependencies
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

function isReadyChildTask(
  task: Record<string, unknown>,
  statusById: Map<string, string>,
): boolean {
  if (!isQueuedChildTask(task)) return false;
  return childTaskDependencies(task).every((dependencyId) => {
    const dependencyStatus = statusById.get(dependencyId);
    return typeof dependencyStatus === "string" && CHILD_DONE_STATUSES.has(dependencyStatus);
  });
}

function executeChildPrepare(body: Record<string, unknown>): Record<string, unknown> {
  const childInputs = Array.isArray(body.children)
    ? body.children.filter(isPlainObject)
    : [isPlainObject(body.task) ? body.task : {}];
  if (isTerminalChildQuestState(childPrepareWorktreeQuestState(body))) {
    const childIds = childInputs
      .map((task) =>
        optionalString(task.task_id) || optionalString(task.id) || optionalString(task.title),
      )
      .filter(Boolean);
    throw new Error(
      `terminal child quests must not prepare child worktrees${
        childIds.length ? ` (${childIds.join(", ")})` : ""
      }; keep the assigned work local in the current child worktree and continue workflow edits through *.dev.yaml plus Fastflow promotion`,
    );
  }
  const statusById = new Map<string, string>();
  for (const task of childInputs) {
    const taskId = childTaskId(task);
    if (!taskId) continue;
    statusById.set(taskId, optionalString(task.status) || "child_received");
  }
  const selectedInputs = childPrepareWorktreeUsesSuperviseStep(body)
    ? childInputs.filter((task) => isReadyChildTask(task, statusById)).slice(0, 1)
    : childInputs.filter((task) => isReadyChildTask(task, statusById));
  const preparedChildren = selectedInputs.map((task) => prepareChildLaunch(body, task));
  const first = preparedChildren[0] || {};
  return {
    schema_version: "loopship.child.prepare/v1",
    ...first,
    prepared_children: preparedChildren,
    children: preparedChildren,
    count: preparedChildren.length,
  };
}

function executeSystemApplyUpdate(body: Record<string, unknown>): Record<string, unknown> {
  const repo = requireString(body.repo, "repo");
  if (!isPlainObject(body.update)) {
    throw new Error("update must be an object");
  }
  const requestId = optionalString(body.request_id) || `fastflow-system-${Date.now().toString(36)}`;
  if (body.dry_run === true) {
    return {
      schema_version: "loopship.system.apply/v1",
      dry_run: true,
      touched: [],
    };
  }
  const touched = applySystemUpdate(repo, body.update, requestId);
  return {
    schema_version: "loopship.system.apply/v1",
    dry_run: false,
    touched,
  };
}

function gitRevParse(cwd: string, ref: string): string {
  const proc = runCommand("git", ["rev-parse", "--verify", "--end-of-options", ref], {
    cwd,
    timeoutMs: 15_000,
  });
  if (proc.status !== 0) {
    throw new Error(proc.stderr || proc.stdout || `git rev-parse failed for ${ref}`);
  }
  return proc.stdout.trim();
}

function executeGitResolveCommit(body: Record<string, unknown>): Record<string, unknown> {
  const repo = requireString(body.repo, "repo");
  const cwd = optionalString(body.cwd) || repo;
  const ref = optionalString(body.ref) || "HEAD";
  const commit = gitRevParse(cwd, ref);
  return {
    schema_version: "loopship.git.head/v1",
    repo,
    cwd,
    ref,
    commit,
  };
}

function stageChangedEventPayload(input: {
  stageAfter: string;
  stageBefore: string;
  step: string;
  transition: string;
}): Record<string, unknown> {
  return {
    event: "stage_changed",
    stage: input.stageAfter,
    transition: input.transition,
    step: input.step,
    stage_before: input.stageBefore,
    stage_after: input.stageAfter,
  };
}

function normalizeStageResultEvent(
  event: Record<string, unknown>,
  transitionContext: Record<string, unknown>,
): Record<string, unknown> {
  const payload = isPlainObject(event.payload) ? event.payload : event;
  return {
    schema_version: optionalString(event.schema_version) || "1.0.0",
    payload: {
      ...payload,
      ...transitionContext,
    },
  };
}

function executeFlowComposeTransitionResult(body: Record<string, unknown>): Record<string, unknown> {
  const flowId = requireString(body.flow_id, "flow_id");
  const stageBefore = requireString(body.stage_before, "stage_before");
  const stageAfter = requireString(body.stage_after, "stage_after");
  const transition = requireString(body.transition, "transition");
  const step = requireString(body.step, "step");
  const stepWorkflowTask = requireString(body.step_workflow_task, "step_workflow_task");
  const stepPayload = isPlainObject(body.step_payload) ? body.step_payload : {};
  const stepAction = isPlainObject(body.step_action) ? body.step_action : stepPayload;
  const statePatch = isPlainObject(body.state_patch) ? body.state_patch : {};
  const runtime = isPlainObject(body.runtime) ? body.runtime : {};
  const eventPayload = stageChangedEventPayload({
    stageAfter,
    stageBefore,
    step,
    transition,
  });
  const transitionContext = {
    transition,
    step,
    stage_before: stageBefore,
    stage_after: stageAfter,
  };
  const events = Array.isArray(body.events)
    ? body.events
        .filter(isPlainObject)
        .map((event) => normalizeStageResultEvent(event, transitionContext))
    : [];
  const result = {
    schema_version: "loopship.stage-result/v1",
    flow_id: flowId,
    stage_before: stageBefore,
    stage_after: stageAfter,
    transition,
    step,
    step_workflow_task: stepWorkflowTask,
    step_payload: clone(stepPayload),
    step_action: clone(stepAction),
    state_patch: clone(statePatch),
    events: [
      ...events,
      {
        schema_version: "1.0.0",
        payload: eventPayload,
      },
    ],
    event_payload: eventPayload,
    runtime: clone(runtime),
  };
  if (body.as_check === true) {
    return {
      ok: true,
      evidence: {
        schema_version: result.schema_version,
        flow_id: result.flow_id,
        stage_before: result.stage_before,
        stage_after: result.stage_after,
        transition: result.transition,
        event_count: result.events.length,
      },
    };
  }
  return result;
}

function executeRuntimeCommitQuestState(body: Record<string, unknown>): Record<string, unknown> {
  const requestedRepo = resolve(requireString(body.repo, "repo"));
  if (!existsSync(requestedRepo) || realpathSync(requestedRepo) !== requestedRepo) {
    throw new Error(`runtime quest commit requires a canonical repository: ${requestedRepo}`);
  }
  const wtree = assertCanonicalWtreeName(requireString(body.wtree, "wtree"));
  const files = questFiles(requestedRepo, wtree);
  requireCanonicalRegisteredWorktree({
    repoRoot: requestedRepo,
    workspaceRoot: files.workspace_root,
    wtree,
    operation: "runtime quest commit",
  });
  if (!existsSync(files.tasks) || !existsSync(files.events)) {
    throw new Error(`runtime quest commit requires canonical tasks and events: ${files.dir}`);
  }
  const state = parseTasksYaml(readText(files.tasks));
  if (
    requireString(state.wtree || state.quest_id, "tasks.wtree") !== wtree ||
    resolve(requireString(state.context_root, "tasks.context_root")) !== requestedRepo ||
    resolve(requireString(state.coordinator_worktree, "tasks.coordinator_worktree")) !==
      files.workspace_root
  ) {
    throw new Error(`runtime quest commit state does not match canonical quest ${wtree}`);
  }
  let events: Array<Record<string, unknown>>;
  try {
    events = readText(files.events)
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const event = JSON.parse(line);
        if (!isPlainObject(event)) throw new Error("event must be an object");
        return event;
      });
  } catch (error) {
    throw new Error(
      `runtime quest commit events are corrupt at ${files.events}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (events[0]?.event !== "quest_started" || events[0]?.quest_id !== wtree) {
    throw new Error(`runtime quest commit events do not start with canonical quest ${wtree}`);
  }
  const before = verifyQuestManifest(files);
  if (body.as_check === true) {
    if (!before.ok) {
      throw new Error(
        `runtime quest manifest verification failed: ${before.errors.join("; ")}`,
      );
    }
    return {
      ok: true,
      evidence: {
        schema_version: "loopship.runtime.commit-quest-state/v1",
        wtree,
        committed: false,
      },
    };
  }
  if (!before.ok) {
    const onlyManagedFileDrift = before.errors.every((error) =>
      error.startsWith("unauthorized/tampered quest file:"),
    );
    if (!onlyManagedFileDrift) {
      throw new Error(`runtime quest manifest is corrupt: ${before.errors.join("; ")}`);
    }
    writeQuestManifest(
      files,
      requireString(body.request_id, "request_id"),
      "loopship fastflow afn runtime.commit-quest-state",
    );
  }
  const after = verifyQuestManifest(files);
  if (!after.ok) {
    throw new Error(`runtime quest manifest commit failed: ${after.errors.join("; ")}`);
  }
  const result = {
    schema_version: "loopship.runtime.commit-quest-state/v1",
    wtree,
    committed: !before.ok,
  };
  return result;
}

function gitCurrentBranch(cwd: string): string | null {
  const proc = runCommand("git", ["branch", "--show-current"], {
    cwd,
    timeoutMs: 15_000,
  });
  if (proc.status !== 0) return null;
  return proc.stdout.trim() || null;
}

function gitWorktreeDirtyEntries(path: string): string[] {
  const cwd = path.trim();
  if (!cwd || !existsSync(cwd)) return [];
  const probe = runCommand("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    timeoutMs: 15_000,
  });
  if (probe.status !== 0 || probe.stdout.trim() !== "true") {
    throw new Error(
      `cannot inspect Git worktree ${cwd}: ${probe.stderr || probe.stdout || "git rev-parse failed"}`,
    );
  }
  const status = runCommand(
    "git",
    ["status", "--short", "--untracked-files=all"],
    {
      cwd,
      timeoutMs: 15_000,
    },
  );
  if (status.status !== 0) {
    throw new Error(
      `cannot inspect Git worktree ${cwd}: ${status.stderr || status.stdout || "git status failed"}`,
    );
  }
  return status.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function dirtyEntryPath(entry: string): string {
  return entry.replace(/^[A-Z?!]{1,2}\s+/, "").trim();
}

function isIgnorableOperationalDirtyPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized === ".codex/hooks.json" ||
    normalized === ".gemini/settings.json" ||
    normalized === ".github/hooks/loopship.json" ||
    normalized === ".github/hooks" ||
    normalized.startsWith(".loopship/runtime/") ||
    normalized === ".loopship/cache" ||
    normalized.startsWith(".loopship/cache/") ||
    normalized === ".loopship/data" ||
    normalized.startsWith(".loopship/data/") ||
    normalized === ".loopship/catalog.db" ||
    normalized === ".loopship/catalog.db-shm" ||
    normalized === ".loopship/catalog.db-wal" ||
    normalized.startsWith("worktrees/")
  );
}

function isDurableLoopshipDirtyPath(path: string): boolean {
  return path.replace(/\\/g, "/").startsWith(".loopship/");
}

function nonLoopshipGitDirtyEntries(path: string): string[] {
  return gitWorktreeDirtyEntries(path).filter((entry) => {
    const dirtyPath = dirtyEntryPath(entry);
    return (
      !isIgnorableOperationalDirtyPath(dirtyPath) &&
      !isDurableLoopshipDirtyPath(dirtyPath)
    );
  });
}

function nonOperationalGitDirtyEntries(path: string): string[] {
  return gitWorktreeDirtyEntries(path).filter(
    (entry) => !isIgnorableOperationalDirtyPath(dirtyEntryPath(entry)),
  );
}

function landingTargetDirtyEntries(path: string): string[] {
  return nonOperationalGitDirtyEntries(path).filter(
    (entry) =>
      dirtyEntryPath(entry) !== ".loopship/.gitignore" ||
      !entry.trimStart().startsWith("?? "),
  );
}

function durableLoopshipStagePaths(cwd: string): string[] {
  const candidates = [
    ".loopship/.gitignore",
    ".loopship/system.yaml",
    ".loopship/signature.yaml",
    ".loopship/docs",
  ];
  const tracked = runCommand("git", ["ls-files", "--", ...candidates], {
    cwd,
    timeoutMs: 15_000,
  });
  const trackedPaths =
    tracked.status === 0
      ? tracked.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
  const trackedSet = new Set(trackedPaths);
  const existingPaths = candidates.filter((path) => {
    if (!existsSync(resolve(cwd, path))) return false;
    if (trackedSet.has(path)) return true;
    const ignored = runCommand("git", ["check-ignore", "--quiet", "--", path], {
      cwd,
      timeoutMs: 15_000,
    });
    return ignored.status !== 0;
  });
  return Array.from(new Set([...existingPaths, ...trackedPaths]));
}

function commitDurableLoopshipState(cwd: string, message: string): string | null {
  if (!existsSync(resolve(cwd, ".loopship"))) return null;
  const durablePathspec = durableLoopshipStagePaths(cwd);
  if (!durablePathspec.length) return null;
  const add = runCommand("git", ["add", "-A", "--", ...durablePathspec], {
    cwd,
    timeoutMs: 30_000,
  });
  if (add.status !== 0) {
    throw new Error(add.stderr || add.stdout || "failed to stage .loopship state");
  }
  const diff = runCommand(
    "git",
    ["diff", "--cached", "--quiet", "--", ...durablePathspec],
    {
    cwd,
    timeoutMs: 15_000,
    },
  );
  if (diff.status === 0) return null;
  if (diff.status !== 1) {
    throw new Error(diff.stderr || diff.stdout || "failed to inspect staged .loopship state");
  }
  const commit = runCommand(
    "git",
    ["commit", "--only", "-m", message, "--", ...durablePathspec],
    {
    cwd,
    timeoutMs: 60_000,
    },
  );
  if (commit.status !== 0) {
    throw new Error(commit.stderr || commit.stdout || "failed to commit .loopship state");
  }
  return gitRevParse(cwd, "HEAD");
}

function gitIsAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  const proc = runCommand(
    "git",
    ["merge-base", "--is-ancestor", "--end-of-options", ancestor, descendant],
    {
      cwd,
      timeoutMs: 15_000,
    },
  );
  return proc.status === 0;
}

function assertNoTrackedWorktreePaths(repo: string): void {
  const trackedWorktreePaths = runCommand(
    "git",
    ["ls-files", "--", "worktrees"],
    { cwd: repo, timeoutMs: 15_000 },
  );
  if (trackedWorktreePaths.status !== 0) return;
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

function assertLandingPreflight(input: {
  repo: string;
  state: Record<string, unknown>;
}): void {
  const tasks = Array.isArray(input.state.tasks) ? input.state.tasks : [];
  const unmerged = tasks.filter(
    (task) =>
      isPlainObject(task) &&
      CHILD_DONE_STATUSES.has(String(task.status ?? "")) &&
      !String(task.merge_commit ?? "").trim(),
  );
  if (unmerged.length) {
    throw new Error(
      `cannot land while child tasks are missing merge_commit: ${unmerged.map((task) => String((task as Record<string, unknown>).id ?? "")).join(", ")}`,
    );
  }
  const coordinatorWorktree = String(input.state.coordinator_worktree ?? "");
  const coordinatorBranch = assertValidGitBranchRef(
    String(input.state.coordinator_branch ?? ""),
    "coordinator branch",
  );
  if (
    !coordinatorWorktree ||
    !existsSync(coordinatorWorktree) ||
    (resolve(coordinatorWorktree) !== resolve(input.repo) &&
      !isInsideRepoWorktrees(input.repo, coordinatorWorktree))
  ) {
    throw new Error(
      `coordinator worktree must be the repository or a canonical task worktree: ${coordinatorWorktree || "(empty)"}`,
    );
  }
  const registeredCoordinator = parseGitWorktrees(input.repo).find(
    (entry) => entry.branch === coordinatorBranch,
  );
  if (
    !registeredCoordinator ||
    resolve(registeredCoordinator.worktree) !== resolve(coordinatorWorktree)
  ) {
    throw new Error(
      `coordinator branch ${coordinatorBranch} is not checked out at ${coordinatorWorktree}`,
    );
  }
  const dirtyCoordinatorEntries = nonLoopshipGitDirtyEntries(coordinatorWorktree);
  if (dirtyCoordinatorEntries.length) {
    throw new Error(
      `cannot land while coordinator worktree has uncommitted changes: ${dirtyCoordinatorEntries.slice(0, 5).join(", ")}`,
    );
  }
  assertNoTrackedWorktreePaths(input.repo);
}

function gitMergeIntoTarget(input: {
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  targetWorktree: string;
}): Record<string, unknown> {
  input.sourceBranch = assertValidGitBranchRef(input.sourceBranch, "source branch");
  input.targetBranch = assertValidGitBranchRef(input.targetBranch, "target branch");
  const sourceWorktree = parseGitWorktrees(input.repo).find(
    (entry) => entry.branch === input.sourceBranch,
  )?.worktree;
  if (sourceWorktree) {
    commitDurableLoopshipState(
      sourceWorktree,
      `chore(loopship): record ${input.sourceBranch} durable state`,
    );
  }
  const existingTargetWorktree = parseGitWorktrees(input.repo).find(
    (entry) => entry.branch === input.targetBranch,
  );
  if (existingTargetWorktree) {
    const existingPath = resolve(existingTargetWorktree.worktree);
    const requestedPath = resolve(input.targetWorktree);
    const defaultPath = landingTargetWorktreePath(input.repo, input.targetBranch);
    if (
      existingPath !== resolve(input.repo) &&
      !isInsideRepoWorktrees(input.repo, existingPath)
    ) {
      throw new Error(
        `landing target branch is checked out outside the repository worktrees: ${existingPath}`,
      );
    }
    if (existingPath !== requestedPath && requestedPath !== defaultPath) {
      throw new Error(
        `landing target worktree ${requestedPath} does not match the checked-out branch workspace ${existingPath}`,
      );
    }
  }
  const workspace = existingTargetWorktree
    ? {
        branch_ref: input.targetBranch,
        worktree_path: existingTargetWorktree.worktree,
        mode: "git",
      }
    : ensureTaskWorkspace(
        input.repo,
        input.targetBranch,
        input.targetWorktree,
      );
  const currentBranch = gitCurrentBranch(workspace.worktree_path);
  if (currentBranch !== input.targetBranch) {
    throw new Error(
      `landing target worktree ${workspace.worktree_path} is on ${currentBranch || "unknown"} instead of ${input.targetBranch}`,
    );
  }
  const dirtyTargetEntries = landingTargetDirtyEntries(workspace.worktree_path);
  if (dirtyTargetEntries.length) {
    throw new Error(
      `cannot merge into dirty landing target worktree ${workspace.worktree_path}: ${dirtyTargetEntries.slice(0, 5).join(", ")}`,
    );
  }
  const sourceCommit = gitRevParse(input.repo, input.sourceBranch);
  const targetCommit = gitRevParse(input.repo, input.targetBranch);
  if (sourceCommit === targetCommit) {
    return {
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
      target_worktree: workspace.worktree_path,
      landed_commit: sourceCommit,
      strategy: "already-up-to-date",
    };
  }
  const ffOnly = gitIsAncestor(input.repo, targetCommit, sourceCommit);
  removeUntrackedLoopshipGitignoreConflict(
    workspace.worktree_path,
    input.sourceBranch,
  );
  const mergeArgs = ffOnly
    ? ["merge", "--ff-only", input.sourceBranch]
    : ["merge", "--no-ff", "--no-edit", input.sourceBranch];
  const merge = runCommand("git", mergeArgs, {
    cwd: workspace.worktree_path,
    timeoutMs: 60_000,
  });
  if (merge.status !== 0) {
    throw new Error(
      merge.stderr ||
        merge.stdout ||
        `failed to merge ${input.sourceBranch} into ${input.targetBranch}`,
    );
  }
  const dirtyAfterMerge = landingTargetDirtyEntries(workspace.worktree_path);
  if (dirtyAfterMerge.length) {
    throw new Error(
      `landing target worktree ${workspace.worktree_path} is dirty after merge: ${dirtyAfterMerge.slice(0, 5).join(", ")}`,
    );
  }
  return {
    source_branch: input.sourceBranch,
    target_branch: input.targetBranch,
    target_worktree: workspace.worktree_path,
    landed_commit: gitRevParse(workspace.worktree_path, "HEAD"),
    strategy: ffOnly ? "fast-forward" : "merge-commit",
  };
}

type LandingCleanupCandidate = {
  source: string;
  branch: string;
  worktree: string;
};

type LandingCleanupSkipped = LandingCleanupCandidate & {
  reason: string;
  details?: string[];
};

function isInsideRepoWorktrees(repo: string, path: string): boolean {
  const base = resolve(repo, "worktrees");
  const target = resolve(path);
  if (dirname(target) !== base) return false;
  if (existsSync(base)) {
    try {
      if (realpathSync(base) !== resolve(realpathSync(repo), "worktrees")) return false;
    } catch {
      return false;
    }
  }
  if (existsSync(target)) {
    try {
      return dirname(realpathSync(target)) === realpathSync(base);
    } catch {
      return false;
    }
  }
  return true;
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function branchExists(repo: string, branch: string): boolean {
  return (
    runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repo,
      timeoutMs: 10_000,
    }).status === 0
  );
}

function branchIsMerged(repo: string, branch: string, targetBranch: string, landedCommit: string): boolean {
  if (!branchExists(repo, branch)) return false;
  if (targetBranch && gitIsAncestor(repo, branch, targetBranch)) return true;
  return Boolean(landedCommit && gitIsAncestor(repo, branch, landedCommit));
}

function cleanupCandidateKey(candidate: LandingCleanupCandidate): string {
  return `${candidate.branch}\n${resolve(candidate.worktree)}`;
}

function landedCleanupCandidates(state: Record<string, unknown>): LandingCleanupCandidate[] {
  const candidates: LandingCleanupCandidate[] = [];
  const coordinatorBranch = optionalString(state.coordinator_branch);
  const coordinatorWorktree = optionalString(state.coordinator_worktree);
  if (coordinatorBranch && coordinatorWorktree) {
    candidates.push({
      source: "coordinator",
      branch: coordinatorBranch,
      worktree: coordinatorWorktree,
    });
  }
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  for (const task of tasks) {
    if (!isPlainObject(task)) continue;
    const status = optionalString(task.status);
    if (status && !CHILD_DONE_STATUSES.has(status)) continue;
    const branch = optionalString(task.branch_ref);
    const worktree = optionalString(task.worktree_path);
    if (!branch || !worktree) continue;
    candidates.push({
      source: `task:${optionalString(task.id) || optionalString(task.task_id) || branch}`,
      branch,
      worktree,
    });
  }
  const seen = new Set<string>();
  const unique = candidates.filter((candidate) => {
    const key = cleanupCandidateKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.filter((candidate) => candidate.source !== "coordinator").concat(
    unique.filter((candidate) => candidate.source === "coordinator"),
  );
}

export function cleanupLandedWorktrees(input: {
  repo: string;
  wtree: string;
  dryRun?: boolean;
}): Record<string, unknown> {
  const repo = resolve(requireString(input.repo, "repo"));
  const wtree = requireString(input.wtree, "wtree");
  const files = questFiles(repo, wtree);
  if (!existsSync(files.tasks)) {
    throw new Error(`missing Loopship quest state for ${wtree}`);
  }
  const state = parseTasksYaml(readText(files.tasks)) as Record<string, unknown>;
  const targetBranch = optionalString(state.landing_target_branch) || "main";
  const targetWorktree = optionalString(state.landing_target_worktree);
  const landedCommit = optionalString(state.landed_commit);
  const result = {
    schema_version: "loopship.landing.cleanup/v1",
    dry_run: input.dryRun === true,
    repo,
    wtree,
    target_branch: targetBranch,
    landed_commit: landedCommit,
    removed_worktrees: [] as string[],
    removed_branches: [] as string[],
    skipped: [] as LandingCleanupSkipped[],
  };
  if (!landedCommit) {
    result.skipped.push({
      source: "quest",
      branch: "",
      worktree: files.workspace_root,
      reason: "quest_not_landed",
    });
    return result;
  }
  const registeredWorktrees = new Map(
    parseGitWorktrees(repo).map((entry) => [resolve(entry.worktree), entry]),
  );
  for (const candidate of landedCleanupCandidates(state)) {
    const normalizedWorktree = resolve(candidate.worktree);
    if (candidate.branch === targetBranch) {
      result.skipped.push({ ...candidate, worktree: normalizedWorktree, reason: "target_branch" });
      continue;
    }
    if (targetWorktree && samePath(normalizedWorktree, targetWorktree)) {
      result.skipped.push({ ...candidate, worktree: normalizedWorktree, reason: "target_worktree" });
      continue;
    }
    if (!isInsideRepoWorktrees(repo, normalizedWorktree)) {
      result.skipped.push({ ...candidate, worktree: normalizedWorktree, reason: "outside_repo_worktrees" });
      continue;
    }
    if (!branchIsMerged(repo, candidate.branch, targetBranch, landedCommit)) {
      result.skipped.push({ ...candidate, worktree: normalizedWorktree, reason: "branch_not_merged" });
      continue;
    }
    const registered = registeredWorktrees.get(normalizedWorktree);
    if (registered && registered.branch !== candidate.branch) {
      result.skipped.push({
        ...candidate,
        worktree: normalizedWorktree,
        reason: "worktree_branch_mismatch",
        details: [
          `registered to ${registered.branch || "detached HEAD"}, not ${candidate.branch}`,
        ],
      });
      continue;
    }
    const dirty = existsSync(normalizedWorktree)
      ? nonOperationalGitDirtyEntries(normalizedWorktree)
      : [];
    if (dirty.length) {
      result.skipped.push({
        ...candidate,
        worktree: normalizedWorktree,
        reason: "dirty_worktree",
        details: dirty.slice(0, 5),
      });
      continue;
    }
    if (input.dryRun === true) {
      result.removed_worktrees.push(normalizedWorktree);
      result.removed_branches.push(candidate.branch);
      continue;
    }
    if (existsSync(normalizedWorktree) && registered) {
      const currentRegistration = parseGitWorktrees(repo).find(
        (entry) => resolve(entry.worktree) === normalizedWorktree,
      );
      if (!currentRegistration || currentRegistration.branch !== candidate.branch) {
        result.skipped.push({
          ...candidate,
          worktree: normalizedWorktree,
          reason: "worktree_branch_mismatch",
          details: [
            currentRegistration
              ? `registered to ${currentRegistration.branch || "detached HEAD"}, not ${candidate.branch}`
              : "worktree registration changed before removal",
          ],
        });
        continue;
      }
      const remove = runCommand("git", ["worktree", "remove", "--force", normalizedWorktree], {
        cwd: repo,
        timeoutMs: 30_000,
      });
      if (remove.status !== 0) {
        result.skipped.push({
          ...candidate,
          worktree: normalizedWorktree,
          reason: "worktree_remove_failed",
          details: [remove.stderr || remove.stdout || "git worktree remove failed"],
        });
        continue;
      }
      result.removed_worktrees.push(normalizedWorktree);
    }
    if (branchExists(repo, candidate.branch)) {
      const branchDelete = runCommand("git", ["branch", "-d", "--", candidate.branch], {
        cwd: repo,
        timeoutMs: 15_000,
      });
      if (branchDelete.status === 0) {
        result.removed_branches.push(candidate.branch);
      } else {
        result.skipped.push({
          ...candidate,
          worktree: normalizedWorktree,
          reason: "branch_delete_failed",
          details: [branchDelete.stderr || branchDelete.stdout || "git branch -d failed"],
        });
      }
    }
  }
  return result;
}

function gitBranchPathText(
  repo: string,
  branch: string,
  path: string,
): string | null {
  const result = runCommand("git", ["show", "--end-of-options", `${branch}:${path}`], {
    cwd: repo,
    timeoutMs: 15_000,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

function gitWorktreeTracksPath(worktreePath: string, path: string): boolean {
  const result = runCommand("git", ["ls-files", "--error-unmatch", "--", path], {
    cwd: worktreePath,
    timeoutMs: 15_000,
  });
  return result.status === 0;
}

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isGeneratedLoopshipGitignoreReplacement(
  targetText: string,
  sourceText: string,
): boolean {
  const targetLines = normalizeLines(targetText);
  const sourceLines = new Set(normalizeLines(sourceText));
  return (
    targetLines.length > 0 &&
    targetLines[0] === "# fastflow runtime data" &&
    targetLines.every((line) => sourceLines.has(line))
  );
}

function removeUntrackedLoopshipGitignoreConflict(
  targetWorktree: string,
  sourceBranch: string,
): void {
  const relativePath = ".loopship/.gitignore";
  const sourceText = gitBranchPathText(targetWorktree, sourceBranch, relativePath);
  if (sourceText === null) return;
  if (gitWorktreeTracksPath(targetWorktree, relativePath)) return;
  const fullPath = resolve(targetWorktree, relativePath);
  if (!existsSync(fullPath)) return;
  const targetText = readFileSync(fullPath, "utf8");
  if (!isGeneratedLoopshipGitignoreReplacement(targetText, sourceText)) {
    throw new Error(
      `cannot replace untracked landing target ${relativePath}; move or track it before landing`,
    );
  }
  rmSync(fullPath, { force: true });
}

function verifiedRecordedReceipt(input: {
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  targetWorktree: string;
  receipt: Record<string, unknown>;
}): Record<string, unknown> {
  input.sourceBranch = assertValidGitBranchRef(input.sourceBranch, "source branch");
  input.targetBranch = assertValidGitBranchRef(input.targetBranch, "target branch");
  const receiptTargetBranch = optionalString(input.receipt.target_branch);
  const receiptSourceBranch = optionalString(input.receipt.source_branch);
  if (receiptTargetBranch && receiptTargetBranch !== input.targetBranch) {
    throw new Error(
      `landing receipt target branch ${receiptTargetBranch} does not match ${input.targetBranch}`,
    );
  }
  if (receiptSourceBranch && receiptSourceBranch !== input.sourceBranch) {
    throw new Error(
      `landing receipt source branch ${receiptSourceBranch} does not match ${input.sourceBranch}`,
    );
  }
  const targetBranch = input.targetBranch;
  const sourceBranch = input.sourceBranch;
  const receiptTargetWorktree = optionalString(input.receipt.target_worktree);
  const existingTargetWorktree = parseGitWorktrees(input.repo).find(
    (entry) => entry.branch === targetBranch,
  )?.worktree;
  if (
    receiptTargetWorktree &&
    existingTargetWorktree &&
    resolve(receiptTargetWorktree) !== resolve(existingTargetWorktree)
  ) {
    throw new Error(
      `landing receipt target worktree ${receiptTargetWorktree} does not match ${existingTargetWorktree}`,
    );
  }
  const targetWorktree =
    receiptTargetWorktree || existingTargetWorktree || input.targetWorktree;
  if (
    targetWorktree &&
    resolve(targetWorktree) !== resolve(input.repo) &&
    !isInsideRepoWorktrees(input.repo, targetWorktree)
  ) {
    throw new Error(`landing receipt target worktree is outside the repository: ${targetWorktree}`);
  }
  const landedCommit = gitRevParse(
    input.repo,
    requireString(input.receipt.landed_commit, "receipt.landed_commit"),
  );
  if (sourceBranch) {
    const sourceCommit = gitRevParse(input.repo, sourceBranch);
    if (!gitIsAncestor(input.repo, sourceCommit, landedCommit)) {
      throw new Error(
        `landing receipt commit ${landedCommit} does not contain source branch ${sourceBranch}`,
      );
    }
  }
  if (targetBranch) {
    gitRevParse(input.repo, targetBranch);
    if (!gitIsAncestor(input.repo, landedCommit, targetBranch)) {
      throw new Error(
        `landing receipt commit ${landedCommit} is not present in target branch ${targetBranch}`,
      );
    }
  }
  if (targetWorktree && existsSync(targetWorktree)) {
    const dirtyTargetEntries = landingTargetDirtyEntries(targetWorktree);
    if (dirtyTargetEntries.length) {
      throw new Error(
        `cannot record landing receipt for dirty target worktree ${targetWorktree}: ${dirtyTargetEntries.slice(0, 5).join(", ")}`,
      );
    }
  }
  return {
    source_branch: sourceBranch,
    target_branch: targetBranch,
    target_worktree: targetWorktree,
    landed_commit: landedCommit,
    strategy: optionalString(input.receipt.strategy) || "recorded",
  };
}

function persistLandingMergeReceipt(
  files: ReturnType<typeof questFiles>,
  requestId: string,
  receipt: Record<string, unknown>,
): Record<string, unknown> {
  const existing = readJsonlRecords(files.events).find(
    (record) =>
      record.event === "landing_merge_recorded" &&
      record.request_id === requestId,
  );
  if (existing) {
    if (!isPlainObject(existing.payload) || !nativeValuesMatch(existing.payload, receipt)) {
      throw new Error(`landing merge receipt conflicts with request ${requestId}`);
    }
    return existing.payload;
  }
  appendJsonl(files.events, {
    event: "landing_merge_recorded",
    quest_id: files.wtree,
    request_id: requestId,
    payload: receipt,
  });
  return receipt;
}

function executeLandingApplyOutcome(body: Record<string, unknown>): Record<string, unknown> {
  const repo = requireString(body.repo, "repo");
  const wtree = requireString(body.wtree, "wtree");
  const files = questFiles(repo, wtree);
  const requestId = optionalString(body.request_id) || `fastflow-landing-${Date.now().toString(36)}`;
  if (!existsSync(files.tasks)) {
    const legacyTasks = resolve(repo, LOOPSHIP_RUNTIME_NAMESPACE, "tasks.yaml");
    if (existsSync(legacyTasks)) {
      throw legacyExecutionUnsupported(
        `repository-root quest state at ${legacyTasks} cannot be interpreted; resubmit ${wtree} as a new Native execution`,
      );
    }
    throw new Error(`missing canonical Loopship Native quest state for ${wtree}`);
  }
  const state = parseTasksYaml(readText(files.tasks)) as Record<string, unknown>;
  const sourceBranch = optionalString(body.source_branch) || String(state.coordinator_branch || "");
  const targetBranch =
    optionalString(body.target_branch) || String(state.landing_target_branch || "main");
  const targetWorktree =
    optionalString(body.target_worktree) ||
    String(state.landing_target_worktree || landingTargetWorktreePath(repo, targetBranch));
  const receipt = isPlainObject(body.receipt) ? body.receipt : {};
  const status = optionalString(body.status) || "landed";
  const nextStage = optionalString(body.next_stage);
  if (!["landed", "blocked"].includes(status)) {
    throw new Error("landing.apply-outcome status must be landed or blocked");
  }
  if (body.dry_run === true) {
    return {
      schema_version: "loopship.landing.apply/v1",
      dry_run: true,
      status,
      source_branch: sourceBranch,
      target_branch: targetBranch,
      target_worktree: targetWorktree,
    };
  }
  if (status === "blocked") {
    const blockedStage = nextStage || optionalString(state.stage);
    if (!blockedStage) {
      throw new Error("landing.apply-outcome blocked status requires next_stage or current state.stage");
    }
    appendJsonl(files.events, {
      event: "landing_submitted",
      quest_id: files.wtree,
      stage: blockedStage,
      request_id: requestId,
      payload: { status, summary: optionalString(body.summary) },
    });
    updateQuestStage(files, blockedStage, requestId, "loopship fastflow afn landing.apply-outcome");
    writeQuestManifest(files, requestId, "loopship fastflow afn landing.apply-outcome");
    return {
      schema_version: "loopship.landing.apply/v1",
      dry_run: false,
      status,
      source_branch: sourceBranch,
      target_branch: targetBranch,
      target_worktree: targetWorktree,
      summary: optionalString(body.summary),
      next_stage: blockedStage,
    };
  }
  if (!nextStage) {
    throw new Error("landing.apply-outcome landed status requires next_stage");
  }
  assertLandingPreflight({ repo, state });
  if (!sourceBranch) {
    throw new Error("landing.apply-outcome requires source_branch or state.coordinator_branch");
  }
  const landingReceipt = optionalString(receipt.landed_commit)
    ? verifiedRecordedReceipt({
        repo,
        sourceBranch,
        targetBranch,
        targetWorktree,
        receipt,
      })
    : gitMergeIntoTarget({
        repo,
        sourceBranch,
        targetBranch,
        targetWorktree,
      });
  persistLandingMergeReceipt(files, requestId, landingReceipt);
  applyLandingReceipt(files, state, {
    parent_wtree: String(state.parent_wtree || ""),
    landing_target_branch: String(landingReceipt.target_branch),
    landing_target_worktree: String(landingReceipt.target_worktree),
    landed_commit: String(landingReceipt.landed_commit),
    landing_strategy: String(landingReceipt.strategy),
  });
  appendJsonl(files.events, {
    event: "landing_applied",
    quest_id: files.wtree,
    request_id: requestId,
    payload: landingReceipt,
  });
  updateQuestStage(files, nextStage, requestId, "loopship fastflow afn landing.apply-outcome");
  writeQuestManifest(files, requestId, "loopship fastflow afn landing.apply-outcome");
  return {
    schema_version: "loopship.landing.apply/v1",
    dry_run: false,
    status,
    summary: optionalString(body.summary),
    next_stage: nextStage,
    ...landingReceipt,
  };
}

function executeLandingCleanupLandedWorktrees(body: Record<string, unknown>): Record<string, unknown> {
  return cleanupLandedWorktrees({
    repo: requireString(body.repo, "repo"),
    wtree: requireString(body.wtree, "wtree"),
    dryRun: body.dry_run === true,
  });
}

type LoopshipAfnHandler = (
  body: Record<string, unknown>,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

type LoopshipAfnEffectReceipt = {
  schemaVersion: "loopship.afn-effect-receipt/v1";
  status: "started" | "completed";
  callId: string;
  effectKey: string;
  inputDigest: string;
  requestId: string | null;
  preparedOutput?: Record<string, unknown>;
  output?: Record<string, unknown>;
};

const LOOPSHIP_AFN_EFFECT_LOCK_WAIT_MS = 30_000;
const LOOPSHIP_AFN_EFFECT_BUSY = "loopship-afn-effect-busy";

async function withLoopshipLandingMutationLock<T>(
  repo: string,
  operation: () => Promise<T>,
): Promise<T> {
  const repositoryRoot = canonicalRepositoryRoot(repo, "repo");
  const path = resolve(
    repositoryRoot,
    LOOPSHIP_RUNTIME_NAMESPACE,
    "landing-mutation.lock.sqlite",
  );
  let release: (() => void) | null = null;
  try {
    release = acquireCrashSafeFileLock(path, LOOPSHIP_AFN_EFFECT_LOCK_WAIT_MS);
  } catch (error) {
    if ((error as { code?: string }).code === "loopship_file_lock_busy") {
      throw Object.assign(
        new Error(`Loopship landing mutation is already in progress for ${repositoryRoot}`),
        { code: LOOPSHIP_AFN_EFFECT_BUSY },
      );
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    release();
  }
}

function mutatesLoopshipLandingResource(callId: string): boolean {
  return (
    callId === LOOPSHIP_AFN_CALLS.landingApplyOutcome ||
    callId === LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees
  );
}

async function withLoopshipAfnEffectLock<T>(
  receiptPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const path = `${receiptPath}.lock.sqlite`;
  let release: (() => void) | null = null;
  try {
    release = acquireCrashSafeFileLock(path, LOOPSHIP_AFN_EFFECT_LOCK_WAIT_MS);
  } catch (error) {
    if ((error as { code?: string }).code === "loopship_file_lock_busy") {
      throw Object.assign(
        new Error(`Loopship AFN effect ${basename(receiptPath)} is already in progress`),
        { code: LOOPSHIP_AFN_EFFECT_BUSY },
      );
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    release();
  }
}

function bindNativeEffectRequestId(
  descriptor: CallDescriptor,
  body: Record<string, unknown>,
  effectKey: string,
): Record<string, unknown> {
  const schema = descriptor.inputs.schema as Record<string, unknown>;
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  if (!("request_id" in properties) || optionalString(body.request_id)) return body;
  return {
    ...body,
    request_id: `native-effect-${sha256(effectKey).slice("sha256:".length)}`,
  };
}

function descriptorHasDurableEffects(descriptor: CallDescriptor): boolean {
  const effects = descriptor.metadata?.effects;
  return (
    Array.isArray(effects) &&
    effects.some((effect) => typeof effect === "string" && !effect.endsWith(".read"))
  );
}

function readLoopshipAfnEffectReceipt(path: string): LoopshipAfnEffectReceipt | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isPlainObject(parsed) ||
    parsed.schemaVersion !== "loopship.afn-effect-receipt/v1" ||
    !["started", "completed"].includes(String(parsed.status)) ||
    (parsed.preparedOutput !== undefined && !isPlainObject(parsed.preparedOutput)) ||
    (parsed.output !== undefined && !isPlainObject(parsed.output))
  ) {
    throw new Error(`invalid Loopship AFN effect receipt: ${path}`);
  }
  return parsed as LoopshipAfnEffectReceipt;
}

export function cleanupCompletedNativeWorkspaceResidue(input: {
  repo: string;
  workspaceRoot: string;
}): boolean {
  const repo = resolve(requireString(input.repo, "repo"));
  const workspaceRoot = resolve(requireString(input.workspaceRoot, "workspaceRoot"));
  if (!existsSync(workspaceRoot) || !isInsideRepoWorktrees(repo, workspaceRoot)) {
    return false;
  }
  try {
    if (realpathSync(workspaceRoot) !== workspaceRoot) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const registered = parseGitWorktrees(repo).some(
    (entry) => resolve(entry.worktree) === workspaceRoot,
  );
  if (
    registered ||
    existsSync(resolve(workspaceRoot, ".git")) ||
    existsSync(resolve(workspaceRoot, LOOPSHIP_RUNTIME_NAMESPACE, "tasks.yaml"))
  ) {
    return false;
  }
  const receiptRoot = resolve(repo, LOOPSHIP_RUNTIME_NAMESPACE, "afn-effects");
  if (!existsSync(receiptRoot)) return false;
  const cleanupWasCompleted = readdirSync(receiptRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .some((entry) => {
      let receipt: LoopshipAfnEffectReceipt | null = null;
      try {
        receipt = readLoopshipAfnEffectReceipt(resolve(receiptRoot, entry.name));
      } catch {
        return false;
      }
      if (
        receipt?.status !== "completed" ||
        receipt.callId !== LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees
      ) {
        return false;
      }
      const removed = receipt.output?.removed_worktrees;
      return (
        Array.isArray(removed) &&
        removed.some(
          (path) => typeof path === "string" && resolve(path) === workspaceRoot,
        )
      );
  });
  if (!cleanupWasCompleted) return false;
  const residue = collectAllowlistedNativeWorkspaceResidue(workspaceRoot);
  if (!residue) return false;

  // The Native cleanup effect already removed the registered worktree. Fastflow
  // may recreate its state directory while finalizing the enclosing workflow;
  // remove only exact generated entries, then empty directories. If anything is
  // added concurrently, a non-recursive directory removal fails closed.
  if (
    parseGitWorktrees(repo).some((entry) => resolve(entry.worktree) === workspaceRoot) ||
    existsSync(resolve(workspaceRoot, ".git")) ||
    existsSync(resolve(workspaceRoot, LOOPSHIP_RUNTIME_NAMESPACE, "tasks.yaml"))
  ) {
    return false;
  }
  for (const path of residue.files) {
    try {
      rmSync(path, { force: true });
    } catch {
      return false;
    }
  }
  for (const directory of residue.directories.sort((left, right) => right.length - left.length)) {
    try {
      rmdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
  }
  try {
    rmdirSync(workspaceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  return !existsSync(workspaceRoot);
}

const FASTFLOW_RUNTIME_GITIGNORE =
  "# fastflow runtime data\ncache/\ndata/\ncatalog.db\ncatalog.db-shm\ncatalog.db-wal\n";

function collectAllowlistedNativeWorkspaceResidue(
  workspaceRoot: string,
): { files: string[]; directories: string[] } | null {
  const allowedDirectories = new Set([
    ".loopship",
    ".loopship/data",
    ".loopship/data/json",
    ".loopship/data/projections",
    ".loopship/runtime",
    ".loopship/runtime/native-executions",
    ".loopship/workflows",
  ]);
  const allowedFiles = new Set([
    ".loopship/catalog.db",
    ".loopship/catalog.db-journal",
    ".loopship/catalog.db-shm",
    ".loopship/catalog.db-wal",
    ".loopship/data/primary.sqlite",
    ".loopship/data/primary.sqlite-journal",
    ".loopship/data/primary.sqlite-shm",
    ".loopship/data/primary.sqlite-wal",
    ".loopship/runtime/native-execution.json",
    ".loopship/runtime/native-execution.lock.sqlite",
    ".loopship/runtime/native-execution.lock.sqlite-journal",
    ".loopship/runtime/quest-init.lock.sqlite",
    ".loopship/runtime/quest-init.lock.sqlite-journal",
  ]);
  const files: string[] = [];
  const directories: string[] = [];
  const allowedFile = (relativePath: string, absolutePath: string): boolean => {
    if (relativePath === ".loopship/.gitignore") {
      return readFileSync(absolutePath, "utf8") === FASTFLOW_RUNTIME_GITIGNORE;
    }
    return (
      allowedFiles.has(relativePath) ||
      /^\.loopship\/runtime\/native-executions\/loopship-[0-9a-f]{64}\.json$/u.test(
        relativePath,
      )
    );
  };
  const visit = (directory: string): boolean => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = resolve(directory, entry.name);
      if (!existsSync(entryPath)) continue;
      const relativePath = normalizePackagePath(relative(workspaceRoot, entryPath));
      if (entry.isDirectory()) {
        if (!allowedDirectories.has(relativePath)) return false;
        directories.push(entryPath);
        if (!visit(entryPath)) return false;
      } else if (entry.isSymbolicLink() && relativePath === ".loopship/cache") {
        files.push(entryPath);
      } else if (entry.isFile()) {
        try {
          if (!allowedFile(relativePath, entryPath)) return false;
          files.push(entryPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      } else {
        return false;
      }
    }
    return true;
  };
  return visit(workspaceRoot) ? { files, directories } : null;
}

function writeLoopshipAfnEffectReceipt(
  path: string,
  receipt: LoopshipAfnEffectReceipt,
): void {
  writeJsonAtomically(path, receipt);
}

function nativeValuesMatch(left: unknown, right: unknown): boolean {
  return (
    digestNativeContract(left as JsonValue) ===
    digestNativeContract(right as JsonValue)
  );
}

function recoverStartedSystemUpdate(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  const repo = resolve(requireString(body.repo, "repo"));
  const update = isPlainObject(body.update) ? body.update : null;
  if (!update) throw new Error("update must be an object");
  if (String(update.mode ?? "") === "no_change") {
    return {
      schema_version: "loopship.system.apply/v1",
      dry_run: false,
      touched: [],
    };
  }
  if (!isPlainObject(update.root)) return null;
  const systemPath = resolve(repo, ".loopship", "system.yaml");
  if (
    !existsSync(systemPath) ||
    !nativeValuesMatch(parseYaml(readFileSync(systemPath, "utf8")), update.root)
  ) {
    return null;
  }
  const resources = Array.isArray(update.root.resources)
    ? update.root.resources.filter(isPlainObject)
    : [];
  const locations = new Map(
    resources.map((resource) => [
      `resource:${optionalString(resource.id)}`,
      optionalString(resource.location),
    ]),
  );
  const touched = [systemPath];
  const externalDocs = Array.isArray(update.external_docs)
    ? update.external_docs.filter(isPlainObject)
    : [];
  for (const externalDoc of externalDocs) {
    const resourceRef = requireString(externalDoc.resource_ref, "update.external_docs.resource_ref");
    const location = requireString(
      locations.get(resourceRef),
      `update resource location for ${resourceRef}`,
    );
    const fullPath = resolve(repo, location);
    const relativePath = relative(repo, fullPath);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`system update resource escapes repository: ${location}`);
    }
    if (externalDoc.op === "delete") {
      if (existsSync(fullPath)) return null;
      continue;
    }
    if (
      !isPlainObject(externalDoc.document) ||
      !existsSync(fullPath) ||
      !nativeValuesMatch(
        parseYaml(readFileSync(fullPath, "utf8")),
        externalDoc.document,
      )
    ) {
      return null;
    }
    touched.push(fullPath);
  }
  const signaturePath = resolve(repo, ".loopship", "signature.yaml");
  if (!verifyRootManifest(repo).ok) return null;
  touched.push(signaturePath);
  return {
    schema_version: "loopship.system.apply/v1",
    dry_run: false,
    touched,
  };
}

function readJsonlRecords(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(isPlainObject);
}

function recoverRecordedLandingOutcome(input: {
  body: Record<string, unknown>;
  requestId: string;
}): Record<string, unknown> | null {
  const repo = resolve(requireString(input.body.repo, "repo"));
  const wtree = assertCanonicalWtreeName(requireString(input.body.wtree, "wtree"));
  const files = questFiles(repo, wtree);
  if (!existsSync(files.tasks)) {
    const legacyTasks = resolve(repo, LOOPSHIP_RUNTIME_NAMESPACE, "tasks.yaml");
    if (existsSync(legacyTasks)) {
      throw legacyExecutionUnsupported(
        `repository-root quest state at ${legacyTasks} cannot recover ${wtree}; resubmit it as a new Native execution`,
      );
    }
    return null;
  }
  const tasksPath = files.tasks;
  const eventsPath = files.events;
  const records = readJsonlRecords(eventsPath);
  const status = optionalString(input.body.status) || "landed";
  const eventName = status === "blocked" ? "landing_submitted" : "landing_applied";
  const eventIndex = records.findIndex(
    (record) => record.event === eventName && record.request_id === input.requestId,
  );
  if (eventIndex < 0) {
    if (status !== "landed") return null;
    const mergeRecord = records.find(
      (record) =>
        record.event === "landing_merge_recorded" &&
        record.request_id === input.requestId,
    );
    if (mergeRecord) {
      if (!isPlainObject(mergeRecord.payload)) {
        throw new Error(`landing merge receipt ${input.requestId} has no payload`);
      }
      return executeLandingApplyOutcome({
        ...input.body,
        receipt: mergeRecord.payload,
      });
    }
    const state = parseTasksYaml(readText(tasksPath)) as Record<string, unknown>;
    const sourceBranch =
      optionalString(input.body.source_branch) || optionalString(state.coordinator_branch);
    const targetBranch =
      optionalString(input.body.target_branch) ||
      optionalString(state.landing_target_branch) ||
      "main";
    if (!sourceBranch || !gitIsAncestor(repo, sourceBranch, targetBranch)) return null;
    throw new Error(
      `landing recovery refuses an ambiguous merged branch without the durable receipt for ${input.requestId}`,
    );
  }

  const event = records[eventIndex]!;
  let state = parseTasksYaml(readText(tasksPath)) as Record<string, unknown>;
  const nextStage =
    optionalString(input.body.next_stage) ||
    (status === "blocked" ? optionalString(state.stage) : "");
  if (!nextStage) {
    throw new Error(`landing ${status} recovery requires next_stage`);
  }
  if (optionalString(state.stage) !== nextStage) {
    updateQuestStage(
      files,
      nextStage,
      input.requestId,
      "loopship fastflow afn landing.apply-outcome recovery",
    );
  } else {
    const stageWasRecorded = records.slice(eventIndex + 1).some(
      (record) => record.event === "stage_changed" && record.stage === nextStage,
    );
    if (!stageWasRecorded) {
      appendJsonl(files.events, {
        event: "stage_changed",
        quest_id: optionalString(state.quest_id) || files.wtree,
        stage: nextStage,
      });
    }
    if (!stageWasRecorded || !verifyQuestManifest(files).ok) {
      writeQuestManifest(
        files,
        input.requestId,
        "loopship fastflow afn landing.apply-outcome recovery",
      );
    }
  }
  state = parseTasksYaml(readText(files.tasks)) as Record<string, unknown>;
  const verification = verifyQuestManifest(files);
  if (!verification.ok) {
    throw new Error(`landing recovery could not restore quest manifest: ${verification.errors.join("; ")}`);
  }

  const sourceBranch =
    optionalString(input.body.source_branch) || optionalString(state.coordinator_branch);
  const targetBranch =
    optionalString(input.body.target_branch) ||
    optionalString(state.landing_target_branch) ||
    "main";
  const targetWorktree =
    optionalString(input.body.target_worktree) ||
    optionalString(state.landing_target_worktree) ||
    landingTargetWorktreePath(repo, targetBranch);
  if (status === "blocked") {
    return {
      schema_version: "loopship.landing.apply/v1",
      dry_run: false,
      status,
      source_branch: sourceBranch,
      target_branch: targetBranch,
      target_worktree: targetWorktree,
      summary: optionalString(input.body.summary),
      next_stage: nextStage,
    };
  }
  const landingReceipt = isPlainObject(event.payload) ? event.payload : null;
  if (!landingReceipt) {
    throw new Error(`landing recovery event ${input.requestId} has no receipt payload`);
  }
  return {
    schema_version: "loopship.landing.apply/v1",
    dry_run: false,
    status,
    summary: optionalString(input.body.summary),
    next_stage: nextStage,
    ...landingReceipt,
  };
}

function cleanupRecoverySnapshot(body: Record<string, unknown>): Record<string, unknown> {
  const dryRun = cleanupLandedWorktrees({
    repo: requireString(body.repo, "repo"),
    wtree: requireString(body.wtree, "wtree"),
    dryRun: true,
  });
  return { ...dryRun, dry_run: false };
}

function executeCleanupRecoveryPlan(
  body: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  const repo = resolve(requireString(body.repo, "repo"));
  const wtree = assertCanonicalWtreeName(requireString(body.wtree, "wtree"));
  if (resolve(requireString(snapshot.repo, "cleanup snapshot repo")) !== repo) {
    throw new Error("cleanup recovery snapshot does not match its repository");
  }
  if (requireString(snapshot.wtree, "cleanup snapshot wtree") !== wtree) {
    throw new Error("cleanup recovery snapshot does not match its quest");
  }
  const worktrees = Array.isArray(snapshot.removed_worktrees)
    ? snapshot.removed_worktrees.map((path) => requireString(path, "cleanup snapshot worktree"))
    : [];
  const branches = Array.isArray(snapshot.removed_branches)
    ? snapshot.removed_branches.map((branch) =>
        assertValidGitBranchRef(requireString(branch, "cleanup snapshot branch")),
      )
    : [];
  if (worktrees.length !== branches.length) {
    throw new Error("cleanup recovery snapshot has mismatched worktree and branch entries");
  }
  const targetBranch = optionalString(snapshot.target_branch) || "main";
  const landedCommit = optionalString(snapshot.landed_commit);
  for (let index = 0; index < worktrees.length; index += 1) {
    const worktree = resolve(worktrees[index]!);
    const branch = branches[index]!;
    if (!isInsideRepoWorktrees(repo, worktree)) {
      throw new Error(`cleanup recovery worktree is outside the repository: ${worktree}`);
    }
    const registered = parseGitWorktrees(repo).find(
      (entry) => resolve(entry.worktree) === worktree,
    );
    if (registered && registered.branch !== branch) {
      throw new Error(
        `cleanup recovery worktree ${worktree} is registered to ${registered.branch || "detached HEAD"}, not ${branch}`,
      );
    }
    if (registered) {
      const dirty = nonOperationalGitDirtyEntries(worktree);
      if (dirty.length) {
        throw new Error(
          `cleanup recovery refuses dirty worktree ${worktree}: ${dirty.slice(0, 5).join(", ")}`,
        );
      }
      const remove = runCommand("git", ["worktree", "remove", "--force", worktree], {
        cwd: repo,
        timeoutMs: 30_000,
      });
      if (remove.status !== 0) {
        throw new Error(remove.stderr || remove.stdout || `failed to remove ${worktree}`);
      }
    } else if (existsSync(worktree)) {
      throw new Error(
        `cleanup recovery refuses substituted unregistered workspace: ${worktree}`,
      );
    }
    if (branchExists(repo, branch)) {
      if (!branchIsMerged(repo, branch, targetBranch, landedCommit)) {
        throw new Error(`cleanup recovery refuses unmerged branch ${branch}`);
      }
      const removeBranch = runCommand("git", ["branch", "-d", "--", branch], {
        cwd: repo,
        timeoutMs: 15_000,
      });
      if (removeBranch.status !== 0) {
        throw new Error(
          removeBranch.stderr || removeBranch.stdout || `failed to remove branch ${branch}`,
        );
      }
    }
  }
  return clone(snapshot);
}

function recoverStartedLoopshipAfnEffect(input: {
  receipt: LoopshipAfnEffectReceipt;
  body: Record<string, unknown>;
}): Record<string, unknown> | null {
  if (input.receipt.callId === LOOPSHIP_AFN_CALLS.systemApplyUpdate) {
    return recoverStartedSystemUpdate(input.body);
  }
  if (input.receipt.callId === LOOPSHIP_AFN_CALLS.landingApplyOutcome) {
    const requestId = requireString(input.receipt.requestId, "landing effect requestId");
    return recoverRecordedLandingOutcome({ body: input.body, requestId });
  }
  if (input.receipt.callId === LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees) {
    if (!input.receipt.preparedOutput) {
      throw new Error(
        `cleanup effect ${input.receipt.effectKey} cannot be recovered without its durable snapshot`,
      );
    }
    return executeCleanupRecoveryPlan(input.body, input.receipt.preparedOutput);
  }
  return null;
}

async function executeLoopshipAfnEffect(input: {
  descriptor: CallDescriptor;
  invocation: { call: { callId: string }; effectKey: string };
  body: Record<string, unknown>;
  handler: LoopshipAfnHandler;
}): Promise<Record<string, unknown>> {
  if (
    !descriptorHasDurableEffects(input.descriptor) ||
    input.body.dry_run === true ||
    (input.invocation.call.callId === LOOPSHIP_AFN_CALLS.runtimeCommitQuestState &&
      input.body.as_check === true)
  ) {
    return input.handler(input.body);
  }
  const repo = requireString(input.body.repo, "repo");
  const receiptPath = resolve(
    repo,
    LOOPSHIP_RUNTIME_NAMESPACE,
    "afn-effects",
    `${sha256(input.invocation.effectKey).slice("sha256:".length)}.json`,
  );
  return withLoopshipAfnEffectLock(receiptPath, async () => {
    const executeEffect = async (): Promise<Record<string, unknown>> => {
      const inputDigest = digestNativeContract({
        callId: input.invocation.call.callId,
        body: input.body as unknown as JsonValue,
      });
      const expected = {
        callId: input.invocation.call.callId,
        effectKey: input.invocation.effectKey,
        inputDigest,
      };
      const existing = readLoopshipAfnEffectReceipt(receiptPath);
      if (
        existing &&
        (existing.callId !== expected.callId ||
          existing.effectKey !== expected.effectKey ||
          existing.inputDigest !== expected.inputDigest)
      ) {
        throw new Error(`Loopship AFN effect receipt conflicts with ${input.invocation.effectKey}`);
      }
      if (existing?.status === "completed") return clone(existing.output || {});
      if (existing?.status === "started") {
        const recovered = recoverStartedLoopshipAfnEffect({
          receipt: existing,
          body: input.body,
        });
        if (recovered) {
          writeLoopshipAfnEffectReceipt(receiptPath, {
            ...existing,
            status: "completed",
            output: recovered,
          });
          return recovered;
        }
      }
      const started: LoopshipAfnEffectReceipt = existing || {
        schemaVersion: "loopship.afn-effect-receipt/v1",
        status: "started",
        ...expected,
        requestId: optionalString(input.body.request_id) || null,
        ...(input.invocation.call.callId === LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees
          ? { preparedOutput: cleanupRecoverySnapshot(input.body) }
          : {}),
      };
      if (!existing) writeLoopshipAfnEffectReceipt(receiptPath, started);
      const output = await input.handler(input.body);
      writeLoopshipAfnEffectReceipt(receiptPath, {
        ...started,
        status: "completed",
        output,
      });
      return output;
    };
    return mutatesLoopshipLandingResource(input.invocation.call.callId)
      ? withLoopshipLandingMutationLock(repo, executeEffect)
      : executeEffect();
  });
}

function createLoopshipAfnHandlerRegistry(): ReadonlyMap<string, LoopshipAfnHandler> {
  return new Map<string, LoopshipAfnHandler>([
    [LOOPSHIP_AFN_CALLS.childPrepareWorktree, executeChildPrepare],
    [LOOPSHIP_AFN_CALLS.flowComposeTransitionResult, executeFlowComposeTransitionResult],
    [LOOPSHIP_AFN_CALLS.runtimeCommitQuestState, executeRuntimeCommitQuestState],
    [LOOPSHIP_AFN_CALLS.gitResolveCommit, executeGitResolveCommit],
    [LOOPSHIP_AFN_CALLS.systemApplyUpdate, executeSystemApplyUpdate],
    [LOOPSHIP_AFN_CALLS.landingApplyOutcome, executeLandingApplyOutcome],
    [LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees, executeLandingCleanupLandedWorktrees],
  ]);
}

export function createLoopshipFastflowAdapters(): Record<string, unknown> {
  const adapterIdentity = PACKAGE_JSON.name || "@omar391/loopship";
  const adapterVersion = PACKAGE_JSON.version || "0.0.0";
  const handlers = createLoopshipAfnHandlerRegistry();
  const implementationDigest = String(
    loopshipAfnImplementationEvidence(LOOPSHIP_AFN_DESCRIPTORS[0]?.call || "loopship.afn.service.step.unknown")
      .implementation_digest,
  );
  const afnDispatch = createAfnDispatchPort({
    routes: LOOPSHIP_AFN_DESCRIPTORS.map((descriptor) => ({
      callId: descriptor.call,
      contractDigest: digestCallContract(descriptor as unknown as JsonValue),
      implementationDigest,
      routeId: `loopship:local:${descriptor.call}`,
      async handler(invocation): Promise<ExecutionDecision> {
        try {
          const handler = handlers.get(invocation.call.callId);
          const descriptor = DESCRIPTOR_BY_CALL.get(invocation.call.callId);
          if (!handler || !descriptor) {
            throw new Error(`Loopship AFN '${invocation.call.callId}' has no normal handler.`);
          }
          if (!isPlainObject(invocation.input)) {
            throw new Error(`Loopship call '${invocation.call.callId}' requires object input.`);
          }
          const body = bindNativeEffectRequestId(
            descriptor,
            invocation.input,
            invocation.effectKey,
          );
          validateBodyAgainstDescriptor(descriptor, body);
          const output = await executeLoopshipAfnEffect({
            descriptor,
            invocation,
            body,
            handler,
          });
          return completedDecision({
            invocationId: invocation.invocationId,
            output: output as unknown as JsonValue,
          });
        } catch (error) {
          const retryable =
            error instanceof Error &&
            (error as Error & { code?: string }).code === LOOPSHIP_AFN_EFFECT_BUSY;
          return failedDecision({
            invocationId: invocation.invocationId,
            error: {
              code: retryable ? LOOPSHIP_AFN_EFFECT_BUSY : "loopship-afn-failed",
              message: error instanceof Error ? error.message : String(error),
              retryable,
            },
          });
        }
      },
    })),
  });
  return {
    adapterIdentity,
    adapterVersion,
    validatorIdentity: `${adapterIdentity}.fastflow-native`,
    validatorVersion: adapterVersion,
    adapterRoot: LOOPSHIP_ROOT,
    afnDispatch,
    runtimeOffer: createRuntimeOffer({
      endpointId: `${adapterIdentity}:local`,
      dispatchPort: afnDispatch,
      hostFacts: [
        {
          name: "runtime",
          value: loopshipApplicationRuntimeRef(),
        },
        { name: "platform", value: process.platform },
      ],
      affinity: [{ kind: "git-worktree", resolution: "host-local" }],
      invocationGrantKinds: ["filesystem", "git", "process"],
    }),
    registeredCalls: clone(LOOPSHIP_AFN_DESCRIPTORS),
    resolveCallDescriptor({ call }: { call?: string } = {}) {
      const descriptor = DESCRIPTOR_BY_CALL.get(String(call || ""));
      return descriptor ? clone(descriptor) : null;
    },
    validateCallInvocation({
      call,
      with: withValue,
      phase,
    }: {
      call?: string;
      with?: { body?: Record<string, unknown> };
      phase?: string;
    } = {}) {
      const descriptor = DESCRIPTOR_BY_CALL.get(String(call || ""));
      if (!descriptor) return;
      const allowed = descriptor.metadata?.allowed_phases;
      if (Array.isArray(allowed) && phase && !allowed.includes(phase as never)) {
        throw new Error(`Loopship call '${call}' is not allowed during ${phase}.`);
      }
      const body = withValue?.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error(`Loopship call '${call}' requires with.body.`);
      }
      validateBodyAgainstDescriptor(descriptor, body);
    },
    describeCallImplementation({ call }: { call?: string } = {}) {
      if (!DESCRIPTOR_BY_CALL.has(String(call || ""))) return null;
      const callId = String(call || "");
      return {
        schemaVersion: "loopship/call-implementation/v1",
        call: callId,
        implementation: "loopship.fastflow.adapter",
        adapter_identity: adapterIdentity,
        adapter_version: adapterVersion,
        ...loopshipAfnImplementationEvidence(callId),
      };
    },
    describeAdapterImplementation() {
      return {
        schemaVersion: "loopship/adapter-implementation/v1",
        adapter_identity: adapterIdentity,
        adapter_version: adapterVersion,
        catalog_root: LOOPSHIP_CALL_CATALOG_ROOT,
      };
    },
    async auditAfn({
      action,
    }: {
      action?: { call?: string; with?: { body?: Record<string, unknown> } };
    } = {}) {
      const call = String(action?.call || "");
      if (!DESCRIPTOR_BY_CALL.has(call)) {
        throw new Error(`Unknown Loopship AFN audit call: ${call}`);
      }
      return {
        schemaVersion: "fastflow.audit.proposal/v1",
        ok: true,
        audited: true,
        call,
        effects: DESCRIPTOR_BY_CALL.get(call)?.metadata?.effects || [],
        body: action?.with?.body || {},
      };
    },
  };
}

export async function configureFastflowForLoopship(
  _repoRoot: string = LOOPSHIP_ROOT,
): Promise<Record<string, unknown>> {
  const { configureFastflowApp } = await import("@cueintent/fastflow");
  const workflowCatalogRoot = await ensureLoopshipFastflowWorkflowCatalog(LOOPSHIP_ROOT);
  return configureFastflowApp({
    appName: "loopship",
    systemWorkflowsDir: workflowCatalogRoot,
    callCatalogRoots: [workflowCatalogRoot, LOOPSHIP_CALL_CATALOG_ROOT],
    supervisorGuidance: LOOPSHIP_SUPERVISOR_GUIDANCE,
    workflowResumeCommand: LOOPSHIP_WORKFLOW_RESUME_COMMAND,
    adapters: createLoopshipFastflowAdapters(),
  });
}

export async function getLoopshipFastflowAdapters(): Promise<Record<string, unknown>> {
  const { getFastflowAdapters } = await import("@cueintent/fastflow");
  return getFastflowAdapters();
}
