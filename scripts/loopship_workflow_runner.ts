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
import { readText } from "./loopship_utils.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const WORKFLOW_SCHEMA_FILE = "fastflow.workflow.yaml";

type ValidationPhase =
  | "fastflow_schema"
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
  cachedValidationPolicy = {
    facade: {
      entrypoint: "validateWorkflowRecord",
    },
    phases: ["fastflow_schema", "loopship_semantics"],
    allowedDslVersions: ["1.0.3"],
    allowedFeatures: ["set", "call", "run.script", "workflow-data"],
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
  const tasks = Array.isArray(rawWorkflow.do) ? rawWorkflow.do : [];
  const hasFlowSpec = tasks.some(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      Object.prototype.hasOwnProperty.call(item, "flow_spec"),
  );
  if (hasFlowSpec) return "flow";
  return tasks.length === 1 ? "step-workflow" : null;
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
    `${record.filePath} must be a Loopship Fastflow flow with flow_spec or a single-step workflow`,
  );
}

export function validateWorkflowRecord(
  record: LoopshipWorkflowRecord,
  _options: Record<string, unknown> = {},
): void {
  const policy = loadWorkflowValidationPolicy();
  const errors: string[] = [];
  for (const phase of policy.phases) {
    if (errors.length) break;
    switch (phase) {
      case "fastflow_schema": {
        if (record.rawWorkflow?.document == null || record.rawWorkflow?.input == null || record.rawWorkflow?.output == null) {
          errors.push(`${record.filePath} must be a Fastflow workflow with document, input, output, and do`);
        }
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
  const filePath = resolve(ROOT, "assets", "flows", `${flowId}.stable.yaml`);
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
