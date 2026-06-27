import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CallDescriptor } from "@cueintent/fastflow";
import {
  applyLandingReceipt,
  applySystemUpdate,
  appendJsonl,
  ensureTaskWorkspace,
  landingTargetWorktreePath,
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
  type LoadedLoopshipFlow,
  type LoopshipFlowStage,
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
const LOOPSHIP_WORKFLOW_REGISTRY = "loopship";
const LOOPSHIP_WORKFLOW_TARGET = "service";
const LOOPSHIP_STEP_SCOPE = "step";
const LOOPSHIP_FLOW_SCOPE = "flows";
const WORKFLOW_CATALOG_GENERATOR_VERSION = "loopship-fastflow-flow-orchestrator/v1";

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
    concurrency_group: { type: "string" },
    merge_target: { type: "string" },
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

export const LOOPSHIP_AFN_CALLS = Object.freeze({
  childPrepare: "loopship.afn.service.child.prepare",
  systemApply: "loopship.afn.service.system.apply",
  landingApply: "loopship.afn.service.landing.apply",
});
const LOOPSHIP_AFN_CALL_SET = new Set<string>(Object.values(LOOPSHIP_AFN_CALLS));

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
    call: LOOPSHIP_AFN_CALLS.landingApply,
    summary: "Apply Loopship landing policy, merge results, and record landed state.",
    inputs: {
      required: ["repo", "wtree"],
      optional: [
        "status",
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
          status: LANDING_STATUS_SCHEMA,
          receipt: LANDING_RECEIPT_SCHEMA,
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
type FastflowCatalogModule = typeof import("@cueintent/fastflow/catalog");

export type LoopshipFastflowSession = {
  schema_version: "loopship.fastflow.session/v1";
  workflow_ref: string;
  step_id: string;
  session_id: string;
  nonce: string;
};

type StepWorkflowPins = Record<string, { digest: string; version: string }>;

const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;

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
  if (
    schema === SYSTEM_UPDATE_SCHEMA &&
    isPlainObject(value) &&
    value.mode === "replace" &&
    !isPlainObject(value.root)
  ) {
    throw new Error(`${path}.root is required when mode is replace.`);
  }
  if (
    schema === SYSTEM_UPDATE_SCHEMA &&
    Array.isArray(value.external_docs)
  ) {
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

export function workflowNameForStep(stepId: string): string {
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
              code: `const ok = action !== undefined;
return { ok, evidence: { has_action: ok } };
`,
            },
          },
        },
      ],
    },
  };
}

function requestTaskMetadata(step: LoopshipStepDefinition): Record<string, unknown> {
  return {
    ...commonTaskMetadata(step.summary, "handoff"),
    validation: {
      post: {
        kind: "js",
        expression: `return {
  ok: Boolean(state?.steps?.[${JSON.stringify(step.id)}]?.action?.decision),
  evidence: { waiting_for_decision: true }
};
`,
      },
    },
  };
}

function requestInputTask(step: LoopshipStepDefinition): Record<string, unknown> {
  const inputSchema = asObjectSchema(dereferencedSchemaSource(step.input_schema));
  const outputSchema = asObjectSchema(dereferencedSchemaSource(step.output_schema));
  return {
    metadata: requestTaskMetadata(step),
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
  if (step.call === LOOPSHIP_AFN_CALLS.childPrepare) {
    return {
      metadata: commonTaskMetadata(step.summary),
      call: LOOPSHIP_AFN_CALLS.childPrepare,
      with: {
        body: {
          repo: "${inputs.repo || inputs.repoRoot || env.PWD || ''}",
          wtree: "${inputs.wtree || inputs.quest?.wtree || ''}",
          task: "${inputs.task || (Array.isArray(inputs.children) ? inputs.children[0] : null) || inputs}",
          runtime: "${inputs.runtime || ''}",
        },
      },
    };
  }
  if (step.call === LOOPSHIP_AFN_CALLS.systemApply) {
    return {
      metadata: commonTaskMetadata(step.summary),
      call: LOOPSHIP_AFN_CALLS.systemApply,
      with: {
        body: {
          repo: "${inputs.repo || inputs.repoRoot || env.PWD || ''}",
          update: "${inputs.system_update || inputs.update || inputs}",
          actor: "${inputs.actor || 'loopship'}",
        },
      },
    };
  }
  if (step.call === LOOPSHIP_AFN_CALLS.landingApply) {
    return {
      metadata: commonTaskMetadata(step.summary),
      call: LOOPSHIP_AFN_CALLS.landingApply,
      with: {
        body: {
          repo: "${inputs.repo || inputs.repoRoot || env.PWD || ''}",
          wtree: "${inputs.wtree || inputs.quest?.wtree || ''}",
          status: "${inputs.status || 'landed'}",
          summary: "${inputs.summary || ''}",
          target_branch: "${inputs.target_branch || ''}",
          target_worktree: "${inputs.target_worktree || ''}",
          source_branch: "${inputs.source_branch || ''}",
        },
      },
    };
  }
  return requestInputTask(step);
}

function sideEffectOutputSchema(step: LoopshipStepDefinition): Record<string, unknown> | null {
  if (!LOOPSHIP_AFN_CALL_SET.has(step.call)) return null;
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      schema_version: { type: "string" },
    },
  };
}

