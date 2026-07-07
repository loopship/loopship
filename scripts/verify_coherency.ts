#!/usr/bin/env bun

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { readText } from "./loopship_utils.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_ROOT =
  basename(resolve(PACKAGE_ROOT, "..")) === "worktrees"
    ? resolve(PACKAGE_ROOT, "..", "..", "..")
    : resolve(PACKAGE_ROOT, "..");
function resolveAiRulesRoot(): string {
  const candidates = [
    process.env.AI_RULES_ROOT,
    "/Volumes/Projects/business/AstronLab/personal/devtools/ai-rules",
    join(WORKSPACE_ROOT, "ai-rules"),
    resolve(PACKAGE_ROOT, "..", "..", "..", "personal", "devtools", "ai-rules"),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const found = candidates.find((candidate) =>
    existsSync(resolve(candidate, "skills", "loopship", "SKILL.md")),
  );
  return resolve(found ?? candidates[0]);
}
const AI_RULES_ROOT = resolveAiRulesRoot();
const SKILL_ROOT = resolve(AI_RULES_ROOT, "skills", "loopship");

function assertExists(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`missing ${label}: ${path}`);
}

function assertContains(text: string, needle: string, scope: string): void {
  if (!text.includes(needle)) throw new Error(`${scope} must include: ${needle}`);
}

function assertNotContains(text: string, needle: string, scope: string): void {
  if (text.includes(needle)) throw new Error(`${scope} must not include: ${needle}`);
}

function readYamlObject(path: string): Record<string, unknown> {
  const value = parseYaml(readText(path));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`YAML document must be an object: ${path}`);
  }
  return value as Record<string, unknown>;
}

function collectFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(path));
    else files.push(path);
  }
  return files;
}

function relativePackagePath(path: string): string {
  return path.slice(PACKAGE_ROOT.length + 1);
}

function assertMinimalSkillRoot(): void {
  const visibleEntries = readdirSync(SKILL_ROOT).filter((entry) => !entry.startsWith("."));
  if (visibleEntries.length !== 1 || visibleEntries[0] !== "SKILL.md") {
    throw new Error(`skills/loopship must stay launcher-only; found: ${visibleEntries.join(", ") || "(empty)"}`);
  }
}

function assertPackageFilesExist(): void {
  const packageJson = JSON.parse(readText(resolve(PACKAGE_ROOT, "package.json"))) as {
    files?: unknown;
  };
  const files = Array.isArray(packageJson.files) ? packageJson.files : [];
  for (const entry of files) {
    if (typeof entry !== "string" || !entry.trim() || entry.includes("*")) continue;
    assertExists(resolve(PACKAGE_ROOT, entry), `package.json files entry ${entry}`);
  }
}

function assertNoLegacySystemDocs(): void {
  const legacyPaths = [
    ".loopship/manifest.sign.json",
    ".loopship/manifest.yaml",
    ".loopship/docs/system-behaviours.yaml",
    ".loopship/docs/architecture.yaml",
    ".loopship/docs/design-system.yaml",
    ".loopship/docs/high-level-design.yaml",
    ".loopship/docs/low-level-design.yaml",
    ".loopship/docs/views",
    ".loopship/docs/contexts",
    ".loopship/docs/domains",
    ".loopship/docs/adrs",
    "schemas/system-behaviours.yaml",
    "schemas/system-architecture.yaml",
    "schemas/system-context.yaml",
    "schemas/system-design-system.yaml",
    "schemas/system-high-level-design.yaml",
    "schemas/system-low-level-design.yaml",
    "schemas/system-common.yaml",
    "schemas/system-assertion.yaml",
    "schemas/system-domain.yaml",
    "schemas/system-view.yaml",
    "schemas/system-adr.yaml",
    "schemas/system-artifact.yaml",
    "schemas/system-manifest.yaml",
    "schemas/system-doc.yaml",
    "schemas/manifest.yaml",
    "schemas/resource-markdown.yaml",
    "schemas/docs/workflow-contract.yaml",
    "schemas/docs/agent-contract.yaml",
    "schemas/docs/knowledge-map.yaml",
    "schemas/docs/data-card.yaml",
    "schemas/docs/organization-model.yaml",
    "schemas/docs/artifact-card.yaml",
  ];
  for (const relativePath of legacyPaths) {
    if (existsSync(resolve(PACKAGE_ROOT, relativePath))) {
      throw new Error(`legacy path must not exist after hard cut: ${relativePath}`);
    }
  }
}

