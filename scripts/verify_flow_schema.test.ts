import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  loadBundledFlowRecord,
  loadFlowDefinition,
  loadFlowDefinitionFromPath,
  loadStepDefinitions,
  validateWorkflowRecord,
  WORKFLOW_DSL_VERSION,
  WORKFLOW_VALIDATION_ENTRYPOINT,
} from "./loopship_workflow_runner.ts";
import { V3_STEP_SCHEMAS, validateV3Input } from "./loopship_schema.ts";

const command = {
  cmd: "loopship",
  args: ["resume", "--wtree", "demo", "--json", "@-"],
};

const schemaRef = {
  schema_path: "schemas/steps/next-input.yaml",
};

const prose = (value: string): string => value.replace(/ ([^ ]+)$/, "\n$1");

const embeddedPlanInputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "schemas/steps/plan-input.yaml",
  title: "Loopship V3 Plan Input",
  type: "object",
};

const embeddedChildResultSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "schemas/steps/child-result-input.yaml",
  title: "Loopship V3 Child Result Input",
  type: "object",
};

const emptySystemContext = {
  relevant_object_refs: [],
  relevant_assertion_refs: [],
  relevant_resource_refs: [],
  relevant_memory_refs: [],
  durable_implications: [],
};

function writeYamlFixture(path: string, value: Record<string, unknown>): void {
  writeFileSync(path, stringifyYaml(value), "utf8");
}

function taskMetadata(description: string): Record<string, unknown> {
  return {
    description,
    validation: {
      post: {
        kind: "static",
        ok: true,
        evidence: { source: "test-fixture" },
      },
    },
    verification: {
      assertions: [
        {
          id: "fixture_contract",
          kind: "behaviour",
          statement: "The test fixture is structurally valid.",
          check: {
            script: {
              kind: "js",
              code: "return { ok: true, evidence: { source: 'test-fixture' } };",
            },
          },
        },
      ],
    },
  };
}

function makeStepWorkflow(options: {
  taskName: string;
  stepId?: string;
  handler?: string;
  inputStep?: string | null;
  inputSchemaRef: string;
  outputSchemaRef?: string;
  summary?: string;
  instructions?: string;
  resultSchemaPath?: string;
}): Record<string, unknown> {
  const {
    taskName,
    stepId = taskName,
    inputSchemaRef,
    outputSchemaRef,
    summary = `${taskName} summary`,
    instructions = `# Loopship ${taskName} Step`,
  } = options;
  const description = instructions;
  const inputSchema = {
    format: "json",
    document: {
      $ref: inputSchemaRef,
    },
  };
  const baseTask = {
    input: {
      schema: inputSchema,
      from: "${inputs}",
    },
    metadata: taskMetadata(description),
  };
  return {
    document: {
      dsl: "1.0.3",
      namespace: "loopship-steps",
      name: taskName,
      version: "1.0.0",
      summary,
      metadata: {
        catalog: {
          tags: ["loopship", "step", stepId],
        },
      },
    },
    input: {
      schema: inputSchema,
    },
    output: {
      schema: {
        format: "json",
        document: outputSchemaRef
          ? {
              type: "object",
              additionalProperties: true,
            }
          : {
              $ref: inputSchemaRef,
            },
      },
      as: outputSchemaRef ? `\${state.steps.${taskName}.action}` : "${inputs}",
    },
    do: [
      {
        [taskName]: outputSchemaRef
          ? {
              ...baseTask,
              call: "fastflow.afn.core.request.input",
              with: {
                body: {
                  instruction: description,
                  request: {
                    schema: {
                      type: "object",
                      additionalProperties: true,
                    },
                    build: {
                      kind: "js",
                      using: ["inputs"],
                      code: "return inputs;",
                    },
                  },
                  answer: {
                    schema: {
                      $ref: outputSchemaRef,
                    },
                  },
                },
              },
              output: {
                schema: {
                  format: "json",
                  document: {
                    type: "object",
                    additionalProperties: true,
                  },
                },
                as: "${action}",
              },
            }
          : {
              ...baseTask,
              set: {
                archived: "${inputs}",
              },
              output: {
                schema: inputSchema,
                as: "${inputs}",
              },
            },
      },
    ],
  };
}

