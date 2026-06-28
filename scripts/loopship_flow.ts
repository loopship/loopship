#!/usr/bin/env bun

import { existsSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { readText } from "./loopship_utils.ts";
import {
  type LoopshipSchemaSource,
  v3SchemaFilePath,
} from "./loopship_schema.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_FLOW_ID = "swe";
export const DEFAULT_FLOW_VERSION = 1;
const FLOW_SOURCE_EXTENSION = ".flow.yaml";
const FLOW_WORKFLOW_EXTENSION = ".stable.yaml";
const CATALOG_WORKFLOW_ROOT = resolve(
  ROOT,
  "call-catalog",
  "loopship",
  "workflow",
  "service",
);
const FASTFLOW_REQUEST_INPUT_CALL = "fastflow.afn.core.request.input";
const LOOPSHIP_CHILD_PREPARE_CALL = "loopship.afn.service.child.prepare";
const LOOPSHIP_STEP_REQUEST_SCHEMA = "schemas/steps/step-request.yaml";
const LOOPSHIP_CHILD_DISPATCH_REQUEST_SCHEMA = "schemas/steps/child-dispatch-request.yaml";

export type LoopshipStepDefinition = {
  schema_version: 1;
  id: string;
  handler: string;
  call: string;
  input_step: string | null;
  input_schema: LoopshipSchemaSource;
  output_schema: LoopshipSchemaSource;
  result_schema: string;
  summary: string;
  instructions: string;
};

export type LoopshipTransitionKey =
  | { kind: "static"; value: string }
  | { kind: "js"; code: string };

export type LoopshipFlowStage = {
  id: string;
  step: string;
  transitions: Record<string, string>;
  transition_key: LoopshipTransitionKey | null;
};

export type LoopshipSubflowDefinition = {
  id: string;
  type: "in_flow_detour" | "spawned_quest";
  starts_at: string;
  returns_to: string;
  trigger: string;
  result_step?: string;
  flow_id?: string;
};

export type LoopshipFlowDefinition = {
  schema_version: 1;
  id: string;
  version: number;
  default_stage: string;
  stages: LoopshipFlowStage[];
  subflows: LoopshipSubflowDefinition[];
};

export type LoadedLoopshipFlow = LoopshipFlowDefinition & {
  stages_by_id: Record<string, LoopshipFlowStage>;
  steps_by_id: Record<string, LoopshipStepDefinition>;
};

function fail(message: string): never {
  throw new Error(message);
}

function readYamlObject(path: string): Record<string, any> {
  const parsed = parseYaml(readText(path));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`YAML document must be an object: ${path}`);
  }
  return parsed as Record<string, any>;
}

function repoRelativePath(path: string): string {
  return relative(ROOT, path).replace(/\\/g, "/");
}