function assertCanonicalSchemas(): void {
  for (const relativePath of [
    "schemas/system.yaml",
    "schemas/system-pack.yaml",
    "schemas/signature.yaml",
    "schemas/semantic-rules.yaml",
    "schemas/docs/software-architecture.yaml",
    "schemas/docs/decision-records.yaml",
    "schemas/docs/workflow-spec.yaml",
    "schemas/docs/agent-system-card.yaml",
    "schemas/docs/knowledge-report.yaml",
    "schemas/docs/dataset-datasheet.yaml",
    "schemas/docs/model-card.yaml",
    "schemas/docs/business-architecture.yaml",
    "schemas/docs/artifact-bom.yaml",
  ]) {
    assertExists(resolve(PACKAGE_ROOT, relativePath), relativePath);
  }
  const schemaDir = resolve(PACKAGE_ROOT, "schemas");
  const jsonSchemas = readdirSync(schemaDir).filter((name) => name.endsWith(".json"));
  if (jsonSchemas.length) {
    throw new Error(`schemas directory must not contain JSON schema files: ${jsonSchemas.join(", ")}`);
  }
  const versionedSchemas = readdirSync(schemaDir).filter((name) => /\.v\d+\./.test(name));
  if (versionedSchemas.length) {
    throw new Error(`schema filenames must not contain version tags: ${versionedSchemas.join(", ")}`);
  }
}

function assertPlanPrompt(): void {
  const text = readText(resolve(PACKAGE_ROOT, "call-catalog", "loopship", "workflow", "service", "step", "plan.stable.yaml"));
  const scope = "plan step prompt";
  for (const needle of [
    "# Loopship Plan Step",
    "Documentation Grill",
    ".loopship/system.yaml",
    "## Terminal Child Constraint",
    "`parent_task_id`",
    "`parent_context_ref`",
    "`execute child task`",
    "leave `child_wtree` and `merge_lease_id` empty or omitted",
    "`*.stable.yaml` and call-catalog `index.yaml` as promotion-managed",
    "make edits in `*.dev.yaml` only",
    "`objects[]`",
    "`assertions[]`",
    "`resources[]`",
    "`memories[]`",
    "relation-keyed `links` maps",
    "supported_by: [resource:<id>#/<json-pointer>]",
    "software-architecture",
    "decision-records",
    "workflow-spec",
    "agent-system-card",
    "relevant_object_refs",
    "relevant_assertion_refs",
    "relevant_resource_refs",
    "relevant_memory_refs",
    "durable_implications",
    "AF/OF improve the reasoning process here",
    "not output fields",
  ]) {
    assertContains(text, needle, scope);
  }
  for (const needle of [
    "control_plane.assertions",
    "domain_refs",
    "relevant_domain_refs",
    "relevant_evidence_refs",
    "relevant_relation_refs",
    "relevant_record_refs",
    "`records[]`",
    "`relations[]`",
    ".loopship/docs/system-behaviours.yaml",
    ".loopship/docs/domains/*.yaml",
    ".loopship/docs/adrs/*.yaml",
    "`af`",
    "`of`",
  ]) {
    assertNotContains(text, needle, scope);
  }
}

function assertWorkflowSpecTerminalChildRules(): void {
  const text = readText(resolve(PACKAGE_ROOT, ".loopship", "docs", "workflow", "spec.yaml"));
  const scope = ".loopship/docs/workflow/spec.yaml";
  for (const needle of [
    "terminal child quests",
    "Only root/coordinator quests may decompose into child worktrees",
    "launch one child at a time",
    "Unsupervised runs may still dispatch multiple children in parallel",
    "Fastflow `*.stable.yaml` workflow files and call-catalog `index.yaml` files",
    "promotion-managed release artifacts",
    "Workflow validation rejects stable workflow digest drift",
    "restore the stable artifact",
  ]) {
    assertContains(text, needle, scope);
  }
}

function assertAgentSystemCardTerminalChildRules(): void {
  const text = readText(resolve(PACKAGE_ROOT, ".loopship", "docs", "agent", "system-card.yaml"));
  const scope = ".loopship/docs/agent/system-card.yaml";
  for (const needle of [
    "terminal child agents stay local",
    "coordinators launch one child at a time",
    "`loopship stepper init`",
    "promotion-managed release artifacts",
    "Do not hand-edit Fastflow `*.stable.yaml` workflow files or call-catalog `index.yaml`",
    "Do not let a terminal child quest dispatch child worktrees",
    "malformed stable workflow edits",
    "restore the stable artifact",
  ]) {
    assertContains(text, needle, scope);
  }
}

