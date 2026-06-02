#!/usr/bin/env bun

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  expandHome,
  hashText,
  nowIso,
  readJson,
  readText,
  runCommand,
  shellQuote,
  writeJson,
  writeText,
} from "./loopo_utils.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const LOOPO_DIR = ".loopo";
export const LOOPO_RUNTIME_DIR = join(LOOPO_DIR, "runtime");
export const LOOPO_SYSTEM_FILE = join(LOOPO_DIR, "system.yaml");
export const LOOPO_DOCS_DIR = join(LOOPO_DIR, "docs");
export const LOOPO_ROOT_MANIFEST_FILE = join(LOOPO_DIR, "manifest.sign.json");
export const LOOPO_SYSTEM_BEHAVIOURS_FILE = join(
  LOOPO_DOCS_DIR,
  "system-behaviours.yaml",
);
export const LOOPO_BIN_FILE = join(LOOPO_DIR, "bin", "loopo");
export const LOOPO_GLOBAL_BIN_ENV = "LOOPO_GLOBAL_BIN";
export const LOOPO_SCRIPT_ENV = "LOOPO_SCRIPT";
export const CANONICAL_QUEST_RE =
  /(?:^|[\\/])\.loopo[\\/]runtime[\\/]tasks\.yaml$/i;
const LEGACY_WTREE_KEY = ["sl", "ug"].join("");
const LEGACY_PARENT_WTREE_KEY = ["parent", "quest", ["sl", "ug"].join("")].join("_");
const LEGACY_CHILD_WTREE_KEY = ["child", ["sl", "ug"].join("")].join("_");

export type QuestFiles = {
  wtree: string;
  workspace_root: string;
  loopo_root: string;
  dir: string;
  tasks: string;
  events: string;
  manifest: string;
  hook_state: string;
  lock: string;
};

export type QuestTask = {
  id: string;
  title: string;
  type: "coding" | "general";
  status: string;
  dependencies: string[];
  scope_files: string[];
  spec_refs: string[];
  context_refs: string[];
  branch_ref: string;
  worktree_path: string;
  child_wtree: string;
  concurrency_group: string;
  merge_target: string;
  merge_lease_id: string;
  merge_commit: string;
  system_impact_ref: string;
  acceptance: string;
  blocker?: string;
};

export type QuestQuestion = {
  id: string;
  question: string;
  impact?: string;
  default?: string;
};

export type QuestAnswer = {
  id?: string;
  question_id?: string;
  question?: string;
  answer: string;
  accepted_default?: boolean;
};

export type QuestQuestionRound = {
  questions: QuestQuestion[];
};

export type QuestPlanDetail = {
  classification: string;
  scope: string;
  summary: string;
  rationale: string;
  af: Record<string, unknown>;
  of: Record<string, unknown>;
  high_impact_unknowns: string[];
  defaulted_unknowns: string[];
  verification_targets: string[];
  decomposition_rationale: string;
};

export type QuestValidationReceipt = {
  status: string;
  checks: Array<Record<string, unknown>>;
};

export type QuestVerificationReceipt = {
  status: string;
  acceptance_trace: Array<Record<string, unknown>>;
  risks: Array<Record<string, unknown>>;
};

export type QuestState = {
  schema_version: 3;
  wtree: string;
  quest_id: string;
  flow_id: string;
  flow_version: number;
  stage: string;
  prompt: string;
  context_root: string;
  resolution_source: string;
  coordinator_branch: string;
  coordinator_worktree: string;
  parent_wtree: string;
  parent_task_id: string;
  parent_context_ref: string;
  landing_target_branch: string;
  landing_target_worktree: string;
  landed_commit: string;
  landing_strategy: string;
  assumptions: string[];
  constraints: string[];
  question_rounds: QuestQuestionRound[];
  answers: QuestAnswer[];
  plan_detail: QuestPlanDetail;
  validation_receipt: QuestValidationReceipt;
  verification_receipt: QuestVerificationReceipt;
  tasks: QuestTask[];
};

export type QuestWorkspace = {
  branch_ref: string;
  worktree_path: string;
  mode: "git" | "directory";
};

function normalizeTaskPathSegment(value: string): string {
  const cleaned = String(value || "")
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "task";
}

function compactTaskAssignmentKey(wtree: string, taskId: string): string {
  const normalizedWtree = normalizeTaskPathSegment(wtree);
  const normalizedTaskId = normalizeTaskPathSegment(taskId);
  const full = `${normalizedWtree}-${normalizedTaskId}`;
  if (full.length <= 72) return full;
  const digest = hashText(full).slice(0, 12);
  const taskPart = normalizedTaskId.slice(0, 20).replace(/-+$/g, "") || "task";
  const wtreeBudget = Math.max(16, 72 - taskPart.length - digest.length - 2);
  const wtreePart =
    normalizedWtree.slice(0, wtreeBudget).replace(/-+$/g, "") || "quest";
  return `${wtreePart}-${taskPart}-${digest}`;
}

export function taskAssignmentBranchRef(wtree: string, taskId: string): string {
  return `codex/${compactTaskAssignmentKey(wtree, taskId)}`;
}

export function taskAssignmentChildWtree(
  wtree: string,
  taskId: string,
): string {
  return compactTaskAssignmentKey(wtree, taskId);
}

export function taskAssignmentMergeLeaseId(
  wtree: string,
  taskId: string,
): string {
  return `lease-${compactTaskAssignmentKey(wtree, taskId)}`;
}

export function taskAssignmentWorktreePath(
  repoRoot: string,
  wtree: string,
  taskId: string,
): string {
  return resolve(
    repoRoot,
    "worktrees",
    compactTaskAssignmentKey(wtree, taskId),
  );
}

export function normalizeName(input: string): string {
  const value = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return value || "main";
}

function yamlScalar(value: string): string {
  return JSON.stringify(String(value ?? ""));
}