function sideEffectInputSchemaSource(step: LoopshipStepDefinition): unknown {
  if (step.call === LOOPSHIP_AFN_CALLS.systemApply || step.call === LOOPSHIP_AFN_CALLS.landingApply) {
    return step.output_schema;
  }
  return step.input_schema;
}

function stepActionOutputSchema(
  step: LoopshipStepDefinition,
  outputSchema: Record<string, unknown>,
): Record<string, unknown> {
  if (LOOPSHIP_AFN_CALL_SET.has(step.call)) return outputSchema;
  return {
    type: "object",
    additionalProperties: true,
  };
}

function augmentSideEffectInputSchema(
  step: LoopshipStepDefinition,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!LOOPSHIP_AFN_CALL_SET.has(step.call)) return schema;
  const properties = isPlainObject(schema.properties)
    ? { ...(schema.properties as Record<string, unknown>) }
    : {};
  return {
    ...schema,
    additionalProperties: false,
    properties: {
      ...properties,
      repo: { type: "string" },
      repoRoot: { type: "string" },
      wtree: { type: "string" },
      quest: { type: "object", additionalProperties: true },
      runtime: { type: "string" },
      actor: { type: "string" },
      target_branch: { type: "string" },
      target_worktree: { type: "string" },
      source_branch: { type: "string" },
      receipt: LANDING_RECEIPT_SCHEMA,
      task: TASK_PAYLOAD_SCHEMA,
      update: SYSTEM_UPDATE_SCHEMA,
    },
  };
}

function stepWorkflowInputSchema(step: LoopshipStepDefinition): Record<string, unknown> {
  return augmentSideEffectInputSchema(
    step,
    asObjectSchema(dereferencedSchemaSource(sideEffectInputSchemaSource(step))),
  );
}

function inputAccessExpression(key: string): string {
  const access = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `inputs.${key}`
    : `inputs[${JSON.stringify(key)}]`;
  return `\${${access}}`;
}

function workflowInputFromSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = isPlainObject(schema.properties)
    ? (schema.properties as Record<string, unknown>)
    : {};
  return Object.fromEntries(
    Object.keys(properties).map((key) => [key, inputAccessExpression(key)]),
  );
}

function schemaRefOrEmbedded(source: unknown): unknown {
  if (source == null) return null;
  if (typeof source === "string") return { schema_path: source };
  return source;
}

function stepContextForWorkflowInput(step: LoopshipStepDefinition): Record<string, unknown> {
  return {
    schema_version: step.schema_version,
    id: step.id,
    handler: step.handler,
    input_step: step.input_step,
    input_schema: schemaRefOrEmbedded(step.input_schema),
    output_schema: schemaRefOrEmbedded(step.output_schema),
    result_schema_path: step.result_schema,
    summary: step.summary,
    instructions: step.instructions,
  };
}

function childDispatchExpression(flow: LoadedLoopshipFlow): string {
  return `\${(() => {
  const root = state.steps.read_tasks?.action || {};
  const tasks = Array.isArray(root.tasks) ? root.tasks : [];
  const doneStatuses = new Set(["child_merged", "child_archived", "done", "merged"]);
  const done = new Set(tasks.filter((task) => doneStatuses.has(String(task.status || ""))).map((task) => String(task.id || task.task_id || "")));
  const selected = [];
  const usedGroups = new Set();
  const usedScopes = new Set();
  for (const task of tasks) {
    const status = String(task.status || "child_received");
    if (!["child_received", "pending", "ready"].includes(status)) continue;
    const dependencies = Array.isArray(task.dependencies) ? task.dependencies : [];
    if (!dependencies.every((id) => done.has(String(id)))) continue;
    const group = String(task.concurrency_group || "").trim();
    if (group && usedGroups.has(group)) continue;
    const scopes = (Array.isArray(task.scope_files) ? task.scope_files : []).map((scope) => String(scope).trim()).filter(Boolean);
    if (scopes.some((scope) => usedScopes.has(scope))) continue;
    selected.push(task);
    if (group) usedGroups.add(group);
    for (const scope of scopes) usedScopes.add(scope);
  }
  const wtree = String(root.wtree || inputs.wtree || "");
  const repo = String(inputs.repo || inputs.repoRoot || env.PWD || "");
  const runtime = String(inputs.runtime || "codex");
  const flowId = ${JSON.stringify(flow.id)};
  return selected.map((task) => {
    const taskId = String(task.id || task.task_id || "task");
    const title = String(task.title || taskId);
    const childWtree = String(task.child_wtree || [wtree, taskId].filter(Boolean).join("-"));
    const branchRef = String(task.branch_ref || ["loopship", wtree, taskId].filter(Boolean).join("/"));
    const worktreePath = String(task.worktree_path || (repo && wtree ? repo + "/worktrees/" + childWtree : ""));
    const mergeTarget = String(task.merge_target || wtree);
    const parentContextRef = repo && wtree ? repo + "/worktrees/" + wtree + "/.loopship/runtime/tasks.yaml" : "";
    const request = "loopship: execute child task " + taskId + ": " + title + ". Read parent context at " + parentContextRef + ". Implement only this assigned task. Do not split into child worktrees. Land into " + mergeTarget + " and return the merge_commit.";
    return {
      task_id: taskId,
      title,
      child_wtree: childWtree,
      parent_wtree: wtree,
      parent_task_id: taskId,
      parent_context_ref: parentContextRef,
      branch_ref: branchRef,
      worktree_path: worktreePath,
      merge_target: mergeTarget,
      merge_target_worktree: repo && wtree ? repo + "/worktrees/" + wtree : "",
      acceptance: Array.isArray(task.acceptance) ? task.acceptance.join("\\n") : String(task.acceptance || ""),
      commands: {
        init: { cmd: "loopship", args: ["init", request, "--wtree", childWtree, "--runtime", runtime, "--flow", flowId] },
        next: { cmd: "loopship", args: ["resume", "--wtree", childWtree, "--json", "@-"] }
      },
      result_schema: { schema_path: "schemas/steps/child-result-input.yaml" }
    };
  });
})()}`;
}

