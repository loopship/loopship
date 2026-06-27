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
import type { CallDescriptor } from "@cueintent/fastflow";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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

export type LoopshipFastflowSession = {
  schema_version: "loopship.fastflow.session/v1";
  workflow_ref: string;
  step_id: string;
  session_id: string;
  nonce: string;
};

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
          update: "${inputs.system_update || inputs.update || inputs}",
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
  if (!["executing", "system_update", "landing"].includes(step.id)) return null;
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      schema_version: { type: "string" },
    },
  };
}

function sideEffectInputSchemaSource(step: LoopshipStepDefinition): unknown {
  if (["system_update", "landing"].includes(step.id)) return step.output_schema;
  return step.input_schema;
}

function stepActionOutputSchema(
  step: LoopshipStepDefinition,
  outputSchema: Record<string, unknown>,
): Record<string, unknown> {
  if (["executing", "system_update", "landing"].includes(step.id)) return outputSchema;
  return {
    type: "object",
    additionalProperties: true,
  };
}

function augmentSideEffectInputSchema(
  step: LoopshipStepDefinition,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!["executing", "system_update", "landing"].includes(step.id)) return schema;
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

export function buildLoopshipFastflowStepWorkflow(
  step: LoopshipStepDefinition,
): FastflowRecord {
  const inputSchema = augmentSideEffectInputSchema(
    step,
    asObjectSchema(dereferencedSchemaSource(sideEffectInputSchemaSource(step))),
  );
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
      summary: `Loopship ${flow.id} flow runtime snapshot for Fastflow-native supervision.`,
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
            schema_version: "loopship.flow-runtime-snapshot/v1",
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

async function hashFastflowWorkflow(workflow: FastflowRecord): Promise<string> {
  const { hashSwfWorkflow } = await import(
    pathToFileURL(resolve(resolveFastflowRoot(), "src", "lib", "swf-compat.mjs")).href
  );
  return `sha256:${hashSwfWorkflow(workflow)}`;
}

function loopshipCatalogRoot(repoRoot: string): string {
  return resolve(repoRoot, ".loopship", "call-catalog");
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

async function writeStableWorkflow(
  root: string,
  scope: string,
  name: string,
  workflow: FastflowRecord,
): Promise<void> {
  const materialized = structuredClone(workflow) as FastflowRecord;
  materialized.document = {
    ...((materialized.document as Record<string, unknown> | undefined) || {}),
    namespace: `${LOOPSHIP_WORKFLOW_TARGET}-${scope}`,
  };
  const dir = resolve(
    root,
    LOOPSHIP_WORKFLOW_REGISTRY,
    "workflow",
    LOOPSHIP_WORKFLOW_TARGET,
    scope,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, `${name}.stable.yaml`),
    stringifyYaml(materialized, { aliasDuplicateObjects: false }),
    "utf8",
  );
  const indexPath = resolve(dir, "index.yaml");
  const existing = existsSync(indexPath)
    ? parseYaml(readFileSync(indexPath, "utf8"))
    : null;
  const workflows =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...((existing as Record<string, any>).workflows || {}) }
      : {};
  workflows[name] = {
    stable: {
      release: 1,
      digest: await hashFastflowWorkflow(materialized),
      summary: String(
        (materialized.document as Record<string, unknown> | undefined)?.summary ||
          `${name} workflow`,
      ),
      inputs: { required: [], optional: [] },
      requires: [],
    },
  };
  writeFileSync(
    indexPath,
    stringifyYaml({
      schemaVersion: "fastflow/call-catalog-scope/v1",
      calls: [],
      workflows,
    }),
    "utf8",
  );
}

export async function ensureLoopshipFastflowWorkflowCatalog(
  repoRoot: string,
): Promise<string> {
  const root = loopshipCatalogRoot(repoRoot);
  mkdirSync(root, { recursive: true });
  const stepWorkflows = buildLoopshipFastflowStepWorkflows();
  for (const [stepId, workflow] of Object.entries(stepWorkflows)) {
    await writeStableWorkflow(root, LOOPSHIP_STEP_SCOPE, workflowNameForStep(stepId), workflow);
  }
  const flow = buildLoopshipFastflowFlowWorkflow(DEFAULT_FLOW_ID);
  await writeStableWorkflow(
    root,
    LOOPSHIP_FLOW_SCOPE,
    DEFAULT_FLOW_ID.replace(/_/g, "-"),
    flow,
  );
  writeFileSync(
    resolve(root, "index.yaml"),
    stringifyYaml({
      schemaVersion: "fastflow/call-catalog-manifest/v2",
      pathTemplate: "{registry}/{kind}/{target}/{scope}/index.yaml",
      prefixes: {
        loopship: {
          workflow: {
            service: {
              step: {
                path: "loopship/workflow/service/step/index.yaml",
                tags: ["loopship", "step"],
              },
              flows: {
                path: "loopship/workflow/service/flows/index.yaml",
                tags: ["loopship", "flow"],
              },
            },
          },
        },
      },
    }),
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
  catalogRoot: string;
  operation: "run" | "resume";
  request: Record<string, unknown>;
}): Record<string, unknown> {
  const tempDir = mkdtempSync(join(tmpdir(), "loopship-fastflow-session-"));
  const requestPath = join(tempDir, "request.json");
  const scriptPath = join(tempDir, "run.mjs");
  const fastflowRoot = resolveFastflowRoot();
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
      process.env.LOOPSHIP_WORKSPACE_ROOT = ${JSON.stringify(resolve(input.repoRoot))};
      configureFastflowApp({
        appName: "loopship",
        systemWorkflowsDir: ${JSON.stringify(input.catalogRoot)},
        callCatalogRoots: [${JSON.stringify(input.catalogRoot)}, LOOPSHIP_CALL_CATALOG_ROOT],
        adapters: createLoopshipFastflowAdapters(),
      });
      const result = ${JSON.stringify(input.operation)} === "run"
        ? await executeFastflowWorkflowRunRequest(request)
        : await executeFastflowWorkflowResumeRequest(request);
      console.log(JSON.stringify(result));
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
  stepId: string;
  inputs: Record<string, unknown>;
}): Promise<LoopshipFastflowSession | null> {
  const catalogRoot = await ensureLoopshipFastflowWorkflowCatalog(input.repoRoot);
  const workflowRef = loopshipStepWorkflowRef(input.stepId);
  const result = runFastflowNodeSession({
    repoRoot: input.repoRoot,
    catalogRoot,
    operation: "run",
    request: {
      workflowRef,
      inputs: input.inputs,
      progressMode: "compact",
    },
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

export async function resumeLoopshipFastflowStepSession(input: {
  repoRoot: string;
  session: LoopshipFastflowSession;
  decision: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const catalogRoot = await ensureLoopshipFastflowWorkflowCatalog(input.repoRoot);
  return runFastflowNodeSession({
    repoRoot: input.repoRoot,
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
  const add = runCommand("git", ["add", "--", ".loopship", ":(exclude).loopship/call-catalog"], {
    cwd,
    timeoutMs: 30_000,
  });
  if (add.status !== 0) {
    throw new Error(add.stderr || add.stdout || "failed to stage .loopship state");
  }
  const durablePathspec = [".loopship", ":(exclude).loopship/call-catalog"];
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
  repoRoot: string = LOOPSHIP_ROOT,
): Promise<Record<string, unknown>> {
  const { configureFastflowApp } = await import("@cueintent/fastflow");
  const workflowCatalogRoot = await ensureLoopshipFastflowWorkflowCatalog(repoRoot);
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