function yamlStringList(values: string[]): string {
  if (!values.length) return "[]";
  return `[${values.map((value) => yamlScalar(value)).join(", ")}]`;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function planTaskAcceptance(value: unknown): string {
  if (Array.isArray(value)) return asStringList(value).join("; ");
  return String(value ?? "").trim();
}

export function questFiles(repoRoot: string, wtree: string): QuestFiles {
  const worktreeRoot = coordinatorWorktreePath(repoRoot, wtree);
  return questFilesForWorkspace(worktreeRoot, wtree);
}

export function questFilesForWorkspace(
  workspaceRoot: string,
  wtree: string,
): QuestFiles {
  const workspace_root = resolve(workspaceRoot);
  const loopo_root = resolve(workspace_root, LOOPO_DIR);
  const dir = resolve(workspace_root, LOOPO_RUNTIME_DIR);
  return {
    wtree,
    workspace_root,
    loopo_root,
    dir,
    tasks: resolve(dir, "tasks.yaml"),
    events: resolve(dir, "events.jsonl"),
    manifest: resolve(dir, "manifest.sign.json"),
    hook_state: resolve(dir, "hook-state.json"),
    lock: resolve(dir, "lock.json"),
  };
}

export function questWorkspaceRoot(files: QuestFiles): string {
  return files.workspace_root;
}

type SystemDocDef = {
  id: string;
  file: string;
  schema: string;
};

export const SYSTEM_DOCS: SystemDocDef[] = [
  {
    id: "high-level-design",
    file: "high-level-design.yaml",
    schema: "system-high-level-design.v1.json",
  },
  {
    id: "low-level-design",
    file: "low-level-design.yaml",
    schema: "system-low-level-design.v1.json",
  },
  {
    id: "architecture",
    file: "architecture.yaml",
    schema: "system-architecture.v1.json",
  },
  {
    id: "system-behaviours",
    file: "system-behaviours.yaml",
    schema: "system-behaviours.v1.json",
  },
  {
    id: "design-system",
    file: "design-system.yaml",
    schema: "system-design-system.v1.json",
  },
];

export function systemDocPath(repoRoot: string, file: string): string {
  return resolve(repoRoot, LOOPO_DOCS_DIR, file);
}

export function renderSystemDocYaml(doc: SystemDocDef): string {
  if (doc.id === "system-behaviours") {
    return renderSystemBehavioursYaml();
  }
  const title = doc.id
    .split("-")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
  return [
    "schema_version: 1",
    `id: ${yamlScalar(doc.id)}`,
    `title: ${yamlScalar(title)}`,
    "sections: []",
    "updated_at: null",
    "",
  ].join("\n");
}

export function renderSystemIndexYaml(repoRoot: string): string {
  const lines = ["schema_version: 1", "docs:"];
  for (const doc of SYSTEM_DOCS) {
    const path = systemDocPath(repoRoot, doc.file);
    lines.push(`  - id: ${yamlScalar(doc.id)}`);
    lines.push(`    path: ${yamlScalar(`.loopo/docs/${doc.file}`)}`);
    lines.push(`    schema_path: ${yamlScalar(`schemas/${doc.schema}`)}`);
    lines.push(`    digest: ${yamlScalar(hashText(readText(path)))}`);
  }
  return `${lines.join("\n")}\n`;
}

function manifestPathKey(root: string, path: string): string {
  const key = relative(root, path).replace(/\\/g, "/");
  return key && !key.startsWith("..") ? key : path;
}

export function rootManagedFiles(repoRoot: string): string[] {
  return [
    resolve(repoRoot, LOOPO_SYSTEM_FILE),
    ...SYSTEM_DOCS.map((doc) => systemDocPath(repoRoot, doc.file)),
  ];
}

export function writeRootManifest(
  repoRoot: string,
  requestId = "system",
  writerCommand = "loopo system",
): string {
  const manifestPath = resolve(repoRoot, LOOPO_ROOT_MANIFEST_FILE);
  const previous = readJson(manifestPath) as Record<string, unknown> | null;
  const previousHead =
    typeof previous?.receipt_head === "string" ? previous.receipt_head : null;
  const files: Record<string, string> = {};
  for (const file of rootManagedFiles(repoRoot)) {
    files[manifestPathKey(repoRoot, file)] = hashText(readText(file));
  }
  const receiptHead = hashText(
    [
      previousHead ?? "",
      requestId,
      writerCommand,
      ...Object.entries(files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, hash]) => `${name}:${hash}`),
    ].join("\n"),
  );
  writeJson(manifestPath, {
    schema_version: 1,
    generated_at: nowIso(),
    generated_by: "loopo",
    writer_command: writerCommand,
    request_id: requestId,
    hash_algorithm: "sha256",
    previous_receipt_head: previousHead,
    receipt_head: receiptHead,
    files,
  });
  return manifestPath;
}

export function ensureSystemScaffold(repoRoot: string): string[] {
  const touched: string[] = [];
  for (const doc of SYSTEM_DOCS) {
    const path = systemDocPath(repoRoot, doc.file);
    if (!existsSync(path)) {
      writeText(path, renderSystemDocYaml(doc));
      touched.push(path);
    }
  }
  const systemPath = resolve(repoRoot, LOOPO_SYSTEM_FILE);
  const nextIndex = renderSystemIndexYaml(repoRoot);
  if (!existsSync(systemPath) || readText(systemPath) !== nextIndex) {
    writeText(systemPath, nextIndex);
    touched.push(systemPath);
  }
  touched.push(writeRootManifest(repoRoot, "system-scaffold", "loopo init"));
  return touched;
}

export function verifyRootManifest(repoRoot: string): {
  ok: boolean;
  errors: string[];
} {
  const manifestPath = resolve(repoRoot, LOOPO_ROOT_MANIFEST_FILE);
  const manifest = readJson(manifestPath) as Record<string, any> | null;
  if (!manifest || typeof manifest !== "object") {
    return { ok: false, errors: [`missing root manifest: ${manifestPath}`] };
  }
  const files =
    manifest.files && typeof manifest.files === "object"
      ? (manifest.files as Record<string, string>)
      : {};
  const errors: string[] = [];
  const managed = rootManagedFiles(repoRoot);
  const managedKeys = managed.map((file) => manifestPathKey(repoRoot, file));
  const useRelativeKeys = managedKeys.some((key) => files[key] != null);
  for (const file of managed) {
    const key = useRelativeKeys ? manifestPathKey(repoRoot, file) : file;
    const expected = files[key];
    if (!expected) {
      errors.push(`root manifest missing file entry: ${key}`);
      continue;
    }
    const actual = hashText(readText(file));
    if (actual !== expected)
      errors.push(`unauthorized/tampered root file: ${file}`);
  }
  const managedSet = new Set(useRelativeKeys ? managedKeys : managed);
  for (const file of Object.keys(files)) {
    if (!managedSet.has(file)) {
      errors.push(`root manifest contains unmanaged file entry: ${file}`);
    }
  }
  const expectedHead = hashText(
    [
      typeof manifest.previous_receipt_head === "string"
        ? manifest.previous_receipt_head
        : "",
      String(manifest.request_id ?? ""),
      String(manifest.writer_command ?? ""),
      ...Object.entries(files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, hash]) => `${name}:${hash}`),
    ].join("\n"),
  );
  if (manifest.receipt_head !== expectedHead) {
    errors.push(`root manifest receipt chain mismatch: ${manifestPath}`);
  }
  return { ok: errors.length === 0, errors };
}

function renderSystemUpdateSections(
  updates: Array<Record<string, unknown>>,
): string[] {
  const lines: string[] = [];
  if (!updates.length) {
    lines.push("sections: []");
    return lines;
  }
  lines.push("sections:");
  updates.forEach((update, index) => {
    const id = String(update.id ?? update.section_id ?? `update-${index + 1}`);
    lines.push(`  - id: ${yamlScalar(normalizeName(id))}`);
    lines.push(
      `    title: ${yamlScalar(String(update.title ?? "System update"))}`,
    );
    lines.push(`    summary: ${yamlScalar(String(update.summary ?? ""))}`);
    const refs = asStringList(
      update.refs ?? update.references ?? update.source_refs,
    );
    lines.push(`    refs: ${yamlStringList(refs)}`);
  });
  return lines;
}