function workflowInputForStage(
  flow: LoadedLoopshipFlow,
  stage: LoopshipFlowStage,
  step: LoopshipStepDefinition,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = isPlainObject(schema.properties)
    ? (schema.properties as Record<string, unknown>)
    : {};
  if (!("step" in properties) || !("output_schema" in properties) || !("commands" in properties)) {
    return workflowInputFromSchema(schema);
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const wtreeExpression = "${state.steps.read_tasks.action.wtree || inputs.wtree || ''}";
  const envelope: Record<string, unknown> = {
    schema_version: 3,
    kind: "quest_step",
    schema_path:
      typeof step.input_schema === "string"
        ? step.input_schema
        : "schemas/steps/step-output.yaml",
    wtree: wtreeExpression,
    quest_id: "${state.steps.read_tasks.action.quest_id || state.steps.read_tasks.action.wtree || inputs.wtree || ''}",
    flow_id: flow.id,
    flow_version: flow.version,
    step: step.input_step ?? step.id,
    state: stage.id,
    summary: step.summary,
    output_schema: schemaRefOrEmbedded(step.output_schema),
    allowed_transitions: stage.transitions,
    context: {
      step: stepContextForWorkflowInput(step),
    },
    commands: {
      next: {
        cmd: "loopship",
        args: ["resume", "--wtree", wtreeExpression, "--json", "@-"],
      },
    },
    docs: {
      state_yaml: ".loopship/runtime/tasks.yaml",
      events_jsonl: ".loopship/runtime/events.jsonl",
      manifest: ".loopship/runtime/manifest.yaml",
    },
  };
  if ("children" in properties) {
    envelope.children = childDispatchExpression(flow);
  }

  const alwaysUseful = new Set([
    "schema_version",
    "kind",
    "schema_path",
    "wtree",
    "quest_id",
    "flow_id",
    "flow_version",
    "state",
    "summary",
    "allowed_transitions",
    "context",
    "docs",
  ]);
  return Object.fromEntries(
    Object.entries(envelope).filter(([key]) => {
      if (!(key in properties)) return false;
      return required.has(key) || alwaysUseful.has(key);
    }),
  );
}

export function buildLoopshipFastflowStepWorkflow(
  step: LoopshipStepDefinition,
): FastflowRecord {
  const inputSchema = stepWorkflowInputSchema(step);
  const outputSchema =
    sideEffectOutputSchema(step) || asObjectSchema(dereferencedSchemaSource(step.output_schema));
  const actionOutputSchema = stepActionOutputSchema(step, outputSchema);
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
              document: actionOutputSchema,
            },
            as: "${action}",
          },
        },
      },
    ],
    output: {
      schema: {
        document: actionOutputSchema,
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

function flowStageTaskName(stageId: string): string {
  return `stage_${stageId.replace(/[^A-Za-z0-9_]+/g, "_")}`;
}

function buildResolveStageScript(flow: LoadedLoopshipFlow): string {
  return `const flow = ${JSON.stringify({
    id: flow.id,
    default_stage: flow.default_stage,
    stages: flow.stages,
    subflows: flow.subflows,
  })};
const tasks = state.steps.read_tasks?.action || {};
const requestedStage = String(args.stage || args.state || tasks.stage || flow.default_stage || "").trim();
const stage = flow.stages.find((item) => item.id === requestedStage) ||
  flow.stages.find((item) => item.id === flow.default_stage);
const inputStepByStage = ${JSON.stringify(
    Object.fromEntries(
      flow.stages.map((stage) => {
        const step = flow.steps_by_id[stage.step];
        return [stage.id, step.input_step ?? step.id];
      }),
    ),
  )};
return {
  schema_version: "loopship.flow-stage/v1",
  flow_id: flow.id,
  default_stage: flow.default_stage,
  current_stage: stage.id,
  current_step: stage.step,
  expected_input_step: inputStepByStage[stage.id] || stage.step,
  transitions: stage.transitions || {},
  runtime: {
    tasks,
    manifest: null,
    events: state.steps.query_events?.action || []
  }
};`;
}

function indentGeneratedCode(code: string, spaces: string): string {
  return code
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `${spaces}${line}` : ""))
    .join("\n");
}

