#!/usr/bin/env bun

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { readText } from "./loopo_utils.ts";
import { loadFlowDefinition } from "./loopo_flow.ts";
import { validateSchemaPath } from "./loopo_schema.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_ROOT =
  basename(resolve(PACKAGE_ROOT, "..")) === "worktrees"
    ? resolve(PACKAGE_ROOT, "..", "..", "..")
    : resolve(PACKAGE_ROOT, "..");
const AI_RULES_ROOT = resolve(
  process.env.AI_RULES_ROOT ?? join(WORKSPACE_ROOT, "ai-rules"),
);
const SKILL_ROOT = resolve(AI_RULES_ROOT, "skills", "loopo");
const AGENT_MD_ROOT = resolve(AI_RULES_ROOT, "skills", "agent-md");

function assertExists(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`missing ${label}: ${path}`);
}

function assertContains(text: string, needle: string, scope: string): void {
  if (!text.includes(needle))
    throw new Error(`${scope} must include: ${needle}`);
}

function assertNotContains(text: string, needle: string, scope: string): void {
  if (text.includes(needle))
    throw new Error(`${scope} must not include: ${needle}`);
}

function assertNoLegacyIdentityTerms(): void {
  const pattern = [
    "\\bsl",
    "ug\\b",
    "parent_quest_",
    "sl",
    "ug",
    "child_",
    "sl",
    "ug",
    "--sl",
    "ug",
  ].join("");
  const proc = Bun.spawnSync(
    [
      "rg",
      "-n",
      pattern,
      ".",
      "--hidden",
      "--glob",
      "!node_modules",
      "--glob",
      "!.git",
      "--glob",
      "!worktrees",
      "--glob",
      "!.loopo",
    ],
    {
      cwd: PACKAGE_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (proc.exitCode === 1) return;
  if (proc.exitCode !== 0) {
    throw new Error(
      `legacy identity scan failed: ${new TextDecoder().decode(proc.stderr).trim() || new TextDecoder().decode(proc.stdout).trim()}`,
    );
  }
  throw new Error(
    `legacy identity terms reintroduced:\n${new TextDecoder().decode(proc.stdout).trim()}`,
  );
}

function assertMinimalSkillRoot(): void {
  const visibleEntries = readdirSync(SKILL_ROOT).filter(
    (entry) => !entry.startsWith("."),
  );
  if (visibleEntries.length !== 1 || visibleEntries[0] !== "SKILL.md") {
    throw new Error(
      `skills/loopo must stay launcher-only; found: ${visibleEntries.join(", ") || "(empty)"}`,
    );
  }
}

function assertMinimalRuntimeModel(): void {
  const scopedFiles = [
    join(PACKAGE_ROOT, "scripts", "loopo.ts"),
    join(PACKAGE_ROOT, "scripts", "loopo_core.ts"),
    join(PACKAGE_ROOT, "scripts", "loopo_sim.ts"),
    join(PACKAGE_ROOT, "scripts", "loopo_utils.ts"),
    join(PACKAGE_ROOT, "scripts", "verify_runtime_live.ts"),
    join(PACKAGE_ROOT, "references", "core", "architecture.md"),
    join(PACKAGE_ROOT, "tasks.md"),
  ];
  const forbidden = [
    ".loopo/quests",
    "LOOPO_QUESTS",
    "LOOPO_ARCHIEVE",
    "storage_mode",
    "questions.jsonl",
    "plans.jsonl",
    "evidence.jsonl",
    "validation.jsonl",
    "review.jsonl",
    "handoffs.jsonl",
    "hook-events.jsonl",
    ".git/loopo",
  ];
  for (const file of scopedFiles) {
    const text = readText(file);
    const scope = file.replace(`${PACKAGE_ROOT}/`, "");
    for (const needle of forbidden) {
      assertNotContains(text, needle, scope);
    }
  }
}

function stepTitle(id: string): string {
  return id
    .split(/[-_]/)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function assertStepInstructionsSelfScoped(
  flow: ReturnType<typeof loadFlowDefinition>,
): void {
  const forbiddenRawStateIds = flow.stages
    .map((stage) => stage.id)
    .filter((id) => id.includes("_"));
  const forbiddenTransitionPhrases = [
    "after canonical state is ready",
    "advances to",
    "returns to",
    "send it back",
    "sends failed",
    "move to execution",
    "before archiving",
  ];

  for (const step of Object.values(flow.steps_by_id)) {
    const scope = `${step.id} step`;
    const headings = step.instructions
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^#\s+Loopo\b/.test(line));
    const expectedHeading = `# Loopo ${stepTitle(step.id)} Step`;
    if (headings.length !== 1 || headings[0] !== expectedHeading) {
      throw new Error(
        `${scope} instructions must contain exactly one heading: ${expectedHeading}`,
      );
    }
    const text = `${step.summary}\n${step.instructions}`;
    assertNotContains(text, "Loopo Replanning Stage", scope);
    assertNotContains(text, "Loopo Plan Review Stage", scope);
    assertNotContains(text, "Loopo Task Graph Ready Stage", scope);
    for (const stateId of forbiddenRawStateIds) {
      assertNotContains(text, stateId, scope);
    }
    const normalized = text.toLowerCase();
    for (const phrase of forbiddenTransitionPhrases) {
      assertNotContains(normalized, phrase, scope);
    }
  }
}

function main(): number {
  const required = [
    ["loopo package.json", join(PACKAGE_ROOT, "package.json")],
    ["skill launcher", join(SKILL_ROOT, "SKILL.md")],
    ["swe flow", join(PACKAGE_ROOT, "assets", "flows", "swe.yaml")],
    [
      "signed system behaviours",
      join(PACKAGE_ROOT, ".loopo", "docs", "system-behaviours.yaml"),
    ],
    [
      "signed system index",
      join(PACKAGE_ROOT, ".loopo", "system.yaml"),
    ],
    [
      "signed root manifest",
      join(PACKAGE_ROOT, ".loopo", "manifest.sign.json"),
    ],
    ["plan step", join(PACKAGE_ROOT, "assets", "steps", "plan.yaml")],
    ["executing step", join(PACKAGE_ROOT, "assets", "steps", "executing.yaml")],
    [
      "architecture reference",
      join(PACKAGE_ROOT, "references", "core", "architecture.md"),
    ],
    [
      "child integration test",
      join(PACKAGE_ROOT, "scripts", "verify_child_agent_integration.test.ts"),
    ],
    [
      "quest verifier",
      join(PACKAGE_ROOT, "scripts", "verify_quest_contract.ts"),
    ],
    ["runtime simulator", join(PACKAGE_ROOT, "scripts", "loopo_sim.ts")],
    [
      "runtime simulation verifier",
      join(PACKAGE_ROOT, "scripts", "verify_runtime_simulation.ts"),
    ],
    [
      "system index schema",
      join(PACKAGE_ROOT, "schemas", "system-index.v1.json"),
    ],
    [
      "high-level schema",
      join(PACKAGE_ROOT, "schemas", "system-high-level-design.v1.json"),
    ],
    [
      "low-level schema",
      join(PACKAGE_ROOT, "schemas", "system-low-level-design.v1.json"),
    ],
    [
      "architecture schema",
      join(PACKAGE_ROOT, "schemas", "system-architecture.v1.json"),
    ],
    [
      "behaviours schema",
      join(PACKAGE_ROOT, "schemas", "system-behaviours.v1.json"),
    ],
    [
      "design-system schema",
      join(PACKAGE_ROOT, "schemas", "system-design-system.v1.json"),
    ],
    [
      "quest plan v3 schema",
      join(PACKAGE_ROOT, "schemas", "quest-plan.v3.json"),
    ],
    ["tasks v3 schema", join(PACKAGE_ROOT, "schemas", "tasks.v3.json")],
    [
      "init output schema",
      join(PACKAGE_ROOT, "schemas", "steps", "init-output.v3.json"),
    ],
    [
      "step output schema",
      join(PACKAGE_ROOT, "schemas", "steps", "step-output.v3.json"),
    ],
    [
      "error output schema",
      join(PACKAGE_ROOT, "schemas", "steps", "error-output.v3.json"),
    ],
    [
      "common step schema defs",
      join(PACKAGE_ROOT, "schemas", "steps", "common.v3.json"),
    ],
    ["flow YAML schema", join(PACKAGE_ROOT, "schemas", "flow.v1.json")],
    [
      "step definition YAML schema",
      join(PACKAGE_ROOT, "schemas", "step-definition.v1.json"),
    ],
    [
      "next input schema",
      join(PACKAGE_ROOT, "schemas", "steps", "next-input.v3.json"),
    ],
    [
      "plan schema",
      join(PACKAGE_ROOT, "schemas", "steps", "plan-input.v3.json"),
    ],
    [
      "child result schema",
      join(PACKAGE_ROOT, "schemas", "steps", "child-result-input.v3.json"),
    ],
    [
      "merge lease schema",
      join(PACKAGE_ROOT, "schemas", "merge-lease.v1.json"),
    ],
    [
      "system update schema",
      join(PACKAGE_ROOT, "schemas", "system-update.v1.json"),
    ],
  ] as const;
  for (const [label, path] of required) assertExists(path, label);
  assertNoLegacyIdentityTerms();
  assertMinimalRuntimeModel();
  assertMinimalSkillRoot();
  assertNotContains(
    existsSync(join(PACKAGE_ROOT, "SKILL.md")) ? "present" : "",
    "present",
    "package skill launcher removed",
  );

  const baseBehavioursPath = join(
    PACKAGE_ROOT,
    ".loopo",
    "docs",
    "system-behaviours.yaml",
  );
  const baseBehaviours = parseYaml(readText(baseBehavioursPath));
  if (
    !baseBehaviours ||
    typeof baseBehaviours !== "object" ||
    Array.isArray(baseBehaviours)
  ) {
    throw new Error("base system behaviours YAML must be an object");
  }
  const behaviourErrors = validateSchemaPath(
    baseBehaviours as Record<string, any>,
    "schemas/system-behaviours.v1.json",
  );
  if (behaviourErrors.length) {
    throw new Error(
      `system behaviours schema validation failed: ${behaviourErrors.join(
        "; ",
      )}`,
    );
  }

  const skill = readText(join(SKILL_ROOT, "SKILL.md"));
  assertContains(
    skill,
    'loopo init "{request}" --runtime <runtime>',
    "skills/loopo/SKILL.md",
  );
  assertContains(
    skill,
    "Package source lives in `/Volumes/Projects/business/AstronLab/omar391/loopo`.",
    "skills/loopo/SKILL.md",
  );
  assertNotContains(skill, "loopo quest start --json", "skills/loopo/SKILL.md");
  assertNotContains(
    skill,
    "loopo quest update --json",
    "skills/loopo/SKILL.md",
  );
  assertNotContains(skill, "--stdin", "skills/loopo/SKILL.md");
  assertNotContains(skill, "loopo apply", "skills/loopo/SKILL.md");
  assertNotContains(skill, "loopo quest hook", "skills/loopo/SKILL.md");

  const flow = loadFlowDefinition("swe");
  assertStepInstructionsSelfScoped(flow);
  if (flow.steps_by_id.executing.input_step !== "child_result") {
    throw new Error("swe executing stage must accept child_result input");
  }
  if (!flow.steps_by_id.plan.instructions.includes("# Loopo Plan Step")) {
    throw new Error("plan step must inline plan instructions");
  }
  assertNotContains(
    flow.steps_by_id.plan.instructions,
    "plan_intake",
    "plan step",
  );
  assertContains(
    flow.steps_by_id.plan.instructions,
    "request_user_input",
    "plan step",
  );
  assertContains(
    flow.steps_by_id.plan.instructions,
    "1-3 short questions",
    "plan step",
  );
  assertContains(
    flow.steps_by_id.plan.instructions,
    "wait indefinitely for a human answer",
    "plan step",
  );
  if ("spec_refs" in flow.steps_by_id.plan) {
    throw new Error("step definitions must not point back to stage specs");
  }
  if (
    !flow.subflows.some(
      (subflow) =>
        subflow.type === "spawned_quest" &&
        subflow.result_step === "child_result" &&
        subflow.returns_to === "task_graph_ready",
    )
  ) {
    throw new Error("swe flow must define child subflow return contract");
  }
  assertNotContains(
    existsSync(
      join(PACKAGE_ROOT, "references", "profiles", "coding", "swe-profile.md"),
    )
      ? "present"
      : "",
    "present",
    "unused profile removed",
  );

  const commonSpec = readText(
    join(AGENT_MD_ROOT, "assets", "specs", "common.md"),
  );
  assertNotContains(commonSpec, "## Loopo Launcher", "common spec");
  assertNotContains(commonSpec, "agent-md", "common spec");

  assertNotContains(
    existsSync(join(PACKAGE_ROOT, "assets", "specs")) ? "present" : "",
    "present",
    "loopo spec folder removed",
  );

  const repoAgents = readText(join(AI_RULES_ROOT, "AGENTS.md"));
  assertNotContains(repoAgents, "## Loopo Launcher", "repo AGENTS.md");
  assertNotContains(repoAgents, "rules:spec:loopo", "repo AGENTS.md");
  assertNotContains(repoAgents, "skills/loopo/assets/specs", "repo AGENTS.md");
  assertContains(
    repoAgents,
    "skills/agent-md/assets/specs/code-review.md",
    "repo AGENTS.md",
  );
  assertContains(
    repoAgents,
    "skills/agent-md/assets/specs/ts.md",
    "repo AGENTS.md",
  );
  assertNotContains(repoAgents, "loopo-stage-", "repo AGENTS.md");

  const architecture = readText(
    join(PACKAGE_ROOT, "references", "core", "architecture.md"),
  );
  assertContains(architecture, ".loopo/system.yaml", "architecture reference");
  assertContains(architecture, "system_update_pending", "architecture reference");
  assertContains(
    architecture,
    "Child CLI agents are senior developer agents",
    "architecture reference",
  );
  assertContains(architecture, "merge_target", "architecture reference");
  assertContains(architecture, "unauthorized/tampered", "architecture reference");
  assertContains(
    architecture,
    "Do not add separate lifecycle stage specs",
    "architecture reference",
  );
  assertContains(
    architecture,
    "Continue only when the latest `stop_reason` is exactly `none`.",
    "architecture reference",
  );
  assertContains(
    architecture,
    "Limit each automatic continuation chain to 12 non-terminal hook-triggered",
    "architecture reference",
  );
  assertContains(
    architecture,
    "When agent narration, terminal chatter, and Loopo state disagree",
    "architecture reference",
  );
  assertContains(
    architecture,
    "bun scripts/verify_runtime_hooks.ts",
    "architecture reference",
  );
  assertContains(
    architecture,
    "loopo cmdproto execjson <path> <payload>",
    "architecture reference",
  );
  assertContains(
    architecture,
    "delegates back to the direct",
    "architecture reference",
  );
  assertNotContains(architecture, "compatibility-only", "architecture reference");
  assertNotContains(architecture, "tasks.md", "architecture reference");
  assertNotContains(
    architecture,
    "stage specs may exist",
    "architecture reference",
  );

  for (const file of [
    join("assets", "specs", "index.json"),
    join("assets", "specs", "loopo-stage-executing.md"),
    join("assets", "post-commit", "post-commit"),
    join("scripts", "install_spec_post_commit_hook.sh"),
    join("assets", "steps", "plan-intake.yaml"),
    join("schemas", "steps", "plan-intake-input.v3.json"),
    join("references", "core", "intake-protocol.md"),
    join("references", "core", "controller-contract.md"),
    join("references", "runtime-hooks.md"),
    join("references", "runtime-hook-ops.md"),
  ]) {
    assertNotContains(
      existsSync(join(PACKAGE_ROOT, file)) ? "present" : "",
      "present",
      `${file} removed`,
    );
  }

  assertContains(
    flow.steps_by_id.questions.instructions,
    "human-provided answers",
    "questions step",
  );
  assertContains(
    flow.steps_by_id.questions.instructions,
    "`questions` step schema",
    "questions step",
  );

  for (const file of [
    "apply-request.v1.json",
    "apply-response.v1.json",
    join("scripts", "verify_apply_abi.ts"),
    join("scripts", "migrations", "migrate_task_loop_to_loopo.ts"),
    join("scripts", "migrations", "migrate_legacy_task_docs.ts"),
  ]) {
    assertNotContains(
      existsSync(join(PACKAGE_ROOT, file)) ? "present" : "",
      "present",
      `${file} removed`,
    );
  }

  console.log("loopo coherency verification passed");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
