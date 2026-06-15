#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_FLOW_ID,
  DEFAULT_FLOW_VERSION,
  flowStage,
  flowStep,
  listBundledFlows,
  loadFlowDefinition,
  loadFlowDefinitionFromPath,
  loadStepDefinitions,
  type LoadedLoopshipFlow,
  type LoopshipStepDefinition,
} from "./loopship_flow.ts";
import { FLOW_SCHEMA_PATH, validateSchemaPath } from "./loopship_schema.ts";
import { readText } from "./loopship_utils.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const WORKFLOW_SCHEMA_FILE = resolve(ROOT, FLOW_SCHEMA_PATH);

type ValidationPhase =
  | "loopship_schema"
  | "official_swf_schema"
  | "loopship_semantics";

export type LoopshipWorkflowValidationPolicy = {
  facade: {
    entrypoint: string;
  };
  phases: ValidationPhase[];
  allowedDslVersions: string[];
  allowedFeatures: string[];
};

export type LoopshipWorkflowRecord = {
  filePath: string;
  rawWorkflow: Record<string, unknown>;
  workflowId: string;
  workflowVersion: string;
  workflowKind: "flow" | "step-workflow" | null;
  flow: LoadedLoopshipFlow | null;
  step: LoopshipStepDefinition | null;
};

let cachedValidationPolicy: LoopshipWorkflowValidationPolicy | null = null;

function readYamlObject(path: string): Record<string, unknown> {
  const parsed = parseYaml(readText(path));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`YAML document must be an object: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

export function loadWorkflowValidationPolicy(): LoopshipWorkflowValidationPolicy {
  if (cachedValidationPolicy) return cachedValidationPolicy;
  const rawSchema = readYamlObject(WORKFLOW_SCHEMA_FILE);
  const rawPolicy =
    rawSchema["x-loopship-validation"] &&
    typeof rawSchema["x-loopship-validation"] === "object" &&
    !Array.isArray(rawSchema["x-loopship-validation"])
      ? (rawSchema["x-loopship-validation"] as Record<string, unknown>)
      : {};
  const rawFacade =
    rawPolicy.facade &&
    typeof rawPolicy.facade === "object" &&
    !Array.isArray(rawPolicy.facade)
      ? (rawPolicy.facade as Record<string, unknown>)
      : {};
  const phases = Array.isArray(rawPolicy.phases)
    ? rawPolicy.phases.filter(
        (phase): phase is ValidationPhase =>
          phase === "loopship_schema" ||
          phase === "official_swf_schema" ||
          phase === "loopship_semantics",
      )
    : [];
  const allowedDslVersions = Array.isArray(rawPolicy.allowedDslVersions)
    ? rawPolicy.allowedDslVersions
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const allowedFeatures = Array.isArray(rawPolicy.allowedFeatures)
    ? rawPolicy.allowedFeatures
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];

  cachedValidationPolicy = {
    facade: {
      entrypoint:
        typeof rawFacade.entrypoint === "string" && rawFacade.entrypoint.trim()
          ? rawFacade.entrypoint.trim()
          : "validateWorkflowRecord",
    },
    phases: phases.length
      ? phases
      : ["loopship_schema", "official_swf_schema", "loopship_semantics"],
    allowedDslVersions: allowedDslVersions.length
      ? allowedDslVersions
      : ["1.0.3"],
    allowedFeatures,
  };
  return cachedValidationPolicy;
}

export const WORKFLOW_DSL_VERSION =
  loadWorkflowValidationPolicy().allowedDslVersions[0] || "1.0.3";
export const WORKFLOW_VALIDATION_ENTRYPOINT =
  loadWorkflowValidationPolicy().facade.entrypoint;

function detectWorkflowKind(
  rawWorkflow: Record<string, unknown>,
): LoopshipWorkflowRecord["workflowKind"] {
  const document =
    rawWorkflow.document &&
    typeof rawWorkflow.document === "object" &&
    !Array.isArray(rawWorkflow.document)
      ? (rawWorkflow.document as Record<string, unknown>)
      : null;
  const metadata =
    document?.metadata &&
    typeof document.metadata === "object" &&
    !Array.isArray(document.metadata)
      ? (document.metadata as Record<string, unknown>)
      : null;
  const loopshipMeta =
    metadata?.loopship && typeof metadata.loopship === "object" && !Array.isArray(metadata.loopship)
      ? (metadata.loopship as Record<string, unknown>)
      : null;
  const kind =
    loopshipMeta && typeof loopshipMeta.kind === "string" ? loopshipMeta.kind : null;
  return kind === "flow" || kind === "step-workflow" ? kind : null;
}

function loadSingleStepWorkflow(filePath: string): LoopshipStepDefinition {
  const steps = loadStepDefinitions(dirname(filePath));
  const step = Object.values(steps)[0];
  if (!step) {
    throw new Error(`${filePath} did not yield a step workflow definition`);
  }
  return step;
}

export function loadWorkflowRecord(filePath: string): LoopshipWorkflowRecord {
  const rawWorkflow = readYamlObject(filePath);
  const document =
    rawWorkflow.document &&
    typeof rawWorkflow.document === "object" &&
    !Array.isArray(rawWorkflow.document)
      ? (rawWorkflow.document as Record<string, unknown>)
      : {};
  const workflowKind = detectWorkflowKind(rawWorkflow);
  return {
    filePath,
    rawWorkflow,
    workflowId: String(document.name ?? ""),
    workflowVersion: String(document.version ?? ""),
    workflowKind,
    flow:
      workflowKind === "flow"
        ? loadFlowDefinitionFromPath(filePath, String(document.name ?? ""))
        : null,
    step:
      workflowKind === "step-workflow" ? loadSingleStepWorkflow(filePath) : null,
  };
}

function validateLoopshipSemantics(
  record: LoopshipWorkflowRecord,
  errors: string[],
): void {
  if (record.workflowKind === "flow") {
    try {
      loadFlowDefinitionFromPath(record.filePath, record.workflowId || undefined);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (record.workflowKind === "step-workflow") {
    try {
      loadSingleStepWorkflow(record.filePath);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  errors.push(
    `${record.filePath} must set document.metadata.loopship.kind to flow or step-workflow`,
  );
}

export function validateWorkflowRecord(record: LoopshipWorkflowRecord): void {
  const policy = loadWorkflowValidationPolicy();
  const errors: string[] = [];
  for (const phase of policy.phases) {
    if (errors.length) break;
    switch (phase) {
      case "loopship_schema": {
        errors.push(...validateSchemaPath(record.rawWorkflow, FLOW_SCHEMA_PATH));
        break;
      }
      case "official_swf_schema": {
        errors.push(
          ...validateSchemaPath(
            record.rawWorkflow,
            "vendor/serverlessworkflow/1.0.3/workflow.yaml",
          ),
        );
        break;
      }
      case "loopship_semantics": {
        validateLoopshipSemantics(record, errors);
        break;
      }
    }
  }
  if (errors.length) {
    throw new Error(
      `Workflow validation failed for ${record.filePath}:\n- ${errors.join("\n- ")}`,
    );
  }
}

export function loadBundledFlowRecord(
  flowId = DEFAULT_FLOW_ID,
): LoopshipWorkflowRecord {
  const filePath = resolve(ROOT, "assets", "flows", `${flowId}.yaml`);
  return loadWorkflowRecord(filePath);
}

export {
  DEFAULT_FLOW_ID,
  DEFAULT_FLOW_VERSION,
  flowStage,
  flowStep,
  listBundledFlows,
  loadFlowDefinition,
  loadFlowDefinitionFromPath,
  loadStepDefinitions,
};