function assertSystemUpdatePrompt(): void {
  const text = readText(resolve(PACKAGE_ROOT, "call-catalog", "loopship", "workflow", "service", "step", "system-update.stable.yaml"));
  const scope = "system_update side-effect workflow";
  for (const needle of [
    "Submit system doc updates. Loopship writes signed repo docs.",
    "fastflow.afn.core.request.input",
    "loopship.afn.service.system.apply",
    "schemas/steps/system-update-input.yaml",
    "schema_version",
    ".loopship/system.yaml",
    ".loopship/docs/**/*.yaml",
    ".loopship/signature.yaml",
    "Use `mode: \"no_change\"` only when",
  ]) {
    assertContains(text, needle, scope);
  }
  for (const needle of [
    "control_plane.assertions",
    "domain_refs",
    "doc_type",
    ".loopship/docs/system-behaviours.yaml",
    ".loopship/docs/domains/",
    ".loopship/docs/adrs/",
    "pending_proposals",
    "`records[]`",
    "`relations[]`",
    "subject_refs",
    "source_refs",
    "evidence_refs",
    "authority: canonical",
    ".loopship/docs/*.yaml",
  ]) {
    assertNotContains(text, needle, scope);
  }
}

function assertStepPromptLifecycleCoherency(): void {
  for (const [name, title, contractPhrase] of [
    ["questions", "# Loopship Questions Step", "do not include command strings, successor-state scaffolding"],
    ["task-graph", "# Loopship Task Graph Step", "do not include command strings, successor-state scaffolding"],
    ["child-result", "# Loopship Child Result Step", "do not include command strings, successor-state scaffolding"],
    ["validation", "# Loopship Validation Step", "do not include command strings, successor-state scaffolding"],
    ["verification", "# Loopship Verification Step", "do not include command strings, successor-state scaffolding"],
    ["system-update", "# Loopship System Update Step", "do not emit command strings"],
  ] as const) {
    const text = readText(resolve(PACKAGE_ROOT, "call-catalog", "loopship", "workflow", "service", "step", `${name}.stable.yaml`));
    const scope = `${name} step prompt`;
    assertContains(text, title, scope);
    assertContains(text, "## Step-Local Callback Contract", scope);
    assertContains(text, "The Fastflow orchestrator owns flow", scope);
    assertContains(text, "Return exactly one JSON payload", scope);
    assertContains(text, contractPhrase, scope);
  }

  const executing = readText(resolve(PACKAGE_ROOT, "call-catalog", "loopship", "workflow", "service", "step", "executing.stable.yaml"));
  assertContains(executing, "Prepare ready child worktrees for coordinator quests only", "executing step workflow");
  assertContains(executing, "terminal child quests must not dispatch nested child worktrees", "executing step workflow");

  const landing = readText(resolve(PACKAGE_ROOT, "call-catalog", "loopship", "workflow", "service", "step", "landing.stable.yaml"));
  assertContains(landing, "loopship.afn.service.landing.apply", "landing step workflow");
  assertContains(landing, "target_branch", "landing step workflow");
  assertContains(landing, "target_worktree", "landing step workflow");
  assertContains(landing, "source_branch", "landing step workflow");
}

function assertSweFlowLifecycleGuards(): void {
  const text = readText(resolve(PACKAGE_ROOT, "call-catalog", "loopship", "workflow", "service", "flows", "swe.stable.yaml"));
  const scope = "SWE flow lifecycle guards";
  for (const needle of [
    "stage_result_awaiting_user_answers",
    "answers_partial",
    "const targetStage = complete ? \"planning\" : \"awaiting_user_answers\"",
    "stage_result_plan_review",
    "replan_reason",
    "const emptyApproved = !rejected && payload.approved === true && array(tasks.tasks).length === 0",
    "approved task graph is empty; replan with at least one concrete local or child task before execution",
    "const targetStage = effectiveRejected ? \"replanning\"",
    "stage_leaf_git_head",
    "stage_result_leaf_executing",
    "childResultsAfterChildResult",
    "evidence: array(payload.evidence)",
    "stage_result_landing_ready",
    "landed_commit",
    "landing_strategy",
  ]) {
    assertContains(text, needle, scope);
  }

  const scriptCount = (text.match(/\bscript:/g) ?? []).length;
  if (scriptCount > 43) {
    throw new Error(
      `SWE flow script count grew from the audited baseline: expected <=43 script blocks, found ${scriptCount}`,
    );
  }
}

