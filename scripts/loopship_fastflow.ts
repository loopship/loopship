import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallDescriptor } from "@cueintent/fastflow";
import {
  applyLandingReceipt,
  applySystemUpdate,
  appendJsonl,
  ensureTaskWorkspace,
  parseTasksYaml,
  questFiles,
  taskAssignmentBranchRef,
  taskAssignmentChildWtree,
  taskAssignmentWorktreePath,
  updateQuestStage,
  writeQuestManifest,
} from "./loopship_core.ts";
import {
  DEFAULT_FLOW_ID,
  loadFlowDefinition,
  loadStepDefinitions,
  type LoopshipStepDefinition,
} from "./loopship_flow.ts";
import { dereferencedSchemaSource } from "./loopship_schema.ts";
import { readText, runCommand } from "./loopship_utils.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const LOOPSHIP_ROOT = resolve(SCRIPT_DIR, "..");
export const LOOPSHIP_CALL_CATALOG_ROOT = resolve(LOOPSHIP_ROOT, "call-catalog");
const PACKAGE_JSON = JSON.parse(
  readFileSync(resolve(LOOPSHIP_ROOT, "package.json"), "utf8"),
) as { name?: string; version?: string };
const LOOPSHIP_RUNTIME_NAMESPACE = ".loopship/runtime";

