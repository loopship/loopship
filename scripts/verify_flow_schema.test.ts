import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadFlowDefinition,
  loadFlowDefinitionFromPath,
  loadStepDefinitions,
} from "./loopo_flow.ts";
import {
  FLOW_SCHEMA_PATH,
  STEP_DEFINITION_SCHEMA_PATH,
  V3_STEP_SCHEMAS,
  validateV3Input,
  validateSchemaPath,
} from "./loopo_schema.ts";

const command = {
  cmd: "loopo",
  args: ["quest", "next", "--wtree", "demo", "--json", "@-"],
};

const schemaRef = {
  schema_path: "schemas/steps/next-input.v3.json",
};

const embeddedCallbackSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "schemas/steps/plan-input.v3.json",
  title: "Loopo V3 Plan Input",
  type: "object",
};

const embeddedChildResultSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "schemas/steps/child-result-input.v3.json",
  title: "Loopo V3 Child Result Input",
  type: "object",
};

const docs = {
  state_yaml: "/tmp/tasks.yaml",
  events_jsonl: "/tmp/events.jsonl",
  manifest: "/tmp/manifest.sign.json",
};

const validFlow = {
  schema_version: 1,
  id: "demo",
  version: 1,
  default_stage: "planning",
  stages: [
    {
      id: "planning",
      step: "plan",
      transitions: { planned: "plan_review" },
    },
    {
      id: "plan_review",
      step: "task_graph",
      transitions: { approved: "task_graph_ready" },
    },
    {
      id: "task_graph_ready",
      step: "executing",
      transitions: { complete: "archived" },
    },
    { id: "archived", step: "archived", transitions: {} },
  ],
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
};

const validStepDefinition = {
  schema_version: 1,
  id: "plan",
  handler: "plan",
  input_step: "plan",
  input_schema: "plan-input",
  output_schema: "step-output",
  summary: "Plan the work",
  instructions: "# Loopo Plan Step\n\nPlan with clarification details.",
};

const baseStepOutput = {
  schema_version: 3,
  kind: "quest_step",
  schema_path: "schemas/steps/step-output.v3.json",
  wtree: "demo",
  quest_id: "demo",
  flow_id: "swe",
  flow_version: 1,
  step: "plan",
  state: "planning",
  summary: "Plan the work",
  callback_schema: embeddedCallbackSchema,
  allowed_transitions: { planned: "plan_review" },
  context: {
    step: {
      schema_version: 1,
      id: "plan",
      handler: "plan",
      input_step: "plan",
      callback_schema: embeddedCallbackSchema,
      output_schema: "step-output",
      summary: "Plan the work",
      instructions: "# Loopo Plan Step\n\nPlan with clarification details.",
    },
  },
  commands: { next: command },
  docs,
};

