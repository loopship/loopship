#!/usr/bin/env bun

import {
  chmodSync,
  existsSync,
  realpathSync,
  readdirSync,
  rmSync,
} from "node:fs";
import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  expandHome,
  ensureDirectoryDurable,
  hashText,
  nowIso,
  readText,
  removeFileDurably,
  runCommand,
  shellQuote,
  writeJson,
  writeText,
} from "./loopship_utils.ts";
import { loopshipChildDagTaskAliasErrors } from "./loopship_child_dag.ts";
import { validateSchemaPath } from "./loopship_schema.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const LOOPSHIP_DIR = ".loopship";
export const LOOPSHIP_RUNTIME_DIR = join(LOOPSHIP_DIR, "runtime");
export const LOOPSHIP_SYSTEM_FILE = join(LOOPSHIP_DIR, "system.yaml");
export const LOOPSHIP_DOCS_DIR = join(LOOPSHIP_DIR, "docs");
export const LOOPSHIP_ROOT_SIGNATURE_FILE = join(LOOPSHIP_DIR, "signature.yaml");
export const LOOPSHIP_ROOT_MANIFEST_FILE = LOOPSHIP_ROOT_SIGNATURE_FILE;
export const LOOPSHIP_ASSERTIONS_DIR = join(LOOPSHIP_DOCS_DIR, "assertions");
export const LOOPSHIP_AREAS_DIR = join(LOOPSHIP_DOCS_DIR, "areas");
export const LOOPSHIP_DECISIONS_DIR = join(LOOPSHIP_DOCS_DIR, "decisions");
export const LOOPSHIP_ASSETS_DIR = join(LOOPSHIP_DOCS_DIR, "assets");
export const LOOPSHIP_MEMORIES_DIR = join(LOOPSHIP_DOCS_DIR, "memories");
export const LOOPSHIP_MIXED_DOCS_DIR = join(LOOPSHIP_DOCS_DIR, "mixed");
export const LOOPSHIP_BIN_FILE = join(LOOPSHIP_DIR, "bin", "loopship");
export const LOOPSHIP_GLOBAL_BIN_ENV = "LOOPSHIP_GLOBAL_BIN";
export const LOOPSHIP_SCRIPT_ENV = "LOOPSHIP_SCRIPT";
export const CANONICAL_QUEST_RE =
  /(?:^|[\\/])\.loopship[\\/]runtime[\\/]tasks\.yaml$/i;
const LEGACY_WTREE_KEY = ["sl", "ug"].join("");
const LEGACY_PARENT_WTREE_KEY = ["parent", "quest", ["sl", "ug"].join("")].join("_");
const LEGACY_CHILD_WTREE_KEY = ["child", ["sl", "ug"].join("")].join("_");

export type QuestFiles = {
  wtree: string;
  workspace_root: string;
  loopship_root: string;
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

export type QuestEvidence = {
  type: string;
  ref: string;
  summary?: string;
  status?: string;
};

export type QuestChildResult = {
  task_id: string;
  child_wtree: string;
  status: string;
  evidence: QuestEvidence[];
  branch_ref: string;
  worktree_path: string;
  merge_target: string;
  merge_lease_id: string;
  merge_commit: string;
};

export type QuestQuestion = {
  id: string;
  question: string;
  impact?: string;
  default?: string;
  options?: Array<{
    label: string;
    description: string;
  }>;
  status?: "open" | "answered" | "defaulted";
  answer?: string;
  accepted_default?: boolean;
};

export type QuestQuestionRound = {
  questions: QuestQuestion[];
};

export type QuestDurableImplication = {
  record_kind:
    | "rule"
    | "behaviour"
    | "claim"
    | "assumption"
    | "limitation"
    | "area"
    | "actor"
    | "unit"
    | "interface"
    | "flow"
    | "store"
    | "asset"
    | "schema"
    | "document"
    | "artifact"
    | "evidence"
    | "preference"
    | "learning"
    | "observation";
  text: string;
  links: Record<string, string[]>;
  expected_system_update:
    | "none"
    | "object_update"
    | "assertion_update"
    | "resource_update"
    | "memory_update"
    | "doc_update"
    | "system_update";
  confidence: "low" | "medium" | "high";
};

export type QuestSystemContext = {
  relevant_object_refs: string[];
  relevant_assertion_refs: string[];
  relevant_resource_refs: string[];
  relevant_memory_refs: string[];
  durable_implications: QuestDurableImplication[];
};

export type QuestPlanDetail = {
  classification: string;
  scope: string;
  summary: string;
  rationale: string;
  system_context: QuestSystemContext;
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
  schema_version: 5;
  wtree: string;
  quest_id: string;
  flow_id: string;
  flow_version: number;
  stage: string;
  prompt: string;
  context_root: string;
  resolution_source: string;
  supervise_step: boolean;
  coordinator_branch: string;
  coordinator_worktree: string;
  parent_wtree: string;
  parent_task_id: string;
  parent_context_ref: string;
  landing_target_branch: string;
  landing_target_worktree: string;
  landed_commit: string;
  landing_strategy: string;
  replan_reason: string;
  assumptions: string[];
  constraints: string[];
  question_rounds: QuestQuestionRound[];
  plan_detail: QuestPlanDetail;
  validation_receipt: QuestValidationReceipt;
  verification_receipt: QuestVerificationReceipt;
  local_work_receipt?: Record<string, unknown>;
  child_results: QuestChildResult[];
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

function compactTaskAssignmentDigest(value: string): string {
  const fnv = (seed: number): string => {
    let hash = seed;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  return `${fnv(2166136261)}${fnv(2166136261 ^ 0x9e3779b9)}`.slice(
    0,
    12,
  );
}

function compactTaskAssignmentKey(wtree: string, taskId: string): string {
  const normalizedWtree = normalizeTaskPathSegment(wtree);
  const normalizedTaskId = normalizeTaskPathSegment(taskId);
  const full = `${normalizedWtree}-${normalizedTaskId}`;
  if (full.length <= 72) return full;
  const digest = compactTaskAssignmentDigest(full);
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

export function assertCanonicalWtreeName(value: string, label = "wtree"): string {
  const normalized = String(value ?? "").trim();
  if (
    !normalized ||
    normalized.length > 96 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)
  ) {
    throw new Error(
      `${label} must use lowercase letters, numbers, and single hyphen separators`,
    );
  }
  return normalized;
}

export function assertValidGitBranchRef(value: string, label = "branch"): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.startsWith("-") || normalized.includes("@{")) {
    throw new Error(`${label} is not a valid Git branch name: ${normalized || "(empty)"}`);
  }
  const checked = runCommand("git", ["check-ref-format", "--branch", normalized], {
    timeoutMs: 10_000,
  });
  if (checked.status !== 0) {
    throw new Error(`${label} is not a valid Git branch name: ${normalized}`);
  }
  return normalized;
}

function normalizedPromptText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^loopship:\s*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isTerminalChildQuestState(
  state: Partial<Pick<
    QuestState,
    "prompt" | "parent_wtree" | "parent_task_id" | "parent_context_ref"
  >>,
): boolean {
  return (
    Boolean(String(state.parent_wtree ?? "").trim()) ||
    Boolean(String(state.parent_task_id ?? "").trim()) ||
    Boolean(String(state.parent_context_ref ?? "").trim()) ||
    normalizedPromptText(state.prompt).startsWith("execute child task ")
  );
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function asLinkMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = new Set([
    "about",
    "part_of",
    "uses",
    "constrains",
    "supported_by",
    "derives_from",
    "supersedes",
  ]);
  const result: Record<string, string[]> = {};
  for (const [relation, targets] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(relation)) continue;
    const refs = asStringList(targets);
    if (refs.length) result[relation] = refs;
  }
  return result;
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
  const loopship_root = resolve(workspace_root, LOOPSHIP_DIR);
  const dir = resolve(workspace_root, LOOPSHIP_RUNTIME_DIR);
  return {
    wtree,
    workspace_root,
    loopship_root,
    dir,
    tasks: resolve(dir, "tasks.yaml"),
    events: resolve(dir, "events.jsonl"),
    manifest: resolve(dir, "manifest.yaml"),
    hook_state: resolve(dir, "hook-state.json"),
    lock: resolve(dir, "lock.json"),
  };
}

export function questWorkspaceRoot(files: QuestFiles): string {
  return files.workspace_root;
}

function manifestPathKey(root: string, path: string): string {
  const key = relative(root, path).replace(/\\/g, "/");
  return key && !key.startsWith("..") ? key : path;
}