function buildTransitionKeyFunction(flow: LoadedLoopshipFlow): string {
  const cases = flow.stages.map((stage) => {
    const rule = stage.transition_key;
    if (!rule) {
      return `    case ${JSON.stringify(stage.id)}:
      return "continue";`;
    }
    if (rule.kind === "static") {
      return `    case ${JSON.stringify(stage.id)}:
      return ${JSON.stringify(rule.value)};`;
    }
    return `    case ${JSON.stringify(stage.id)}: {
${indentGeneratedCode(rule.code, "      ")}
    }`;
  });
  return `function transitionKey(stageId, payload, tasks, resolved, args) {
  switch (stageId) {
${cases.join("\n")}
    default:
      return "continue";
  }
}`;
}

function buildTransitionScript(flow: LoadedLoopshipFlow): string {
  return `const flow = ${JSON.stringify({
    id: flow.id,
    default_stage: flow.default_stage,
    stages: flow.stages,
    subflows: flow.subflows,
  })};
const stageTaskNames = ${JSON.stringify(
    Object.fromEntries(flow.stages.map((stage) => [stage.id, flowStageTaskName(stage.id)])),
  )};
const inputStepByStage = ${JSON.stringify(
    Object.fromEntries(
      flow.stages.map((stage) => {
        const step = flow.steps_by_id[stage.step];
        return [stage.id, step.input_step ?? step.id];
      }),
    ),
  )};
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function decisionPayload(value) {
  const out = object(value);
  const decision = object(out.decision);
  if (Object.prototype.hasOwnProperty.call(decision, "decision")) return decision.decision;
  if (Object.keys(decision).length) return decision;
  if (Object.prototype.hasOwnProperty.call(out, "decision")) return out.decision;
  return out;
}
function tasksAfterPayload(tasks, payload, stepId) {
  if (stepId !== "child_result") return tasks;
  const taskId = String(payload.task_id || payload.id || "");
  const items = Array.isArray(tasks.tasks) ? tasks.tasks : [];
  if (!taskId || !items.length) return tasks;
  return {
    ...tasks,
    tasks: items.map((task) => {
      if (String(task.id || "") !== taskId) return task;
      const status = String(payload.status || "");
      return {
        ...task,
        status: status === "passed" ? "child_archived" : status === "blocked" ? "blocked" : "failed",
        child_wtree: String(payload.child_wtree || task.child_wtree || ""),
        branch_ref: String(payload.branch_ref || task.branch_ref || ""),
        worktree_path: String(payload.worktree_path || task.worktree_path || ""),
        merge_target: String(payload.merge_target || task.merge_target || ""),
        merge_lease_id: String(payload.merge_lease_id || task.merge_lease_id || ""),
        merge_commit: String(payload.merge_commit || task.merge_commit || "")
      };
    })
  };
}
${buildTransitionKeyFunction(flow)}
const resolved = object(state.steps.resolve_stage?.action);
const currentStage = String(resolved.current_stage || args.stage || flow.default_stage);
const stage = flow.stages.find((item) => item.id === currentStage) ||
  flow.stages.find((item) => item.id === flow.default_stage);
const taskName = stageTaskNames[stage.id];
const stageAction = object(state.steps[taskName]?.action);
const workflowOutput = object(stageAction.result?.output || stageAction.workflow?.output);
const payload = decisionPayload(workflowOutput);
const tasks = object(state.steps.read_tasks?.action);
const stepId = inputStepByStage[stage.id] || stage.step;
const transitionTasks = tasksAfterPayload(tasks, payload, stepId);
const key = transitionKey(stage.id, payload, transitionTasks, resolved, args);
const transitions = object(stage.transitions);
const targetStage = transitions[key] || stage.id;
return {
  schema_version: "loopship.flow-transition/v1",
  flow_id: flow.id,
  stage_before: stage.id,
  stage_after: targetStage,
  transition: key,
  step: stepId,
  step_workflow_task: taskName,
  step_payload: payload,
  step_action: stageAction,
  state_patch: {
    stage: targetStage
  },
  event_payload: {
    event: "stage_changed",
    stage: targetStage,
    transition: key,
    step: stepId,
    stage_before: stage.id,
    stage_after: targetStage
  },
  runtime: resolved.runtime || {
    tasks,
    manifest: null,
    events: state.steps.query_events?.action || []
  }
};`;
}