function assertReadmeCommandSurface(): void {
  const text = readText(resolve(PACKAGE_ROOT, "README.md"));
  const scope = "README.md";
  for (const needle of [
    "node index.ts handbook",
    "node index.ts handbook --raw",
    "node index.ts handbook --duplicates --json",
    "node index.ts handbook --fix-duplicates --json",
    "node index.ts cmdproto execjson handbook",
    "`loopship handbook` renders a standalone generated Markdown handbook",
    "`loopship handbook --duplicates` reports exact normalized duplicate prose",
    "recoverable system temp path",
    "generated output, not canonical truth",
  ]) {
    assertContains(text, needle, scope);
  }
}

function assertCanonicalArchitectureDocs(): void {
  if (existsSync(resolve(PACKAGE_ROOT, "references", "core", "architecture.md"))) {
    throw new Error("references/core/architecture.md must be archived after canonical YAML migration");
  }
  if (existsSync(resolve(PACKAGE_ROOT, "system-review.md"))) {
    throw new Error("system-review.md must be archived after canonical YAML migration");
  }
  assertExists(resolve(PACKAGE_ROOT, "references", "archive", "core-architecture.md"), "archived architecture reference");
  assertExists(resolve(PACKAGE_ROOT, "references", "archive", "system-review.md"), "archived system review");
  const text = readText(resolve(PACKAGE_ROOT, ".loopship", "docs", "software", "architecture.yaml"));
  const scope = ".loopship/docs/software/architecture.yaml";
  for (const needle of [
    ".loopship/system.yaml",
    ".loopship/signature.yaml",
    "schemas/system.yaml",
    "relation-keyed typed links",
    "diagrams:",
    "examples:",
    "syntax: mermaid",
    "source: |-",
    "resource:software-architecture#/constraints",
    "system_update",
    "hook continuation",
  ]) {
    assertContains(text, needle, scope);
  }
  for (const needle of [
    "control_plane.assertions",
    ".loopship/docs/system-behaviours.yaml",
    ".loopship/docs/contexts/*.yaml",
    ".loopship/docs/areas/*.yaml",
    ".loopship/docs/domains/*.yaml",
    ".loopship/docs/adrs/*.yaml",
    ".loopship/docs/high-level-design.yaml",
    ".loopship/docs/low-level-design.yaml",
    ".loopship/docs/design-system.yaml",
    "references/core/architecture.md",
  ]) {
    assertNotContains(text, needle, scope);
  }
}

function assertRootSystemDocument(): void {
  const system = readYamlObject(resolve(PACKAGE_ROOT, ".loopship", "system.yaml"));
  for (const key of ["objects", "assertions", "resources"]) {
    if (!Array.isArray(system[key]) || !system[key].length) {
      throw new Error(`.loopship/system.yaml must define non-empty ${key}[]`);
    }
  }
  if ("memories" in system && (!Array.isArray(system.memories) || !system.memories.length)) {
    throw new Error(".loopship/system.yaml memories[] must be omitted when empty");
  }
  for (const forbiddenKey of [
    "status",
    "summary",
    "purpose",
    "write_policy",
    "generated_policy",
    "manifest_ref",
    "memory_policy",
    "relations",
    "records",
  ]) {
    if (forbiddenKey in system) throw new Error(`.loopship/system.yaml must not define ${forbiddenKey}`);
  }
  const resources = Array.isArray(system.resources) ? system.resources : [];
  const objectRows = Array.isArray(system.objects) ? system.objects : [];
  for (const object of objectRows) {
    if (!object || typeof object !== "object" || Array.isArray(object)) continue;
    const kind = String((object as Record<string, unknown>).kind ?? "");
    if (kind === "view" || kind === "decision") {
      throw new Error(`.loopship/system.yaml must not use object kind: ${kind}`);
    }
  }
  const canonicalDocs = resources.filter(
    (resource): resource is Record<string, unknown> =>
      Boolean(resource && typeof resource === "object" && resource.kind === "document" && resource.role === "canonical"),
  );
  const schemaRefs = new Set<string>();
  for (const doc of canonicalDocs) {
    if ("slots" in doc) throw new Error(`canonical document resource must not use slots: ${String(doc.id ?? "")}`);
    schemaRefs.add(String(doc.schema_ref ?? ""));
  }
  for (const requiredSchema of [
    "loopship://schemas/docs/software-architecture.yaml",
    "loopship://schemas/docs/decision-records.yaml",
    "loopship://schemas/docs/workflow-spec.yaml",
    "loopship://schemas/docs/agent-system-card.yaml",
  ]) {
    if (!schemaRefs.has(requiredSchema)) throw new Error(`Loopship missing canonical document schema: ${requiredSchema}`);
  }
  const resourceIds = new Set(
    resources
      .filter((resource): resource is Record<string, unknown> => Boolean(resource && typeof resource === "object"))
      .map((resource) => String(resource.id ?? "")),
  );
  for (const staleId of [
    "markdown-resource-schema",
    "system-doc-schema",
    "manifest-schema",
    "architecture-doc",
    "decision-log-doc",
    "workflow-contract",
    "agent-contract",
  ]) {
    if (resourceIds.has(staleId)) throw new Error(`.loopship/system.yaml must not include stale resource: ${staleId}`);
  }
  for (const block of ["objects", "assertions", "resources", "memories"]) {
    const rows = Array.isArray(system[block]) ? system[block] : [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const links = (row as Record<string, unknown>).links;
      if (links === undefined) continue;
      if (!links || typeof links !== "object" || Array.isArray(links)) {
        throw new Error(`.loopship/system.yaml ${block} links must be relation-keyed maps`);
      }
      const rendered = JSON.stringify(links);
      if (!/\b(object|assertion|resource|memory):/.test(rendered)) {
        throw new Error(`.loopship/system.yaml ${block} links must use typed refs`);
      }
    }
  }
}