function renderUpdatedSystemDocYaml(
  doc: SystemDocDef,
  updates: Array<Record<string, unknown>>,
): string {
  if (doc.id === "system-behaviours") {
    const behaviours = updates.flatMap((update, index) => {
      const explicit = Array.isArray(update.behaviours)
        ? (update.behaviours as Array<Record<string, unknown>>)
        : [];
      if (explicit.length) return explicit;
      const summary = String(update.summary ?? "").trim();
      if (!summary) return [];
      return [
        {
          id: update.id ?? `behaviour-${index + 1}`,
          statement: summary,
          test_refs: update.test_refs ?? update.refs ?? [],
        },
      ];
    });
    const lines = ["schema_version: 1", "behaviours:"];
    if (!behaviours.length) {
      lines.push("  []");
    } else {
      for (const behaviour of behaviours) {
        lines.push(
          `  - id: ${yamlScalar(normalizeName(String(behaviour.id ?? "behaviour")))}`,
        );
        lines.push(
          `    statement: ${yamlScalar(String(behaviour.statement ?? ""))}`,
        );
        lines.push(
          `    test_refs: ${yamlStringList(asStringList(behaviour.test_refs))}`,
        );
      }
    }
    lines.push("pending_proposals: []");
    lines.push("");
    return lines.join("\n");
  }

  const title = doc.id
    .split("-")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
  return [
    "schema_version: 1",
    `id: ${yamlScalar(doc.id)}`,
    `title: ${yamlScalar(title)}`,
    ...renderSystemUpdateSections(updates),
    `updated_at: ${yamlScalar(nowIso())}`,
    "",
  ].join("\n");
}

export function applySystemUpdate(
  repoRoot: string,
  update: Record<string, unknown>,
  requestId: string,
): string[] {
  const touched: string[] = [];
  const updates = Array.isArray(update.updates)
    ? (update.updates as Array<Record<string, unknown>>)
    : [];
  for (const doc of SYSTEM_DOCS) {
    const docUpdates = updates.filter((item) => item.doc_id === doc.id);
    if (!docUpdates.length) continue;
    const path = systemDocPath(repoRoot, doc.file);
    writeText(path, renderUpdatedSystemDocYaml(doc, docUpdates));
    touched.push(path);
  }
  const systemPath = resolve(repoRoot, LOOPO_SYSTEM_FILE);
  writeText(systemPath, renderSystemIndexYaml(repoRoot));
  touched.push(systemPath);
  touched.push(writeRootManifest(repoRoot, requestId, "loopo quest next"));
  return touched;
}

export function renderSystemBehavioursYaml(): string {
  return [
    "schema_version: 1",
    "behaviours: []",
    "pending_proposals: []",
    "",
  ].join("\n");
}

export function ensureSystemBehaviours(repoRoot: string): string {
  ensureSystemScaffold(repoRoot);
  const path = resolve(repoRoot, LOOPO_SYSTEM_BEHAVIOURS_FILE);
  if (!existsSync(path)) writeText(path, renderSystemBehavioursYaml());
  return path;
}

export function renderMinimalSkillMd(): string {
  return [
    "---",
    "name: loopo",
    "description: Bin-owned loop workflow launcher.",
    "---",
    "",
    "# Loopo",
    "",
    "Package source lives in `/Volumes/Projects/business/AstronLab/omar391/loopo`.",
    "",
    'When user prompt is `loopo: {request}`, invoke `loopo init "{request}" --runtime <runtime>` from the repo root and follow the instructions from output.',
    "",
    "```bash",
    'loopo init "loopo: build the app" --runtime codex',
    "```",
    "",
  ].join("\n");
}

export function ensureGlobalSkillFiles(skillRoot?: string | null): string {
  const home = process.env.HOME?.trim() || ".";
  const base =
    skillRoot?.trim() ||
    process.env.LOOPO_SKILL_HOME?.trim() ||
    resolve(home, ".agents", "skills", "loopo");
  const skillPath = resolve(expandHome(base), "SKILL.md");
  const expected = renderMinimalSkillMd();
  if (!existsSync(skillPath) || readText(skillPath) !== expected) {
    writeText(skillPath, expected);
  }
  return skillPath;
}

function defaultQuestPlanDetail(): QuestPlanDetail {
  return {
    classification: "",
    scope: "",
    summary: "",
    rationale: "",
    af: {},
    of: {},
    high_impact_unknowns: [],
    defaulted_unknowns: [],
    verification_targets: [],
    decomposition_rationale: "",
  };
}

function defaultQuestValidationReceipt(): QuestValidationReceipt {
  return { status: "", checks: [] };
}

function defaultQuestVerificationReceipt(): QuestVerificationReceipt {
  return { status: "", acceptance_trace: [], risks: [] };
}

function normalizeQuestQuestion(value: unknown): QuestQuestion | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = String(row.id ?? "").trim();
  const question = String(row.question ?? "").trim();
  if (!id || !question) return null;
  const result: QuestQuestion = { id, question };
  if (String(row.impact ?? "").trim()) result.impact = String(row.impact).trim();
  if (String(row.default ?? "").trim())
    result.default = String(row.default).trim();
  return result;
}

function normalizeQuestAnswer(value: unknown): QuestAnswer | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const answer = String(row.answer ?? "").trim();
  if (!answer) return null;
  const result: QuestAnswer = { answer };
  if (String(row.id ?? "").trim()) result.id = String(row.id).trim();
  if (String(row.question_id ?? "").trim())
    result.question_id = String(row.question_id).trim();
  if (String(row.question ?? "").trim())
    result.question = String(row.question).trim();
  if (typeof row.accepted_default === "boolean") {
    result.accepted_default = row.accepted_default;
  }
  return result;
}

function normalizeQuestionRounds(value: unknown): QuestQuestionRound[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const questions = Array.isArray((entry as Record<string, unknown>).questions)
        ? ((entry as Record<string, unknown>).questions as unknown[])
            .map(normalizeQuestQuestion)
            .filter((row): row is QuestQuestion => Boolean(row))
        : [];
      return questions.length ? { questions } : null;
    })
    .filter((row): row is QuestQuestionRound => Boolean(row));
}

function normalizeTaskList(value: unknown): QuestTask[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) =>
      normalizePlanTask(
        {},
        typeof item === "object" && item ? (item as Record<string, unknown>) : {},
        index,
      ),
    )
    .filter(Boolean);
}