const validPayloads: Record<string, Record<string, unknown>> = {
  "init-output": {
    schema_version: 3,
    kind: "init_route",
    schema_path: "schemas/steps/init-output.v3.json",
    request: "loopo: demo",
    runtime: "codex",
    flow_id: "swe",
    flow_version: 1,
    candidates: [],
    new_quest: {
      suggested_wtree: "demo",
      command,
      callback_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "schemas/steps/next-input.v3.json",
        title: "Loopo V3 Next Input",
        type: "object",
      },
      input: {
        step: "select_quest",
        action: "create_quest",
        wtree: "demo",
        flow_id: "swe",
        request: "loopo: demo",
      },
    },
  },
  "next-input": {
    step: "select_quest",
    action: "create_quest",
    wtree: "demo",
    flow_id: "swe",
    request: "loopo: demo",
  },
  "step-output": baseStepOutput,
  "error-output": {
    schema_version: 3,
    kind: "error",
    schema_path: "schemas/steps/error-output.v3.json",
    error: "callback schema validation failed",
    wtree: "demo",
    state: "planning",
    schema: schemaRef,
    errors: ["/extra is not allowed"],
  },
  "plan-input": {
    step: "plan",
    classification: "feature",
    scope: "demo",
    af: { hidden_assumptions: ["none"] },
    of: { procedure: ["plan"] },
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
    schema_path: "schemas/steps/child-dispatch-output.v3.json",
    step: "executing",
    state: "executing",
    callback_schema: embeddedChildResultSchema,
    context: {
      step: {
        schema_version: 1,
        id: "executing",
        handler: "child_result",
        input_step: "child_result",
        callback_schema: embeddedChildResultSchema,
        output_schema: "child-dispatch-output",
        summary: "Dispatch children",
        instructions: "# Loopo Executing Step\n\nDispatch child work.",
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
      updates: [{ doc_id: "architecture", summary: "updated" }],
    },
  },
  "landing-input": {
    step: "landing",
    status: "landed",
    summary: "done",
  },
  "archive-output": {
    ...baseStepOutput,
    schema_path: "schemas/steps/archive-output.v3.json",
    step: "archived",
    state: "archived",
    callback_schema: null,
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
        callback_schema: null,
        output_schema: "archive-output",
        summary: "Archived",
        instructions: "# Loopo Archived Step\n\nReport final state.",
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
    schema_path: "schemas/steps/lock-error.v3.json",
    wtree: "demo",
    lock: {
      path: "/tmp/lock.json",
      pid: 123,
      retry: command,
    },
  },
};