function makeFlowWorkflow(options: {
  name?: string;
  defaultStage?: string;
  stages: Record<
    string,
    {
      step: string;
      task?: string;
      transitionKey?: Record<string, unknown>;
      transitions: Record<string, string>;
    }
  >;
  tasks?: Record<string, Record<string, unknown>>;
  subflows?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  const {
    name = "demo",
    defaultStage = "planning",
    stages,
    subflows = [],
  } = options;
  const sourceStages = Object.fromEntries(
    Object.entries(stages).map(([stageId, stage]) => [
      stageId,
      {
        step: stage.step,
        ...(stage.transitionKey ? { transitionKey: stage.transitionKey } : {}),
        transitions: stage.transitions,
      },
    ]),
  );
  return {
    schema_version: 1,
    id: name,
    version: 1,
    default_stage: defaultStage,
    stages: sourceStages,
    subflows,
  };
}

const baseStepOutput = {
  schema_version: 3,
  kind: "quest_step",
  schema_path: "schemas/steps/step-output.yaml",
  wtree: "demo",
  quest_id: "demo",
  flow_id: "swe",
  flow_version: 1,
  current_stage: "planning",
  summary: "Plan the work",
  task: {
    id: "plan",
    instructions: "# Loopship Plan Step\n\nPlan with clarification details.",
  },
  answer_schema: embeddedPlanInputSchema,
  continuation: {
    kind: "fastflow.resume",
    transport: "loopship",
    wtree: "demo",
    command,
  },
};

const validPayloads: Record<string, Record<string, unknown>> = {
  "init-output": {
    schema_version: 3,
    kind: "init_route",
    schema_path: "schemas/steps/init-output.yaml",
    request: "loopship: demo",
    runtime: "codex",
    flow_id: "swe",
    flow_version: 1,
    candidates: [],
    new_quest: {
      suggested_wtree: "demo",
      command,
      resume_input_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "schemas/steps/next-input.yaml",
        title: "Loopship V3 Next Input",
        type: "object",
      },
      input: {
        action: "create_quest",
        wtree: "demo",
        flow_id: "swe",
        request: "loopship: demo",
      },
    },
  },
  "next-input": {
    action: "create_quest",
    wtree: "demo",
    flow_id: "swe",
    request: "loopship: demo",
  },
  "step-output": baseStepOutput,
  "error-output": {
    schema_version: 3,
    kind: "error",
    schema_path: "schemas/steps/error-output.yaml",
    error: "output schema validation failed",
    wtree: "demo",
    state: "planning",
    schema: schemaRef,
    errors: ["/extra is not allowed"],
  },
  "plan-input": {
    classification: "feature",
    scope: "demo",
    system_context: emptySystemContext,
    verification_targets: ["works"],
    task_graph: {
      tasks: [{ id: "T001", title: "Build", acceptance: ["works"] }],
    },
  },
  "questions-input": {
    answers: [{ question_id: "q1", answer: "yes" }],
  },
  "task-graph-input": { approved: true },
  "step-request": {
    schema_version: "loopship.step.request/v1",
    kind: "quest_step_request",
    wtree: "demo",
    quest_id: "demo",
    flow_id: "swe",
    flow_version: 1,
    current_stage: "planning",
    summary: "Plan the work",
    prompt: "loopship: demo",
    tasks: [],
    question_rounds: [],
    events: [],
  },
  "child-dispatch-request": {
    schema_version: "loopship.child-dispatch.request/v1",
    kind: "child_dispatch_request",
    wtree: "demo",
    quest_id: "demo",
    flow_id: "swe",
    flow_version: 1,
    current_stage: "task_graph_ready",
    summary: "Dispatch children",
    children: [
      {
        task_id: "t001",
        title: "Build",
        child_wtree: "demo-t001",
        branch_ref: "codex/demo-t001",
        worktree_path: "/tmp/worktree",
        acceptance: "works",
      },
    ],
  },
  "child-dispatch-output": {
    ...baseStepOutput,
    schema_path: "schemas/steps/child-dispatch-output.yaml",
    current_stage: "executing",
    answer_schema: embeddedChildResultSchema,
    task: {
      id: "executing",
      instructions: "# Loopship Executing Step\n\nDispatch child work.",
    },
    children: [
      {
        task_id: "t001",
        title: "Build",
        child_wtree: "demo-t001",
        branch_ref: "codex/demo-t001",
        worktree_path: "/tmp/worktree",
        acceptance: "works",
        actions: { init: command, resume: command },
      },
    ],
  },
  "child-result-input": {
    task_id: "T001",
    child_wtree: "demo-t001",
    status: "passed",
    evidence: [{ type: "summary", ref: "README.md" }],
    merge_commit: "abc123",
  },
  "validation-input": {
    status: "passed",
    checks: [{ name: "test", status: "passed" }],
  },
  "verification-input": {
    status: "passed",
    acceptance_trace: [{ acceptance: "works", status: "passed" }],
    risks: [{ risk: "none", severity: "low" }],
  },
  "system-update-input": {
    system_update: {
      schema_version: 1,
      mode: "replace",
      summary: "Replace the canonical root system model.",
      root: {
        schema_version: 2,
        id: "loopship",
        title: "Loopship",
        kinds: ["software", "workflow", "agent"],
        text: prose("Deterministic workflow launcher."),
        scope_in: ["Loopship runtime"],
        scope_out: ["Generated apps"],
        objects: [
          {
            id: "system-model",
            kind: "unit",
            text: prose("Durable semantic frontier for Loopship."),
          },
        ],
        assertions: [
          {
            id: "canonical-docs-are-signed",
            kind: "rule",
            level: "must",
            text: prose("Canonical documents must be covered by the signature."),
            links: {
              about: ["object:system-model"],
              supported_by: ["resource:software-architecture#/constraints"],
            },
          },
        ],
        resources: [
          {
            id: "software-architecture",
            kind: "document",
            role: "canonical",
            text: prose("Full software architecture document."),
            location: ".loopship/docs/software/architecture.yaml",
            schema_ref: "loopship://schemas/docs/software-architecture.yaml",
            links: {
              about: ["object:system-model"],
            },
          },
          {
            id: "decisions",
            kind: "document",
            role: "canonical",
            text: prose("Architecture-significant decision records."),
            location: ".loopship/docs/decisions/records.yaml",
            schema_ref: "loopship://schemas/docs/decision-records.yaml",
            links: {
              about: ["object:system-model"],
            },
          },
          {
            id: "workflow-spec",
            kind: "document",
            role: "canonical",
            text: prose("Full workflow specification document."),
            location: ".loopship/docs/workflow/spec.yaml",
            schema_ref: "loopship://schemas/docs/workflow-spec.yaml",
            links: {
              about: ["object:system-model"],
            },
          },
          {
            id: "agent-system-card",
            kind: "document",
            role: "canonical",
            text: prose("Full agent system card document."),
            location: ".loopship/docs/agent/system-card.yaml",
            schema_ref: "loopship://schemas/docs/agent-system-card.yaml",
            links: {
              about: ["object:system-model"],
            },
          },
        ],
      },
      external_docs: [
        {
          op: "upsert",
          resource_ref: "resource:software-architecture",
          document: {
            schema_version: 2,
            id: "software-architecture",
            title: "Software Architecture",
            text: prose("Full software architecture document."),
            links: {
              about: ["object:system-model"],
            },
            standard_alignment: {
              arc42: prose("Aligns with arc42 architecture concerns for goals, context, structure, runtime, quality, and risk."),
            },
            goals: [
              prose("Loopship coordinates deterministic workflow execution across worktrees."),
            ],
            stakeholders: {
              operator: {
                role: "operator",
                text: prose("Operators need readable schema-backed architecture docs."),
                concerns: [prose("Canonical docs must avoid empty shell content.")],
              },
            },
            constraints: [
              prose("The root remains minimal and delegates detail to documents."),
            ],
            context: {
              business: prose("Users submit quests and expect deterministic coordination."),
              technical: prose("Bun and Git worktrees provide local runtime execution."),
            },
            solution_strategy: prose("Use schema-backed flows and concrete canonical documents."),
            structure: {
              overview: prose("Loopship is organized around the CLI, runtime state, canonical docs, and verification."),
              systems: { loopship: prose("Loopship is the workflow launcher system.") },
              containers: { cli: prose("The CLI container owns command execution.") },
              components: { verifier: prose("The verifier component checks durable state.") },
              code_units: { loopship_core: prose("loopship_core owns state and signature updates.") },
            },
            runtime: {
              overview: prose("Runtime proceeds through planning, execution, verification, update, landing, and archive."),
              scenarios: { quest_lifecycle: prose("The plan step scouts durable system knowledge before execution.") },
              failure_scenarios: { shell_docs: prose("Shell docs fail verification before becoming canonical.") },
            },
            deployment: {
              environments: { local_worktree: prose("Loopship runs in a local repository worktree.") },
              nodes: { developer_machine: prose("The developer machine runs Bun verification commands.") },
            },
            interfaces: {
              task_yaml: { kind: "file", text: prose("Task YAML schemas define quest inputs and step outputs.") },
            },
            data: {
              stores: { system_yaml: prose("System YAML stores the semantic frontier.") },
              flows: { system_update: prose("System updates flow into canonical YAML and signature refresh.") },
            },
            quality: {
              goals: { determinism: prose("Loopship prioritizes deterministic schema validation.") },
              scenarios: { multiline_prose: prose("Single-line prose fails system model verification.") },
            },
            risks: {
              shell_docs: {
                text: prose("Agents may create shell docs unless concrete schemas require meaningful canonical content."),
                mitigation: prose("Full profile schemas require meaningful fields."),
              },
            },
            technical_debt: {
              generated_markdown: prose("Generated Markdown renderers are future work."),
            },
            diagrams: {
              context: {
                kind: "context",
                syntax: "mermaid",
                text: prose("C4-style context diagram source can be generated."),
                source: prose("flowchart LR User --> Loopship"),
              },
            },
            examples: {
              "resource-link": {
                language: "yaml",
                text: prose("Example canonical resource link in system YAML."),
                source: prose("resources:\n  - id: software-architecture\n    kind: document"),
              },
            },
            decision_refs: ["resource:decisions"],
            glossary: {
              canonical: prose("Canonical YAML files are signed durable truth."),
            },
          },
        },
        {
          op: "upsert",
          resource_ref: "resource:decisions",
          document: {
            schema_version: 2,
            id: "decisions",
            title: "Decision Records",
            text: prose("Architecture-significant decision records."),
            links: {
              about: ["object:system-model"],
            },
            standard_alignment: {
              adr: prose("Aligns with ADR context, decision, rationale, options, and consequences."),
            },
            decisions: {
              minimal_kernel: {
                state: "accepted",
                date: "2026-06-08",
                title: "Use minimal kernel",
                context: prose("Loopship needs a minimal root that works across software, workflow, and agent contexts."),
                drivers: [
                  prose("The model must remain readable to agents."),
                ],
                options: {
                  records_array: {
                    text: prose("Use one records array for every durable item."),
                    tradeoffs: [prose("This reduces blocks but weakens readable grouping.")],
                  },
                  four_blocks: {
                    text: prose("Use objects assertions resources and memories."),
                    tradeoffs: [prose("This keeps grouping while preserving compact links.")],
                  },
                },
                decision: prose("Use objects, assertions, resources, and memories with typed links as the root model."),
                rationale: prose("This preserves useful mental models without a relation warehouse or generic section docs."),
                consequences: [prose("The verifier must resolve links and reject shell external docs.")],
              },
            },
          },
        },
      ],
    },
  },
  "landing-input": {
    status: "landed",
    summary: "done",
  },
  "archive-output": {
    schema_version: 3,
    kind: "quest_step",
    schema_path: "schemas/steps/archive-output.yaml",
    wtree: "demo",
    quest_id: "demo",
    flow_id: "swe",
    flow_version: 1,
    current_stage: "archived",
    summary: "Archived",
    terminal: true,
    task: {
      id: "archived",
      instructions: "# Loopship Archived Step\n\nReport final state.",
    },
    landing: {
      source_branch: "build-demo",
      target_branch: "main",
      target_worktree: "/tmp/main-worktree",
      landed_commit: "abc123",
      strategy: "fast-forward",
    },
  },
  "hook-output": {
    decision: "block",
    reason: "{}",
  },
  "lock-error": {
    schema_version: 3,
    kind: "lock_error",
    schema_path: "schemas/steps/lock-error.yaml",
    wtree: "demo",
    lock: {
      path: "/tmp/lock.json",
      pid: 123,
      retry: command,
    },
  },
};