type SystemResourceEntry = {
  id: string;
  kind: string;
  role: "canonical" | "reference" | "generated";
  location: string;
  schema_ref: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseYamlFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  return asRecord(parseYaml(readText(path)));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function canonicalYamlDigest(path: string): string {
  const parsed = parseYaml(readText(path));
  return hashText(JSON.stringify(sortJson(parsed)));
}

function managedFileDigest(path: string): string {
  if (/\.(ya?ml)$/i.test(path)) return canonicalYamlDigest(path);
  return hashText(readText(path));
}

const LOCAL_MANIFEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIHgTC2I4kof+irKCC5FoOYtE4R03zw8KAF3bj9nN2AU/
-----END PRIVATE KEY-----`;

function signManifestReceipt(receiptHead: string): Record<string, string> {
  const privateKey = createPrivateKey(LOCAL_MANIFEST_PRIVATE_KEY);
  const value = signBytes(null, Buffer.from(receiptHead, "utf8"), privateKey).toString("base64");
  return {
    algorithm: "ed25519",
    key_id: "loopship-local-v2",
    value,
  };
}

function manifestSignatureIsValid(receiptHead: string, value: string): boolean {
  try {
    return verifyBytes(
      null,
      Buffer.from(receiptHead, "utf8"),
      createPublicKey(createPrivateKey(LOCAL_MANIFEST_PRIVATE_KEY)),
      Buffer.from(value, "base64"),
    );
  } catch {
    return false;
  }
}

function renderYamlDocument(value: Record<string, unknown>): string {
  const rendered = stringifyYaml(value, {
    lineWidth: 0,
    minContentWidth: 0,
  });
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

const MULTILINE_PROSE_KEYS = new Set([
  "abstract",
  "access",
  "collection",
  "text",
  "context",
  "decision",
  "deprecation_policy",
  "environment",
  "labeling",
  "maintenance",
  "meaning",
  "mission",
  "motivation",
  "overview",
  "policy",
  "preprocessing",
  "purpose",
  "rationale",
  "mitigation",
  "solution_strategy",
  "source",
]);
const MULTILINE_PROSE_MAP_KEYS = new Set([
  "allowed_memory",
  "background",
  "capabilities",
  "caveats_recommendations",
  "code_units",
  "components",
  "containers",
  "data_objects",
  "deployment",
  "discussion",
  "environments",
  "ethical_considerations",
  "ethics_privacy",
  "exceptions",
  "factors",
  "failure_scenarios",
  "flows",
  "forbidden_memory",
  "glossary",
  "goals",
  "governance",
  "human_oversight",
  "information",
  "initiatives",
  "invariants",
  "licenses",
  "limitations",
  "mitigations",
  "monitoring",
  "nodes",
  "policies",
  "processes",
  "products_services",
  "provenance",
  "quality",
  "quantitative_analyses",
  "references",
  "research_questions",
  "responsibilities",
  "results",
  "risks",
  "scenarios",
  "security",
  "splits",
  "stakeholders",
  "standard_alignment",
  "stores",
  "systems",
  "technical_debt",
  "triggers",
  "units",
  "value_streams",
]);
const NON_PROSE_METADATA_KEYS = new Set([
  "algorithm",
  "at",
  "date",
  "digest",
  "id",
  "key_id",
  "kind",
  "lane",
  "level",
  "location",
  "media",
  "path",
  "rendered_ref",
  "resource_ref",
  "role",
  "schema_ref",
  "schema_version",
  "state",
  "syntax",
  "title",
  "type",
  "value",
  "version",
]);

function wrapProse(value: string): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.includes("\n")) return normalized.trim();
  const words = normalized.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > 88 && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length === 1) {
    const text = lines[0];
    const midpoint = Math.max(1, Math.floor(text.length / 2));
    const splitAt = text.lastIndexOf(" ", midpoint) > 0
      ? text.lastIndexOf(" ", midpoint)
      : text.indexOf(" ", midpoint);
    if (splitAt > 0) return `${text.slice(0, splitAt)}\n${text.slice(splitAt + 1)}`;
    return `${text}\n`;
  }
  return lines.join("\n");
}

function normalizeBullet(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeMultilineProse(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    return MULTILINE_PROSE_KEYS.has(key) ? wrapProse(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? normalizeBullet(item) : normalizeMultilineProse(item)));
  }
  if (!value || typeof value !== "object") return value;
  if (MULTILINE_PROSE_MAP_KEYS.has(key)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        typeof childValue === "string" && !NON_PROSE_METADATA_KEYS.has(childKey)
          ? wrapProse(childValue)
          : normalizeMultilineProse(childValue, childKey),
      ]),
    );
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
      childKey,
      normalizeMultilineProse(childValue, childKey),
    ]),
  );
}

function defaultSystemTitle(repoRoot: string): string {
  return basename(resolve(repoRoot))
    .split(/[-_]/)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function renderSystemYaml(value: Record<string, unknown>): string {
  return renderYamlDocument(normalizeMultilineProse(value) as Record<string, unknown>);
}

export function renderSystemDocYaml(value: Record<string, unknown>): string {
  return renderYamlDocument(normalizeMultilineProse(value) as Record<string, unknown>);
}

function defaultSystemRoot(repoRoot: string): Record<string, unknown> {
  const id = normalizeName(basename(resolve(repoRoot)));
  return {
    schema_version: 2,
    id,
    title: defaultSystemTitle(repoRoot),
    kinds: ["software"],
    text: "Canonical semantic frontier for durable system knowledge.",
    scope_in: ["Durable system knowledge tracking."],
    scope_out: ["Application-specific implementation details outside this system root."],
    objects: [
      {
        id: "system-model",
        kind: "unit",
        text: "Durable semantic frontier using objects, assertions, resources, optional memories, links, concrete canonical docs, and signature integrity.",
      },
    ],
    assertions: [
      {
        id: "canonical-docs-are-signed",
        kind: "rule",
        level: "must",
        text: "Canonical system resources must be covered by the root signature.",
        links: {
          about: ["object:system-model"],
          supported_by: ["resource:software-architecture"],
        },
      },
    ],
    resources: [
      {
        id: "software-architecture",
        kind: "document",
        role: "canonical",
        location: ".loopship/docs/software/architecture.yaml",
        schema_ref: "loopship://schemas/docs/software-architecture.yaml",
        text: "Full software architecture source using arc42 and C4-aligned concerns.",
        links: {
          about: ["object:system-model"],
        },
        media: "application/yaml",
      },
      {
        id: "decisions",
        kind: "document",
        role: "canonical",
        location: ".loopship/docs/decisions/records.yaml",
        schema_ref: "loopship://schemas/docs/decision-records.yaml",
        text: "Architecture-significant decisions for this system.",
        links: {
          about: ["object:system-model"],
        },
        media: "application/yaml",
      },
    ],
  };
}

function defaultArchitectureDoc(repoRoot: string): Record<string, unknown> {
  const title = defaultSystemTitle(repoRoot);
  return {
    schema_version: 2,
    id: "software-architecture",
    title: "Software Architecture",
    text: `Full software architecture source for ${title}.`,
    links: {
      about: ["object:system-model"],
    },
    standard_alignment: {
      arc42: "Aligns with arc42 architecture concerns including goals, context, building blocks, runtime, deployment, quality, risks, and glossary.",
      "c4-model": "Aligns with C4-style system context, container, component, dynamic, and deployment architecture views represented as section-shaped YAML.",
    },
    goals: [
      "Keep durable system knowledge compact, schema-backed, and useful as first-read context for humans and LLM agents.",
    ],
    stakeholders: {
      "agent-operator": {
        role: "operator",
        text: "Human and LLM operators need a stable architecture source that can be validated mechanically and rendered into full human documents.",
        concerns: [
          "Architecture data must remain readable without learning a generic profile or section framework first.",
        ],
      },
    },
    constraints: [
      "The root system file stays minimal and delegates architecture detail to concrete canonical documents.",
    ],
    context: {
      business: "This system tracks durable system knowledge through a semantic root, canonical resources, and signature integrity.",
      technical: "The schema library validates the root, section-shaped document profiles, optional record packs, and signature sidecar.",
    },
    solution_strategy: "Use concrete industry-profile document schemas instead of one generic profile and section format.",
    structure: {
      overview: "The system is organized around a compact semantic root, concrete canonical documents, optional record packs, and signature validation.",
      systems: {
        "system-root": "The system root keeps the first-read semantic model compact and delegates detail to concrete canonical docs.",
      },
      containers: {
        "signature-sidecar": "The signature sidecar stores root and canonical resource digests without bloating the semantic root.",
      },
      components: {
        "system-update-writer": "The system_update step validates and writes canonical root and external document updates.",
      },
      code_units: {
        "system-verifier": "The semantic verifier rejects stale schema surfaces, unresolved links, shell documents, and missing canonical coverage.",
      },
    },
    runtime: {
      overview: "Runtime writes canonical knowledge through system_update and refreshes signature coverage after accepted changes.",
      scenarios: {
        "system-update-runtime": "Validate proposed root and external documents against the schema library, write canonical YAML, and refresh the signature sidecar.",
      },
      failure_scenarios: {
        "shell-doc-rejection": "A canonical document with placeholder or title-only content fails semantic verification before it can become durable truth.",
      },
    },
    deployment: {
      environments: {
        "local-worktree": "Canonical system files live inside the active repository worktree and are verified before finishing the task.",
      },
      nodes: {
        "developer-machine": "The local developer machine runs Bun scripts that validate schemas, runtime flows, and signature coverage.",
      },
    },
    interfaces: {
      "root-yaml-interface": {
        kind: "file",
        text: ".loopship/system.yaml is the stable semantic interface for agents and humans.",
      },
      "signature-yaml-interface": {
        kind: "file",
        text: ".loopship/signature.yaml is the mechanical audit and digest sidecar for root and canonical resources.",
      },
    },
    data: {
      stores: {
        "system-yaml-store": "The root YAML stores objects, assertions, resources, and optional memories as the semantic frontier.",
      },
      flows: {
        "system-update-flow": "System updates flow from validated payloads into root and canonical documents, followed by signature refresh.",
      },
    },
    quality: {
      goals: {
        "small-first-read-context": "The root prioritizes compact, deterministic, schema-backed first-read context.",
      },
      scenarios: {
        "multiline-doc-prose": "Durable text fields use multiline YAML block scalars so LLM-written files stay readable and mechanically detectable.",
      },
    },
    risks: {
      "shell-doc-risk": {
        text: "Generic durable docs can become shells unless concrete schemas require meaningful fields.",
        mitigation: "Concrete document schemas require industry-profile sections and semantic verification rejects placeholder prose.",
      },
    },
    technical_debt: {
      "legacy-doc-names": "Older generic or compact document names must remain rejected by coherency checks after the v2 hard cut.",
    },
    diagrams: {
      "context-diagram": {
        kind: "context",
        syntax: "mermaid",
        text: "C4-style context diagram source for the root system, canonical docs, signature, and verifier.",
        source: "flowchart LR\n  Root[.loopship/system.yaml] --> Docs[Canonical YAML Docs]\n  Docs --> Signature[.loopship/signature.yaml]\n  Verifier[verify_system_model] --> Root\n  Verifier --> Docs\n  Verifier --> Signature",
      },
    },
    examples: {
      "canonical-resource-link": {
        language: "yaml",
        text: "Example canonical document resource linked from the root system model.",
        source: "resources:\n  - id: software-architecture\n    kind: document\n    role: canonical\n    location: .loopship/docs/software/architecture.yaml\n    schema_ref: loopship://schemas/docs/software-architecture.yaml",
      },
    },
    decision_refs: ["resource:decisions"],
    glossary: {
      canonical: "Canonical files are durable source-of-truth YAML resources covered by the signature sidecar.",
    },
  };
}

function defaultDecisionLogDoc(repoRoot: string): Record<string, unknown> {
  const title = defaultSystemTitle(repoRoot);
  return {
    schema_version: 2,
    id: "decisions",
    title: "Decision Records",
    text: `Architecture-significant decision records for ${title}.`,
    links: {
      about: ["object:system-model"],
    },
    standard_alignment: {
      adr: "Aligns with ADR practice by recording context, drivers, considered options, the decision, rationale, and consequences.",
    },
    decisions: {
      "initial-system-root-decision": {
        state: "accepted",
        date: "2026-06-08",
        title: "Use a compact semantic root with concrete canonical docs",
        context: "The system needs durable knowledge that stays readable to agents without putting every detail into a single root file.",
        drivers: [
          "The canonical source must be readable to LLM agents without large external instructions.",
        ],
        options: {
          "root-only": {
            text: "Put all durable detail into the root system file.",
            tradeoffs: [
              "This makes one file complete, but quickly bloats first-read context and weakens task locality.",
            ],
          },
          "concrete-docs": {
            text: "Use a compact semantic root and concrete canonical docs covered by a root signature sidecar.",
            tradeoffs: [
              "This keeps first-read context small while preserving full industry-profile documentation through typed resources.",
            ],
          },
        },
        decision: "Use a compact semantic root and concrete canonical docs covered by a root signature sidecar.",
        rationale: "This gives agents a stable first-read context while preserving schema-shaped detail and tamper-evident canonical docs.",
        consequences: [
          "The root must declare canonical document resources.",
          "The runtime must refresh signature coverage after canonical writes.",
        ],
      },
    },
  };
}

function systemResources(
  repoRoot: string,
): Array<SystemResourceEntry & Record<string, unknown>> {
  const system = parseYamlFile(resolve(repoRoot, LOOPSHIP_SYSTEM_FILE));
  const resources = Array.isArray(system?.resources) ? system.resources : [];
  return resources
    .map((item) => asRecord(item))
    .filter((item): item is SystemResourceEntry & Record<string, unknown> =>
      Boolean(
        item && typeof item.location === "string" && typeof item.id === "string",
      ),
    );
}

function schemaPathForResource(schemaRef: string): string {
  if (schemaRef === "self") return "";
  if (schemaRef.startsWith("loopship://schemas/")) {
    return schemaRef.slice("loopship://".length);
  }
  return "";
}

const SECRET_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |OPENSSH |EC |)PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
];

function assertNoSecretMaterial(value: unknown, owner: string): void {
  if (typeof value === "string") {
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error(`system_update contains token-like secret material: ${owner}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, `${owner}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assertNoSecretMaterial(child, owner ? `${owner}.${key}` : key);
  }
}

function assertExternalDocPath(repoRoot: string, resourceRef: string, relativePath: string): string {
  if (!relativePath.endsWith(".yaml")) {
    throw new Error(`system_update external doc must be YAML: ${resourceRef}`);
  }
  const docsRoot = resolve(repoRoot, LOOPSHIP_DOCS_DIR);
  const fullPath = resolve(repoRoot, relativePath);
  const docsRelative = relative(docsRoot, fullPath);
  if (!docsRelative || docsRelative.startsWith("..") || docsRelative.startsWith("/")) {
    throw new Error(`system_update external doc path escapes .loopship/docs: ${resourceRef}`);
  }
  return fullPath;
}

function canonicalManagedEntries(repoRoot: string): Array<{
  resource_ref?: string;
  path: string;
  schema: string;
  schema_path: string;
  role: string;
}> {
  const shippedSchemaEntries = [
    "schemas/system.yaml",
    "schemas/signature.yaml",
    "schemas/system-pack.yaml",
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
  ].map((path) => ({
    path,
    schema: "self",
    schema_path: path,
    role: "canonical",
  })).filter((entry) => existsSync(resolve(repoRoot, entry.path)));
  const resourceEntries = systemResources(repoRoot)
    .filter((entry) => entry.role === "canonical")
    .filter((entry) => entry.location !== LOOPSHIP_ROOT_MANIFEST_FILE)
    .filter((entry) => !String(entry.location).startsWith("http"))
    .map((entry) => ({
      resource_ref: `resource:${entry.id}`,
      path: String(entry.location),
      schema: String(entry.schema_ref),
      schema_path:
        String(entry.schema_ref) === "self"
          ? String(entry.location)
          : schemaPathForResource(String(entry.schema_ref)),
      role: String(entry.role),
    }));
  const byPath = new Map<string, (typeof shippedSchemaEntries)[number] | (typeof resourceEntries)[number]>();
  for (const entry of [...shippedSchemaEntries, ...resourceEntries]) byPath.set(entry.path, entry);
  return [...byPath.values()];
}

export function rootManagedFiles(repoRoot: string): string[] {
  const files = [resolve(repoRoot, LOOPSHIP_SYSTEM_FILE)];
  for (const entry of canonicalManagedEntries(repoRoot)) {
    files.push(resolve(repoRoot, entry.path));
  }
  return files;
}

export function writeSystemManifest(
  repoRoot: string,
  _requestId = "system",
  _writerCommand = "system_update",
): string {
  const manifestPath = resolve(repoRoot, LOOPSHIP_ROOT_MANIFEST_FILE);
  const previous = parseYamlFile(manifestPath);
  const previousHead =
    typeof previous?.receipt_head === "string" ? previous.receipt_head : null;
  const systemPath = resolve(repoRoot, LOOPSHIP_SYSTEM_FILE);
  const rootDigest = canonicalYamlDigest(systemPath);
  const entries = canonicalManagedEntries(repoRoot).map((entry) => ({
    resource_ref: entry.resource_ref,
    path: entry.path,
    schema: entry.schema,
    role: entry.role,
    digest: managedFileDigest(resolve(repoRoot, entry.path)),
  }));
  const receiptHead = hashText(
    [
      previousHead ?? "",
      "system_update",
      manifestPathKey(repoRoot, systemPath),
      rootDigest,
      ...entries
        .slice()
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((entry) => `${entry.path}:${entry.digest}`),
    ].join("\n"),
  );
  writeText(manifestPath, renderYamlDocument({
    schema_version: 2,
    canonicalization: "loopship-canonical-json-v1",
    hash_algorithm: "sha256",
    root: {
      path: manifestPathKey(repoRoot, systemPath),
      schema: "loopship://schemas/system.yaml",
      digest: rootDigest,
    },
    entries,
    previous_receipt_head: previousHead,
    receipt_head: receiptHead,
    signed_at: nowIso(),
    signer: "system_update",
    signature: signManifestReceipt(receiptHead),
  }));
  return manifestPath;
}

export function ensureSystemScaffold(repoRoot: string): string[] {
  const touched: string[] = [];
  const systemPath = resolve(repoRoot, LOOPSHIP_SYSTEM_FILE);
  if (!existsSync(systemPath)) {
    writeText(systemPath, renderSystemYaml(defaultSystemRoot(repoRoot)));
    touched.push(systemPath);
  }
  const architecturePath = resolve(repoRoot, ".loopship/docs/software/architecture.yaml");
  if (!existsSync(architecturePath)) {
    writeText(architecturePath, renderSystemDocYaml(defaultArchitectureDoc(repoRoot)));
    touched.push(architecturePath);
  }
  const decisionLogPath = resolve(repoRoot, ".loopship/docs/decisions/records.yaml");
  if (!existsSync(decisionLogPath)) {
    writeText(decisionLogPath, renderSystemDocYaml(defaultDecisionLogDoc(repoRoot)));
    touched.push(decisionLogPath);
  }
  touched.push(writeSystemManifest(repoRoot, "system-scaffold", "loopship init"));
  return touched;
}

export function verifyRootManifest(repoRoot: string): {
  ok: boolean;
  errors: string[];
} {
  const manifestPath = resolve(repoRoot, LOOPSHIP_ROOT_MANIFEST_FILE);
  const manifest = parseYamlFile(manifestPath) as Record<string, any> | null;
  if (!manifest || typeof manifest !== "object") {
    return { ok: false, errors: [`missing root signature: ${manifestPath}`] };
  }
  const schemaErrors = validateSchemaPath(
    manifest as Record<string, any>,
    "schemas/signature.yaml",
  );
  if (schemaErrors.length) {
    return {
      ok: false,
      errors: schemaErrors.map((error) => `invalid root signature: ${error}`),
    };
  }
  const errors: string[] = [];
  const root = asRecord(manifest.root);
  if (!root || typeof root.path !== "string" || typeof root.digest !== "string") {
    return { ok: false, errors: [`invalid root signature entry: ${manifestPath}`] };
  }
  if (root.schema !== "loopship://schemas/system.yaml") {
    errors.push(`root signature schema must be loopship://schemas/system.yaml: ${manifestPath}`);
  }
  const systemPath = resolve(repoRoot, String(root.path));
  if (!existsSync(systemPath)) {
    errors.push(`root signature missing root file: ${root.path}`);
  } else if (canonicalYamlDigest(systemPath) !== String(root.digest)) {
    errors.push(`unauthorized/tampered root file: ${systemPath}`);
  }
  const expectedEntries = canonicalManagedEntries(repoRoot).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const actualEntries = Array.isArray(manifest.entries)
    ? (manifest.entries as Array<Record<string, unknown>>)
    : [];
  const actualByPath = new Map<string, Record<string, unknown>>(
    actualEntries
      .map(
        (entry): [string, Record<string, unknown>] => [
          String(entry.path ?? ""),
          entry,
        ],
      )
      .filter(([path]) => path.length > 0),
  );
  for (const entry of expectedEntries) {
    const actual = actualByPath.get(entry.path);
    if (!actual) {
      errors.push(`root signature missing file entry: ${entry.path}`);
      continue;
    }
    if (entry.resource_ref && actual.resource_ref !== entry.resource_ref) {
      errors.push(`root signature entry resource_ref mismatch: ${entry.path}`);
    }
    if (actual.schema !== entry.schema) {
      errors.push(`root signature entry schema mismatch: ${entry.path}`);
    }
    if (actual.role !== entry.role) {
      errors.push(`root signature entry role mismatch: ${entry.path}`);
    }
    const fullPath = resolve(repoRoot, entry.path);
    if (!existsSync(fullPath)) {
      errors.push(`root signature references missing file: ${entry.path}`);
      continue;
    }
    if (managedFileDigest(fullPath) !== String(actual.digest ?? "")) {
      errors.push(`unauthorized/tampered root file: ${fullPath}`);
    }
  }
  const expectedPaths = new Set(expectedEntries.map((entry) => entry.path));
  for (const entry of actualEntries) {
    const path = String(entry.path ?? "");
    if (path && !expectedPaths.has(path)) {
      errors.push(`root signature contains unmanaged file entry: ${path}`);
    }
  }
  const expectedHead = hashText(
    [
      typeof manifest.previous_receipt_head === "string"
        ? manifest.previous_receipt_head
        : "",
      String(manifest.signer ?? ""),
      String(root.path ?? ""),
      String(root.digest ?? ""),
      ...actualEntries
        .slice()
        .sort((left, right) =>
          String(left.path ?? "").localeCompare(String(right.path ?? "")),
        )
        .map((entry) => `${String(entry.path ?? "")}:${String(entry.digest ?? "")}`),
    ].join("\n"),
  );
  if (manifest.receipt_head !== expectedHead) {
    errors.push(`root signature receipt chain mismatch: ${manifestPath}`);
  }
  const signature = asRecord(manifest.signature);
  if (
    manifest.signer !== "system_update" ||
    signature?.algorithm !== "ed25519" ||
    signature?.key_id !== "loopship-local-v2" ||
    typeof signature?.value !== "string" ||
    !signature.value
  ) {
    errors.push(`root signature must include a system_update ed25519 signature: ${manifestPath}`);
  } else if (!manifestSignatureIsValid(expectedHead, signature.value)) {
    errors.push(`root signature cryptographic verification failed: ${manifestPath}`);
  }
  return { ok: errors.length === 0, errors };
}
export function applySystemUpdate(
  repoRoot: string,
  update: Record<string, unknown>,
  requestId: string,
): string[] {
  const updateErrors = validateSchemaPath(
    update as Record<string, any>,
    "schemas/system-update.yaml",
  );
  if (updateErrors.length) {
    throw new Error(`system_update schema validation failed: ${updateErrors.join("; ")}`);
  }
  assertNoSecretMaterial(update, "system_update");
  if (String(update.mode ?? "") === "no_change") return [];
  const touched: string[] = [];
  const root = asRecord(update.root);
  if (!root) {
    throw new Error("system_update replace mode requires root");
  }
  const systemErrors = validateSchemaPath(
    root as Record<string, any>,
    "schemas/system.yaml",
  );
  if (systemErrors.length) {
    throw new Error(`system_update root schema validation failed: ${systemErrors.join("; ")}`);
  }
  const externalDocs = Array.isArray(update.external_docs)
    ? (update.external_docs as Array<Record<string, unknown>>)
    : [];
  const rootResources = Array.isArray(root.resources)
    ? (root.resources as Array<Record<string, unknown>>)
    : [];
  const resourceByRef = new Map<string, Record<string, unknown>>(
    rootResources
      .map(
        (resource): [string, Record<string, unknown>] => [
          `resource:${String(resource.id ?? "")}`,
          resource,
        ],
      )
      .filter(([ref]) => ref !== "resource:"),
  );
  const plannedExternalDocs: Array<{
    op: string;
    fullPath: string;
    relativePath: string;
    document?: Record<string, unknown>;
  }> = [];
  for (const item of externalDocs) {
    const op = String(item.op ?? "");
    const resourceRef = String(item.resource_ref ?? "").trim();
    const resource = resourceByRef.get(resourceRef);
    if (!resource) {
      throw new Error(`system_update external doc references unknown resource: ${resourceRef}`);
    }
    const relativePath = String(resource.location ?? "").trim();
    const schemaRef = String(resource.schema_ref ?? "").trim();
    if (!relativePath || !schemaRef) {
      throw new Error(`system_update resource requires location and schema_ref: ${resourceRef}`);
    }
    if (schemaRef === "self") {
      throw new Error(`system_update external doc resource cannot use schema self: ${resourceRef}`);
    }
    const fullPath = assertExternalDocPath(repoRoot, resourceRef, relativePath);
    if (op === "delete") {
      plannedExternalDocs.push({ op, fullPath, relativePath });
      continue;
    }
    const document = asRecord(item.document);
    if (!document) {
      throw new Error(`system_update upsert requires document: ${relativePath}`);
    }
    const schemaPath = schemaPathForResource(schemaRef);
    if (!schemaPath) {
      throw new Error(`system_update cannot resolve schema ${schemaRef} for ${resourceRef}`);
    }
    const documentErrors = validateSchemaPath(
      document as Record<string, any>,
      schemaPath,
    );
    if (documentErrors.length) {
      throw new Error(
        `system_update document schema validation failed for ${relativePath}: ${documentErrors.join("; ")}`,
      );
    }
    plannedExternalDocs.push({ op, fullPath, relativePath, document });
  }

  const systemPath = resolve(repoRoot, LOOPSHIP_SYSTEM_FILE);
  writeText(systemPath, renderSystemYaml(root));
  touched.push(systemPath);

  for (const item of plannedExternalDocs) {
    if (item.op === "delete") {
      removeFileDurably(item.fullPath);
      continue;
    }
    if (!item.document) continue;
    writeText(item.fullPath, renderSystemDocYaml(item.document));
    touched.push(item.fullPath);
  }

  touched.push(writeSystemManifest(repoRoot, requestId, "loopship fastflow"));
  return touched;
}