describe("loopo strict v3 step schemas", () => {
  it("accepts and rejects flow YAML and step definition YAML schemas", () => {
    expect(validateSchemaPath(validFlow, FLOW_SCHEMA_PATH)).toEqual([]);
    expect(
      validateSchemaPath({ ...validFlow, extra: true }, FLOW_SCHEMA_PATH).length,
    ).toBeGreaterThan(0);
    expect(
      validateSchemaPath(
        { ...validFlow, stages: [{ id: "planning", step: "plan" }] },
        FLOW_SCHEMA_PATH,
      ).length,
    ).toBeGreaterThan(0);

    expect(
      validateSchemaPath(validStepDefinition, STEP_DEFINITION_SCHEMA_PATH),
    ).toEqual([]);
    expect(
      validateSchemaPath(
        { ...validStepDefinition, instructions: "" },
        STEP_DEFINITION_SCHEMA_PATH,
      ).length,
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
});

describe("loopo bundled flow definitions", () => {
  it("loads the bundled swe flow", () => {
    const flow = loadFlowDefinition("swe");
    expect(flow.id).toBe("swe");
    expect(flow.stages_by_id.planning.step).toBe("plan");
    expect(flow.stages_by_id.task_graph_ready.step).toBe("executing");
    expect(flow.steps_by_id.executing.input_step).toBe("child_result");
    expect(flow.steps_by_id.plan.instructions).toContain("# Loopo Plan Step");
    expect(flow.steps_by_id.plan.instructions).toContain("## Defaulting Rules");
    expect(flow.steps_by_id.plan.instructions).toContain("request_user_input");
    expect(flow.steps_by_id.plan.instructions).toContain(
      "wait indefinitely for a human answer",
    );
    expect(flow.steps_by_id.questions.instructions).toContain(
      "human-provided answers",
    );
    expect(flow.steps_by_id.executing.instructions).toContain(
      "# Loopo Executing Step",
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

  it("rejects missing steps, bad schema refs, duplicate stages, and bad transitions", () => {
    const root = mkdtempSync(join(tmpdir(), "loopo-flow-schema-"));
    try {
      const stepsDir = join(root, "steps");
      const flowPath = join(root, "flow.yaml");
      mkdirSync(stepsDir, { recursive: true });
      writeFileSync(
        join(stepsDir, "bad.yaml"),
        [
          "schema_version: 1",
          "id: bad",
          "handler: bad",
          "input_step: bad",
          "input_schema: missing-schema",
          "output_schema: step-output",
          "summary: bad",
          "instructions: bad",
          "",
        ].join("\n"),
        "utf8",
      );
      expect(() => loadStepDefinitions(stepsDir)).toThrow(
        "missing step schema",
      );

      const steps = loadStepDefinitions();
      writeFileSync(
        flowPath,
        [
          "schema_version: 1",
          "id: broken",
          "version: 1",
          "default_stage: planning",
          "stages:",
          "  - id: planning",
          "    step: missing_step",
          "    transitions: {}",
          "subflows: []",
          "",
        ].join("\n"),
        "utf8",
      );
      expect(() =>
        loadFlowDefinitionFromPath(flowPath, "broken", steps),
      ).toThrow("missing step");

      writeFileSync(
        flowPath,
        [
          "schema_version: 1",
          "id: broken",
          "version: 1",
          "default_stage: planning",
          "stages:",
          "  - id: planning",
          "    step: plan",
          "    transitions: {}",
          "  - id: planning",
          "    step: questions",
          "    transitions: {}",
          "subflows: []",
          "",
        ].join("\n"),
        "utf8",
      );
      expect(() =>
        loadFlowDefinitionFromPath(flowPath, "broken", steps),
      ).toThrow("duplicate flow stage");

      writeFileSync(
        flowPath,
        [
          "schema_version: 1",
          "id: broken",
          "version: 1",
          "default_stage: planning",
          "stages:",
          "  - id: planning",
          "    step: plan",
          "    transitions:",
          "      next: missing_stage",
          "subflows: []",
          "",
        ].join("\n"),
        "utf8",
      );
      expect(() =>
        loadFlowDefinitionFromPath(flowPath, "broken", steps),
      ).toThrow("targets missing stage");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects incoherent subflow definitions", () => {
    const root = mkdtempSync(join(tmpdir(), "loopo-subflow-schema-"));
    try {
      const flowPath = join(root, "flow.yaml");
      const steps = loadStepDefinitions();
      const baseLines = [
        "schema_version: 1",
        "id: demo",
        "version: 1",
        "default_stage: planning",
        "stages:",
        "  - id: planning",
        "    step: plan",
        "    transitions:",
        "      planned: plan_review",
        "  - id: plan_review",
        "    step: task_graph",
        "    transitions:",
        "      approved: task_graph_ready",
        "  - id: task_graph_ready",
        "    step: executing",
        "    transitions:",
        "      complete: archived",
        "  - id: orphan",
        "    step: validation",
        "    transitions: {}",
        "  - id: archived",
        "    step: archived",
        "    transitions: {}",
        "subflows:",
      ];

      writeFileSync(
        flowPath,
        [
          ...baseLines,
          "  - id: replanning",
          "    type: in_flow_detour",
          "    starts_at: orphan",
          "    returns_to: task_graph_ready",
          "    trigger: replan",
          "",
        ].join("\n"),
        "utf8",
      );
      expect(() => loadFlowDefinitionFromPath(flowPath, "demo", steps)).toThrow(
        "returns_to is not reachable",
      );

      writeFileSync(
        flowPath,
        [
          ...baseLines,
          "  - id: child_task",
          "    type: spawned_quest",
          "    starts_at: task_graph_ready",
          "    returns_to: task_graph_ready",
          "    trigger: children[].commands.init",
          "    result_step: validation",
          "    flow_id: demo",
          "",
        ].join("\n"),
        "utf8",
      );
      expect(() => loadFlowDefinitionFromPath(flowPath, "demo", steps)).toThrow(
        "must match return stage input step child_result",
      );

      writeFileSync(
        flowPath,
        [
          ...baseLines,
          "  - id: child_task",
          "    type: spawned_quest",
          "    starts_at: task_graph_ready",
          "    returns_to: task_graph_ready",
          "    trigger: children[].commands.init",
          "    result_step: child_result",
          "    flow_id: missing_flow",
          "",
        ].join("\n"),
        "utf8",
      );
      expect(() => loadFlowDefinitionFromPath(flowPath, "demo", steps)).toThrow(
        "references missing flow",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