export function renderTasksYaml(state: QuestState): string {
  const wtree = String(state.wtree ?? "").trim();
  return stringifyYaml(
    {
      schema_version: 3,
      wtree,
      quest_id: String(state.quest_id ?? wtree),
      flow_id: String(state.flow_id ?? "swe"),
      flow_version:
        Number.isInteger(state.flow_version) && state.flow_version > 0
          ? state.flow_version
          : 1,
      stage: String(state.stage ?? "planning"),
      prompt: String(state.prompt ?? ""),
      context_root: String(state.context_root ?? ""),
      resolution_source: String(state.resolution_source ?? ""),
      coordinator_branch: String(state.coordinator_branch ?? "main"),
      coordinator_worktree: String(state.coordinator_worktree ?? ""),
      parent_wtree: String(state.parent_wtree ?? ""),
      parent_task_id: String(state.parent_task_id ?? ""),
      parent_context_ref: String(state.parent_context_ref ?? ""),
      landing_target_branch: String(state.landing_target_branch ?? "main"),
      landing_target_worktree: String(state.landing_target_worktree ?? ""),
      landed_commit: String(state.landed_commit ?? ""),
      landing_strategy: String(state.landing_strategy ?? ""),
      assumptions: asStringList(state.assumptions),
      constraints: asStringList(state.constraints),
      question_rounds: Array.isArray(state.question_rounds)
        ? state.question_rounds
        : [],
      answers: Array.isArray(state.answers) ? state.answers : [],
      plan_detail: state.plan_detail ?? defaultQuestPlanDetail(),
      validation_receipt:
        state.validation_receipt ?? defaultQuestValidationReceipt(),
      verification_receipt:
        state.verification_receipt ?? defaultQuestVerificationReceipt(),
      tasks: Array.isArray(state.tasks) ? state.tasks : [],
    },
    { lineWidth: 0 },
  );
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : String(parsed);
  } catch {
    return trimmed.replace(/^['"]|['"]$/g, "");
  }
}

function parseYamlStringList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[]") return [];
  try {
    const parsed = JSON.parse(trimmed);
    return asStringList(parsed);
  } catch {
    return trimmed
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((item) => parseYamlScalar(item))
      .filter(Boolean);
  }
}

function emptyQuestTask(id: string): QuestTask {
  return {
    id,
    title: "",
    type: "coding",
    status: "child_received",
    dependencies: [],
    scope_files: [],
    spec_refs: [],
    context_refs: [],
    branch_ref: "",
    worktree_path: "",
    child_wtree: "",
    concurrency_group: "",
    merge_target: "",
    merge_lease_id: "",
    merge_commit: "",
    system_impact_ref: "",
    acceptance: "",
  };
}

export function parseTasksYaml(text: string): Partial<QuestState> {
  const parsed = parseYaml(text) as Record<string, unknown> | null;
  const raw = parsed && typeof parsed === "object" ? parsed : {};
  if (LEGACY_WTREE_KEY in raw || LEGACY_PARENT_WTREE_KEY in raw) {
    throw new Error(
      "legacy quest state keys are unsupported; recreate or manually update the quest state to use wtree-only fields",
    );
  }
  const result: Partial<QuestState> = {
    schema_version: 3,
    wtree: String(raw.wtree ?? "").trim(),
    quest_id: String(raw.quest_id ?? raw.wtree ?? "").trim(),
    flow_id: String(raw.flow_id ?? "swe").trim() || "swe",
    flow_version: Number.isInteger(raw.flow_version)
      ? Number(raw.flow_version)
      : Math.max(1, Number(raw.flow_version ?? 1) || 1),
    stage: String(raw.stage ?? "planning").trim() || "planning",
    prompt: String(raw.prompt ?? ""),
    context_root: String(raw.context_root ?? ""),
    resolution_source: String(raw.resolution_source ?? ""),
    coordinator_branch: String(raw.coordinator_branch ?? "main"),
    coordinator_worktree: String(raw.coordinator_worktree ?? ""),
    parent_wtree: String(raw.parent_wtree ?? ""),
    parent_task_id: String(raw.parent_task_id ?? ""),
    parent_context_ref: String(raw.parent_context_ref ?? ""),
    landing_target_branch: String(raw.landing_target_branch ?? "main"),
    landing_target_worktree: String(raw.landing_target_worktree ?? ""),
    landed_commit: String(raw.landed_commit ?? ""),
    landing_strategy: String(raw.landing_strategy ?? ""),
    assumptions: asStringList(raw.assumptions),
    constraints: asStringList(raw.constraints),
    question_rounds: normalizeQuestionRounds(raw.question_rounds),
    answers: Array.isArray(raw.answers)
      ? raw.answers
          .map(normalizeQuestAnswer)
          .filter((row): row is QuestAnswer => Boolean(row))
      : [],
    plan_detail:
      raw.plan_detail && typeof raw.plan_detail === "object"
        ? {
            ...defaultQuestPlanDetail(),
            ...(raw.plan_detail as Record<string, unknown>),
            high_impact_unknowns: asStringList(
              (raw.plan_detail as Record<string, unknown>).high_impact_unknowns,
            ),
            defaulted_unknowns: asStringList(
              (raw.plan_detail as Record<string, unknown>).defaulted_unknowns,
            ),
            verification_targets: asStringList(
              (raw.plan_detail as Record<string, unknown>).verification_targets,
            ),
            af:
              (raw.plan_detail as Record<string, unknown>).af &&
              typeof (raw.plan_detail as Record<string, unknown>).af === "object"
                ? ((raw.plan_detail as Record<string, unknown>)
                    .af as Record<string, unknown>)
                : {},
            of:
              (raw.plan_detail as Record<string, unknown>).of &&
              typeof (raw.plan_detail as Record<string, unknown>).of === "object"
                ? ((raw.plan_detail as Record<string, unknown>)
                    .of as Record<string, unknown>)
                : {},
          }
        : defaultQuestPlanDetail(),
    validation_receipt:
      raw.validation_receipt && typeof raw.validation_receipt === "object"
        ? {
            status: String(
              (raw.validation_receipt as Record<string, unknown>).status ?? "",
            ),
            checks: Array.isArray(
              (raw.validation_receipt as Record<string, unknown>).checks,
            )
              ? (((raw.validation_receipt as Record<string, unknown>)
                  .checks as unknown[]) as Array<Record<string, unknown>>)
              : [],
          }
        : defaultQuestValidationReceipt(),
    verification_receipt:
      raw.verification_receipt && typeof raw.verification_receipt === "object"
        ? {
            status: String(
              (raw.verification_receipt as Record<string, unknown>).status ?? "",
            ),
            acceptance_trace: Array.isArray(
              (raw.verification_receipt as Record<string, unknown>)
                .acceptance_trace,
            )
              ? (((raw.verification_receipt as Record<string, unknown>)
                  .acceptance_trace as unknown[]) as Array<
                  Record<string, unknown>
                >)
              : [],
            risks: Array.isArray(
              (raw.verification_receipt as Record<string, unknown>).risks,
            )
              ? (((raw.verification_receipt as Record<string, unknown>)
                  .risks as unknown[]) as Array<Record<string, unknown>>)
              : [],
          }
        : defaultQuestVerificationReceipt(),
    tasks: normalizeTaskList(raw.tasks),
  };
  if (!result.quest_id && result.wtree) result.quest_id = result.wtree;
  return result;
}