export function renderMinimalSkillMd(): string {
  return [
    "---",
    "name: loopship",
    "description: Bin-owned loop workflow launcher.",
    "---",
    "",
    "# Loopship",
    "",
    'When user prompt is `loopship: {request}`, invoke `loopship init "{request}" --runtime <runtime>` from the repo root and follow the instructions from output.',
    "",
    "```bash",
    'loopship init "loopship: build the app" --runtime codex',
    "```",
    "",
  ].join("\n");
}

export function ensureGlobalSkillFiles(skillRoot?: string | null): string {
  const home = process.env.HOME?.trim() || ".";
  const base =
    skillRoot?.trim() ||
    process.env.LOOPSHIP_SKILL_HOME?.trim() ||
    resolve(home, ".agents", "skills", "loopship");
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
    system_context: defaultQuestSystemContext(),
    high_impact_unknowns: [],
    defaulted_unknowns: [],
    verification_targets: [],
    decomposition_rationale: "",
  };
}

function defaultQuestSystemContext(): QuestSystemContext {
  return {
    relevant_object_refs: [],
    relevant_assertion_refs: [],
    relevant_resource_refs: [],
    relevant_memory_refs: [],
    durable_implications: [],
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
  if (Array.isArray(row.options)) {
    const options = row.options
      .map((option) => {
        if (!option || typeof option !== "object") return null;
        const optionRow = option as Record<string, unknown>;
        const label = String(optionRow.label ?? "").trim();
        const description = String(optionRow.description ?? "").trim();
        return label && description ? { label, description } : null;
      })
      .filter((option): option is { label: string; description: string } =>
        Boolean(option),
      );
    if (options.length) result.options = options;
  }
  const status = String(row.status ?? "").trim();
  if (status === "open" || status === "answered" || status === "defaulted") {
    result.status = status;
  }
  if (String(row.answer ?? "").trim()) {
    result.answer = String(row.answer).trim();
  }
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

function normalizeQuestDurableImplication(
  value: unknown,
): QuestDurableImplication | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const recordKind = String(row.record_kind ?? "").trim();
  const text = String(row.text ?? "").trim();
  if (!recordKind || !text) return null;
  const expectedSystemUpdate = String(
    row.expected_system_update ?? "none",
  ).trim() as QuestDurableImplication["expected_system_update"];
  const confidence = String(row.confidence ?? "medium").trim() as
    | "low"
    | "medium"
    | "high";
  const allowedUpdates = new Set([
    "none",
    "object_update",
    "assertion_update",
    "resource_update",
    "memory_update",
    "doc_update",
    "system_update",
  ]);
  const allowedKinds = new Set([
    "rule",
    "behaviour",
    "claim",
    "assumption",
    "limitation",
    "area",
    "actor",
    "unit",
    "interface",
    "flow",
    "store",
    "asset",
    "schema",
    "document",
    "artifact",
    "evidence",
    "preference",
    "learning",
    "observation",
  ]);
  const allowedConfidence = new Set(["low", "medium", "high"]);
  return {
    record_kind: allowedKinds.has(recordKind)
      ? (recordKind as QuestDurableImplication["record_kind"])
      : "rule",
    text,
    links: asLinkMap(row.links),
    expected_system_update: allowedUpdates.has(expectedSystemUpdate)
      ? expectedSystemUpdate
      : "none",
    confidence: allowedConfidence.has(confidence) ? confidence : "medium",
  };
}

function normalizeQuestSystemContext(value: unknown): QuestSystemContext {
  if (!value || typeof value !== "object") return defaultQuestSystemContext();
  const row = value as Record<string, unknown>;
  return {
    relevant_object_refs: asStringList(row.relevant_object_refs),
    relevant_assertion_refs: asStringList(row.relevant_assertion_refs),
    relevant_resource_refs: asStringList(row.relevant_resource_refs),
    relevant_memory_refs: asStringList(row.relevant_memory_refs),
    durable_implications: Array.isArray(row.durable_implications)
      ? row.durable_implications
          .map(normalizeQuestDurableImplication)
          .filter((entry): entry is QuestDurableImplication => Boolean(entry))
      : [],
  };
}

function normalizeQuestEvidence(value: unknown): QuestEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const type = String(row.type ?? "").trim();
  const ref = String(row.ref ?? "").trim();
  if (!type || !ref) return null;
  return {
    type,
    ref,
    summary: String(row.summary ?? "").trim() || undefined,
    status: String(row.status ?? "").trim() || undefined,
  };
}