function assertNoStaleProjectLanguage(): void {
  const roots = [
    resolve(PACKAGE_ROOT, ".loopship"),
    resolve(PACKAGE_ROOT, "call-catalog", "loopship", "workflow", "service", "step"),
    resolve(PACKAGE_ROOT, "references", "core"),
  ];
  const files = [
    resolve(PACKAGE_ROOT, "AGENTS.md"),
    resolve(PACKAGE_ROOT, "README.md"),
    resolve(PACKAGE_ROOT, "tasks.md"),
    ...roots.flatMap(collectFiles),
  ].filter((path) => /\.(md|ya?ml)$/.test(path));
  for (const path of files) {
    const text = readText(path);
    const scope = relativePackagePath(path);
    assertNotContains(text, "system index", scope);
    assertNotContains(text, ".loopship/docs/*.yaml", scope);
    assertNotContains(text, ".loopship/manifest.yaml", scope);
    assertNotContains(text, "schemas/system-doc.yaml", scope);
    assertNotContains(text, "schemas/manifest.yaml", scope);
    assertNotContains(text, "schema_ref: resource:system-doc-schema", scope);
    assertNotContains(text, "meaningful `slots`", scope);
    assertNotContains(text, "standard_alignment[]", scope);
    assertNotContains(text, "about <record_id>", scope);
    assertNotContains(text, "part_of <record_id>", scope);
    assertNotContains(text, "supported_by <record_id>", scope);
    assertNotContains(text, "references/core/architecture.md", scope);
    assertNotContains(text, "system-review.md", scope);
  }
}

function assertWorkflowValidation(): void {
  for (const relativePath of [
    "call-catalog/loopship/workflow/service/flows/index.yaml",
    "call-catalog/loopship/workflow/service/flows/swe.stable.yaml",
    "call-catalog/loopship/workflow/service/step/index.yaml",
    "call-catalog/loopship/workflow/service/step/plan.stable.yaml",
    "call-catalog/loopship/workflow/service/step/system-update.stable.yaml",
  ]) {
    const absolutePath = resolve(PACKAGE_ROOT, relativePath);
    assertExists(absolutePath, relativePath);
    const document = readYamlObject(absolutePath);
    if (relativePath.endsWith(".stable.yaml")) {
      const metadata = document.document;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new Error(`${relativePath} must contain Fastflow document metadata`);
      }
      if (!Array.isArray(document.do)) {
        throw new Error(`${relativePath} must contain a Fastflow do list`);
      }
    }
  }
}

function main(): number {
  assertExists(resolve(PACKAGE_ROOT, "package.json"), "loopship package.json");
  assertExists(resolve(SKILL_ROOT, "SKILL.md"), "skill launcher");
  assertExists(resolve(PACKAGE_ROOT, ".loopship", "system.yaml"), "root system");
  assertExists(resolve(PACKAGE_ROOT, ".loopship", "signature.yaml"), "root signature");
  assertMinimalSkillRoot();
  assertPackageFilesExist();
  assertNoLegacySystemDocs();
  assertCanonicalSchemas();
  assertRootSystemDocument();
  assertNoStaleProjectLanguage();
  assertReadmeCommandSurface();
  assertPlanPrompt();
  assertSystemUpdatePrompt();
  assertStepPromptLifecycleCoherency();
  assertSweFlowLifecycleGuards();
  assertCanonicalArchitectureDocs();
  assertWorkflowSpecTerminalChildRules();
  assertAgentSystemCardTerminalChildRules();
  assertWorkflowValidation();
  return 0;
}

process.exit(main());