export const LOOPSHIP_AFN_CALLS = Object.freeze({
  childPrepare: "loopship.afn.service.child.prepare",
  systemApply: "loopship.afn.service.system.apply",
  landingApply: "loopship.afn.service.landing.apply",
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
    call: LOOPSHIP_AFN_CALLS.childPrepare,
    summary: "Prepare Loopship child quest/worktree launch context without running the child agent.",
    inputs: {
      required: ["repo", "wtree"],
      optional: [
        "task_id",
        "task",
        "parent",
        "runtime",
        "branch",
        "base_branch",
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
          task: { type: "object" },
          parent: { type: "object" },
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
    avoidWhen: ["The workflow only needs planning, validation, verification, or model reasoning."],
    metadata: {
      allowed_phases: ["action"],
      effects: ["worktree.prepare", "quest.prepare"],
    },
  },
  {
    call: LOOPSHIP_AFN_CALLS.systemApply,
    summary: "Apply Loopship system document updates and refresh managed signatures.",
    inputs: {
      required: ["repo", "update"],
      optional: ["request_id", "actor", "reason", "dry_run"],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["repo", "update"],
        properties: {
          repo: { type: "string", minLength: 1 },
          update: { type: "object" },
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
    call: LOOPSHIP_AFN_CALLS.landingApply,
    summary: "Apply Loopship landing policy, merge results, and record landed state.",
    inputs: {
      required: ["repo", "wtree"],
      optional: [
        "receipt",
        "summary",
        "target_branch",
        "target_worktree",
        "source_branch",
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
          receipt: { type: "object" },
          summary: { type: "string" },
          target_branch: { type: "string" },
          target_worktree: { type: "string" },
          source_branch: { type: "string" },
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
];

const DESCRIPTOR_BY_CALL = new Map(
  LOOPSHIP_AFN_DESCRIPTORS.map((descriptor) => [descriptor.call, descriptor]),
);

type FastflowRecord = Record<string, unknown>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function asObjectSchema(value: Record<string, unknown> | null): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return { type: "object", additionalProperties: true };
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

function schemaAllowsType(schema: Record<string, unknown>, value: unknown): boolean {
  const type = schema.type;
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("object")) return isPlainObject(value);
  if (types.includes("string")) return typeof value === "string";
  if (types.includes("boolean")) return typeof value === "boolean";
  return true;
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
    if (!schemaAllowsType(fieldSchema, value)) {
      throw new Error(`Loopship call '${descriptor.call}' body.${field} has invalid type.`);
    }
    if (
      fieldSchema.type === "string" &&
      fieldSchema.minLength === 1 &&
      typeof value === "string" &&
      !value.trim()
    ) {
      throw new Error(`Loopship call '${descriptor.call}' body.${field} must be non-empty.`);
    }
  }
}

function loopshipDataAdapterConfig(rootDir = "."): Record<string, unknown> {
  return {
    defaultAdapter: "yaml",
    adapters: {
      yaml: { rootDir },
      json: { rootDir },
      jsonl: { rootDir },
    },
  };
}

function dataBody(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    namespace: LOOPSHIP_RUNTIME_NAMESPACE,
    adapter_config: { rootDir: "." },
    ...extra,
  };
}

export function buildLoopshipWorkflowDataTasks(): Record<string, Record<string, unknown>> {
  return {
    read_tasks: {
      metadata: commonTaskMetadata("Read the current Loopship task document through Fastflow workflow data."),
      call: LOOPSHIP_DATA_CALLS.documentRead,
      with: {
        body: dataBody({ adapter: "yaml", document: "tasks" }),
      },
      output: {
        schema: { document: { type: ["object", "null"], additionalProperties: true } },
        as: "${action.document}",
      },
    },
    read_manifest: {
      metadata: commonTaskMetadata("Read the Loopship runtime manifest through Fastflow workflow data."),
      call: LOOPSHIP_DATA_CALLS.documentRead,
      with: {
        body: dataBody({ adapter: "yaml", document: "manifest" }),
      },
      output: {
        schema: { document: { type: ["object", "null"], additionalProperties: true } },
        as: "${action.document}",
      },
    },
    query_events: {
      metadata: commonTaskMetadata("Query the Loopship event log through Fastflow workflow data."),
      call: LOOPSHIP_DATA_CALLS.eventLogQuery,
      with: {
        body: dataBody({ adapter: "jsonl", log: "events", limit: 25 }),
      },
      output: {
        schema: { document: { type: "array", items: { type: "object", additionalProperties: true } } },
        as: "${action.events}",
      },
    },
    append_event: {
      metadata: commonTaskMetadata("Append a Loopship event through Fastflow workflow data."),
      call: LOOPSHIP_DATA_CALLS.eventLogAppend,
      with: {
        body: dataBody({
          adapter: "jsonl",
          log: "events",
          events: [
            {
              schema_version: "1.0.0",
              payload: { event: "fastflow_native_probe" },
            },
          ],
        }),
      },
      output: {
        schema: { document: { type: "object", additionalProperties: true } },
        as: "${action}",
      },
    },
  };
}

function workflowNameForStep(stepId: string): string {
  return stepId.replace(/_/g, "-");
}

function commonTaskMetadata(description: string, inference?: string): Record<string, unknown> {
  return {
    description,
    ...(inference ? { inference } : {}),
    validation: {
      post: {
        kind: "static",
        ok: true,
        evidence: { generated_by: "loopship.fastflow" },
      },
    },
    verification: {
      assertions: [
        {
          id: "loopship_native_step_contract",
          kind: "behaviour",
          statement: "The generated Loopship Fastflow-native step produced an action result.",
          check: {
            script: {
              kind: "js",
              code: "return { ok: action !== undefined, evidence: { has_action: action !== undefined } };",
            },
          },
        },
      ],
    },
  };
}

function requestInputTask(step: LoopshipStepDefinition): Record<string, unknown> {
  const inputSchema = asObjectSchema(dereferencedSchemaSource(step.input_schema));
  const outputSchema = asObjectSchema(dereferencedSchemaSource(step.output_schema));
  return {
    metadata: commonTaskMetadata(step.summary, "handoff"),
    call: "fastflow.afn.core.request.input",
    with: {
      body: {
        instruction: step.instructions || step.summary,
        request: {
          schema: {
            type: "object",
            additionalProperties: true,
            properties: {
              step: { type: "object", additionalProperties: true },
              inputs: inputSchema,
              state: { type: "object", additionalProperties: true },
              args: { type: "object", additionalProperties: true },
            },
            required: ["step", "inputs"],
          },
          build: {
            kind: "js",
            using: ["inputs", "state", "args"],
            code: `return {
  step: ${JSON.stringify({
    id: step.id,
    handler: step.handler,
    summary: step.summary,
    input_step: step.input_step,
    result_schema: step.result_schema,
  })},
  inputs,
  state,
  args
};`,
          },
        },
        answer: {
          schema: outputSchema,
        },
      },
    },
  };
}

function sideEffectTask(step: LoopshipStepDefinition): Record<string, unknown> {
  if (step.id === "executing") {
    return {
      metadata: commonTaskMetadata(step.summary),
      call: LOOPSHIP_AFN_CALLS.childPrepare,
      with: {
        body: {
          repo: "${inputs.repo || inputs.repoRoot || env.PWD || ''}",
          wtree: "${inputs.wtree || inputs.quest?.wtree || ''}",
          task: "${inputs.task || inputs}",
          runtime: "${inputs.runtime || ''}",
        },
      },
    };
  }
  if (step.id === "system_update") {
    return {
      metadata: commonTaskMetadata(step.summary),
      call: LOOPSHIP_AFN_CALLS.systemApply,
      with: {
        body: {
          repo: "${inputs.repo || inputs.repoRoot || env.PWD || ''}",
          update: "${inputs.update || inputs}",
          actor: "${inputs.actor || 'loopship'}",
        },
      },
    };
  }
  if (step.id === "landing") {
    return {
      metadata: commonTaskMetadata(step.summary),
      call: LOOPSHIP_AFN_CALLS.landingApply,
      with: {
        body: {
          repo: "${inputs.repo || inputs.repoRoot || env.PWD || ''}",
          wtree: "${inputs.wtree || inputs.quest?.wtree || ''}",
          receipt: "${inputs.receipt || inputs}",
          summary: "${inputs.summary || ''}",
        },
      },
    };
  }
  return requestInputTask(step);
}

export function buildLoopshipFastflowStepWorkflow(
  step: LoopshipStepDefinition,
): FastflowRecord {
  const inputSchema = asObjectSchema(dereferencedSchemaSource(step.input_schema));
  const outputSchema = asObjectSchema(dereferencedSchemaSource(step.output_schema));
  return {
    document: {
      dsl: "1.0.3",
      namespace: "loopship-steps",
      name: workflowNameForStep(step.id),
      version: "0.1.0",
      summary: step.summary,
      metadata: {
        catalog: {
          tags: ["loopship", "step", step.id],
        },
      },
    },
    input: {
      schema: {
        document: inputSchema,
      },
    },
    do: [
      {
        [step.id]: {
          input: {
            schema: {
              document: inputSchema,
            },
            from: "${inputs}",
          },
          ...sideEffectTask(step),
          output: {
            schema: {
              document: outputSchema,
            },
            as: "${action}",
          },
        },
      },
    ],
    output: {
      schema: {
        document: outputSchema,
      },
      as: "${state.steps." + step.id + ".action}",
    },
  };
}

export function buildLoopshipFastflowStepWorkflows(): Record<string, FastflowRecord> {
  return Object.fromEntries(
    Object.entries(loadStepDefinitions()).map(([stepId, step]) => [
      stepId,
      buildLoopshipFastflowStepWorkflow(step),
    ]),
  );
}

export function buildLoopshipFastflowFlowWorkflow(
  flowId = DEFAULT_FLOW_ID,
): FastflowRecord {
  const flow = loadFlowDefinition(flowId);
  const dataTasks = buildLoopshipWorkflowDataTasks();
  return {
    document: {
      dsl: "1.0.3",
      namespace: "loopship-flows",
      name: flow.id.replace(/_/g, "-"),
      version: "0.1.0",
      summary: `Loopship ${flow.id} flow scaffold generated for Fastflow-native execution.`,
      metadata: {
        catalog: {
          tags: ["loopship", "flow", flow.id],
        },
        data: {
          ...loopshipDataAdapterConfig("."),
        },
      },
    },
    input: {
      schema: {
        document: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
    do: [
      { read_tasks: dataTasks.read_tasks },
      { read_manifest: dataTasks.read_manifest },
      { query_events: dataTasks.query_events },
      {
        describe_flow: {
          metadata: commonTaskMetadata("Expose the Loopship flow graph and runtime data as Fastflow-native data."),
          set: {
            schema_version: "loopship.flow-scaffold/v1",
            flow_id: flow.id,
            default_stage: flow.default_stage,
            stages: flow.stages,
            subflows: flow.subflows,
            runtime: {
              tasks: "${state.steps.read_tasks.action.document}",
              manifest: "${state.steps.read_manifest.action.document}",
              events: "${state.steps.query_events.action.events}",
            },
          },
          output: {
            schema: {
              document: { type: "object", additionalProperties: true },
            },
            as: "${state.steps.describe_flow.set}",
          },
        },
      },
    ],
    output: {
      schema: {
        document: {
          type: "object",
          additionalProperties: true,
        },
      },
      as: "${state.steps.describe_flow.set}",
    },
  };
}

export function buildLoopshipFastflowSuperviseStepRunRequest(input: {
  workflowRef: string;
  inputs?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    workflowRef: input.workflowRef,
    inputs: input.inputs || {},
    superviseStep: true,
  };
}

function command(cmd: string, args: string[]): Record<string, unknown> {
  return { cmd, args };
}

function executeChildPrepare(body: Record<string, unknown>): Record<string, unknown> {
  const repo = requireString(body.repo, "repo");
  const parentWtree = requireString(body.wtree, "wtree");
  const task = isPlainObject(body.task) ? body.task : {};
  const parent = isPlainObject(body.parent) ? body.parent : {};
  const taskId =
    optionalString(body.task_id) ||
    optionalString(task.id) ||
    optionalString(parent.task_id) ||
    "task";
  const childWtree =
    optionalString(body.child_wtree) ||
    optionalString(task.child_wtree) ||
    taskAssignmentChildWtree(parentWtree, taskId);
  const branchRef =
    optionalString(body.branch) ||
    optionalString(task.branch_ref) ||
    taskAssignmentBranchRef(parentWtree, taskId);
  const worktreePath =
    optionalString(body.worktree_path) ||
    optionalString(task.worktree_path) ||
    taskAssignmentWorktreePath(repo, parentWtree, taskId);
  const workspace = body.dry_run === true
    ? { branch_ref: branchRef, worktree_path: worktreePath, mode: "dry-run" }
    : ensureTaskWorkspace(repo, branchRef, worktreePath);
  const runtime = optionalString(body.runtime) || "codex";
  const request = `loopship: execute child task ${taskId}: ${optionalString(task.title) || taskId}. Read parent context at ${repo}/worktrees/${parentWtree}/.loopship/runtime/tasks.yaml. Implement only this assigned task. Do not split into child worktrees. Land into ${parentWtree} and return the merge_commit.`;
  return {
    schema_version: "loopship.child.prepare/v1",
    task_id: taskId,
    child_wtree: childWtree,
    parent_wtree: parentWtree,
    branch_ref: workspace.branch_ref,
    worktree_path: workspace.worktree_path,
    runtime,
    commands: {
      init: command("loopship", [
        "init",
        request,
        "--wtree",
        childWtree,
        "--runtime",
        runtime,
      ]),
      resume: command("loopship", ["resume", "--wtree", childWtree, "--json", "@-"]),
    },
  };
}

function executeSystemApply(body: Record<string, unknown>): Record<string, unknown> {
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
  const proc = runCommand("git", ["rev-parse", "--verify", ref], {
    cwd,
    timeoutMs: 15_000,
  });
  if (proc.status !== 0) {
    throw new Error(proc.stderr || proc.stdout || `git rev-parse failed for ${ref}`);
  }
  return proc.stdout.trim();
}

function gitCurrentBranch(cwd: string): string | null {
  const proc = runCommand("git", ["branch", "--show-current"], {
    cwd,
    timeoutMs: 15_000,
  });
  if (proc.status !== 0) return null;
  return proc.stdout.trim() || null;
}

function gitMergeIntoTarget(input: {
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  targetWorktree: string;
}): Record<string, unknown> {
  const workspace = ensureTaskWorkspace(
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
  const merge = runCommand("git", ["merge", "--no-ff", "--no-edit", input.sourceBranch], {
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
  return {
    source_branch: input.sourceBranch,
    target_branch: input.targetBranch,
    target_worktree: workspace.worktree_path,
    landed_commit: gitRevParse(workspace.worktree_path, "HEAD"),
    strategy: "merge-commit",
  };
}

function executeLandingApply(body: Record<string, unknown>): Record<string, unknown> {
  const repo = requireString(body.repo, "repo");
  const wtree = requireString(body.wtree, "wtree");
  const files = questFiles(repo, wtree);
  if (!existsSync(files.tasks)) {
    throw new Error(`missing Loopship quest state for ${wtree}`);
  }
  const requestId = optionalString(body.request_id) || `fastflow-landing-${Date.now().toString(36)}`;
  const state = parseTasksYaml(readText(files.tasks));
  const sourceBranch = optionalString(body.source_branch) || String(state.coordinator_branch || "");
  const targetBranch =
    optionalString(body.target_branch) || String(state.landing_target_branch || "main");
  const targetWorktree =
    optionalString(body.target_worktree) ||
    String(state.landing_target_worktree || `${repo}/worktrees/${targetBranch}`);
  const receipt = isPlainObject(body.receipt) ? body.receipt : {};
  if (body.dry_run === true) {
    return {
      schema_version: "loopship.landing.apply/v1",
      dry_run: true,
      source_branch: sourceBranch,
      target_branch: targetBranch,
      target_worktree: targetWorktree,
    };
  }
  const landingReceipt = optionalString(receipt.landed_commit)
    ? {
        source_branch: sourceBranch,
        target_branch: optionalString(receipt.target_branch) || targetBranch,
        target_worktree: optionalString(receipt.target_worktree) || targetWorktree,
        landed_commit: optionalString(receipt.landed_commit),
        strategy: optionalString(receipt.strategy) || "recorded",
      }
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
  updateQuestStage(files, "archived", requestId, "loopship fastflow afn landing.apply");
  writeQuestManifest(files, requestId, "loopship fastflow afn landing.apply");
  return {
    schema_version: "loopship.landing.apply/v1",
    dry_run: false,
    ...landingReceipt,
  };
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
      return {
        schemaVersion: "loopship/call-implementation/v1",
        call,
        implementation: "loopship.fastflow.adapter",
        adapter_identity: adapterIdentity,
        adapter_version: adapterVersion,
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
      if (call === LOOPSHIP_AFN_CALLS.childPrepare) return executeChildPrepare(body);
      if (call === LOOPSHIP_AFN_CALLS.systemApply) return executeSystemApply(body);
      if (call === LOOPSHIP_AFN_CALLS.landingApply) return executeLandingApply(body);
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

export async function configureFastflowForLoopship(): Promise<Record<string, unknown>> {
  const { configureFastflowApp } = await import("@cueintent/fastflow");
  return configureFastflowApp({
    appName: "loopship",
    systemWorkflowsDir: LOOPSHIP_CALL_CATALOG_ROOT,
    callCatalogRoots: [LOOPSHIP_CALL_CATALOG_ROOT],
    adapters: createLoopshipFastflowAdapters(),
  });
}

export async function getLoopshipFastflowAdapters(): Promise<Record<string, unknown>> {
  const { getFastflowAdapters } = await import("@cueintent/fastflow");
  return getFastflowAdapters();
}