function normalizeQuestChildResults(value: unknown): QuestChildResult[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      const taskId = String(row.task_id ?? row.id ?? "").trim();
      const childWtree = String(row.child_wtree ?? "").trim();
      const status = String(row.status ?? "").trim();
      if (!taskId || !childWtree || !status) return null;
      return {
        task_id: taskId,
        child_wtree: childWtree,
        status,
        evidence: Array.isArray(row.evidence)
          ? row.evidence
              .map((entry) => normalizeQuestEvidence(entry))
              .filter((entry): entry is QuestEvidence => Boolean(entry))
          : [],
        branch_ref: String(row.branch_ref ?? "").trim(),
        worktree_path: String(row.worktree_path ?? "").trim(),
        merge_target: String(row.merge_target ?? "").trim(),
        merge_lease_id: String(row.merge_lease_id ?? "").trim(),
        merge_commit: String(row.merge_commit ?? "").trim(),
      };
    })
    .filter((entry): entry is QuestChildResult => Boolean(entry));
}

function normalizeTaskList(
  value: unknown,
  state: Partial<QuestState>,
): QuestTask[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) =>
      normalizePlanTask(
        state,
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
      schema_version: 5,
      wtree,
      quest_id: String(state.quest_id ?? wtree),
      flow_id: String(state.flow_id ?? ""),
      flow_version:
        Number.isInteger(state.flow_version) && state.flow_version > 0
          ? state.flow_version
          : 1,
      stage: String(state.stage ?? ""),
      prompt: String(state.prompt ?? ""),
      context_root: String(state.context_root ?? ""),
      resolution_source: String(state.resolution_source ?? ""),
      supervise_step: state.supervise_step === true,
      coordinator_branch: String(state.coordinator_branch ?? "main"),
      coordinator_worktree: String(state.coordinator_worktree ?? ""),
      parent_wtree: String(state.parent_wtree ?? ""),
      parent_task_id: String(state.parent_task_id ?? ""),
      parent_context_ref: String(state.parent_context_ref ?? ""),
      landing_target_branch: String(state.landing_target_branch ?? "main"),
      landing_target_worktree: String(state.landing_target_worktree ?? ""),
      landed_commit: String(state.landed_commit ?? ""),
      landing_strategy: String(state.landing_strategy ?? ""),
      replan_reason: String(state.replan_reason ?? ""),
      assumptions: asStringList(state.assumptions),
      constraints: asStringList(state.constraints),
      question_rounds: Array.isArray(state.question_rounds)
        ? state.question_rounds
        : [],
      plan_detail: state.plan_detail ?? defaultQuestPlanDetail(),
      validation_receipt:
        state.validation_receipt ?? defaultQuestValidationReceipt(),
      verification_receipt:
        state.verification_receipt ?? defaultQuestVerificationReceipt(),
      ...(state.local_work_receipt &&
      typeof state.local_work_receipt === "object"
        ? { local_work_receipt: state.local_work_receipt }
        : {}),
      child_results: Array.isArray(state.child_results) ? state.child_results : [],
      tasks: Array.isArray(state.tasks) ? state.tasks : [],
    },
    { lineWidth: 0 },
  );
}