function localSchemaIdPath(schemaId: unknown): string | null {
  if (typeof schemaId !== "string" || !schemaId.trim()) return null;
  const text = schemaId.trim();
  if (!text.startsWith("schemas/")) return null;
  const file = resolve(ROOT, text);
  if (!existsSync(file)) return null;
  const relativePath = relative(ROOT, file);
  if (relativePath.startsWith("..") || relativePath === "") return null;
  return text;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${path} must be a non-empty string`);
  }
  return value;
}

function transitionKeyFromStage(
  value: unknown,
  path: string,
): LoopshipTransitionKey | null {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const kind = stringValue(record.kind, `${path}.kind`);
  if (kind === "static") {
    return { kind, value: stringValue(record.value, `${path}.value`) };
  }
  if (kind === "js") {
    return { kind, code: stringValue(record.code, `${path}.code`) };
  }
  fail(`${path}.kind must be static or js`);
}

function schemaSourceFromSwfSchema(
  workflowPath: string,
  schema: unknown,
): LoopshipSchemaSource {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const document = (schema as Record<string, unknown>).document;
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return null;
  }
  const documentObject = document as Record<string, unknown>;
  const ref =
    typeof documentObject.$ref === "string" &&
    Object.keys(documentObject).length === 1
      ? documentObject.$ref
      : null;
  if (ref) {
    const resolved = resolve(dirname(workflowPath), ref);
    return repoRelativePath(resolved);
  }
  const localSchemaPath = localSchemaIdPath(documentObject.$id);
  if (localSchemaPath) return localSchemaPath;
  return documentObject;
}

function schemaSourceFromDocumentSchema(
  workflowPath: string,
  schema: unknown,
): LoopshipSchemaSource {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const documentObject = schema as Record<string, unknown>;
  const ref =
    typeof documentObject.$ref === "string" &&
    Object.keys(documentObject).length === 1
      ? documentObject.$ref
      : null;
  if (ref) {
    const resolved = resolve(dirname(workflowPath), ref);
    return repoRelativePath(resolved);
  }
  const localSchemaPath = localSchemaIdPath(documentObject.$id);
  if (localSchemaPath) return localSchemaPath;
  return documentObject;
}

function stepConstFromSchema(schema: LoopshipSchemaSource): string | null {
  const document =
    typeof schema === "string" ? readSchemaObject(schema) : schema;
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const stepProperty = (document as Record<string, any>).properties?.step;
  return typeof stepProperty?.const === "string" && stepProperty.const.trim()
    ? stepProperty.const
    : null;
}

function workflowInputSchemaForTask(input: {
  call: string;
  inputSchema: LoopshipSchemaSource;
}): LoopshipSchemaSource {
  if (input.call === FASTFLOW_REQUEST_INPUT_CALL) {
    return LOOPSHIP_STEP_REQUEST_SCHEMA;
  }
  if (input.call === LOOPSHIP_CHILD_PREPARE_CALL) {
    return LOOPSHIP_CHILD_DISPATCH_REQUEST_SCHEMA;
  }
  return input.inputSchema;
}

function normalizeStepInstructionText(value: unknown): string {
  return String(value ?? "");
}

function readSchemaObject(schemaPath: string): Record<string, any> | null {
  const path =
    schemaPath.endsWith(".yaml") || schemaPath.endsWith(".json")
      ? resolve(ROOT, schemaPath)
      : v3SchemaFilePath(schemaPath);
  if (!existsSync(path)) return null;
  return readYamlObject(path);
}

function assertKnownStepSchema(name: string | null, owner: string): void {
  if (name === null) return;
  if (typeof name !== "string" || !name.trim()) {
    fail(`${owner} schema ref must be a non-empty string or null`);
  }
  const ref = name.trim();
  const schemaPath =
    ref.endsWith(".yaml") || ref.endsWith(".json")
      ? resolve(ROOT, ref)
      : v3SchemaFilePath(ref);
  if (!existsSync(schemaPath)) {
    fail(`${owner} references missing step schema: ${name}`);
  }
}

function hasTransitionPath(
  stagesById: Record<string, LoopshipFlowStage>,
  startsAt: string,
  returnsTo: string,
): boolean {
  const visited = new Set<string>();
  const queue = [startsAt];
  while (queue.length) {
    const current = queue.shift() as string;
    if (current === returnsTo) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const target of Object.values(
      stagesById[current]?.transitions ?? {},
    )) {
      if (!visited.has(target)) queue.push(target);
    }
  }
  return false;
}

function assertKnownFlowRef(
  flowId: string,
  owner: string,
  currentFlowId: string,
  currentFlowPath: string,
): void {
  if (flowId === currentFlowId) return;
  const siblingFlow = resolve(dirname(currentFlowPath), `${flowId}${FLOW_SOURCE_EXTENSION}`);
  const bundledFlow = resolve(
    CATALOG_WORKFLOW_ROOT,
    "flows",
    `${flowId.replace(/_/g, "-")}${FLOW_WORKFLOW_EXTENSION}`,
  );
  if (!existsSync(siblingFlow) && !existsSync(bundledFlow)) {
    fail(`${owner}.flow_id references missing flow: ${flowId}`);
  }
}

export function loadStepDefinitions(
  dir = resolve(CATALOG_WORKFLOW_ROOT, "step"),
): Record<string, LoopshipStepDefinition> {
  if (!existsSync(dir)) fail(`missing steps directory: ${dir}`);
  const steps: Record<string, LoopshipStepDefinition> = {};
  for (const name of readdirSync(dir).filter((entry) =>
    entry.endsWith(".stable.yaml"),
  )) {
    const path = resolve(dir, name);
    const raw = readYamlObject(path);
    if (!Array.isArray(raw.do) || raw.do.length !== 1) {
      fail(`${path} step workflow must contain exactly one task`);
    }
    const taskEntry = raw.do[0];
    if (
      !taskEntry ||
      typeof taskEntry !== "object" ||
      Array.isArray(taskEntry) ||
      Object.keys(taskEntry).length !== 1
    ) {
      fail(`${path} step workflow task must be a single named task`);
    }
    const [taskName, taskDef] = Object.entries(taskEntry)[0] as [
      string,
      Record<string, any>,
    ];
    const id = taskName;
    if (steps[id]) fail(`duplicate step definition id: ${id}`);
    const rawInputSchema = schemaSourceFromSwfSchema(path, taskDef?.input?.schema);
    const call = taskDef?.call ? stringValue(taskDef.call, `${path}.${taskName}.call`) : "set";
    const inputSchema = workflowInputSchemaForTask({
      call,
      inputSchema: rawInputSchema,
    });
    const outputSchema =
      !taskDef?.call
        ? null
        : taskDef?.call === FASTFLOW_REQUEST_INPUT_CALL
          ? schemaSourceFromDocumentSchema(path, taskDef?.with?.body?.answer?.schema)
          : schemaSourceFromSwfSchema(path, taskDef?.output?.schema);
    if (typeof inputSchema === "string") assertKnownStepSchema(inputSchema, path);
    if (typeof outputSchema === "string") assertKnownStepSchema(outputSchema, path);
    const resultSchema = typeof inputSchema === "string" ? inputSchema : "schemas/steps/step-output.yaml";
    const handler = stepConstFromSchema(outputSchema) ?? id;
    steps[id] = {
      schema_version: 1,
      id,
      handler,
      call,
      input_step:
        outputSchema === null ? null : handler,
      input_schema: inputSchema,
      output_schema: outputSchema,
      result_schema: resultSchema,
      summary: String(
        raw.document?.summary ?? taskDef?.metadata?.description ?? "",
      ),
      instructions: String(
        normalizeStepInstructionText(
          taskDef?.with?.body?.instruction ??
            taskDef?.metadata?.description ??
            "",
        ),
      ),
    };
  }
  return steps;
}

export function loadFlowDefinition(flowId = DEFAULT_FLOW_ID): LoadedLoopshipFlow {
  const path = resolve(
    CATALOG_WORKFLOW_ROOT,
    "flows",
    `${flowId.replace(/_/g, "-")}${FLOW_WORKFLOW_EXTENSION}`,
  );
  if (!existsSync(path)) fail(`unknown flow: ${flowId}`);
  return loadFlowDefinitionFromPath(path, flowId);
}

export function loadFlowDefinitionFromPath(
  path: string,
  expectedFlowId?: string,
  stepsById = loadStepDefinitions(),
): LoadedLoopshipFlow {
  const loopshipFlow = readYamlObject(path);
  if (Array.isArray(loopshipFlow.do) && loopshipFlow.document && loopshipFlow.input && loopshipFlow.output) {
    return loadFlowDefinitionFromWorkflow(path, loopshipFlow, expectedFlowId, stepsById);
  }
  const flowId = stringValue(loopshipFlow.id, `${path}.id`);
  if (expectedFlowId && flowId !== expectedFlowId) {
    fail(`${path} flow id must match requested flow ${expectedFlowId}`);
  }
  const defaultStage = stringValue(
    loopshipFlow.default_stage ?? loopshipFlow.defaultStage,
    `${path}.default_stage`,
  );
  const stageRecords =
    loopshipFlow.stages &&
    typeof loopshipFlow.stages === "object" &&
    !Array.isArray(loopshipFlow.stages)
      ? (loopshipFlow.stages as Record<string, any>)
      : null;
  if (!stageRecords || !Object.keys(stageRecords).length) {
    fail(`${path} flow source must declare stages`);
  }

  const stages: LoopshipFlowStage[] = Object.entries(stageRecords).map(
    ([stageId, stageDef]) => {
      if (!stageDef || typeof stageDef !== "object" || Array.isArray(stageDef)) {
        fail(`${path}.stages.${stageId} must be an object`);
      }
      const stepId = String(
        stageDef.step ?? stageDef.stepId ?? "",
      );
      if (!stepsById[stepId]) {
        fail(`${path} stage ${stageId} references missing step workflow ${stepId}`);
      }
      const transitions =
        stageDef.transitions &&
        typeof stageDef.transitions === "object" &&
        !Array.isArray(stageDef.transitions)
          ? (stageDef.transitions as Record<string, string>)
          : {};
      return {
        id: stageId,
        step: stepId,
        transitions,
        transition_key: transitionKeyFromStage(
          stageDef.transitionKey ?? stageDef.transition_key,
          `${path}.stages.${stageId}.transitionKey`,
        ),
      };
    },
  );

  const stagesById: Record<string, LoopshipFlowStage> = {};
  for (const stage of stages) {
    if (stagesById[stage.id]) fail(`duplicate flow stage id: ${stage.id}`);
    stagesById[stage.id] = stage;
  }
  if (!stagesById[defaultStage]) {
    fail(`${path} default stage is not in stages: ${defaultStage}`);
  }
  for (const stage of stages) {
    for (const [name, target] of Object.entries(stage.transitions)) {
      if (!stagesById[target]) {
        fail(`${stage.id} transition ${name} targets missing stage ${target}`);
      }
    }
  }

  const subflowIds = new Set<string>();
  const subflowsRaw = Array.isArray(loopshipFlow.subflows) ? loopshipFlow.subflows : [];
  const subflows: LoopshipSubflowDefinition[] = subflowsRaw.map(
    (subflow: Record<string, any>, index: number) => {
      const prefix = `${path}.subflows[${index}]`;
      if (!subflow || typeof subflow !== "object" || Array.isArray(subflow)) {
        fail(`${prefix} must be an object`);
      }
      const id = stringValue(subflow.id, `${prefix}.id`);
      if (subflowIds.has(id)) fail(`duplicate flow subflow id: ${id}`);
      subflowIds.add(id);
      const type = stringValue(subflow.type, `${prefix}.type`);
      if (!["in_flow_detour", "spawned_quest"].includes(type)) {
        fail(`${prefix}.type is invalid`);
      }
      const startsAt = stringValue(subflow.starts_at, `${prefix}.starts_at`);
      const returnsTo = stringValue(subflow.returns_to, `${prefix}.returns_to`);
      if (!stagesById[startsAt]) fail(`${prefix}.starts_at targets missing stage ${startsAt}`);
      if (!stagesById[returnsTo]) fail(`${prefix}.returns_to targets missing stage ${returnsTo}`);
      if (type === "in_flow_detour" && !hasTransitionPath(stagesById, startsAt, returnsTo)) {
        fail(`${prefix}.returns_to is not reachable from starts_at ${startsAt}`);
      }
      const returnStep = stepsById[stagesById[returnsTo].step];
      const resultStep =
        subflow.result_step == null
          ? undefined
          : stringValue(subflow.result_step, `${prefix}.result_step`);
      const flowIdValue =
        subflow.flow_id == null
          ? undefined
          : stringValue(subflow.flow_id, `${prefix}.flow_id`);
      if (type === "spawned_quest") {
        const expectedResultStep = returnStep.input_step ?? returnStep.id;
        if (resultStep !== expectedResultStep) {
          fail(
            `${prefix}.result_step must match return stage input step ${expectedResultStep}`,
          );
        }
        assertKnownFlowRef(flowIdValue as string, prefix, flowId, path);
      }
      return {
        id,
        type: type as LoopshipSubflowDefinition["type"],
        starts_at: startsAt,
        returns_to: returnsTo,
        trigger: stringValue(subflow.trigger, `${prefix}.trigger`),
        result_step: resultStep,
        flow_id: flowIdValue,
      };
    },
  );

  return {
    schema_version: 1,
    id: flowId,
    version: Number(loopshipFlow.version ?? DEFAULT_FLOW_VERSION),
    default_stage: defaultStage,
    stages,
    subflows,
    stages_by_id: stagesById,
    steps_by_id: stepsById,
  };
}

function extractEmbeddedFlowFromResolveStage(
  workflow: Record<string, any>,
): Record<string, any> | null {
  const tasks = Array.isArray(workflow.do) ? workflow.do : [];
  const resolveStage = tasks.find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).resolve_stage,
  ) as Record<string, any> | undefined;
  const code = resolveStage?.resolve_stage?.run?.script?.code;
  if (typeof code !== "string") return null;
  const match = code.match(/const flow = (\{[\s\S]*?\});\nconst tasks = /);
  if (!match) return null;
  const parsed = JSON.parse(match[1]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, any>;
}

function loadFlowDefinitionFromEmbeddedFlow(
  path: string,
  workflow: Record<string, any>,
  expectedFlowId: string | undefined,
  stepsById: Record<string, LoopshipStepDefinition>,
): LoadedLoopshipFlow | null {
  const embedded = extractEmbeddedFlowFromResolveStage(workflow);
  if (!embedded) return null;
  const name = stringValue(workflow.document?.name, `${path}.document.name`);
  const flowId = expectedFlowId || stringValue(embedded.id ?? name.replace(/-/g, "_"), `${path}.flow.id`);
  if (expectedFlowId && flowId !== expectedFlowId) {
    fail(`${path} flow id must match requested flow ${expectedFlowId}`);
  }
  const defaultStage = stringValue(embedded.default_stage, `${path}.flow.default_stage`);
  const rawStages = Array.isArray(embedded.stages) ? embedded.stages : [];
  if (!rawStages.length) fail(`${path} embedded Fastflow flow must declare stages`);
  const stages = rawStages.map((stage, index) => {
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
      fail(`${path}.flow.stages[${index}] must be an object`);
    }
    const stageId = stringValue(stage.id, `${path}.flow.stages[${index}].id`);
    const stepId = stringValue(stage.step, `${path}.flow.stages[${index}].step`);
    if (!stepsById[stepId]) {
      fail(`${path} stage ${stageId} references missing step workflow ${stepId}`);
    }
    const transitions =
      stage.transitions &&
      typeof stage.transitions === "object" &&
      !Array.isArray(stage.transitions)
        ? Object.fromEntries(
            Object.entries(stage.transitions as Record<string, unknown>)
              .map(([key, value]) => [key, String(value)]),
          )
        : {};
    return {
      id: stageId,
      step: stepId,
      transitions,
      transition_key: null,
    };
  });
  const stagesById: Record<string, LoopshipFlowStage> = {};
  for (const stage of stages) {
    if (stagesById[stage.id]) fail(`duplicate flow stage id: ${stage.id}`);
    stagesById[stage.id] = stage;
  }
  if (!stagesById[defaultStage]) {
    fail(`${path} default stage is not in stages: ${defaultStage}`);
  }
  return {
    schema_version: 1,
    id: flowId,
    version: DEFAULT_FLOW_VERSION,
    default_stage: defaultStage,
    stages,
    subflows: Array.isArray(embedded.subflows)
      ? (embedded.subflows as LoopshipSubflowDefinition[])
      : [],
    stages_by_id: stagesById,
    steps_by_id: stepsById,
  };
}

function loadFlowDefinitionFromWorkflow(
  path: string,
  workflow: Record<string, any>,
  expectedFlowId: string | undefined,
  stepsById: Record<string, LoopshipStepDefinition>,
): LoadedLoopshipFlow {
  const embeddedFlow = loadFlowDefinitionFromEmbeddedFlow(
    path,
    workflow,
    expectedFlowId,
    stepsById,
  );
  if (embeddedFlow) return embeddedFlow;
  fail(`${path} Fastflow flow workflow must include a generated resolve_stage script with an embedded flow graph`);
}

export function flowStage(
  flow: LoadedLoopshipFlow,
  stageId: string | null | undefined,
): LoopshipFlowStage {
  const id = stageId?.trim() || flow.default_stage;
  return flow.stages_by_id[id] ?? flow.stages_by_id[flow.default_stage];
}

export function flowStep(
  flow: LoadedLoopshipFlow,
  stageId: string | null | undefined,
): LoopshipStepDefinition {
  const stage = flowStage(flow, stageId);
  return flow.steps_by_id[stage.step];
}

export function listBundledFlows(): Array<{
  id: string;
  version: number;
  default_stage: string;
  stages: string[];
  subflows: string[];
}> {
  const dir = resolve(CATALOG_WORKFLOW_ROOT, "flows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(FLOW_WORKFLOW_EXTENSION))
    .map((name) => loadFlowDefinition(name.slice(0, -FLOW_WORKFLOW_EXTENSION.length).replace(/-/g, "_")))
    .map((flow) => ({
      id: flow.id,
      version: flow.version,
      default_stage: flow.default_stage,
      stages: flow.stages.map((stage) => stage.id),
      subflows: flow.subflows.map((subflow) => subflow.id),
    }));
}
