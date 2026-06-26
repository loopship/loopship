import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallDescriptor } from "@cueintent/fastflow";
import {
  DEFAULT_FLOW_ID,
  loadFlowDefinition,
  loadStepDefinitions,
  type LoopshipStepDefinition,
} from "./loopship_flow.ts";
import { dereferencedSchemaSource } from "./loopship_schema.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const LOOPSHIP_ROOT = resolve(SCRIPT_DIR, "..");
export const LOOPSHIP_CALL_CATALOG_ROOT = resolve(LOOPSHIP_ROOT, "call-catalog");
const PACKAGE_JSON = JSON.parse(
  readFileSync(resolve(LOOPSHIP_ROOT, "package.json"), "utf8"),
) as { name?: string; version?: string };

export const LOOPSHIP_AFN_CALLS = Object.freeze({
  childPrepare: "loopship.afn.service.child.prepare",
  systemApply: "loopship.afn.service.system.apply",
  landingApply: "loopship.afn.service.landing.apply",
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
        additionalProperties: true,
        required: ["repo", "wtree"],
        properties: {
          repo: { type: "string", minLength: 1 },
          wtree: { type: "string", minLength: 1 },
          task_id: { type: "string" },
          task: { type: "object" },
          parent: { type: "object" },
          runtime: { type: "string" },
          branch: { type: "string" },
          base_branch: { type: "string" },
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
      optional: ["actor", "reason", "dry_run"],
      schema: {
        type: "object",
        additionalProperties: true,
        required: ["repo", "update"],
        properties: {
          repo: { type: "string", minLength: 1 },
          update: { type: "object" },
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
      optional: ["receipt", "summary", "target_branch", "dry_run"],
      schema: {
        type: "object",
        additionalProperties: true,
        required: ["repo", "wtree"],
        properties: {
          repo: { type: "string", minLength: 1 },
          wtree: { type: "string", minLength: 1 },
          receipt: { type: "object" },
          summary: { type: "string" },
          target_branch: { type: "string" },
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
          defaultAdapter: "yaml",
          adapters: {
            yaml: { rootDir: "." },
            jsonl: { rootDir: "." },
          },
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
      {
        describe_flow: {
          metadata: commonTaskMetadata("Expose the Loopship flow graph as Fastflow-native data."),
          set: {
            schema_version: "loopship.flow-scaffold/v1",
            flow_id: flow.id,
            default_stage: flow.default_stage,
            stages: flow.stages,
            subflows: flow.subflows,
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

export function buildLoopshipFastflowAuditRunRequest(input: {
  workflowRef: string;
  inputs?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    workflowRef: input.workflowRef,
    inputs: input.inputs || {},
    supervisionMode: "audit",
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
      for (const field of descriptor.inputs.required) {
        if (!(field in body)) {
          throw new Error(`Loopship call '${call}' requires body.${field}.`);
        }
      }
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
    async executeAfn({ action }: { action?: { call?: string } } = {}) {
      throw new Error(
        `Loopship AFN '${action?.call || ""}' is registered but normal execution is not wired in this migration slice; run audit mode or the existing Loopship CLI.`,
      );
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