export function parseTasksYaml(text: string): Partial<QuestState> {
  const parsed = parseYaml(text) as Record<string, unknown> | null;
  const raw = parsed && typeof parsed === "object" ? parsed : {};
  if (raw.schema_version !== 5) {
    throw legacyQuestStateUnsupported(
      `quest task state schema ${String(raw.schema_version ?? "<missing>")} is unsupported; resubmit it as a new Native v1 execution`,
    );
  }
  if (LEGACY_WTREE_KEY in raw || LEGACY_PARENT_WTREE_KEY in raw) {
    throw legacyQuestStateUnsupported(
      "legacy quest state keys are unsupported; resubmit the quest as a new Native v1 execution",
    );
  }
  if ("answers" in raw) {
    throw legacyQuestStateUnsupported(
      "legacy top-level answers are unsupported; resubmit the quest as a new Native v1 execution",
    );
  }
  const taskState: Partial<QuestState> = {
    wtree: String(raw.wtree ?? "").trim(),
    prompt: String(raw.prompt ?? ""),
    context_root: String(raw.context_root ?? ""),
    coordinator_branch: String(raw.coordinator_branch ?? "main"),
    coordinator_worktree: String(raw.coordinator_worktree ?? ""),
    parent_wtree: String(raw.parent_wtree ?? ""),
    parent_task_id: String(raw.parent_task_id ?? ""),
    parent_context_ref: String(raw.parent_context_ref ?? ""),
    landing_target_branch: String(raw.landing_target_branch ?? "main"),
  };
  const result: Partial<QuestState> = {
    schema_version: 5,
    wtree: String(raw.wtree ?? "").trim(),
    quest_id: String(raw.quest_id ?? raw.wtree ?? "").trim(),
    flow_id: String(raw.flow_id ?? "").trim(),
    flow_version: Number.isInteger(raw.flow_version)
      ? Number(raw.flow_version)
      : Math.max(1, Number(raw.flow_version ?? 1) || 1),
    stage: String(raw.stage ?? "").trim(),
    prompt: String(raw.prompt ?? ""),
    context_root: String(raw.context_root ?? ""),
    resolution_source: String(raw.resolution_source ?? ""),
    supervise_step: raw.supervise_step === true || raw.superviseStep === true,
    coordinator_branch: String(raw.coordinator_branch ?? "main"),
    coordinator_worktree: String(raw.coordinator_worktree ?? ""),
    parent_wtree: String(raw.parent_wtree ?? ""),
    parent_task_id: String(raw.parent_task_id ?? ""),
    parent_context_ref: String(raw.parent_context_ref ?? ""),
    landing_target_branch: String(raw.landing_target_branch ?? "main"),
    landing_target_worktree: String(raw.landing_target_worktree ?? ""),
    landed_commit: String(raw.landed_commit ?? ""),
    landing_strategy: String(raw.landing_strategy ?? ""),
    replan_reason: String(raw.replan_reason ?? ""),
    assumptions: asStringList(raw.assumptions),
    constraints: asStringList(raw.constraints),
    question_rounds: normalizeQuestionRounds(raw.question_rounds),
    plan_detail:
      raw.plan_detail && typeof raw.plan_detail === "object"
        ? {
            classification: String(
              (raw.plan_detail as Record<string, unknown>).classification ?? "",
            ),
            scope: String(
              (raw.plan_detail as Record<string, unknown>).scope ?? "",
            ),
            summary: String(
              (raw.plan_detail as Record<string, unknown>).summary ?? "",
            ),
            rationale: String(
              (raw.plan_detail as Record<string, unknown>).rationale ?? "",
            ),
            system_context: normalizeQuestSystemContext(
              (raw.plan_detail as Record<string, unknown>).system_context,
            ),
            high_impact_unknowns: asStringList(
              (raw.plan_detail as Record<string, unknown>).high_impact_unknowns,
            ),
            defaulted_unknowns: asStringList(
              (raw.plan_detail as Record<string, unknown>).defaulted_unknowns,
            ),
            verification_targets: asStringList(
              (raw.plan_detail as Record<string, unknown>).verification_targets,
            ),
            decomposition_rationale: String(
              (raw.plan_detail as Record<string, unknown>)
                .decomposition_rationale ?? "",
            ),
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
    ...(raw.local_work_receipt &&
    typeof raw.local_work_receipt === "object" &&
    !Array.isArray(raw.local_work_receipt)
      ? { local_work_receipt: raw.local_work_receipt as Record<string, unknown> }
      : {}),
    child_results: normalizeQuestChildResults(raw.child_results),
    tasks: normalizeTaskList(raw.tasks, taskState),
  };
  if (!result.quest_id && result.wtree) result.quest_id = result.wtree;
  return result;
}

function legacyQuestStateUnsupported(message: string): Error {
  return Object.assign(
    new Error(`legacy_execution_unsupported: ${message}`),
    { code: "legacy_execution_unsupported" },
  );
}

export function appendJsonl(
  file: string,
  record: Record<string, unknown>,
): void {
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
  writerCommand = "loopship fastflow",
): void {
  const previous = parseYamlFile(files.manifest);
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
  writeText(files.manifest, renderYamlDocument({
    schema_version: 1,
    canonicalization: "loopship-canonical-json-v1",
    generated_at: nowIso(),
    generated_by: "loopship",
    writer_command: writerCommand,
    request_id: requestId,
    hash_algorithm: "sha256",
    previous_receipt_head: previousHead,
    receipt_head: receiptHead,
    files: hashes,
  }));
}

export function verifyQuestManifest(files: QuestFiles): {
  ok: boolean;
  errors: string[];
} {
  const manifest = parseYamlFile(files.manifest) as Record<string, any> | null;
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

function assertPlanTaskAliasesAgree(
  input: Record<string, unknown>,
  index: number,
): void {
  const errors = loopshipChildDagTaskAliasErrors(input, index);
  if (errors.length) throw new Error(errors.join("; "));
}

function normalizePlanTask(
  state: Partial<QuestState>,
  input: Record<string, unknown>,
  index: number,
): QuestTask {
  assertPlanTaskAliasesAgree(input, index);
  const wtree = String(state.wtree ?? "quest");
  const rawId = String(input.id ?? input.task_id ?? `task-${index + 1}`);
  const id = normalizeName(rawId);
  const contextRoot = String(state.context_root ?? ".");
  const terminalChild = isTerminalChildQuestState(state);
  const coordinatorBranch = String(state.coordinator_branch ?? "main");
  const coordinatorWorktree = String(state.coordinator_worktree ?? contextRoot);
  const landingTargetBranch = String(state.landing_target_branch ?? coordinatorBranch);
  return {
    id,
    title: String(input.title ?? input.name ?? id),
    type: input.type === "general" ? "general" : "coding",
    status: String(input.status ?? (terminalChild ? "pending" : "child_received")),
    dependencies: asStringList(input.dependencies ?? input.depends_on).map((id) =>
      normalizeName(id),
    ),
    scope_files: asStringList(input.scope_files ?? input.scope),
    spec_refs: asStringList(input.spec_refs ?? input.specs),
    context_refs: asStringList(input.context_refs ?? input.context),
    branch_ref: terminalChild
      ? coordinatorBranch
      : taskAssignmentBranchRef(wtree, id),
    worktree_path: terminalChild
      ? coordinatorWorktree
      : taskAssignmentWorktreePath(contextRoot, wtree, id),
    child_wtree: terminalChild
      ? ""
      : taskAssignmentChildWtree(wtree, id),
    concurrency_group: String(input.concurrency_group ?? ""),
    merge_target: terminalChild ? landingTargetBranch : coordinatorBranch,
    merge_lease_id: terminalChild
      ? ""
      : taskAssignmentMergeLeaseId(wtree, id),
    merge_commit: String(input.merge_commit ?? ""),
    system_impact_ref: String(input.system_impact_ref ?? ""),
    acceptance: planTaskAcceptance(
      input.acceptance ?? input.acceptance_criteria,
    ),
  };
}

export function buildQuestPlanState(
  files: QuestFiles,
  state: Partial<QuestState>,
  plan: Record<string, unknown> | null,
): QuestState {
  const taskInputs = Array.isArray(plan?.tasks)
    ? (plan!.tasks as Array<Record<string, unknown>>)
    : [];
  const nextState: QuestState = {
    schema_version: 5,
    wtree: files.wtree,
    quest_id: String(state.quest_id ?? files.wtree),
    flow_id: String(state.flow_id ?? ""),
    flow_version: Number(state.flow_version ?? 1),
    stage: String(state.stage ?? ""),
    prompt: String(state.prompt ?? ""),
    context_root: String(state.context_root ?? ""),
    resolution_source: String(state.resolution_source ?? ""),
    supervise_step: state.supervise_step === true,
    coordinator_branch: String(state.coordinator_branch ?? "main"),
    coordinator_worktree: String(state.coordinator_worktree ?? ""),
    parent_wtree: String(state.parent_wtree ?? ""),
    parent_task_id: String(state.parent_task_id ?? ""),
    parent_context_ref: String(state.parent_context_ref ?? ""),
    landing_target_branch: String(state.landing_target_branch ?? "main"),
    landing_target_worktree: String(state.landing_target_worktree ?? ""),
    landed_commit: String(state.landed_commit ?? ""),
    landing_strategy: String(state.landing_strategy ?? ""),
    replan_reason: "",
    assumptions: asStringList(plan?.assumptions),
    constraints: asStringList(plan?.constraints),
    question_rounds: Array.isArray(state.question_rounds)
      ? state.question_rounds
      : [],
    plan_detail: {
      classification: String(plan?.classification ?? ""),
      scope: String(plan?.scope ?? ""),
      summary: String(plan?.summary ?? plan?.scope ?? ""),
      rationale: String(plan?.summary ?? plan?.scope ?? ""),
      system_context: normalizeQuestSystemContext(plan?.system_context),
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
    child_results: Array.isArray(state.child_results) ? state.child_results : [],
    tasks: taskInputs.map((task, index) =>
      normalizePlanTask(state, task, index),
    ),
  };
  return nextState;
}

export function applyQuestPlanToTasks(
  files: QuestFiles,
  state: Partial<QuestState>,
  plan: Record<string, unknown> | null,
): QuestState {
  const nextState = buildQuestPlanState(files, state, plan);
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
    schema_version: 5,
    wtree: files.wtree,
    quest_id: String(state.quest_id ?? files.wtree),
    flow_id: String(state.flow_id ?? ""),
    flow_version: Number(state.flow_version ?? 1),
    stage: String(state.stage ?? ""),
    prompt: String(state.prompt ?? ""),
    context_root: String(state.context_root ?? ""),
    resolution_source: String(state.resolution_source ?? ""),
    supervise_step: state.supervise_step === true,
    coordinator_branch: String(state.coordinator_branch ?? "main"),
    coordinator_worktree: String(state.coordinator_worktree ?? ""),
    parent_wtree: String(state.parent_wtree ?? ""),
    parent_task_id: String(state.parent_task_id ?? ""),
    parent_context_ref: String(state.parent_context_ref ?? ""),
    landing_target_branch: String(state.landing_target_branch ?? "main"),
    landing_target_worktree: String(state.landing_target_worktree ?? ""),
    landed_commit: String(state.landed_commit ?? ""),
    landing_strategy: String(state.landing_strategy ?? ""),
    replan_reason: String(state.replan_reason ?? ""),
    assumptions: asStringList(state.assumptions),
    constraints: asStringList(state.constraints),
    question_rounds: Array.isArray(state.question_rounds)
      ? state.question_rounds
      : [],
    plan_detail: state.plan_detail ?? defaultQuestPlanDetail(),
    validation_receipt:
      state.validation_receipt ?? defaultQuestValidationReceipt(),
    verification_receipt:
      state.verification_receipt ?? defaultQuestVerificationReceipt(),
    child_results: Array.isArray(state.child_results) ? state.child_results : [],
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
    schema_version: 5,
    wtree: files.wtree,
    quest_id: String(state.quest_id ?? files.wtree),
    flow_id: String(state.flow_id ?? ""),
    flow_version: Number(state.flow_version ?? 1),
    stage: String(state.stage ?? ""),
    prompt: String(state.prompt ?? ""),
    context_root: String(state.context_root ?? ""),
    resolution_source: String(state.resolution_source ?? ""),
    supervise_step: state.supervise_step === true,
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
    replan_reason: String(state.replan_reason ?? ""),
    assumptions: asStringList(state.assumptions),
    constraints: asStringList(state.constraints),
    question_rounds: Array.isArray(state.question_rounds)
      ? state.question_rounds
      : [],
    plan_detail: state.plan_detail ?? defaultQuestPlanDetail(),
    validation_receipt:
      state.validation_receipt ?? defaultQuestValidationReceipt(),
    verification_receipt:
      state.verification_receipt ?? defaultQuestVerificationReceipt(),
    ...(state.local_work_receipt &&
    typeof state.local_work_receipt === "object"
      ? { local_work_receipt: state.local_work_receipt }
      : {}),
    child_results: Array.isArray(state.child_results) ? state.child_results : [],
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
  };
  writeText(files.tasks, renderTasksYaml(nextState));
  return nextState;
}

export type CreateQuestInput = {
  repoRoot: string;
  wtree: string;
  prompt: string;
  resolutionSource: string;
  superviseStep?: boolean;
  workspace: QuestWorkspace;
  flowId: string;
  flowVersion?: number;
  initialStage: string;
  parentWtree?: string;
  parentTaskId?: string;
  parentContextRef?: string;
  landingTargetBranch?: string;
  landingTargetWorktree?: string;
  landedCommit?: string;
  landingStrategy?: string;
};

export function createQuestInitialState(input: CreateQuestInput): QuestState {
  const workspacePath = assertRepoWorktreePath(input.repoRoot, input.workspace.worktree_path);
  const expectedWorkspacePath = coordinatorWorktreePath(input.repoRoot, input.wtree);
  if (workspacePath !== expectedWorkspacePath) {
    throw new Error(
      `quest workspace must match its canonical worktree path: ${expectedWorkspacePath}`,
    );
  }
  const coordinatorBranch = assertValidGitBranchRef(
    input.workspace.branch_ref,
    "coordinator branch",
  );
  const landingTargetBranch = assertValidGitBranchRef(
    input.landingTargetBranch ?? "main",
    "landing target branch",
  );
  if (input.parentWtree) assertCanonicalWtreeName(input.parentWtree, "parent_wtree");
  return {
    schema_version: 5,
    wtree: input.wtree,
    quest_id: input.wtree,
    flow_id: input.flowId,
    flow_version: input.flowVersion ?? 1,
    stage: input.initialStage,
    prompt: input.prompt,
    context_root: input.repoRoot,
    resolution_source: input.resolutionSource,
    supervise_step: input.superviseStep === true,
    coordinator_branch: coordinatorBranch,
    coordinator_worktree: workspacePath,
    parent_wtree: String(input.parentWtree ?? ""),
    parent_task_id: String(input.parentTaskId ?? ""),
    parent_context_ref: String(input.parentContextRef ?? ""),
    landing_target_branch: landingTargetBranch,
    landing_target_worktree: String(input.landingTargetWorktree ?? ""),
    landed_commit: String(input.landedCommit ?? ""),
    landing_strategy: String(input.landingStrategy ?? ""),
    replan_reason: "",
    assumptions: [],
    constraints: [],
    question_rounds: [],
    plan_detail: defaultQuestPlanDetail(),
    validation_receipt: defaultQuestValidationReceipt(),
    verification_receipt: defaultQuestVerificationReceipt(),
    child_results: [],
    tasks: [],
  };
}

export function createQuest(input: CreateQuestInput): { files: QuestFiles; state: QuestState } {
  const state = createQuestInitialState(input);
  const files = questFiles(input.repoRoot, input.wtree);
  if (existsSync(files.tasks)) {
    throw new Error(`quest wtree already exists: ${input.wtree}`);
  }
  writeText(files.tasks, renderTasksYaml(state));
  if (!existsSync(files.events)) writeText(files.events, "");
  if (!existsSync(files.hook_state)) writeJson(files.hook_state, {});
  appendJsonl(files.events, {
    event: "quest_started",
    quest_id: input.wtree,
    stage: state.stage,
  });
  writeQuestManifest(files, `start-${input.wtree}`, "loopship fastflow");
  return { files, state };
}

export function updateQuestStage(
  files: QuestFiles,
  nextStage: string,
  requestId = "quest-stage",
  writerCommand = "loopship fastflow",
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
  if (/(?:^|\/)\.loopship\/runtime\/tasks\.yaml$/i.test(normalized)) {
    const worktreeMatch = normalized.match(
      /(?:^|\/)worktrees\/([a-z0-9]+(?:-[a-z0-9]+)*)\/\.loopship\/runtime\/tasks\.yaml$/i,
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

export function parseGitWorktrees(repoRoot: string): Array<{
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
    if (entries.some((entry) => entry !== ".loopship")) return false;
    const runtimeDir = resolve(path, ".loopship", "runtime");
    if (!existsSync(runtimeDir)) return false;
    const runtimeEntries = readdirSync(runtimeDir);
    return runtimeEntries.every(
      (entry) => entry === "lock.json" || entry === "hook-state.json",
    );
  } catch {
    return false;
  }
}

function gitRefCommit(repoRoot: string, ref: string): string | null {
  const proc = runCommand("git", ["rev-parse", "--verify", "--end-of-options", ref], {
    cwd: repoRoot,
    timeoutMs: 10_000,
  });
  return proc.status === 0 ? proc.stdout.trim() || null : null;
}

function gitWorkspaceClean(worktreePath: string): boolean {
  const proc = runCommand("git", ["status", "--short"], {
    cwd: worktreePath,
    timeoutMs: 10_000,
  });
  return proc.status === 0 && !proc.stdout.trim();
}

function syncWorkspaceToBaseIfSafe(
  repoRoot: string,
  worktreePath: string,
  branchRef: string,
  baseRef?: string,
): void {
  const base = String(baseRef ?? "").trim();
  if (!base) return;
  const branchCommit = gitRefCommit(repoRoot, branchRef);
  const baseCommit = gitRefCommit(repoRoot, base);
  if (!branchCommit || !baseCommit || branchCommit === baseCommit) return;
  const divergence = runCommand(
    "git",
    ["rev-list", "--left-right", "--count", `${baseCommit}...${branchCommit}`],
    {
      cwd: repoRoot,
      timeoutMs: 10_000,
    },
  );
  if (divergence.status !== 0) return;
  const [behindCountRaw, aheadCountRaw] = divergence.stdout.trim().split(/\s+/);
  const behindCount = Number.parseInt(behindCountRaw ?? "0", 10) || 0;
  const aheadCount = Number.parseInt(aheadCountRaw ?? "0", 10) || 0;
  if (behindCount === 0 || aheadCount !== 0 || !gitWorkspaceClean(worktreePath)) {
    return;
  }
  const reset = runCommand("git", ["reset", "--hard", baseCommit], {
    cwd: worktreePath,
    timeoutMs: 30_000,
  });
  if (reset.status !== 0) {
    throw new Error(
      reset.stderr ||
        reset.stdout ||
        `failed to fast-forward ${branchRef} to ${base}`,
    );
  }
}

export function coordinatorWorktreePath(
  repoRoot: string,
  wtree: string,
): string {
  return resolve(repoRoot, "worktrees", assertCanonicalWtreeName(wtree));
}

export function landingTargetWorktreePath(
  repoRoot: string,
  branchRef: string,
): string {
  return resolve(repoRoot, "worktrees", `landing-${normalizeName(branchRef)}`);
}

function assertRepoWorktreePath(repoRoot: string, worktreePath: string): string {
  const worktreesRoot = resolve(repoRoot, "worktrees");
  const requestedPath = resolve(worktreePath);
  const relativePath = relative(worktreesRoot, requestedPath);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath) ||
    dirname(requestedPath) !== worktreesRoot
  ) {
    throw new Error(`task worktree path must stay inside ${worktreesRoot}: ${requestedPath}`);
  }
  if (
    existsSync(worktreesRoot) &&
    realpathSync(worktreesRoot) !== resolve(realpathSync(repoRoot), "worktrees")
  ) {
    throw new Error(`repository worktrees root must not be a symlink: ${worktreesRoot}`);
  }
  if (existsSync(requestedPath)) {
    try {
      const realRelative = relative(realpathSync(worktreesRoot), realpathSync(requestedPath));
      if (realRelative !== relativePath) {
        throw new Error(
          `task worktree path must resolve to its canonical location: ${requestedPath}`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("task worktree path must resolve")) {
        throw error;
      }
      throw new Error(`cannot resolve task worktree path: ${requestedPath}`);
    }
  }
  return requestedPath;
}

function ensureNamedWorkspace(
  repoRoot: string,
  branchRef: string,
  desiredPath: string,
  baseRef?: string,
): QuestWorkspace {
  branchRef = assertValidGitBranchRef(branchRef);
  if (!hasGitCommit(repoRoot)) {
    ensureDirectoryDurable(desiredPath);
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
    if (existingByPath.branch !== branchRef) {
      throw new Error(
        `task worktree ${desiredPath} is registered to ${existingByPath.branch || "a detached HEAD"}, not ${branchRef}`,
      );
    }
    syncWorkspaceToBaseIfSafe(
      repoRoot,
      existingByPath.worktree,
      branchRef,
      baseRef,
    );
    return {
      branch_ref: branchRef,
      worktree_path: existingByPath.worktree,
      mode: "git",
    };
  }

  const existingByBranch = worktrees.find(
    (entry) => entry.branch === branchRef,
  );
  if (existingByBranch) {
    if (resolve(existingByBranch.worktree) !== desiredPath) {
      throw new Error(
        `task branch ${branchRef} is registered at ${existingByBranch.worktree}, not ${desiredPath}`,
      );
    }
    syncWorkspaceToBaseIfSafe(
      repoRoot,
      existingByBranch.worktree,
      branchRef,
      baseRef,
    );
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
  const requestedStartRef = String(baseRef ?? "").trim() || "HEAD";
  const startRef = branchExists
    ? "HEAD"
    : gitRefCommit(repoRoot, requestedStartRef) ?? "HEAD";
  const proc = branchExists
    ? runCommand("git", ["worktree", "add", desiredPath, branchRef], {
        cwd: repoRoot,
        timeoutMs: 30_000,
      })
    : runCommand(
        "git",
        ["worktree", "add", "-b", branchRef, desiredPath, startRef],
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
  const requestedPath = coordinatorWorktreePath(repoRoot, wtree);
  const existingBranchWorkspace = parseGitWorktrees(repoRoot).find(
    (entry) => entry.branch === wtree,
  );
  if (
    existingBranchWorkspace &&
    resolve(existingBranchWorkspace.worktree) !== requestedPath
  ) {
    throw new Error(
      `coordinator branch ${wtree} is already checked out outside its requested worktree: ${existingBranchWorkspace.worktree}`,
    );
  }
  return ensureNamedWorkspace(repoRoot, wtree, requestedPath);
}

export function ensureTaskWorkspace(
  repoRoot: string,
  branchRef: string,
  worktreePath: string,
  baseRef?: string,
): QuestWorkspace {
  const requestedPath = assertRepoWorktreePath(repoRoot, worktreePath);
  const existingBranchWorkspace = parseGitWorktrees(repoRoot).find(
    (entry) => entry.branch === branchRef,
  );
  if (
    existingBranchWorkspace &&
    resolve(existingBranchWorkspace.worktree) !== requestedPath
  ) {
    throw new Error(
      `task branch ${branchRef} is already checked out outside its requested worktree: ${existingBranchWorkspace.worktree}`,
    );
  }
  return ensureNamedWorkspace(repoRoot, branchRef, requestedPath, baseRef);
}

function renderLoopshipShim(loopshipScriptAbs: string): string {
  const script = shellQuote(resolveCanonicalLoopshipScriptPath(loopshipScriptAbs));
  const scriptEnvExpr = `\${${LOOPSHIP_SCRIPT_ENV}:-}`;
  const scriptEnvValue = `$${LOOPSHIP_SCRIPT_ENV}`;
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
    "if command -v bun >/dev/null 2>&1; then",
    '  exec bun --no-install "$SCRIPT" "$@"',
    "fi",
    'echo "Loopship application runtime requires Bun" >&2',
    "exit 127",
    "",
  ].join("\n");
}

export function resolveCanonicalLoopshipScriptPath(
  loopshipScriptAbs: string,
): string {
  const normalized = resolve(loopshipScriptAbs);
  const worktreeMatch = normalized.match(
    /^(.*?)(?:[\\/])worktrees(?:[\\/])[^\\/]+(?:[\\/])(.*)$/,
  );
  const canonical = worktreeMatch
    ? resolve(worktreeMatch[1], worktreeMatch[2])
    : normalized;
  const scriptPath = worktreeMatch && !existsSync(canonical) ? normalized : canonical;
  if (scriptPath.match(/(?:^|[\\/])scripts[\\/]loopship\.ts$/)) {
    return resolve(dirname(dirname(scriptPath)), "index.ts");
  }
  return scriptPath;
}

export function resolveGlobalLoopshipBinPath(): string {
  const envPath = process.env[LOOPSHIP_GLOBAL_BIN_ENV]?.trim();
  if (envPath) return resolve(expandHome(envPath));
  const home = process.env.HOME?.trim();
  if (!home) return resolve(".loopship", "global", "loopship");
  return resolve(home, ".local", "bin", "loopship");
}

export function createLoopshipShim(
  targetPath: string,
  loopshipScriptAbs: string,
): void {
  writeText(targetPath, renderLoopshipShim(loopshipScriptAbs));
  chmodSync(targetPath, 0o755);
}

export function createRepoWrapper(
  repoRoot: string,
  loopshipScriptAbs: string,
): void {
  const wrapper = resolve(repoRoot, LOOPSHIP_BIN_FILE);
  createLoopshipShim(wrapper, loopshipScriptAbs);
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
  flowId = "",
  initialStage = "",
): QuestFiles {
  const files = questFiles(repoRoot, wtree);
  if (!existsSync(files.tasks)) {
    const initial: QuestState = {
      schema_version: 5,
      wtree,
      quest_id: wtree,
      flow_id: flowId,
      flow_version: 1,
      stage: initialStage,
      prompt: objective,
      context_root: repoRoot,
      resolution_source: "manual",
      supervise_step: false,
      coordinator_branch: wtree,
      coordinator_worktree: coordinatorWorktreePath(repoRoot, wtree),
      parent_wtree: "",
      parent_task_id: "",
      parent_context_ref: "",
      landing_target_branch: "main",
      landing_target_worktree: landingTargetWorktreePath(repoRoot, "main"),
      landed_commit: "",
      landing_strategy: "",
      replan_reason: "",
      assumptions: [],
      constraints: [],
      question_rounds: [],
      plan_detail: defaultQuestPlanDetail(),
      validation_receipt: defaultQuestValidationReceipt(),
      verification_receipt: defaultQuestVerificationReceipt(),
      child_results: [],
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
  const direct = resolve(resolved, LOOPSHIP_DIR);
  if (existsSync(direct)) return resolved;
  let cursor = resolved;
  while (true) {
    if (existsSync(resolve(cursor, LOOPSHIP_DIR))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return resolved;
}