export function appendJsonl(
  file: string,
  record: Record<string, unknown>,
): void {
  mkdirSync(dirname(file), { recursive: true });
  const line = JSON.stringify({ ts: nowIso(), ...record });
  writeText(file, `${readText(file)}${line}\n`);
}

function questManagedFiles(files: QuestFiles): string[] {
  return [files.tasks, files.events];
}

function questManifestPathKey(files: QuestFiles, path: string): string {
  return manifestPathKey(files.workspace_root, path);
}

export function writeQuestManifest(
  files: QuestFiles,
  requestId = "quest",
  writerCommand = "loopo quest",
): void {
  const previous = readJson(files.manifest) as Record<string, unknown> | null;
  const previousHead =
    typeof previous?.receipt_head === "string" ? previous.receipt_head : null;
  const hashes: Record<string, string> = {};
  for (const file of questManagedFiles(files)) {
    hashes[questManifestPathKey(files, file)] = hashText(readText(file));
  }
  const receiptHead = hashText(
    [
      previousHead ?? "",
      requestId,
      writerCommand,
      ...Object.entries(hashes)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, hash]) => `${name}:${hash}`),
    ].join("\n"),
  );
  writeJson(files.manifest, {
    schema_version: 1,
    generated_at: nowIso(),
    generated_by: "loopo",
    writer_command: writerCommand,
    request_id: requestId,
    hash_algorithm: "sha256",
    previous_receipt_head: previousHead,
    receipt_head: receiptHead,
    files: hashes,
  });
}

export function verifyQuestManifest(files: QuestFiles): {
  ok: boolean;
  errors: string[];
} {
  const manifest = readJson(files.manifest) as Record<string, any> | null;
  if (!manifest || typeof manifest !== "object") {
    return { ok: false, errors: [`missing quest manifest: ${files.manifest}`] };
  }
  const recorded =
    manifest.files && typeof manifest.files === "object"
      ? (manifest.files as Record<string, string>)
      : {};
  const managed = questManagedFiles(files);
  const managedKeys = managed.map((file) => questManifestPathKey(files, file));
  const useRelativeKeys = managedKeys.some((key) => recorded[key] != null);
  const managedSet = new Set(useRelativeKeys ? managedKeys : managed);
  const errors: string[] = [];
  for (const file of managed) {
    const key = useRelativeKeys ? questManifestPathKey(files, file) : file;
    const expected = recorded[key];
    if (!expected) {
      errors.push(`quest manifest missing file entry: ${key}`);
      continue;
    }
    const actual = hashText(readText(file));
    if (actual !== expected)
      errors.push(`unauthorized/tampered quest file: ${file}`);
  }
  for (const file of Object.keys(recorded)) {
    if (!managedSet.has(file)) {
      errors.push(`quest manifest contains unmanaged file entry: ${file}`);
    }
  }
  const expectedHead = hashText(
    [
      typeof manifest.previous_receipt_head === "string"
        ? manifest.previous_receipt_head
        : "",
      String(manifest.request_id ?? ""),
      String(manifest.writer_command ?? ""),
      ...Object.entries(recorded)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, hash]) => `${name}:${hash}`),
    ].join("\n"),
  );
  if (manifest.receipt_head !== expectedHead) {
    errors.push(`quest manifest receipt chain mismatch: ${files.manifest}`);
  }
  return { ok: errors.length === 0, errors };
}