describe("loopship strict v3 step schemas", () => {
  it("exposes the fast-browser-aligned workflow runner contract", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    expect(WORKFLOW_DSL_VERSION).toBe("1.0.3");
    expect(WORKFLOW_VALIDATION_ENTRYPOINT).toBe("validateWorkflowRecord");
    try {
      const record = loadBundledFlowRecord("swe");
      expect(record.workflowKind).toBe("flow");
      expect(record.workflowId).toBe("swe");
      expect(() => validateWorkflowRecord(record)).not.toThrow();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.join("\n")).not.toContain("unknown format");
  });

  it("loads build-only flow sources and rejects the removed executable Loopship profile", () => {
    const root = mkdtempSync(join(tmpdir(), "loopship-fastflow-flow-"));
    try {
      const flowPath = join(root, "flow.flow.yaml");
      writeYamlFixture(
        flowPath,
        makeFlowWorkflow({
          name: "demo",
          stages: {
            planning: {
              step: "plan",
              task: "planning",
              transitions: { planned: "archived" },
            },
            archived: {
              step: "archived",
              task: "archived",
              transitions: {},
            },
          },
        }),
      );
      const flow = loadFlowDefinitionFromPath(
        flowPath,
        "demo",
        loadStepDefinitions(),
      );
      expect(flow.default_stage).toBe("planning");
      expect(flow.stages.map((stage) => stage.id)).toEqual([
        "planning",
        "archived",
      ]);

      writeYamlFixture(flowPath, {
        document: {
          dsl: "1.0.3",
          namespace: "loopship",
          name: "demo",
          version: "1.0.0",
          metadata: {
            loopship: {
              kind: "flow",
            },
          },
        },
        do: [],
      });
      expect(() =>
        loadFlowDefinitionFromPath(flowPath, "demo", loadStepDefinitions()),
      ).toThrow(".id must be a non-empty string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const schemaName of V3_STEP_SCHEMAS) {
    it(`accepts and rejects ${schemaName}`, () => {
      const valid = validPayloads[schemaName];
      expect(valid, `missing test payload for ${schemaName}`).toBeTruthy();
      expect(validateV3Input(valid, schemaName)).toEqual([]);
      expect(
        validateV3Input({ ...valid, extra: true }, schemaName).length,
      ).toBeGreaterThan(0);
    });
  }

  it("accepts plain embedded JSON Schema fragments for answer schemas", () => {
    expect(
      validateV3Input(
        {
          ...validPayloads["child-dispatch-output"],
          answer_schema: {
            type: "object",
            additionalProperties: true,
            properties: {
              schema_version: { type: "string" },
            },
          },
        },
        "child-dispatch-output",
      ),
    ).toEqual([]);
  });

  it("requires replan_reason when rejecting task graph approval", () => {
    expect(
      validateV3Input(
        { approved: false },
        "task-graph-input",
      ),
    ).not.toEqual([]);
    expect(
      validateV3Input(
        {
          approved: false,
          replan_reason: "scope changed",
        },
        "task-graph-input",
      ),
    ).toEqual([]);
  });

  it("rejects malformed plan system_context durable implications", () => {
    expect(
      validateV3Input(
        {
          ...validPayloads["plan-input"],
          system_context: {
            ...emptySystemContext,
            durable_implications: [
              {
                record_kind: "behaviour",
                links: {
                  supported_by: ["docs"],
                },
                expected_system_update: "assertion_update",
                confidence: "high",
              },
            ],
          },
        },
        "plan-input",
      ),
    ).not.toEqual([]);
  });

  it("rejects malformed system_update replace payloads", () => {
    const valid = validPayloads["system-update-input"];
    const baseUpdate = valid.system_update as Record<string, unknown>;

    expect(
      validateV3Input(
        {
          system_update: {
            schema_version: 1,
            mode: "replace",
            summary: "missing root",
          },
        },
        "system-update-input",
      ),
    ).not.toEqual([]);

    expect(
      validateV3Input(
        {
          system_update: {
            ...baseUpdate,
            external_docs: [
              {
                op: "upsert",
                resource_ref: "resource:software-architecture",
                document: {
                  ...((baseUpdate.external_docs as any)[0].document as Record<string, unknown>),
                  diagrams: {
                    context: {
                      kind: "context",
                      syntax: "mermaid",
                      text: prose("Diagram source missing canonical source block."),
                    },
                  },
                },
              },
            ],
          },
        },
        "system-update-input",
      ),
    ).not.toEqual([]);

    expect(
      validateV3Input(
        {
          system_update: {
            ...baseUpdate,
            external_docs: [
              {
                op: "upsert",
                resource_ref: "resource:software-architecture",
                document: {
                  ...((baseUpdate.external_docs as any)[0].document as Record<string, unknown>),
                  examples: {
                    "invalid-language": {
                      language: "ruby",
                      text: prose("Invalid language must be rejected by schema."),
                      source: prose("puts :hello"),
                    },
                  },
                },
              },
            ],
          },
        },
        "system-update-input",
      ),
    ).not.toEqual([]);

    expect(
      validateV3Input(
        {
          system_update: {
            ...baseUpdate,
            external_docs: [
              {
                op: "upsert",
                resource_ref: "resource:software-architecture",
              },
            ],
          },
        },
        "system-update-input",
      ),
    ).not.toEqual([]);

    expect(
      validateV3Input(
        {
          ...valid,
          system_update: {
            ...baseUpdate,
            root: {
              ...(baseUpdate.root as Record<string, unknown>),
              assertions: [
                {
                  ...((baseUpdate.root as any).assertions[0] as Record<string, unknown>),
                  links: {
                    about: ["object:system-model"],
                    supported_by: ["resource:software-architecture#constraints"],
                  },
                },
              ],
            },
          },
        },
        "system-update-input",
      ),
    ).not.toEqual([]);

    expect(
      validateV3Input(
        {
          ...valid,
          system_update: {
            ...baseUpdate,
            root: {
              ...(baseUpdate.root as Record<string, unknown>),
              resources: [
                {
                  ...((baseUpdate.root as any).resources[0] as Record<string, unknown>),
                  schema_ref: "loopship://schemas/docs/software-architecture.yaml#/properties",
                },
              ],
            },
          },
        },
        "system-update-input",
      ),
    ).not.toEqual([]);

    expect(
      validateV3Input(
        {
          system_update: {
            ...baseUpdate,
            external_docs: [
              {
                op: "upsert",
                resource_ref: "resource:software-architecture",
                document: {
                  schema_version: 2,
                  id: "software-architecture",
                  text: prose("Old shell architecture document."),
                  standard_alignment: [
                    { id: "architecture-arc42", name: "arc42", text: prose("Old id text section shape.") },
                  ],
                  goals: [
                    { id: "architecture-goal", text: prose("Old id text section shape.") },
                  ],
                },
              },
            ],
          },
        },
        "system-update-input",
      ),
    ).not.toEqual([]);
  });
});

describe("loopship bundled flow definitions", () => {
  it("loads the bundled swe flow", () => {
    const flow = loadFlowDefinition("swe");
    expect(flow.id).toBe("swe");
    expect(flow.stages_by_id.planning.step).toBe("plan");
    expect(flow.stages_by_id.task_graph_ready.step).toBe("executing");
    expect(flow.stages_by_id.executing.step).toBe("child_result");
    expect(flow.steps_by_id.executing.input_step).toBe("executing");
    expect(flow.steps_by_id.child_result.input_step).toBe("child_result");
    for (const step of Object.values(flow.steps_by_id)) {
      if (step.instructions.includes("## Terminal Output Contract")) {
        expect(step.instructions).toContain(
          "Fastflow orchestrator owns terminal flow state",
        );
      } else if (step.output_schema && step.call === "fastflow.afn.core.request.input") {
        expect(step.instructions).toContain("## Step-Local Callback Contract");
        expect(step.instructions).toContain(
          "Fastflow orchestrator owns flow transitions",
        );
        expect(step.instructions).toContain(
          "matching this step's answer schema",
        );
      } else if (!step.output_schema) {
        expect(step.instructions).toContain("## Terminal Output Contract");
        expect(step.instructions).toContain(
          "Fastflow orchestrator owns terminal flow state",
        );
      }
    }
    expect(flow.steps_by_id.plan.instructions).toContain("# Loopship Plan Step");
    expect(flow.steps_by_id.plan.instructions).toContain(
      "## Universal Planning Contract",
    );
    expect(flow.steps_by_id.plan.instructions).toContain(
      "top-class principal architect",
    );
    expect(flow.steps_by_id.plan.instructions).toContain("system prompt");
    expect(flow.steps_by_id.plan.instructions).toContain(
      "human is available only during",
    );
    expect(flow.steps_by_id.plan.instructions).toContain(
      "## Scout-Grill-Converge Loop",
    );
    expect(flow.steps_by_id.plan.instructions).toContain(
      "scout the repo for relevant assumptions",
    );
    expect(flow.steps_by_id.plan.instructions).toContain("## Repo Scout");
    expect(flow.steps_by_id.plan.instructions).toContain("## Plan Gate");
    expect(flow.steps_by_id.plan.instructions).toContain(
      "Critical Missing Scope",
    );
    expect(flow.steps_by_id.plan.instructions).toContain("design-tree grill");
    expect(flow.steps_by_id.plan.instructions).toContain("recommended answer");
    expect(flow.steps_by_id.plan.instructions).toContain("Discoverable facts");
    expect(flow.steps_by_id.plan.instructions).toContain("decision-complete");
    expect(flow.steps_by_id.plan.instructions).toContain(
      "General non-coding requests",
    );
    expect(flow.steps_by_id.plan.instructions).toContain("## Defaulting Rules");
    expect(flow.steps_by_id.plan.instructions).toContain("request_user_input");
    expect(flow.steps_by_id.plan.instructions).toContain(
      "wait indefinitely for a human answer",
    );
    expect(flow.steps_by_id.questions.instructions).toContain(
      "human-provided answers",
    );
    expect(flow.steps_by_id.executing.instructions).toContain(
      "Start the ready child wtree commands",
    );
    expect(flow.subflows.map((subflow) => subflow.id)).toEqual([
      "replanning",
      "add_task",
      "child_task",
    ]);
    expect(flow.stages_by_id.task_graph_ready.step).toBe("executing");
    expect(flow.stages_by_id.executing.step).toBe("child_result");
  });

  it("rejects invalid flow references", () => {
    expect(() => loadFlowDefinition("missing")).toThrow("unknown flow");
  });

  it("rejects missing steps, bad schema refs, and bad transitions", () => {
    const root = mkdtempSync(join(tmpdir(), "loopship-flow-schema-"));
    try {
      const stepsDir = join(root, "steps");
      const flowPath = join(root, "flow.flow.yaml");
      mkdirSync(stepsDir, { recursive: true });
      writeFileSync(
        join(stepsDir, "bad.stable.yaml"),
        stringifyYaml(
            makeStepWorkflow({
              taskName: "bad",
            inputSchemaRef: join(
              process.cwd(),
              "schemas/steps/step-request.yaml",
            ),
            outputSchemaRef: join(root, "missing-schema.yaml"),
          }),
        ),
        "utf8",
      );
      expect(() => loadStepDefinitions(stepsDir)).toThrow(
        "missing step schema",
      );

      const steps = loadStepDefinitions();
      writeYamlFixture(
        flowPath,
        makeFlowWorkflow({
          name: "broken",
          stages: {
            planning: {
              step: "missing_step",
              task: "planning",
              transitions: {},
            },
          },
        }),
      );
      expect(() =>
        loadFlowDefinitionFromPath(flowPath, "broken", steps),
      ).toThrow("missing step");

      writeYamlFixture(
        flowPath,
        makeFlowWorkflow({
          name: "broken",
          stages: {
            planning: {
              step: "plan",
              task: "planning",
              transitions: {
                next: "missing_stage",
              },
            },
          },
        }),
      );
      expect(() =>
        loadFlowDefinitionFromPath(flowPath, "broken", steps),
      ).toThrow("targets missing stage");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects incoherent subflow definitions", () => {
    const root = mkdtempSync(join(tmpdir(), "loopship-subflow-schema-"));
    try {
      const flowPath = join(root, "flow.flow.yaml");
      const steps = loadStepDefinitions();
      const baseStages = {
        planning: {
          step: "plan",
          task: "planning",
          transitions: {
            planned: "plan_review",
          },
        },
        plan_review: {
          step: "task_graph",
          task: "plan_review",
          transitions: {
            approved: "task_graph_ready",
          },
        },
        task_graph_ready: {
          step: "executing",
          task: "task_graph_ready",
          transitions: {
            complete: "archived",
          },
        },
        orphan: {
          step: "validation",
          task: "orphan",
          transitions: {},
        },
        archived: {
          step: "archived",
          task: "archived",
          transitions: {},
        },
      };

      writeYamlFixture(
        flowPath,
        makeFlowWorkflow({
          stages: baseStages,
          subflows: [
            {
              id: "replanning",
              type: "in_flow_detour",
              starts_at: "orphan",
              returns_to: "task_graph_ready",
              trigger: "replan",
            },
          ],
        }),
      );
      expect(() => loadFlowDefinitionFromPath(flowPath, "demo", steps)).toThrow(
        "returns_to is not reachable",
      );

      writeYamlFixture(
        flowPath,
        makeFlowWorkflow({
          stages: baseStages,
          subflows: [
            {
              id: "child_task",
              type: "spawned_quest",
              starts_at: "task_graph_ready",
              returns_to: "task_graph_ready",
              trigger: "children[].actions.init",
              result_step: "validation",
              flow_id: "demo",
            },
          ],
        }),
      );
      expect(() => loadFlowDefinitionFromPath(flowPath, "demo", steps)).toThrow(
        "must match return stage input step executing",
      );

      writeYamlFixture(
        flowPath,
        makeFlowWorkflow({
          stages: baseStages,
          subflows: [
            {
              id: "child_task",
              type: "spawned_quest",
              starts_at: "task_graph_ready",
              returns_to: "task_graph_ready",
              trigger: "children[].actions.init",
              result_step: "executing",
              flow_id: "missing_flow",
            },
          ],
        }),
      );
      expect(() => loadFlowDefinitionFromPath(flowPath, "demo", steps)).toThrow(
        "references missing flow",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
