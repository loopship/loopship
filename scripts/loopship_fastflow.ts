import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CallDescriptor } from "@cueintent/fastflow";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  applyLandingReceipt,
  applySystemUpdate,
  assertCanonicalWtreeName,
  assertValidGitBranchRef,
  appendJsonl,
  createQuest,
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
  writeQuestManifest,
} from "./loopship_core.ts";
import type { QuestState } from "./loopship_core.ts";
import { recordHookRoute, runtimeIdentityFromEnv } from "./loopship_hook_state.ts";
import { readText, runCommand } from "./loopship_utils.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const LOOPSHIP_ROOT = resolve(SCRIPT_DIR, "..");
export const LOOPSHIP_CALL_CATALOG_ROOT = resolve(LOOPSHIP_ROOT, "call-catalog");
const PACKAGE_JSON = JSON.parse(
  readFileSync(resolve(LOOPSHIP_ROOT, "package.json"), "utf8"),
) as { name?: string; version?: string };
const LOOPSHIP_RUNTIME_NAMESPACE = ".loopship/runtime";
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
    "Judge each Loopship flow before every native Fastflow decision: require the current step to match its declared lifecycle purpose; root/coordinator quests may decompose, but terminal child quests identified by parent_wtree, parent_task_id, parent_context_ref, or an execute child task prompt must stay local and never prepare child worktrees; run emitted child commands for real when the flow delegates work; route terminal-child implementation gaps through the workflow-owned aitl.subagent fallback with subagent receipts instead of supervisor inline edits; and require canonical Loopship runtime, worktree, task, validation, verification, explicit system_update, landing, or archive evidence before approving completion. Answer safe clarification prompts as the human supervisor; when upfront scoping misses material clarification, reject or re-run scoping instead of inventing replacement planner clarification payloads. Improve weak Loopship prompts, schemas, bindings, transitions, or verification rules within scope.",
  ref: "README.md#mocked-runtime-lifecycle-stepping",
});

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