function normalizePlanTask(
  state: Partial<QuestState>,
  input: Record<string, unknown>,
  index: number,
): QuestTask {
  const wtree = String(state.wtree ?? "quest");
  const rawId = String(input.id ?? input.task_id ?? `task-${index + 1}`);
  const id = normalizeName(rawId);
  const contextRoot = String(state.context_root ?? ".");
  const normalizedPrompt = String(state.prompt ?? "")
    .toLowerCase()
    .replace(/^loopo:\s*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const leafChild = normalizedPrompt.startsWith("execute child task ");
  const coordinatorBranch = String(state.coordinator_branch ?? "main");
  const coordinatorWorktree = String(state.coordinator_worktree ?? contextRoot);
  return {
    id,
    title: String(input.title ?? input.name ?? id),
    type: input.type === "general" ? "general" : "coding",
    status: String(input.status ?? (leafChild ? "pending" : "child_received")),
    dependencies: asStringList(input.dependencies ?? input.depends_on).map((id) =>
      normalizeName(id),
    ),
    scope_files: asStringList(input.scope_files ?? input.scope),
    spec_refs: asStringList(input.spec_refs ?? input.specs),
    context_refs: asStringList(input.context_refs ?? input.context),
    branch_ref: String(
      input.branch_ref ??
        (leafChild ? coordinatorBranch : taskAssignmentBranchRef(wtree, id)),
    ),
    worktree_path: String(
      input.worktree_path ??
        (leafChild
          ? coordinatorWorktree
          : taskAssignmentWorktreePath(contextRoot, wtree, id)),
    ),
    child_wtree: String(
      input.child_wtree ?? (leafChild ? "" : taskAssignmentChildWtree(wtree, id)),
    ),
    concurrency_group: String(input.concurrency_group ?? ""),
    merge_target: String(input.merge_target ?? coordinatorBranch),
    merge_lease_id: String(
      input.merge_lease_id ??
        (leafChild ? "" : taskAssignmentMergeLeaseId(wtree, id)),
    ),
    merge_commit: String(input.merge_commit ?? ""),
    system_impact_ref: String(input.system_impact_ref ?? ""),
    acceptance: planTaskAcceptance(
      input.acceptance ?? input.acceptance_criteria,
    ),
  };
}

export function applyQuestPlanToTasks(
  files: QuestFiles,
  state: Partial<QuestState>,
  plan: Record<string, unknown> | null,
): QuestState {
  const taskInputs = Array.isArray(plan?.tasks)
    ? (plan!.tasks as Array<Record<string, unknown>>)
    : [];
  const nextState: QuestState = {
    schema_version: 3,
    wtree: files.wtree,
    quest_id: String(state.quest_id ?? files.wtree),
    flow_id: String(state.flow_id ?? "swe"),
    flow_version: Number(state.flow_version ?? 1),
    stage: String(state.stage ?? "planning"),
    prompt: String(state.prompt ?? ""),
    context_root: String(state.context_root ?? ""),
    resolution_source: String(state.resolution_source ?? ""),
    coordinator_branch: String(state.coordinator_branch ?? "main"),
    coordinator_worktree: String(state.coordinator_worktree ?? ""),
    parent_wtree: String(state.parent_wtree ?? ""),
    parent_task_id: String(state.parent_task_id ?? ""),
    parent_context_ref: String(state.parent_context_ref ?? ""),
    landing_target_branch: String(state.landing_target_branch ?? "main"),
    landing_target_worktree: String(state.landing_target_worktree ?? ""),
    landed_commit: String(state.landed_commit ?? ""),
    landing_strategy: String(state.landing_strategy ?? ""),
    assumptions: asStringList(plan?.assumptions),
    constraints: asStringList(plan?.constraints),
    question_rounds: Array.isArray(state.question_rounds)
      ? state.question_rounds
      : [],
    answers: Array.isArray(state.answers) ? state.answers : [],
    plan_detail: {
      ...defaultQuestPlanDetail(),
      ...(state.plan_detail ?? {}),
      classification: String(plan?.classification ?? ""),
      scope: String(plan?.scope ?? ""),
      summary: String(plan?.summary ?? plan?.scope ?? ""),
      rationale: String(plan?.summary ?? plan?.scope ?? ""),
      af:
        plan?.af && typeof plan.af === "object"
          ? (plan.af as Record<string, unknown>)
          : {},
      of:
        plan?.of && typeof plan.of === "object"
          ? (plan.of as Record<string, unknown>)
          : {},
      high_impact_unknowns: asStringList(plan?.high_impact_unknowns),
      defaulted_unknowns: asStringList(plan?.defaulted_unknowns),
      verification_targets: asStringList(plan?.verification_targets),
      decomposition_rationale: String(
        plan?.decomposition_rationale ?? plan?.summary ?? "",
      ),
    },
    validation_receipt:
      state.validation_receipt ?? defaultQuestValidationReceipt(),
    verification_receipt:
      state.verification_receipt ?? defaultQuestVerificationReceipt(),
    tasks: taskInputs.map((task, index) =>
      normalizePlanTask(state, task, index),
    ),
  };
  writeText(files.tasks, renderTasksYaml(nextState));
  return nextState;
}

function childTaskValue(value: unknown, fallback: string): string {
  const next = String(value ?? "").trim();
  return next || fallback;
}

export function applyChildStatusToTasks(
  files: QuestFiles,
  state: Partial<QuestState>,
  update: Partial<QuestTask> & { id: string; status: string },
): QuestState {
  if (LEGACY_CHILD_WTREE_KEY in update) {
    throw new Error(
      `legacy child callback key "${LEGACY_CHILD_WTREE_KEY}" is unsupported; send "child_wtree" instead`,
    );
  }
  const taskId = normalizeName(update.id);
  const nextState: QuestState = {
    schema_version: 3,
    wtree: files.wtree,
    quest_id: String(state.quest_id ?? files.wtree),
    flow_id: String(state.flow_id ?? "swe"),
    flow_version: Number(state.flow_version ?? 1),
    stage: String(state.stage ?? "planning"),
    prompt: String(state.prompt ?? ""),
    context_root: String(state.context_root ?? ""),
    resolution_source: String(state.resolution_source ?? ""),
    coordinator_branch: String(state.coordinator_branch ?? "main"),
    coordinator_worktree: String(state.coordinator_worktree ?? ""),
    parent_wtree: String(state.parent_wtree ?? ""),
    parent_task_id: String(state.parent_task_id ?? ""),
    parent_context_ref: String(state.parent_context_ref ?? ""),
    landing_target_branch: String(state.landing_target_branch ?? "main"),
    landing_target_worktree: String(state.landing_target_worktree ?? ""),
    landed_commit: String(state.landed_commit ?? ""),
    landing_strategy: String(state.landing_strategy ?? ""),
    assumptions: asStringList(state.assumptions),
    constraints: asStringList(state.constraints),
    question_rounds: Array.isArray(state.question_rounds)
      ? state.question_rounds
      : [],
    answers: Array.isArray(state.answers) ? state.answers : [],
    plan_detail: state.plan_detail ?? defaultQuestPlanDetail(),
    validation_receipt:
      state.validation_receipt ?? defaultQuestValidationReceipt(),
    verification_receipt:
      state.verification_receipt ?? defaultQuestVerificationReceipt(),
    tasks: (Array.isArray(state.tasks) ? state.tasks : []).map((task) => {
      if (task.id !== taskId) return task;
      return {
        ...task,
        status: update.status,
        child_wtree: childTaskValue(update.child_wtree, task.child_wtree ?? ""),
        branch_ref: childTaskValue(update.branch_ref, task.branch_ref),
        worktree_path: childTaskValue(update.worktree_path, task.worktree_path),
        merge_target: childTaskValue(update.merge_target, task.merge_target),
        merge_lease_id: childTaskValue(
          update.merge_lease_id,
          task.merge_lease_id,
        ),
        merge_commit: childTaskValue(update.merge_commit, task.merge_commit),
      };
    }),
  };
  writeText(files.tasks, renderTasksYaml(nextState));
  return nextState;
}

export function applyChildSummaryToTasks(
  files: QuestFiles,
  state: Partial<QuestState>,
  summary: Partial<QuestTask> & { id: string },
): QuestState {
  return applyChildStatusToTasks(files, state, {
    ...summary,
    status: "child_archived",
  });
}

export function applyLandingReceipt(
  files: QuestFiles,
  state: Partial<QuestState>,
  receipt: Partial<
    Pick<
      QuestState,
      | "parent_wtree"
      | "landing_target_branch"
      | "landing_target_worktree"
      | "landed_commit"
      | "landing_strategy"
    >
  >,
): QuestState {
  const nextState: QuestState = {
    schema_version: 3,
    wtree: files.wtree,
    quest_id: String(state.quest_id ?? files.wtree),
    flow_id: String(state.flow_id ?? "swe"),
    flow_version: Number(state.flow_version ?? 1),
    stage: String(state.stage ?? "planning"),
    prompt: String(state.prompt ?? ""),
    context_root: String(state.context_root ?? ""),
    resolution_source: String(state.resolution_source ?? ""),
    coordinator_branch: String(state.coordinator_branch ?? "main"),
    coordinator_worktree: String(state.coordinator_worktree ?? ""),
    parent_wtree: String(
      receipt.parent_wtree ?? state.parent_wtree ?? "",
    ),
    parent_task_id: String(state.parent_task_id ?? ""),
    parent_context_ref: String(state.parent_context_ref ?? ""),
    landing_target_branch: String(
      receipt.landing_target_branch ?? state.landing_target_branch ?? "main",
    ),
    landing_target_worktree: String(
      receipt.landing_target_worktree ?? state.landing_target_worktree ?? "",
    ),
    landed_commit: String(receipt.landed_commit ?? state.landed_commit ?? ""),
    landing_strategy: String(
      receipt.landing_strategy ?? state.landing_strategy ?? "",
    ),
    assumptions: asStringList(state.assumptions),
    constraints: asStringList(state.constraints),
    question_rounds: Array.isArray(state.question_rounds)
      ? state.question_rounds
      : [],
    answers: Array.isArray(state.answers) ? state.answers : [],
    plan_detail: state.plan_detail ?? defaultQuestPlanDetail(),
    validation_receipt:
      state.validation_receipt ?? defaultQuestValidationReceipt(),
    verification_receipt:
      state.verification_receipt ?? defaultQuestVerificationReceipt(),
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
  };
  writeText(files.tasks, renderTasksYaml(nextState));
  return nextState;
}

export function createQuest(input: {
  repoRoot: string;
  wtree: string;
  prompt: string;
  resolutionSource: string;
  workspace: QuestWorkspace;
  flowId?: string;
  flowVersion?: number;
  parentWtree?: string;
  parentTaskId?: string;
  parentContextRef?: string;
  landingTargetBranch?: string;
  landingTargetWorktree?: string;
  landedCommit?: string;
  landingStrategy?: string;
}): { files: QuestFiles; state: QuestState } {
  const files = questFiles(input.repoRoot, input.wtree);
  if (existsSync(files.tasks)) {
    throw new Error(`quest wtree already exists: ${input.wtree}`);
  }
  const state: QuestState = {
    schema_version: 3,
    wtree: input.wtree,
    quest_id: input.wtree,
    flow_id: input.flowId ?? "swe",
    flow_version: input.flowVersion ?? 1,
    stage: "planning",
    prompt: input.prompt,
    context_root: input.repoRoot,
    resolution_source: input.resolutionSource,
    coordinator_branch: input.workspace.branch_ref,
    coordinator_worktree: input.workspace.worktree_path,
    parent_wtree: String(input.parentWtree ?? ""),
    parent_task_id: String(input.parentTaskId ?? ""),
    parent_context_ref: String(input.parentContextRef ?? ""),
    landing_target_branch: String(input.landingTargetBranch ?? "main"),
    landing_target_worktree: String(input.landingTargetWorktree ?? ""),
    landed_commit: String(input.landedCommit ?? ""),
    landing_strategy: String(input.landingStrategy ?? ""),
    assumptions: [],
    constraints: [],
    question_rounds: [],
    answers: [],
    plan_detail: defaultQuestPlanDetail(),
    validation_receipt: defaultQuestValidationReceipt(),
    verification_receipt: defaultQuestVerificationReceipt(),
    tasks: [],
  };
  writeText(files.tasks, renderTasksYaml(state));
  if (!existsSync(files.events)) writeText(files.events, "");
  if (!existsSync(files.hook_state)) writeJson(files.hook_state, {});
  appendJsonl(files.events, {
    event: "quest_started",
    quest_id: input.wtree,
    stage: state.stage,
  });
  writeQuestManifest(files, `start-${input.wtree}`, "loopo quest next");
  return { files, state };
}

export function updateQuestStage(
  files: QuestFiles,
  nextStage: string,
  requestId = "quest-stage",
  writerCommand = "loopo quest next",
): Partial<QuestState> {
  const current = parseTasksYaml(readText(files.tasks));
  const state = {
    ...current,
    stage: nextStage,
  } as QuestState;
  writeText(files.tasks, renderTasksYaml(state));
  appendJsonl(files.events, {
    event: "stage_changed",
    quest_id: state.quest_id ?? files.wtree,
    stage: nextStage,
  });
  writeQuestManifest(files, requestId, writerCommand);
  return parseTasksYaml(readText(files.tasks));
}

export function extractWtreeFromTasksPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  if (/(?:^|\/)\.loopo\/runtime\/tasks\.yaml$/i.test(normalized)) {
    const worktreeMatch = normalized.match(
      /(?:^|\/)worktrees\/([a-z0-9]+(?:-[a-z0-9]+)*)\/\.loopo\/runtime\/tasks\.yaml$/i,
    );
    return worktreeMatch?.[1] ?? null;
  }
  return null;
}