export function buildLoopshipFastflowFlowWorkflow(
  flowId = DEFAULT_FLOW_ID,
  options: { stepPins?: StepWorkflowPins } = {},
): FastflowRecord {
  const flow = loadFlowDefinition(flowId);
  const dataTasks = buildLoopshipWorkflowDataTasks();
  const pins = options.stepPins || {};
  const stageCalls = flow.stages.map((stage) => {
    const taskName = flowStageTaskName(stage.id);
    const step = flow.steps_by_id[stage.step];
    const inputSchema = stepWorkflowInputSchema(step);
    const pin = pins[step.id] || { digest: PLACEHOLDER_DIGEST, version: "0.1.0" };
    return {
      [taskName]: {
        if: `\${state.steps.resolve_stage.action.current_stage === ${JSON.stringify(stage.id)}}`,
        then: "derive_transition",
        metadata: {
          ...commonTaskMetadata(`Run Loopship ${stage.id} via the pinned ${step.id} step workflow.`),
          ref: { digest: pin.digest },
        },
        call: loopshipStepWorkflowRef(step.id),
        with: {
          version: pin.version,
          input: workflowInputForStage(flow, stage, step, inputSchema),
        },
        output: {
          schema: {
            document: { type: "object", additionalProperties: true },
          },
          as: "${action}",
        },
      },
    };
  });
  return {
    document: {
      dsl: "1.0.3",
      namespace: "loopship-flows",
      name: flow.id.replace(/_/g, "-"),
      version: "0.1.0",
      summary: `Loopship ${flow.id} flow orchestration for Fastflow-native supervision.`,
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
      { query_events: dataTasks.query_events },
      {
        resolve_stage: {
          metadata: commonTaskMetadata("Resolve the active Loopship flow stage from Fastflow workflow-data state."),
          run: {
            script: {
              language: "js",
              code: buildResolveStageScript(flow),
            },
          },
          output: {
            schema: {
              document: { type: "object", additionalProperties: true },
            },
            as: "${action.value}",
          },
        },
      },
      {
        route_stage: {
          metadata: commonTaskMetadata("Route directly to the active Loopship flow stage."),
          switch: flow.stages.map((stage) => ({
            [stage.id]: {
              when: `\${state.steps.resolve_stage.action.current_stage === ${JSON.stringify(stage.id)}}`,
              then: flowStageTaskName(stage.id),
            },
          })),
        },
      },
      ...stageCalls,
      {
        derive_transition: {
          metadata: commonTaskMetadata("Derive the Loopship flow transition from the nested step workflow output."),
          run: {
            script: {
              language: "js",
              code: buildTransitionScript(flow),
            },
          },
          output: {
            schema: {
              document: { type: "object", additionalProperties: true },
            },
            as: "${action.value}",
          },
        },
      },
      {
        persist_stage: {
          metadata: commonTaskMetadata("Persist the Fastflow-derived Loopship stage through workflow data."),
          call: LOOPSHIP_DATA_CALLS.documentPatch,
          with: {
            body: dataBody({
              adapter: "yaml",
              document: "tasks",
              patch: "${state.steps.derive_transition.action.state_patch}",
            }),
          },
          output: {
            schema: {
              document: { type: "object", additionalProperties: true },
            },
            as: "${action}",
          },
        },
      },
      {
        append_stage_event: {
          metadata: commonTaskMetadata("Append the Fastflow-derived stage transition event through workflow data."),
          call: LOOPSHIP_DATA_CALLS.eventLogAppend,
          with: {
            body: dataBody({
              adapter: "jsonl",
              log: "events",
              events: [
                {
                  schema_version: "1.0.0",
                  payload: {
                    event: "${state.steps.derive_transition.action.event_payload.event}",
                    stage: "${state.steps.derive_transition.action.event_payload.stage}",
                    transition: "${state.steps.derive_transition.action.event_payload.transition}",
                    step: "${state.steps.derive_transition.action.event_payload.step}",
                    stage_before: "${state.steps.derive_transition.action.event_payload.stage_before}",
                    stage_after: "${state.steps.derive_transition.action.event_payload.stage_after}",
                  },
                },
              ],
            }),
          },
          output: {
            schema: {
              document: { type: "object", additionalProperties: true },
            },
            as: "${action}",
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
      as: "${state.steps.derive_transition.action}",
    },
  };
}

export function buildLoopshipFastflowSuperviseStepRunRequest(input: {
  workflowRef: string;
  inputs?: Record<string, unknown>;
  progressMode?: string;
}): Record<string, unknown> {
  return {
    workflowRef: input.workflowRef,
    inputs: input.inputs || {},
    superviseStep: true,
    ...(input.progressMode ? { progressMode: input.progressMode } : {}),
  };
}

function resolveFastflowRoot(): string {
  const candidates = [
    resolve(LOOPSHIP_ROOT, "node_modules", "@cueintent", "fastflow"),
    resolve(LOOPSHIP_ROOT, "..", "..", "orgs", "cueintent", "fastflow"),
    resolve(LOOPSHIP_ROOT, "..", "..", "..", "..", "orgs", "cueintent", "fastflow"),
  ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, "package.json"))) return candidate;
  }
  throw new Error("could not resolve @cueintent/fastflow runtime");
}

async function importFastflowCatalogModule(): Promise<FastflowCatalogModule> {
  try {
    return await import("@cueintent/fastflow/catalog");
  } catch (error) {
    const sourceModule = resolve(resolveFastflowRoot(), "src", "catalog.mjs");
    if (!existsSync(sourceModule)) throw error;
    return (await import(pathToFileURL(sourceModule).href)) as FastflowCatalogModule;
  }
}

function loopshipCatalogRoot(repoRoot: string): string {
  return resolve(repoRoot, "call-catalog");
}

function generatedCatalogCachePath(repoRoot: string): string {
  return resolve(repoRoot, "tmp", "loopship-fastflow-workflow-catalog.json");
}

function generatedCatalogSourceDigest(): string {
  const hash = createHash("sha256");
  const addFile = (path: string): void => {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  };
  hash.update(WORKFLOW_CATALOG_GENERATOR_VERSION);
  addFile(fileURLToPath(import.meta.url));
  addFile(resolve(LOOPSHIP_ROOT, "assets", "flows", `${DEFAULT_FLOW_ID}.flow.yaml`));
  const stepDir = resolve(LOOPSHIP_ROOT, "assets", "workflows", "steps");
  for (const name of readdirSync(stepDir).filter((entry) => entry.endsWith(".stable.yaml")).sort()) {
    addFile(resolve(stepDir, name));
  }
  return `sha256:${hash.digest("hex")}`;
}

