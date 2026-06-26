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
import {
  FLOW_SCHEMA_PATH,
  V3_STEP_SCHEMAS,
  validateV3Input,
  validateSchemaPath,
} from "./loopship_schema.ts";

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

const embeddedStepOutputEnvelope = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "schemas/steps/step-output.yaml",
  title: "Loopship V3 Step Output",
  type: "object",
};

const docs = {
  state_yaml: "/tmp/tasks.yaml",
  events_jsonl: "/tmp/events.jsonl",
  manifest: "/tmp/manifest.yaml",
};

const emptySystemContext = {
  relevant_object_refs: [],
  relevant_assertion_refs: [],
  relevant_resource_refs: [],
  relevant_memory_refs: [],
  durable_implications: [],
};

const validFlow = {
  document: {
    dsl: "1.0.3",
    namespace: "loopship",
    name: "demo",
    version: "1.0.0",
    metadata: {
      loopship: {
        kind: "flow",
        version: 1,
        defaultStage: "planning",
        stages: {
          planning: {
            step: "plan",
            task: "planning",
            transitions: { planned: "plan_review" },
          },
          plan_review: {
            step: "task_graph",
            task: "plan_review",
            transitions: { approved: "task_graph_ready" },
          },
          task_graph_ready: {
            step: "executing",
            task: "task_graph_ready",
            transitions: { complete: "archived" },
          },
          archived: {
            step: "archived",
            task: "archived",
            transitions: {},
          },
        },
        subflows: [
          {
            id: "child_task",
            type: "spawned_quest",
            starts_at: "task_graph_ready",
            returns_to: "task_graph_ready",
            trigger: "children[].commands.init",
            result_step: "child_result",
            flow_id: "demo",
          },
        ],
      },
    },
  },
  do: [
    { planning: { call: "workflow.loopship.steps.plan" } },
    { plan_review: { call: "workflow.loopship.steps.task_graph" } },
    { task_graph_ready: { call: "workflow.loopship.steps.executing" } },
    { archived: { call: "workflow.loopship.steps.archived" } },
  ],
};

