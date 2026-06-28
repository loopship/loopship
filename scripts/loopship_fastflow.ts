import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
        "children",
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
          schema: inputSchema,
          build: {
            kind: "js",
            using: ["inputs", "state", "env"],
            code: `const quest = (state && state.steps && state.steps.read_tasks && state.steps.read_tasks.action) || {};
const queriedEvents = (state && state.steps && state.steps.query_events && state.steps.query_events.action) || [];
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
return {
  schema_version: inputs.schema_version || "loopship.step.request/v1",
  kind: inputs.kind || "quest_step_request",
  wtree: String(inputs.wtree || quest.wtree || ""),
  quest_id: String(inputs.quest_id || quest.quest_id || inputs.wtree || quest.wtree || ""),
  flow_id: String(inputs.flow_id || quest.flow_id || ${JSON.stringify(DEFAULT_FLOW_ID)}),
  flow_version: Number(inputs.flow_version || quest.flow_version || 1),
  current_stage: String(inputs.current_stage || quest.stage || ""),
  summary: String(inputs.summary || ${JSON.stringify(step.summary)}),
  prompt: String(inputs.prompt || quest.prompt || ""),
  repo: String(inputs.repo || inputs.repoRoot || quest.context_root || env.PWD || ""),
  repoRoot: String(inputs.repoRoot || inputs.repo || quest.context_root || env.PWD || ""),
  runtime: String(inputs.runtime || ""),
  tasks: array(inputs.tasks).length ? array(inputs.tasks) : array(quest.tasks),
  question_rounds: array(inputs.question_rounds).length ? array(inputs.question_rounds) : array(quest.question_rounds),
  plan_detail: Object.keys(object(inputs.plan_detail)).length ? object(inputs.plan_detail) : object(quest.plan_detail),
  validation_receipt: Object.keys(object(inputs.validation_receipt)).length ? object(inputs.validation_receipt) : object(quest.validation_receipt),
  verification_receipt: Object.keys(object(inputs.verification_receipt)).length ? object(inputs.verification_receipt) : object(quest.verification_receipt),
  events: array(inputs.events).length ? array(inputs.events) : array(queriedEvents),
  parent_wtree: String(inputs.parent_wtree || quest.parent_wtree || ""),
  coordinator_branch: String(inputs.coordinator_branch || quest.coordinator_branch || ""),
  coordinator_worktree: String(inputs.coordinator_worktree || quest.coordinator_worktree || ""),
  landing_target_branch: String(inputs.landing_target_branch || quest.landing_target_branch || ""),
  landing_target_worktree: String(inputs.landing_target_worktree || quest.landing_target_worktree || ""),
  requirements: array(inputs.requirements)
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
          children: "${Array.isArray(inputs.children) ? inputs.children : (inputs.task ? [inputs.task] : [inputs])}",
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

function requiredSchemaProperties(schema: Record<string, unknown>): Set<string> {
  return new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
}

function sideEffectStageInputExpression(
  key: string,
  step: LoopshipStepDefinition,
): string {
  if (key === "repo") {
    return "${inputs.repo || inputs.repoRoot || state.steps.read_tasks.action.context_root || env.PWD || ''}";
  }
  if (key === "repoRoot") {
    return "${inputs.repoRoot || inputs.repo || state.steps.read_tasks.action.context_root || env.PWD || ''}";
  }
  if (key === "wtree") return "${state.steps.read_tasks.action.wtree || inputs.wtree || ''}";
  if (key === "runtime") return "${inputs.runtime || ''}";
  if (key === "actor") return "${inputs.actor || 'loopship'}";
  if (key === "target_branch") {
    return "${inputs.target_branch || state.steps.read_tasks.action.landing_target_branch || 'main'}";
  }
  if (key === "target_worktree") {
    return "${inputs.target_worktree || state.steps.read_tasks.action.landing_target_worktree || ''}";
  }
  if (key === "source_branch") {
    return "${inputs.source_branch || state.steps.read_tasks.action.coordinator_branch || ''}";
  }
  if (key === "system_update") {
    return "${inputs.system_update || inputs.update || { schema_version: 1, mode: 'no_change', summary: '' }}";
  }
  if (key === "status") return "${inputs.status || 'landed'}";
  if (key === "summary") return "${inputs.summary || ''}";
  return inputAccessExpression(key);
}

function stepRequestStageInputExpression(
  key: string,
  flow: LoadedLoopshipFlow,
  stage: LoopshipFlowStage,
  step: LoopshipStepDefinition,
): unknown {
  if (key === "schema_version") return "loopship.step.request/v1";
  if (key === "kind") return "quest_step_request";
  if (key === "wtree") return "${state.steps.read_tasks.action.wtree || inputs.wtree || ''}";
  if (key === "quest_id") return "${state.steps.read_tasks.action.quest_id || state.steps.read_tasks.action.wtree || inputs.wtree || ''}";
  if (key === "flow_id") return flow.id;
  if (key === "flow_version") return flow.version;
  if (key === "current_stage") return stage.id;
  if (key === "summary") return step.summary;
  if (key === "prompt") return "${state.steps.read_tasks.action.prompt || inputs.request || ''}";
  if (key === "repo") return "${inputs.repo || inputs.repoRoot || state.steps.read_tasks.action.context_root || env.PWD || ''}";
  if (key === "repoRoot") return "${inputs.repoRoot || inputs.repo || state.steps.read_tasks.action.context_root || env.PWD || ''}";
  if (key === "runtime") return "${inputs.runtime || ''}";
  if (key === "tasks") return "${Array.isArray(state.steps.read_tasks.action.tasks) ? state.steps.read_tasks.action.tasks : []}";
  if (key === "question_rounds") return "${Array.isArray(state.steps.read_tasks.action.question_rounds) ? state.steps.read_tasks.action.question_rounds : []}";
  if (key === "plan_detail") return "${state.steps.read_tasks.action.plan_detail || {}}";
  if (key === "validation_receipt") return "${state.steps.read_tasks.action.validation_receipt || {}}";
  if (key === "verification_receipt") return "${state.steps.read_tasks.action.verification_receipt || {}}";
  if (key === "events") return "${Array.isArray(state.steps.query_events.action) ? state.steps.query_events.action : []}";
  if (key === "parent_wtree") return "${state.steps.read_tasks.action.parent_wtree || ''}";
  if (key === "coordinator_branch") return "${state.steps.read_tasks.action.coordinator_branch || ''}";
  if (key === "coordinator_worktree") return "${state.steps.read_tasks.action.coordinator_worktree || ''}";
  if (key === "landing_target_branch") return "${state.steps.read_tasks.action.landing_target_branch || 'main'}";
  if (key === "landing_target_worktree") return "${state.steps.read_tasks.action.landing_target_worktree || ''}";
  if (key === "requirements" && step.id === "plan") {
    return [
      "Classify the request.",
      "Use repository discovery before asking questions.",
      "Use AF to surface contradictions, hidden assumptions, weak evidence, and edge cases.",
      "Use OF to collapse scope, defaults, acceptance, decomposition, and verification targets.",
      "For greenfield app/product work, ask or explicitly default every high-impact unknown before task graph approval.",
    ];
  }
  if (key === "requirements") return [];
  return inputAccessExpression(key);
}

function workflowStepRequestInputFromSchema(
  flow: LoadedLoopshipFlow,
  stage: LoopshipFlowStage,
  step: LoopshipStepDefinition,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = isPlainObject(schema.properties)
    ? (schema.properties as Record<string, unknown>)
    : {};
  return Object.fromEntries(
    Object.keys(properties).map((key) => [
      key,
      stepRequestStageInputExpression(key, flow, stage, step),
    ]),
  );
}

function sideEffectWorkflowInputFromSchema(
  step: LoopshipStepDefinition,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = isPlainObject(schema.properties)
    ? (schema.properties as Record<string, unknown>)
    : {};
  const required = requiredSchemaProperties(schema);
  const sideEffectUseful = new Set([
    "repo",
    "repoRoot",
    "wtree",
    "runtime",
    "actor",
    "target_branch",
    "target_worktree",
    "source_branch",
  ]);
  return Object.fromEntries(
    Object.keys(properties)
      .filter((key) => required.has(key) || sideEffectUseful.has(key))
      .map((key) => [key, sideEffectStageInputExpression(key, step)]),
  );
}

function schemaRefOrEmbedded(source: unknown): unknown {
  if (source == null) return null;
  if (typeof source === "string") return { schema_path: source };
  return source;
}

function childDispatchExpression(_flow: LoadedLoopshipFlow): string {
  return "${inputs.children || []}";
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
  if (LOOPSHIP_AFN_CALL_SET.has(step.call)) {
    const input = sideEffectWorkflowInputFromSchema(step, schema);
    if ("children" in properties) {
      return {
        ...input,
        children: childDispatchExpression(flow),
      };
    }
    return input;
  }
  return workflowStepRequestInputFromSchema(flow, stage, step, schema);
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
      namespace: "service-step",
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
      return defaultTransitionKey(stageId, payload, tasks, resolved, args);`;
    }
    if (rule.kind === "static") {
      return `    case ${JSON.stringify(stage.id)}:
      return ${JSON.stringify(rule.value)};`;
    }
    return `    case ${JSON.stringify(stage.id)}: {
${indentGeneratedCode(rule.code, "      ")}
    }`;
  });
  return `function terminalTaskState(tasks) {
  const statuses = array(object(tasks).tasks)
    .map((task) => String(object(task).status || "child_received"))
    .filter(Boolean);
  if (!statuses.length) return "unknown";
  const done = new Set(["child_merged", "child_archived", "done", "merged"]);
  const stalled = new Set(["blocked", "deferred", "failed"]);
  if (statuses.every((status) => done.has(status))) return "all_done";
  if (statuses.every((status) => stalled.has(status))) return "all_stalled";
  return "continue";
}
function defaultTransitionKey(stageId, payload, tasks, resolved, args) {
  const transitions = object(object(resolved).transitions);
  if ("questions" in transitions && array(object(payload).questions).length) return "questions";
  if ("planned" in transitions && ("task_graph" in object(payload) || "classification" in object(payload))) return "planned";
  if ("answered" in transitions && "answers" in object(payload)) return "answered";
  if ("rejected" in transitions && (object(payload).approved === false || object(payload).rejected === true)) return "rejected";
  if ("approved" in transitions && object(payload).approved === true) return "approved";
  if ("complete" in transitions || "partial" in transitions) {
    const terminal = terminalTaskState(tasks);
    if (terminal === "all_done" && "complete" in transitions) return "complete";
    if (terminal === "all_stalled" && "failed_child" in transitions) return "failed_child";
    if ("partial" in transitions) return "partial";
  }
  const status = String(object(payload).status || object(args).status || "").trim();
  if (status && status in transitions) return status;
  if ("updated" in transitions && ("system_update" in object(payload) || "update" in object(payload) || "mode" in object(payload))) return "updated";
  return "continue";
}
function transitionKey(stageId, payload, tasks, resolved, args) {
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
function array(value) {
  return Array.isArray(value) ? value : [];
}
function stringList(value) {
  return array(value).map((item) => String(item || "").trim()).filter(Boolean);
}
function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-") || "main";
}
function normalizeTaskPathSegment(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[\\\\/]+/g, "-")
    .replace(/\\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "task";
}
function compactDigest(value) {
  const text = String(value || "");
  const fnv = (seed) => {
    let hash = seed;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  return (fnv(2166136261) + fnv(2166136261 ^ 0x9e3779b9)).slice(0, 12);
}
function compactTaskAssignmentKey(wtree, taskId) {
  const normalizedWtree = normalizeTaskPathSegment(wtree || "quest");
  const normalizedTaskId = normalizeTaskPathSegment(taskId || "task");
  const full = [normalizedWtree, normalizedTaskId].filter(Boolean).join("-");
  if (full.length <= 72) return full;
  const digest = compactDigest(full);
  const taskPart = normalizedTaskId.slice(0, 20).replace(/-+$/g, "") || "task";
  const wtreeBudget = Math.max(16, 72 - taskPart.length - digest.length - 2);
  const wtreePart = normalizedWtree.slice(0, wtreeBudget).replace(/-+$/g, "") || "quest";
  return [wtreePart, taskPart, digest].join("-");
}
function taskAssignmentBranchRef(wtree, taskId) {
  return "codex/" + compactTaskAssignmentKey(wtree, taskId);
}
function taskAssignmentChildWtree(wtree, taskId) {
  return compactTaskAssignmentKey(wtree, taskId);
}
function taskAssignmentMergeLeaseId(wtree, taskId) {
  return "lease-" + compactTaskAssignmentKey(wtree, taskId);
}
function taskAssignmentWorktreePath(contextRoot, wtree, taskId) {
  const root = String(contextRoot || ".").replace(/[\\\\/]+$/g, "");
  return root + "/worktrees/" + compactTaskAssignmentKey(wtree, taskId);
}
function taskAcceptance(value) {
  return Array.isArray(value) ? stringList(value).join("; ") : String(value || "").trim();
}
function normalizeSystemContext(value) {
  const row = object(value);
  return {
    relevant_object_refs: stringList(row.relevant_object_refs),
    relevant_assertion_refs: stringList(row.relevant_assertion_refs),
    relevant_resource_refs: stringList(row.relevant_resource_refs),
    relevant_memory_refs: stringList(row.relevant_memory_refs),
    durable_implications: array(row.durable_implications).filter((item) => Object.keys(object(item)).length),
  };
}
function normalizePlanTask(tasks, input, index) {
  const task = object(input);
  const wtree = String(tasks.wtree || "quest");
  const id = normalizeName(task.id || task.task_id || "task-" + (index + 1));
  const contextRoot = String(tasks.context_root || ".");
  const normalizedPrompt = String(tasks.prompt || "")
    .toLowerCase()
    .replace(/^loopship:\\s*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const leafChild = normalizedPrompt.startsWith("execute child task ");
  const coordinatorBranch = String(tasks.coordinator_branch || "main");
  const coordinatorWorktree = String(tasks.coordinator_worktree || contextRoot);
  return {
    id,
    title: String(task.title || task.name || id),
    type: task.type === "general" ? "general" : "coding",
    status: String(task.status || (leafChild ? "pending" : "child_received")),
    dependencies: stringList(task.dependencies || task.depends_on).map(normalizeName),
    scope_files: stringList(task.scope_files || task.scope),
    spec_refs: stringList(task.spec_refs || task.specs),
    context_refs: stringList(task.context_refs || task.context),
    branch_ref: String(task.branch_ref || (leafChild ? coordinatorBranch : taskAssignmentBranchRef(wtree, id))),
    worktree_path: String(task.worktree_path || (leafChild ? coordinatorWorktree : taskAssignmentWorktreePath(contextRoot, wtree, id))),
    child_wtree: String(task.child_wtree || (leafChild ? "" : taskAssignmentChildWtree(wtree, id))),
    concurrency_group: String(task.concurrency_group || ""),
    merge_target: String(task.merge_target || coordinatorBranch),
    merge_lease_id: String(task.merge_lease_id || (leafChild ? "" : taskAssignmentMergeLeaseId(wtree, id))),
    merge_commit: String(task.merge_commit || ""),
    system_impact_ref: String(task.system_impact_ref || ""),
    acceptance: taskAcceptance(task.acceptance || task.acceptance_criteria)
  };
}
function decisionPayload(value) {
  const out = object(value);
  const decision = object(out.decision);
  if (Object.prototype.hasOwnProperty.call(decision, "decision")) return decision.decision;
  if (Object.keys(decision).length) return decision;
  if (Object.prototype.hasOwnProperty.call(out, "decision")) return out.decision;
  return out;
}
function payloadMatchesStep(payload, stepId) {
  const row = object(payload);
  if (stepId === "plan") {
    return "classification" in row || "questions" in row || "task_graph" in row;
  }
  if (stepId === "questions") return "answers" in row;
  if (stepId === "task_graph") return "approved" in row || "rejected" in row || "replan_reason" in row;
  if (stepId === "child_result") return "child_wtree" in row || "merge_commit" in row;
  if (stepId === "validation") return "checks" in row && "status" in row;
  if (stepId === "verification") return "acceptance_trace" in row || "risks" in row;
  if (stepId === "system_update") return "system_update" in row || "update" in row || "mode" in row;
  if (stepId === "landing") return "status" in row && "summary" in row;
  return Object.keys(row).length > 0;
}
function findStepPayload(value, stepId, depth = 0) {
  if (depth > 8 || !value || typeof value !== "object") return {};
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStepPayload(item, stepId, depth + 1);
      if (payloadMatchesStep(found, stepId)) return found;
    }
    return {};
  }
  const row = object(value);
  const direct = decisionPayload(row);
  if (payloadMatchesStep(direct, stepId)) return direct;
  for (const key of ["output", "result", "workflow", "action", "value", "answer"]) {
    if (key in row) {
      const found = findStepPayload(row[key], stepId, depth + 1);
      if (payloadMatchesStep(found, stepId)) return found;
    }
  }
  for (const item of Object.values(row)) {
    const found = findStepPayload(item, stepId, depth + 1);
    if (payloadMatchesStep(found, stepId)) return found;
  }
  return {};
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
function answerKey(answer) {
  return String(answer.question_id || answer.id || "").trim();
}
function mergeAnswersIntoLatestQuestionRound(tasks, answers) {
  const rounds = array(tasks.question_rounds).map((round) => ({
    ...object(round),
    questions: array(object(round).questions)
  }));
  if (!rounds.length) return rounds;
  const latest = rounds[rounds.length - 1];
  const byId = new Map();
  const byQuestion = new Map();
  for (const answer of answers) {
    const row = object(answer);
    const key = answerKey(row);
    if (key) byId.set(key, row);
    const question = String(row.question || "").trim();
    if (question) byQuestion.set(question, row);
  }
  latest.questions = array(latest.questions).map((question) => {
    const row = object(question);
    const answer = byId.get(String(row.id || "").trim()) ||
      byQuestion.get(String(row.question || "").trim());
    if (!answer) return row;
    return {
      ...row,
      status: answer.accepted_default ? "defaulted" : "answered",
      answer: String(answer.answer || "").trim(),
      accepted_default: Boolean(answer.accepted_default)
    };
  });
  return rounds;
}
function statePatchForPayload(tasks, payload, stepId, targetStage) {
  const patch = { stage: targetStage };
  if (stepId === "plan") {
    const questions = array(payload.questions);
    if (questions.length) {
      return {
        ...patch,
        question_rounds: [...array(tasks.question_rounds), { questions }]
      };
    }
    const taskInputs = array(object(payload.task_graph).tasks);
    return {
      ...patch,
      assumptions: stringList(payload.assumptions),
      constraints: stringList(payload.constraints),
      plan_detail: {
        classification: String(payload.classification || ""),
        scope: String(payload.scope || ""),
        summary: String(payload.summary || payload.scope || ""),
        rationale: String(payload.summary || payload.scope || ""),
        system_context: normalizeSystemContext(payload.system_context),
        high_impact_unknowns: stringList(payload.high_impact_unknowns),
        defaulted_unknowns: stringList(payload.defaulted_unknowns),
        verification_targets: stringList(payload.verification_targets),
        decomposition_rationale: String(payload.decomposition_rationale || payload.summary || "")
      },
      tasks: taskInputs.map((task, index) => normalizePlanTask(tasks, task, index))
    };
  }
  if (stepId === "questions") {
    return {
      ...patch,
      question_rounds: mergeAnswersIntoLatestQuestionRound(tasks, array(payload.answers))
    };
  }
  if (stepId === "child_result") {
    return { ...patch, tasks: tasksAfterPayload(tasks, payload, stepId).tasks || array(tasks.tasks) };
  }
  if (stepId === "validation") {
    return {
      ...patch,
      validation_receipt: {
        status: String(payload.status || ""),
        checks: array(payload.checks)
      }
    };
  }
  if (stepId === "verification") {
    return {
      ...patch,
      verification_receipt: {
        status: String(payload.status || ""),
        acceptance_trace: array(payload.acceptance_trace),
        risks: array(payload.risks)
      }
    };
  }
  return patch;
}
function domainEventForPayload(payload, stepId, targetStage, transition) {
  if (stepId === "plan") {
    const questions = array(payload.questions);
    if (questions.length) return { event: "question_round", stage: targetStage, question_count: questions.length };
    return {
      event: "plan_submitted",
      stage: targetStage,
      classification: String(payload.classification || ""),
      task_count: array(object(payload.task_graph).tasks).length,
      verification_target_count: array(payload.verification_targets).length
    };
  }
  if (stepId === "questions") {
    return { event: "answers_submitted", stage: targetStage, answer_count: array(payload.answers).length };
  }
  if (stepId === "task_graph") {
    return { event: payload.approved === false ? "task_graph_rejected" : "task_graph_approved", stage: targetStage };
  }
  if (stepId === "child_result") {
    return {
      event: "child_result_submitted",
      stage: targetStage,
      task_id: String(payload.task_id || ""),
      child_wtree: String(payload.child_wtree || ""),
      status: String(payload.status || ""),
      merge_commit: String(payload.merge_commit || "")
    };
  }
  if (stepId === "validation") {
    return { event: "validation_submitted", stage: targetStage, status: String(payload.status || ""), check_count: array(payload.checks).length };
  }
  if (stepId === "verification") {
    return {
      event: "verification_submitted",
      stage: targetStage,
      status: String(payload.status || ""),
      acceptance_count: array(payload.acceptance_trace).length,
      risk_count: array(payload.risks).length
    };
  }
  if (stepId === "system_update") {
    return { event: "system_update_submitted", stage: targetStage };
  }
  if (stepId === "landing") {
    return { event: "landing_submitted", stage: targetStage, status: String(payload.status || transition || "") };
  }
  return { event: "step_submitted", stage: targetStage, step: stepId };
}
${buildTransitionKeyFunction(flow)}
const resolved = object(state.steps.resolve_stage?.action);
const currentStage = String(resolved.current_stage || args.stage || flow.default_stage);
const stage = flow.stages.find((item) => item.id === currentStage) ||
  flow.stages.find((item) => item.id === flow.default_stage);
const taskName = stageTaskNames[stage.id];
const stageAction = object(state.steps[taskName]?.action);
const tasks = object(state.steps.read_tasks?.action);
const stepId = inputStepByStage[stage.id] || stage.step;
const payload = findStepPayload(stageAction, stepId);
const transitionTasks = tasksAfterPayload(tasks, payload, stepId);
const key = transitionKey(stage.id, payload, transitionTasks, resolved, args);
const transitions = object(stage.transitions);
const targetStage = transitions[key] || stage.id;
const statePatch = statePatchForPayload(tasks, payload, stepId, targetStage);
const domainEvent = domainEventForPayload(payload, stepId, targetStage, key);
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
  state_patch: statePatch,
  events: [
    {
      schema_version: "1.0.0",
      payload: {
        ...domainEvent,
        transition: key,
        step: stepId,
        stage_before: stage.id,
        stage_after: targetStage
      }
    },
    {
      schema_version: "1.0.0",
      payload: {
        event: "stage_changed",
        stage: targetStage,
        transition: key,
        step: stepId,
        stage_before: stage.id,
        stage_after: targetStage
      }
    }
  ],
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
      namespace: "service-flows",
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
              events: "${state.steps.derive_transition.action.events}",
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

function resolveFastflowRoot(requiredFiles = ["src/index.mjs", "src/catalog.mjs"]): string {
  const candidates = [
    resolve(LOOPSHIP_ROOT, "node_modules", "@cueintent", "fastflow"),
    resolve(LOOPSHIP_ROOT, "..", "..", "orgs", "cueintent", "fastflow"),
    resolve(LOOPSHIP_ROOT, "..", "..", "..", "..", "cueintent", "fastflow"),
    resolve(LOOPSHIP_ROOT, "..", "..", "..", "..", "orgs", "cueintent", "fastflow"),
  ];
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

export async function ensureLoopshipFastflowWorkflowCatalog(
  _repoRoot: string,
): Promise<string> {
  if (!generatedCatalogIsComplete(LOOPSHIP_CALL_CATALOG_ROOT)) {
    throw new Error(`Loopship Fastflow call catalog is incomplete: ${LOOPSHIP_CALL_CATALOG_ROOT}`);
  }
  return LOOPSHIP_CALL_CATALOG_ROOT;
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
        executeFastflowWorkflowResumeRequest,
        executeFastflowWorkflowRunRequest,
      } from ${JSON.stringify(pathToFileURL(resolve(fastflowRoot, "src", "index.mjs")).href)};
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

function prepareChildLaunch(
  body: Record<string, unknown>,
  task: Record<string, unknown>,
): Record<string, unknown> {
  const repo = requireString(body.repo, "repo");
  const parentWtree = requireString(body.wtree, "wtree");
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
    actions: {
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

function executeChildPrepare(body: Record<string, unknown>): Record<string, unknown> {
  const childInputs = Array.isArray(body.children)
    ? body.children.filter(isPlainObject)
    : [isPlainObject(body.task) ? body.task : {}];
  const preparedChildren = childInputs.map((task) => prepareChildLaunch(body, task));
  const first = preparedChildren[0] || {};
  return {
    schema_version: "loopship.child.prepare/v1",
    ...first,
    prepared_children: preparedChildren,
    children: preparedChildren,
    count: preparedChildren.length,
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
    summary: optionalString(body.summary),
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