function generatedCatalogIsComplete(root: string): boolean {
  return (
    existsSync(resolve(root, "index.yaml")) &&
    existsSync(
      resolve(root, LOOPSHIP_WORKFLOW_REGISTRY, "workflow", LOOPSHIP_WORKFLOW_TARGET, LOOPSHIP_STEP_SCOPE, "index.yaml"),
    ) &&
    existsSync(
      resolve(root, LOOPSHIP_WORKFLOW_REGISTRY, "workflow", LOOPSHIP_WORKFLOW_TARGET, LOOPSHIP_STEP_SCOPE, "plan.stable.yaml"),
    ) &&
    existsSync(
      resolve(root, LOOPSHIP_WORKFLOW_REGISTRY, "workflow", LOOPSHIP_WORKFLOW_TARGET, LOOPSHIP_FLOW_SCOPE, "index.yaml"),
    ) &&
    existsSync(
      resolve(root, LOOPSHIP_WORKFLOW_REGISTRY, "workflow", LOOPSHIP_WORKFLOW_TARGET, LOOPSHIP_FLOW_SCOPE, "swe.stable.yaml"),
    )
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

export function loopshipStepWorkflowRef(stepId: string): string {
  return workflowRefFor(LOOPSHIP_STEP_SCOPE, workflowNameForStep(stepId));
}

export function loopshipFlowWorkflowRef(flowId = DEFAULT_FLOW_ID): string {
  return workflowRefFor(LOOPSHIP_FLOW_SCOPE, flowId.replace(/_/g, "-"));
}

export function isLoopshipFastflowHandoffStep(stepId: string): boolean {
  const step = loadStepDefinitions()[stepId];
  if (!step || !step.output_schema) return false;
  const workflow = buildLoopshipFastflowStepWorkflow(step);
  let found = false;
  const walk = (value: unknown): void => {
    if (found) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (object.call === "fastflow.afn.core.request.input") {
      found = true;
      return;
    }
    for (const item of Object.values(object)) walk(item);
  };
  walk(workflow);
  return found;
}

export function isLoopshipFastflowGeneratedStep(stepId: string): boolean {
  return Boolean(loadStepDefinitions()[stepId]);
}

function materializeCatalogWorkflow(
  scope: string,
  workflow: FastflowRecord,
): FastflowRecord {
  const materialized = structuredClone(workflow) as FastflowRecord;
  materialized.document = {
    ...((materialized.document as Record<string, unknown> | undefined) || {}),
    namespace: `${LOOPSHIP_WORKFLOW_TARGET}-${scope}`,
  };
  return materialized;
}

export async function ensureLoopshipFastflowWorkflowCatalog(
  repoRoot: string,
): Promise<string> {
  const root = loopshipCatalogRoot(repoRoot);
  if (generatedCatalogIsComplete(root)) {
    return root;
  }
  const sourceDigest = generatedCatalogSourceDigest();
  const stepWorkflows = buildLoopshipFastflowStepWorkflows();
  const stepPins: StepWorkflowPins = {};
  const generatedWorkflows: Array<{
    call: string;
    rawWorkflow: FastflowRecord;
    store: "global";
    tags: string[];
  }> = [];
  const {
    buildWorkflowReleaseEntry,
    writeGeneratedWorkflowCatalog,
  } = await importFastflowCatalogModule();
  for (const [stepId, workflow] of Object.entries(stepWorkflows)) {
    const name = workflowNameForStep(stepId);
    const call = workflowRefFor(LOOPSHIP_STEP_SCOPE, name);
    const rawWorkflow = materializeCatalogWorkflow(LOOPSHIP_STEP_SCOPE, workflow);
    const release = buildWorkflowReleaseEntry({ call, rawWorkflow });
    stepPins[stepId] = {
      digest: release.digest,
      version: String((workflow.document as Record<string, unknown> | undefined)?.version || "0.1.0"),
    };
    generatedWorkflows.push({
      call,
      rawWorkflow,
      store: "global",
      tags: ["loopship", "step"],
    });
  }
  const flow = buildLoopshipFastflowFlowWorkflow(DEFAULT_FLOW_ID, { stepPins });
  const flowName = DEFAULT_FLOW_ID.replace(/_/g, "-");
  generatedWorkflows.push({
    call: workflowRefFor(LOOPSHIP_FLOW_SCOPE, flowName),
    rawWorkflow: materializeCatalogWorkflow(LOOPSHIP_FLOW_SCOPE, flow),
    store: "global",
    tags: ["loopship", "flow"],
  });
  await writeGeneratedWorkflowCatalog({
    outputRoot: root,
    store: "global",
    appConfig: {
      appName: "loopship",
      systemWorkflowsDir: root,
      callCatalogRoots: [root, LOOPSHIP_CALL_CATALOG_ROOT],
      adapters: createLoopshipFastflowAdapters(),
    },
    catalogTags: {
      "loopship.workflow.service.step": ["loopship", "step"],
      "loopship.workflow.service.flows": ["loopship", "flow"],
    },
    workflows: generatedWorkflows,
  });
  const cachePath = generatedCatalogCachePath(repoRoot);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(
    cachePath,
    `${JSON.stringify({
      version: WORKFLOW_CATALOG_GENERATOR_VERSION,
      source_digest: sourceDigest,
      catalog_root: root,
      generated_at: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );
  return root;
}

async function withLoopshipWorkspaceEnv<T>(
  repoRoot: string,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = process.env.LOOPSHIP_WORKSPACE_ROOT;
  process.env.LOOPSHIP_WORKSPACE_ROOT = resolve(repoRoot);
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.LOOPSHIP_WORKSPACE_ROOT;
    else process.env.LOOPSHIP_WORKSPACE_ROOT = previous;
  }
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
        executeFastflowWorkflowRunRequest,
      } from ${JSON.stringify(pathToFileURL(resolve(fastflowRoot, "src", "index.mjs")).href)};
      import { executeFastflowWorkflowResumeRequest } from ${JSON.stringify(
        pathToFileURL(resolve(fastflowRoot, "src", "lib", "core-v1.mjs")).href,
      )};
      import {
        LOOPSHIP_CALL_CATALOG_ROOT,
        createLoopshipFastflowAdapters,
      } from ${JSON.stringify(pathToFileURL(fileURLToPath(import.meta.url)).href)};

      const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
      process.env.LOOPSHIP_WORKSPACE_ROOT = ${JSON.stringify(workspaceRoot)};
      configureFastflowApp({
        appName: "loopship",
        systemWorkflowsDir: ${JSON.stringify(input.catalogRoot)},
        callCatalogRoots: [${JSON.stringify(input.catalogRoot)}, LOOPSHIP_CALL_CATALOG_ROOT],
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
      timeoutMs: 180_000,
    });
    if (proc.status !== 0) {
      throw new Error(proc.stderr || proc.stdout || "Fastflow session command failed");
    }
    const lines = proc.stdout.trim().split(/\r?\n/).filter(Boolean);
    const parsed = JSON.parse(lines[lines.length - 1] || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Fastflow session command returned a non-object result.");
    }
    return parsed as Record<string, unknown>;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function startLoopshipFastflowStepSession(input: {
  repoRoot: string;
  workspaceRoot?: string;
  stepId: string;
  stageId?: string;
  flowId?: string;
  inputs: Record<string, unknown>;
}): Promise<LoopshipFastflowSession | null> {
  const catalogRoot = await ensureLoopshipFastflowWorkflowCatalog(LOOPSHIP_ROOT);
  const workflowRef = loopshipFlowWorkflowRef(input.flowId || DEFAULT_FLOW_ID);
  const result = runFastflowNodeSession({
    repoRoot: input.repoRoot,
    workspaceRoot: input.workspaceRoot,
    catalogRoot,
    operation: "run",
    request: buildLoopshipFastflowSuperviseStepRunRequest({
      workflowRef,
      inputs: {
        ...input.inputs,
        mode: "step",
        stage: input.stageId || (input.inputs.state as string | undefined) || "",
        step_id: input.stepId,
      },
      progressMode: "compact",
    }),
  });
  if (result?.status !== "paused" || !result.pause?.sessionId || !result.pause?.nonce) {
    return null;
  }
  return {
    schema_version: "loopship.fastflow.session/v1",
    workflow_ref: workflowRef,
    step_id: input.stepId,
    session_id: result.pause.sessionId,
    nonce: result.pause.nonce,
  };
}

export async function runLoopshipFastflowStepOnce(input: {
  repoRoot: string;
  workspaceRoot?: string;
  stepId: string;
  stageId?: string;
  flowId?: string;
  inputs: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const catalogRoot = await ensureLoopshipFastflowWorkflowCatalog(LOOPSHIP_ROOT);
  const workflowRef = loopshipFlowWorkflowRef(input.flowId || DEFAULT_FLOW_ID);
  return runFastflowNodeSession({
    repoRoot: input.repoRoot,
    workspaceRoot: input.workspaceRoot,
    catalogRoot,
    operation: "run",
    request: buildLoopshipFastflowSuperviseStepRunRequest({
      workflowRef,
      inputs: {
        ...input.inputs,
        mode: "step",
        stage: input.stageId || (input.inputs.state as string | undefined) || "",
        step_id: input.stepId,
      },
      progressMode: "compact",
    }),
  });
}

export async function resumeLoopshipFastflowStepSession(input: {
  repoRoot: string;
  workspaceRoot?: string;
  session: LoopshipFastflowSession;
  decision: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const catalogRoot = await ensureLoopshipFastflowWorkflowCatalog(LOOPSHIP_ROOT);
  return runFastflowNodeSession({
    repoRoot: input.repoRoot,
    workspaceRoot: input.workspaceRoot,
    catalogRoot,
    operation: "resume",
    request: {
      sessionId: input.session.session_id,
      nonce: input.session.nonce,
      decision: {
        ok: true,
        decision: input.decision,
      },
      progressMode: "compact",
    },
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
      next: command("loopship", ["resume", "--wtree", childWtree, "--json", "@-"]),
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
    normalized === ".loopship/runtime/hook-state.json" ||
    normalized === ".loopship/runtime/lock.json" ||
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

function commitDurableLoopshipState(cwd: string, message: string): string | null {
  if (!existsSync(resolve(cwd, ".loopship"))) return null;
  const add = runCommand("git", ["add", "--", ".loopship"], {
    cwd,
    timeoutMs: 30_000,
  });
  if (add.status !== 0) {
    throw new Error(add.stderr || add.stdout || "failed to stage .loopship state");
  }
  const durablePathspec = [".loopship"];
  const diff = runCommand("git", ["diff", "--cached", "--quiet", "--", ...durablePathspec], {
    cwd,
    timeoutMs: 15_000,
  });
  if (diff.status === 0) return null;
  if (diff.status !== 1) {
    throw new Error(diff.stderr || diff.stdout || "failed to inspect staged .loopship state");
  }
  const commit = runCommand("git", ["commit", "-m", message, "--", ...durablePathspec], {
    cwd,
    timeoutMs: 60_000,
  });
  if (commit.status !== 0) {
    throw new Error(commit.stderr || commit.stdout || "failed to commit .loopship state");
  }
  return gitRevParse(cwd, "HEAD");
}

function gitIsAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  const proc = runCommand("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    timeoutMs: 15_000,
  });
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
  const dirtyTargetNonLoopshipEntries = nonLoopshipGitDirtyEntries(workspace.worktree_path);
  if (dirtyTargetNonLoopshipEntries.length) {
    throw new Error(
      `cannot merge into dirty landing target worktree ${workspace.worktree_path}: ${dirtyTargetNonLoopshipEntries.slice(0, 5).join(", ")}`,
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
  if (!ffOnly) {
    commitDurableLoopshipState(
      workspace.worktree_path,
      `chore(loopship): record ${input.targetBranch} target state`,
    );
  }
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
  const dirtyAfterMerge = nonLoopshipGitDirtyEntries(workspace.worktree_path);
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

function verifiedRecordedReceipt(input: {
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  targetWorktree: string;
  receipt: Record<string, unknown>;
}): Record<string, unknown> {
  const landedCommit = requireString(input.receipt.landed_commit, "receipt.landed_commit");
  const targetBranch = optionalString(input.receipt.target_branch) || input.targetBranch;
  const sourceBranch = optionalString(input.receipt.source_branch) || input.sourceBranch;
  const targetWorktree = optionalString(input.receipt.target_worktree) || input.targetWorktree;
  gitRevParse(input.repo, landedCommit);
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
    const dirtyTargetEntries = nonLoopshipGitDirtyEntries(targetWorktree);
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

function executeLandingApply(body: Record<string, unknown>): Record<string, unknown> {
  const repo = requireString(body.repo, "repo");
  const wtree = requireString(body.wtree, "wtree");
  const files = questFiles(repo, wtree);
  if (!existsSync(files.tasks)) {
    throw new Error(`missing Loopship quest state for ${wtree}`);
  }
  const requestId = optionalString(body.request_id) || `fastflow-landing-${Date.now().toString(36)}`;
  const state = parseTasksYaml(readText(files.tasks)) as Record<string, unknown>;
  const sourceBranch = optionalString(body.source_branch) || String(state.coordinator_branch || "");
  const targetBranch =
    optionalString(body.target_branch) || String(state.landing_target_branch || "main");
  const targetWorktree =
    optionalString(body.target_worktree) ||
    String(state.landing_target_worktree || landingTargetWorktreePath(repo, targetBranch));
  const receipt = isPlainObject(body.receipt) ? body.receipt : {};
  const status = optionalString(body.status) || "landed";
  if (!["landed", "blocked"].includes(status)) {
    throw new Error("landing.apply status must be landed or blocked");
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
    appendJsonl(files.events, {
      event: "landing_submitted",
      quest_id: files.wtree,
      stage: "landing_ready",
      request_id: requestId,
      payload: { status, summary: optionalString(body.summary) },
    });
    updateQuestStage(files, "landing_ready", requestId, "loopship fastflow afn landing.apply");
    writeQuestManifest(files, requestId, "loopship fastflow afn landing.apply");
    return {
      schema_version: "loopship.landing.apply/v1",
      dry_run: false,
      status,
      source_branch: sourceBranch,
      target_branch: targetBranch,
      target_worktree: targetWorktree,
      summary: optionalString(body.summary),
    };
  }
  assertLandingPreflight({ repo, state });
  if (!sourceBranch) {
    throw new Error("landing.apply requires source_branch or state.coordinator_branch");
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
  updateQuestStage(files, "archived", requestId, "loopship fastflow afn landing.apply");
  writeQuestManifest(files, requestId, "loopship fastflow afn landing.apply");
  return {
    schema_version: "loopship.landing.apply/v1",
    dry_run: false,
    status,
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

export async function configureFastflowForLoopship(
  _repoRoot: string = LOOPSHIP_ROOT,
): Promise<Record<string, unknown>> {
  const { configureFastflowApp } = await import("@cueintent/fastflow");
  const workflowCatalogRoot = await ensureLoopshipFastflowWorkflowCatalog(LOOPSHIP_ROOT);
  return configureFastflowApp({
    appName: "loopship",
    systemWorkflowsDir: workflowCatalogRoot,
    callCatalogRoots: [workflowCatalogRoot, LOOPSHIP_CALL_CATALOG_ROOT],
    adapters: createLoopshipFastflowAdapters(),
  });
}

export async function getLoopshipFastflowAdapters(): Promise<Record<string, unknown>> {
  const { getFastflowAdapters } = await import("@cueintent/fastflow");
  return getFastflowAdapters();
}