export type LoopshipFastflowRunInput = {
  repoRoot: string;
  workspaceRoot?: string;
  flowId?: string | null;
  inputs?: Record<string, unknown>;
  superviseStep?: boolean;
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

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestExistingFile(path: string): string {
  return existsSync(path) ? sha256(readFileSync(path, "utf8")) : sha256("");
}

function loopshipAfnImplementationEvidence(call: string): Record<string, unknown> {
  const implementationFiles = [
    "scripts/loopship_fastflow.ts",
    "scripts/loopship_core.ts",
    "package.json",
  ];
  const implementationDigest = sha256(
    implementationFiles
      .map((file) => `${file}\n${digestExistingFile(resolve(LOOPSHIP_ROOT, file))}`)
      .join("\n"),
  );
  return {
    mode: "direct",
    implementation_ref: `${PACKAGE_JSON.name || "@omar391/loopship"}:${PACKAGE_JSON.version || "0.0.0"}:${call}`,
    implementation_digest: implementationDigest,
    dependency_lock_digest: digestExistingFile(resolve(LOOPSHIP_ROOT, "bun.lock")),
    runtime_ref: `node:${process.versions.node}`,
    implementation_files: implementationFiles,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
  return explicit || defaultLoopshipFlowIdFromCatalog();
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

function ensureLoopshipRuntimeDocument(input: {
  repoRoot: string;
  workspaceRoot: string;
  flowId: string;
  inputs: Record<string, unknown>;
  superviseStep?: boolean;
}): void {
  const repoRoot = resolve(input.repoRoot);
  const runtimeDir = resolve(input.workspaceRoot, LOOPSHIP_RUNTIME_NAMESPACE);
  const tasksPath = resolve(runtimeDir, "tasks.yaml");
  if (existsSync(tasksPath)) return;
  const request = String(input.inputs.request ?? input.inputs.prompt ?? "").trim();
  if (!request) return;
  const wtree = String(input.inputs.wtree ?? "").trim() || defaultWtreeName(request);
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
  createQuest({
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
  });
}

function resolveRunWorkspace(input: LoopshipFastflowRunInput): {
  inputs: Record<string, unknown>;
  workspaceRoot: string;
} {
  const inputs = { ...(input.inputs || {}) };
  if (input.workspaceRoot) {
    return { inputs, workspaceRoot: resolve(input.workspaceRoot) };
  }
  const request = String(inputs.request ?? inputs.prompt ?? "").trim();
  const wtree = String(inputs.wtree ?? "").trim() || (request ? defaultWtreeName(request) : "");
  if (!wtree) {
    return { inputs, workspaceRoot: resolve(input.repoRoot) };
  }
  const workspace = ensureCoordinatorWorkspace(input.repoRoot, wtree);
  inputs.wtree = wtree;
  return { inputs, workspaceRoot: workspace.worktree_path };
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
  return workflowRef.slice(prefix.length).replace(/-/g, "_");
}

export async function ensureLoopshipFastflowWorkflowCatalog(
  _repoRoot: string,
): Promise<string> {
  if (!catalogIsComplete(LOOPSHIP_CALL_CATALOG_ROOT)) {
    throw new Error(`Loopship Fastflow call catalog is incomplete: ${LOOPSHIP_CALL_CATALOG_ROOT}`);
  }
  return LOOPSHIP_CALL_CATALOG_ROOT;
}

function runFastflowNodeSession(input: {
  repoRoot: string;
  workspaceRoot?: string;
  catalogRoot: string;
  operation: "run" | "resume";
  request: Record<string, unknown>;
}): Record<string, unknown> {
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
      import {
        configureFastflowApp,
        executeFastflowWorkflowResumeRequest,
        executeFastflowWorkflowRunRequest,
      } from ${JSON.stringify(pathToFileURL(resolve(fastflowRoot, "src", "index.mjs")).href)};
      import {
        LOOPSHIP_CALL_CATALOG_ROOT,
        LOOPSHIP_SUPERVISOR_GUIDANCE,
        createLoopshipFastflowAdapters,
      } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)};

      const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
      process.env.LOOPSHIP_WORKSPACE_ROOT = ${JSON.stringify(workspaceRoot)};
      configureFastflowApp({
        appName: "loopship",
        systemWorkflowsDir: ${JSON.stringify(input.catalogRoot)},
        callCatalogRoots: [${JSON.stringify(input.catalogRoot)}, LOOPSHIP_CALL_CATALOG_ROOT],
        supervisorGuidance: LOOPSHIP_SUPERVISOR_GUIDANCE,
        adapters: createLoopshipFastflowAdapters(),
      });
      const result = ${JSON.stringify(input.operation)} === "run"
        ? await executeFastflowWorkflowRunRequest(request)
        : await executeFastflowWorkflowResumeRequest(request);
      await new Promise((resolve) => process.stdout.write(JSON.stringify(result) + "\\n", resolve));
      process.exit(0);
    `,
    "utf8",
  );
  try {
    const proc = runCommand("node", [scriptPath, requestPath], {
      cwd: LOOPSHIP_ROOT,
      timeoutMs: 900_000,
    });
    if (proc.status !== 0) {
      throw new Error(proc.stderr || proc.stdout || "Fastflow session command failed");
    }
    const lines = proc.stdout.trim().split(/\r?\n/).filter(Boolean);
    const parsed = JSON.parse(lines[lines.length - 1] || "{}");
    if (!isPlainObject(parsed)) {
      throw new Error("Fastflow session command returned a non-object result.");
    }
    return parsed;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
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
  const catalogRoot = await ensureLoopshipFastflowWorkflowCatalog(LOOPSHIP_ROOT);
  const workflowRef = requireString(input.request.workflowRef, "workflowRef");
  const requestInputs = isPlainObject(input.request.inputs)
    ? { ...(input.request.inputs as Record<string, unknown>) }
    : {};
  const flowId = loopshipFlowIdFromWorkflowRef(workflowRef);
  const { inputs, workspaceRoot } = resolveRunWorkspace({
    repoRoot: input.repoRoot,
    workspaceRoot: input.workspaceRoot,
    flowId,
    inputs: requestInputs,
  });
  const superviseStep = input.request.superviseStep === true || input.request.supervision === "step";
  ensureLoopshipRuntimeDocument({
    repoRoot: input.repoRoot,
    workspaceRoot,
    flowId,
    inputs,
    superviseStep,
  });
  const result = runFastflowNodeSession({
    repoRoot: input.repoRoot,
    workspaceRoot,
    catalogRoot,
    operation: "run",
    request: {
      ...input.request,
      workflowRef,
      inputs,
    },
  });
  const runtime = String(inputs.runtime ?? "").trim();
  if (runtime) {
    const identity = runtimeIdentityFromEnv(runtime);
    recordHookRoute({
      repoRoot: input.repoRoot,
      runtime: identity?.runtime ?? runtime,
      threadId: identity?.threadId,
      workspaceRoot,
      result,
    });
  }
  return result;
}

export async function runLoopshipFastflowWorkflow(
  input: LoopshipFastflowRunInput,
): Promise<Record<string, unknown>> {
  const flowId = resolveLoopshipFlowId(input.flowId);
  return runLoopshipFastflowWorkflowRequest({
    repoRoot: input.repoRoot,
    workspaceRoot: input.workspaceRoot,
    request: {
      workflowRef: loopshipFlowWorkflowRef(flowId),
      inputs: input.inputs || {},
      ...(input.superviseStep ? { superviseStep: true } : {}),
      ...(input.progressMode ? { progressMode: input.progressMode } : {}),
    },
  });
}

export async function resumeLoopshipFastflowWorkflow(
  input: LoopshipFastflowResumeInput,
): Promise<Record<string, unknown>> {
  const catalogRoot = await ensureLoopshipFastflowWorkflowCatalog(LOOPSHIP_ROOT);
  return runFastflowNodeSession({
    repoRoot: input.repoRoot,
    workspaceRoot:
      input.workspaceRoot ||
      (typeof input.request.workspaceRoot === "string" ? input.request.workspaceRoot : undefined),
    catalogRoot,
    operation: "resume",
    request: input.request,
  });
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
  if (probe.status !== 0) return [];
  const status = runCommand(
    "git",
    ["status", "--short", "--untracked-files=all"],
    {
      cwd,
      timeoutMs: 15_000,
    },
  );
  if (status.status !== 0) return [];
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
  const diff = runCommand("git", ["diff", "--cached", "--quiet"], {
    cwd,
    timeoutMs: 15_000,
  });
  if (diff.status === 0) return null;
  if (diff.status !== 1) {
    throw new Error(diff.stderr || diff.stdout || "failed to inspect staged .loopship state");
  }
  const commit = runCommand("git", ["commit", "-m", message], {
    cwd,
    timeoutMs: 60_000,
  });
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
  const registeredWorktrees = new Set(parseGitWorktrees(repo).map((entry) => resolve(entry.worktree)));
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
    if (existsSync(normalizedWorktree) && registeredWorktrees.has(normalizedWorktree)) {
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

function executeNativeRuntimeLandingApply(input: {
  body: Record<string, unknown>;
  repo: string;
  wtree: string;
  requestId: string;
}): Record<string, unknown> {
  const tasksPath = resolve(input.repo, LOOPSHIP_RUNTIME_NAMESPACE, "tasks.yaml");
  if (!existsSync(tasksPath)) {
    throw new Error(`missing Loopship quest state for ${input.wtree}`);
  }
  const eventsPath = resolve(input.repo, LOOPSHIP_RUNTIME_NAMESPACE, "events.jsonl");
  const state = parseTasksYaml(readText(tasksPath)) as Record<string, unknown>;
  const sourceBranch = optionalString(input.body.source_branch) || String(state.coordinator_branch || "");
  const targetBranch =
    optionalString(input.body.target_branch) || String(state.landing_target_branch || "main");
  const targetWorktree =
    optionalString(input.body.target_worktree) ||
    String(state.landing_target_worktree || input.repo);
  const receipt = isPlainObject(input.body.receipt) ? input.body.receipt : {};
  const status = optionalString(input.body.status) || "landed";
  const nextStage = optionalString(input.body.next_stage);
  const summary = optionalString(input.body.summary);
  if (!["landed", "blocked"].includes(status)) {
    throw new Error("landing.apply-outcome status must be landed or blocked");
  }
  if (input.body.dry_run === true) {
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
    state.stage = blockedStage;
    writeFileSync(tasksPath, stringifyYaml(state), "utf8");
    appendJsonl(eventsPath, {
      event: "landing_submitted",
      quest_id: input.wtree,
      stage: blockedStage,
      request_id: input.requestId,
      payload: { status, summary },
    });
    return {
      schema_version: "loopship.landing.apply/v1",
      dry_run: false,
      status,
      source_branch: sourceBranch,
      target_branch: targetBranch,
      target_worktree: targetWorktree,
      summary,
      next_stage: blockedStage,
    };
  }
  if (!nextStage) {
    throw new Error("landing.apply-outcome landed status requires next_stage");
  }
  assertLandingPreflight({ repo: input.repo, state });
  const landingReceipt = optionalString(receipt.landed_commit)
    ? verifiedRecordedReceipt({
        repo: input.repo,
        sourceBranch,
        targetBranch,
        targetWorktree,
        receipt,
      })
    : {
        source_branch: sourceBranch,
        target_branch: targetBranch,
        target_worktree: targetWorktree,
        landed_commit: gitRevParse(input.repo, targetBranch),
        strategy: "recorded",
      };
  state.stage = nextStage;
  state.landing_target_branch = String(landingReceipt.target_branch);
  state.landing_target_worktree = String(landingReceipt.target_worktree);
  state.landed_commit = String(landingReceipt.landed_commit);
  state.landing_strategy = String(landingReceipt.strategy);
  writeFileSync(tasksPath, stringifyYaml(state), "utf8");
  appendJsonl(eventsPath, {
    event: "landing_applied",
    quest_id: input.wtree,
    request_id: input.requestId,
    payload: landingReceipt,
  });
  return {
    schema_version: "loopship.landing.apply/v1",
    dry_run: false,
    status,
    summary,
    next_stage: nextStage,
    ...landingReceipt,
  };
}

function executeLandingApplyOutcome(body: Record<string, unknown>): Record<string, unknown> {
  const repo = requireString(body.repo, "repo");
  const wtree = requireString(body.wtree, "wtree");
  const files = questFiles(repo, wtree);
  const requestId = optionalString(body.request_id) || `fastflow-landing-${Date.now().toString(36)}`;
  if (!existsSync(files.tasks)) {
    return executeNativeRuntimeLandingApply({ body, repo, wtree, requestId });
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

export function createLoopshipFastflowAdapters(): Record<string, unknown> {
  const adapterIdentity = PACKAGE_JSON.name || "@omar391/loopship";
  const adapterVersion = PACKAGE_JSON.version || "0.0.0";
  return {
    adapterIdentity,
    adapterVersion,
    validatorIdentity: `${adapterIdentity}.fastflow-native`,
    validatorVersion: adapterVersion,
    adapterRoot: LOOPSHIP_ROOT,
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
    async executeAfn({
      action,
    }: {
      action?: { call?: string; with?: { body?: Record<string, unknown> } };
    } = {}) {
      const call = String(action?.call || "");
      const descriptor = DESCRIPTOR_BY_CALL.get(call);
      if (!descriptor) {
        throw new Error(`Unknown Loopship AFN execution call: ${call}`);
      }
      const body = action?.with?.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error(`Loopship call '${call}' requires with.body.`);
      }
      validateBodyAgainstDescriptor(descriptor, body);
      if (call === LOOPSHIP_AFN_CALLS.childPrepareWorktree) return executeChildPrepare(body);
      if (call === LOOPSHIP_AFN_CALLS.flowComposeTransitionResult) return executeFlowComposeTransitionResult(body);
      if (call === LOOPSHIP_AFN_CALLS.gitResolveCommit) return executeGitResolveCommit(body);
      if (call === LOOPSHIP_AFN_CALLS.systemApplyUpdate) return executeSystemApplyUpdate(body);
      if (call === LOOPSHIP_AFN_CALLS.landingApplyOutcome) return executeLandingApplyOutcome(body);
      if (call === LOOPSHIP_AFN_CALLS.landingCleanupLandedWorktrees) return executeLandingCleanupLandedWorktrees(body);
      throw new Error(`Loopship AFN '${call}' has no normal handler.`);
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
    adapters: createLoopshipFastflowAdapters(),
  });
}

export async function getLoopshipFastflowAdapters(): Promise<Record<string, unknown>> {
  const { getFastflowAdapters } = await import("@cueintent/fastflow");
  return getFastflowAdapters();
}