function hasGitCommit(repoRoot: string): boolean {
  return (
    runCommand("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repoRoot,
      timeoutMs: 10_000,
    }).status === 0
  );
}

export function ensureGitRootCommit(repoRoot: string): void {
  if (hasGitCommit(repoRoot)) return;
  const init = runCommand("git", ["init", repoRoot], {
    timeoutMs: 15_000,
  });
  if (init.status !== 0) {
    throw new Error(init.stderr || init.stdout || `failed to init git repo at ${repoRoot}`);
  }
}

function parseGitWorktrees(repoRoot: string): Array<{
  worktree: string;
  branch: string | null;
}> {
  const proc = runCommand("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    timeoutMs: 15_000,
  });
  if (proc.status !== 0) return [];
  const entries: Array<{ worktree: string; branch: string | null }> = [];
  let current: { worktree: string | null; branch: string | null } = {
    worktree: null,
    branch: null,
  };
  const flush = (): void => {
    if (!current.worktree) return;
    entries.push({
      worktree: resolve(current.worktree),
      branch: current.branch,
    });
    current = { worktree: null, branch: null };
  };
  for (const line of proc.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (trimmed.startsWith("worktree ")) {
      current.worktree = trimmed.slice("worktree ".length).trim();
    } else if (trimmed.startsWith("branch ")) {
      current.branch = trimmed
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return entries;
}

function isEmptyDirectory(path: string): boolean {
  if (!existsSync(path)) return true;
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

function isRuntimeScaffoldOnlyDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const entries = readdirSync(path);
    if (!entries.length) return true;
    if (entries.some((entry) => entry !== ".loopo")) return false;
    const runtimeDir = resolve(path, ".loopo", "runtime");
    if (!existsSync(runtimeDir)) return false;
    const runtimeEntries = readdirSync(runtimeDir);
    return runtimeEntries.every(
      (entry) => entry === "lock.json" || entry === "hook-state.json",
    );
  } catch {
    return false;
  }
}

export function coordinatorWorktreePath(
  repoRoot: string,
  wtree: string,
): string {
  return resolve(repoRoot, "worktrees", wtree);
}

export function landingTargetWorktreePath(
  repoRoot: string,
  branchRef: string,
): string {
  return resolve(repoRoot, "worktrees", `landing-${normalizeName(branchRef)}`);
}