function writeYamlFixture(path: string, value: Record<string, unknown>): void {
  writeFileSync(path, stringifyYaml(value), "utf8");
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
    handler = taskName,
    inputStep = taskName,
    inputSchemaRef,
    outputSchemaRef,
    summary = `${taskName} summary`,
    instructions = `# Loopship ${taskName} Step`,
    resultSchemaPath = "schemas/steps/step-output.yaml",
  } = options;
  return {
    document: {
      dsl: "1.0.3",
      namespace: "loopship-steps",
      name: taskName,
      version: "1.0.0",
      summary,
      metadata: {
        loopship: {
          kind: "step-workflow",
          stepId,
        },
      },
    },
    do: [
      {
        [taskName]: {
          input: {
            schema: {
              format: "json",
              document: {
                $ref: inputSchemaRef,
              },
            },
          },
          metadata: {
            loopship: {
              stepId,
              handler,
              inputStep,
              summary,
              instructions,
              resultSchemaPath,
            },
          },
          ...(outputSchemaRef
            ? {
                output: {
                  schema: {
                    format: "json",
                    document: {
                      $ref: outputSchemaRef,
                    },
                  },
                },
              }
            : {}),
          call: `workflow.loopship.steps.${taskName}`,
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
      task: string;
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
    tasks = {},
    subflows = [],
  } = options;
  return {
    document: {
      dsl: "1.0.3",
      namespace: "loopship",
      name,
      version: "1.0.0",
      metadata: {
        loopship: {
          kind: "flow",
          version: 1,
          defaultStage: defaultStage,
          stages,
          subflows,
        },
      },
    },
    do: Object.entries(stages).map(([stageId, stageDef]) => ({
      [stageDef.task]: {
        call: `workflow.loopship.steps.${stageDef.step}`,
        then: "continue",
        metadata: {
          loopship: {
            stageId,
            stepId: stageDef.step,
            stepWorkflow: `assets/workflows/steps/${stageDef.step}.yaml`,
          },
        },
        ...(tasks[stageDef.task] ?? {}),
      },
    })),
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
  step: "plan",
  state: "planning",
  summary: "Plan the work",
  output_schema: embeddedPlanInputSchema,
  allowed_transitions: { planned: "plan_review" },
  context: {
    step: {
      schema_version: 1,
      id: "plan",
      handler: "plan",
      input_step: "plan",
      input_schema: embeddedStepOutputEnvelope,
      output_schema: embeddedPlanInputSchema,
      result_schema_path: "schemas/steps/step-output.yaml",
      summary: "Plan the work",
      instructions: "# Loopship Plan Step\n\nPlan with clarification details.",
    },
  },
  commands: { next: command },
  docs,
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
      output_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "schemas/steps/next-input.yaml",
        title: "Loopship V3 Next Input",
        type: "object",
      },
      input: {
        step: "select_quest",
        action: "create_quest",
        wtree: "demo",
        flow_id: "swe",
        request: "loopship: demo",
      },
    },
  },
  "next-input": {
    step: "select_quest",
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
    step: "plan",
    classification: "feature",
    scope: "demo",
    system_context: emptySystemContext,
    verification_targets: ["works"],
    task_graph: {
      tasks: [{ id: "T001", title: "Build", acceptance: ["works"] }],
    },
  },
  "questions-input": {
    step: "questions",
    answers: [{ question_id: "q1", answer: "yes" }],
  },
  "task-graph-input": { step: "task_graph", approved: true },
  "child-dispatch-output": {
    ...baseStepOutput,
    schema_path: "schemas/steps/child-dispatch-output.yaml",
    step: "executing",
    state: "executing",
    output_schema: embeddedChildResultSchema,
    context: {
      step: {
        schema_version: 1,
        id: "executing",
        handler: "child_result",
        input_step: "child_result",
        input_schema: embeddedStepOutputEnvelope,
        output_schema: embeddedChildResultSchema,
        result_schema_path: "schemas/steps/child-dispatch-output.yaml",
        summary: "Dispatch children",
        instructions: "# Loopship Executing Step\n\nDispatch child work.",
      },
    },
    children: [
      {
        task_id: "t001",
        title: "Build",
        child_wtree: "demo-t001",
        branch_ref: "codex/demo-t001",
        worktree_path: "/tmp/worktree",
        acceptance: "works",
        commands: { init: command, next: command },
        result_schema: schemaRef,
      },
    ],
  },
  "child-result-input": {
    step: "child_result",
    task_id: "T001",
    child_wtree: "demo-t001",
    status: "passed",
    evidence: [{ type: "summary", ref: "README.md" }],
    merge_commit: "abc123",
  },
  "validation-input": {
    step: "validation",
    status: "passed",
    checks: [{ name: "test", status: "passed" }],
  },
  "verification-input": {
    step: "verification",
    status: "passed",
    acceptance_trace: [{ acceptance: "works", status: "passed" }],
    risks: [{ risk: "none", severity: "low" }],
  },
  "system-update-input": {
    step: "system_update",
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
    step: "landing",
    status: "landed",
    summary: "done",
  },
  "archive-output": {
    ...baseStepOutput,
    schema_path: "schemas/steps/archive-output.yaml",
    step: "archived",
    state: "archived",
    output_schema: null,
    allowed_transitions: {},
    landing: {
      source_branch: "build-demo",
      target_branch: "main",
      target_worktree: "/tmp/main-worktree",
      landed_commit: "abc123",
      strategy: "fast-forward",
    },
    context: {
      step: {
        schema_version: 1,
        id: "archived",
        handler: "archived",
        input_step: null,
        input_schema: embeddedStepOutputEnvelope,
        output_schema: null,
        result_schema_path: "schemas/steps/archive-output.yaml",
        summary: "Archived",
        instructions: "# Loopship Archived Step\n\nReport final state.",
      },
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

  it("accepts and rejects the SWF flow YAML schema", () => {
    expect(validateSchemaPath(validFlow, FLOW_SCHEMA_PATH)).toEqual([]);
    expect(
      validateSchemaPath({ ...validFlow, extra: true }, FLOW_SCHEMA_PATH).length,
    ).toBeGreaterThan(0);
    expect(
      validateSchemaPath({ ...validFlow, do: [] }, FLOW_SCHEMA_PATH).length,
    ).toBeGreaterThan(0);
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

  it("requires replan_reason when rejecting task graph approval", () => {
    expect(
      validateV3Input(
        { step: "task_graph", approved: false },
        "task-graph-input",
      ),
    ).not.toEqual([]);
    expect(
      validateV3Input(
        {
          step: "task_graph",
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
          step: "system_update",
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
          step: "system_update",
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
          step: "system_update",
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
          step: "system_update",
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
          step: "system_update",
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
    expect(flow.steps_by_id.executing.input_step).toBe("child_result");
    for (const step of Object.values(flow.steps_by_id)) {
      if (step.output_schema) {
        expect(step.instructions).toContain("## Step-Local Callback Contract");
        expect(step.instructions).toContain(
          "orchestrator owns flow transitions",
        );
        expect(step.instructions).toContain("current `output_schema`");
        expect(step.instructions).toContain(
          "do not shape output for a guessed successor",
        );
      } else {
        expect(step.instructions).toContain("## Terminal Output Contract");
        expect(step.instructions).toContain("`output_schema` is null");
        expect(step.instructions).toContain(
          "do not invent a next payload",
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
      "# Loopship Executing Step",
    );
    expect(flow.subflows.map((subflow) => subflow.id)).toEqual([
      "replanning",
      "add_task",
      "child_task",
    ]);
  });

  it("rejects invalid flow references", () => {
    expect(() => loadFlowDefinition("missing")).toThrow("unknown flow");
  });

  it("rejects missing steps, bad schema refs, missing task bindings, and bad transitions", () => {
    const root = mkdtempSync(join(tmpdir(), "loopship-flow-schema-"));
    try {
      const stepsDir = join(root, "steps");
      const flowPath = join(root, "flow.yaml");
      mkdirSync(stepsDir, { recursive: true });
      writeFileSync(
        join(stepsDir, "bad.yaml"),
        stringifyYaml(
            makeStepWorkflow({
              taskName: "bad",
            inputSchemaRef: join(root, "missing-schema.yaml"),
              outputSchemaRef: join(
                process.cwd(),
                "schemas/steps/step-output.yaml",
            ),
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
        {
          document: {
            dsl: "1.0.3",
            namespace: "loopship",
            name: "broken",
            version: "1.0.0",
            metadata: {
              loopship: {
                kind: "flow",
                version: 1,
                defaultStage: "planning",
                stages: {
                  planning: {
                    step: "plan",
                    task: "planning",
                    transitions: {},
                  },
                },
                subflows: [],
              },
            },
          },
          do: [
            {
              other_task: {
                call: "workflow.loopship.steps.plan",
                then: "continue",
              },
            },
          ],
        },
      );
      expect(() =>
        loadFlowDefinitionFromPath(flowPath, "broken", steps),
      ).toThrow("references missing task");

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
      const flowPath = join(root, "flow.yaml");
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
              trigger: "children[].commands.init",
              result_step: "validation",
              flow_id: "demo",
            },
          ],
        }),
      );
      expect(() => loadFlowDefinitionFromPath(flowPath, "demo", steps)).toThrow(
        "must match return stage input step child_result",
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
              trigger: "children[].commands.init",
              result_step: "child_result",
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