function ensureNamedWorkspace(
  repoRoot: string,
  branchRef: string,
  desiredPath: string,
): QuestWorkspace {
  if (!hasGitCommit(repoRoot)) {
    mkdirSync(desiredPath, { recursive: true });
    return {
      branch_ref: branchRef,
      worktree_path: desiredPath,
      mode: "directory",
    };
  }

  const worktrees = parseGitWorktrees(repoRoot);
  const existingByPath = worktrees.find(
    (entry) => resolve(entry.worktree) === desiredPath,
  );
  if (existingByPath) {
    return {
      branch_ref: existingByPath.branch ?? branchRef,
      worktree_path: existingByPath.worktree,
      mode: "git",
    };
  }

  const existingByBranch = worktrees.find(
    (entry) => entry.branch === branchRef,
  );
  if (existingByBranch) {
    return {
      branch_ref: branchRef,
      worktree_path: existingByBranch.worktree,
      mode: "git",
    };
  }

  if (existsSync(desiredPath) && !isEmptyDirectory(desiredPath)) {
    if (isRuntimeScaffoldOnlyDirectory(desiredPath)) {
      rmSync(desiredPath, { recursive: true, force: true });
    }
  }
  if (existsSync(desiredPath) && !isEmptyDirectory(desiredPath)) {
    throw new Error(
      `cannot create coordinator worktree at ${desiredPath}: path already exists and is not empty`,
    );
  }
  if (existsSync(desiredPath)) {
    rmSync(desiredPath, { recursive: true, force: true });
  }

  const branchExists =
    runCommand(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${branchRef}`],
      {
        cwd: repoRoot,
        timeoutMs: 10_000,
      },
    ).status === 0;
  const proc = branchExists
    ? runCommand("git", ["worktree", "add", desiredPath, branchRef], {
        cwd: repoRoot,
        timeoutMs: 30_000,
      })
    : runCommand(
        "git",
        ["worktree", "add", "-b", branchRef, desiredPath, "HEAD"],
        {
          cwd: repoRoot,
          timeoutMs: 30_000,
        },
      );
  if (proc.status !== 0) {
    throw new Error(
      proc.stderr ||
        proc.stdout ||
        `failed to create coordinator worktree at ${desiredPath}`,
    );
  }
  return {
    branch_ref: branchRef,
    worktree_path: desiredPath,
    mode: "git",
  };
}

export function ensureCoordinatorWorkspace(
  repoRoot: string,
  wtree: string,
): QuestWorkspace {
  return ensureNamedWorkspace(repoRoot, wtree, coordinatorWorktreePath(repoRoot, wtree));
}

export function ensureTaskWorkspace(
  repoRoot: string,
  branchRef: string,
  worktreePath: string,
): QuestWorkspace {
  return ensureNamedWorkspace(repoRoot, branchRef, resolve(worktreePath));
}

function renderLoopoShim(loopoScriptAbs: string): string {
  const script = shellQuote(resolveCanonicalLoopoScriptPath(loopoScriptAbs));
  const scriptEnvExpr = `\${${LOOPO_SCRIPT_ENV}:-}`;
  const scriptEnvValue = `$${LOOPO_SCRIPT_ENV}`;
  return [
    "#!/bin/sh",
    "set -eu",
    `DEFAULT_SCRIPT=${script}`,
    `SCRIPT=${shellQuote("")}`,
    `if [ "${scriptEnvExpr}" != "" ]; then`,
    `  SCRIPT="${scriptEnvValue}"`,
    "else",
    "  SCRIPT=$DEFAULT_SCRIPT",
    "fi",
    'FIRST_ARG="${1:-}"',
    'case "$FIRST_ARG" in',
    '  --script)',
    '    if [ "${2:-}" = "" ]; then',
    '      echo "--script requires a path" >&2',
    "      exit 2",
    "    fi",
    "    SCRIPT=$2",
    "    shift 2",
    "    ;;",
    '  --script=*)',
    '    SCRIPT=${FIRST_ARG#--script=}',
    "    shift",
    "    ;;",
    "esac",
    "if command -v node >/dev/null 2>&1; then",
    "  if node -e \"const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 6) ? 0 : 1)\" >/dev/null 2>&1; then",
    '    exec node "$SCRIPT" "$@"',
    "  fi",
    "fi",
    "if command -v bun >/dev/null 2>&1; then",
    '  exec bun "$SCRIPT" "$@"',
    "fi",
    "if command -v npx >/dev/null 2>&1; then",
    '  exec npx -y tsx "$SCRIPT" "$@"',
    "fi",
    'echo "bun, node, and npx tsx are unavailable" >&2',
    "exit 127",
    "",
  ].join("\n");
}

export function resolveCanonicalLoopoScriptPath(
  loopoScriptAbs: string,
): string {
  const normalized = resolve(loopoScriptAbs);
  const worktreeMatch = normalized.match(
    /^(.*?)(?:[\\/])worktrees(?:[\\/])[^\\/]+(?:[\\/])(.*)$/,
  );
  const canonical = worktreeMatch
    ? resolve(worktreeMatch[1], worktreeMatch[2])
    : normalized;
  if (canonical.match(/(?:^|[\\/])scripts[\\/]loopo\.ts$/)) {
    return resolve(dirname(dirname(canonical)), "index.ts");
  }
  return canonical;
}

export function resolveGlobalLoopoBinPath(): string {
  const envPath = process.env[LOOPO_GLOBAL_BIN_ENV]?.trim();
  if (envPath) return resolve(expandHome(envPath));
  const home = process.env.HOME?.trim();
  if (!home) return resolve(".loopo", "global", "loopo");
  return resolve(home, ".local", "bin", "loopo");
}

export function createLoopoShim(
  targetPath: string,
  loopoScriptAbs: string,
): void {
  writeText(targetPath, renderLoopoShim(loopoScriptAbs));
  chmodSync(targetPath, 0o755);
}

export function createRepoWrapper(
  repoRoot: string,
  loopoScriptAbs: string,
): void {
  const wrapper = resolve(repoRoot, LOOPO_BIN_FILE);
  createLoopoShim(wrapper, loopoScriptAbs);
}

export function renderEmptyTasksDocument(meta: {
  objective: string;
  scope?: string;
  constraints?: string;
  assumptions?: string;
}): string {
  return [
    "# Quest",
    `- objective: ${meta.objective.trim() || "Untitled quest"}`,
    `- scope: ${meta.scope?.trim() || "-"}`,
    `- constraints: ${meta.constraints?.trim() || "-"}`,
    `- assumptions: ${meta.assumptions?.trim() || "-"}`,
    "",
    "## Tasks",
    "| id | title | type | status | dependencies | scope_files | owner | branch_ref | worktree_path | acceptance |",
    "|----|-------|------|--------|--------------|-------------|-------|------------|---------------|------------|",
    "",
  ].join("\n");
}

export function ensureQuestFiles(
  repoRoot: string,
  wtree: string,
  objective: string,
): QuestFiles {
  const files = questFiles(repoRoot, wtree);
  if (!existsSync(files.tasks)) {
    const initial: QuestState = {
      schema_version: 3,
      wtree,
      quest_id: wtree,
      flow_id: "swe",
      flow_version: 1,
      stage: "planning",
      prompt: objective,
      context_root: repoRoot,
      resolution_source: "manual",
      coordinator_branch: wtree,
      coordinator_worktree: coordinatorWorktreePath(repoRoot, wtree),
      parent_wtree: "",
      parent_task_id: "",
      parent_context_ref: "",
      landing_target_branch: "main",
      landing_target_worktree: landingTargetWorktreePath(repoRoot, "main"),
      landed_commit: "",
      landing_strategy: "",
      assumptions: [],
      constraints: [],
      question_rounds: [],
      answers: [],
      plan_detail: defaultQuestPlanDetail(),
      validation_receipt: defaultQuestValidationReceipt(),
      verification_receipt: defaultQuestVerificationReceipt(),
      tasks: [],
    };
    writeText(files.tasks, renderTasksYaml(initial));
  }
  if (!existsSync(files.events)) writeText(files.events, "");
  if (!existsSync(files.hook_state)) writeJson(files.hook_state, {});
  return files;
}

export function resolveRepoFromCwd(cwd: string): string {
  const resolved = resolve(cwd);
  const direct = resolve(resolved, LOOPO_DIR);
  if (existsSync(direct)) return resolved;
  let cursor = resolved;
  while (true) {
    if (existsSync(resolve(cursor, LOOPO_DIR))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return resolved;
}
