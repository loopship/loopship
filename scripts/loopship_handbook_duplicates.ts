#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  renderSystemDocYaml,
  renderSystemYaml,
  writeSystemManifest,
} from "./loopship_core.ts";
import { hashText, readText, writeText } from "./loopship_utils.ts";

type YamlMap = Record<string, unknown>;

export type HandbookDuplicateOccurrence = {
  id: string;
  file: string;
  pointer: string;
  owner_ref: string;
  heading_path: string[];
  fix: "keep" | "safe" | "manual";
  fix_reason: string;
};

export type HandbookDuplicateGroup = {
  hash: string;
  chars: number;
  count: number;
  sample: string;
  owner: HandbookDuplicateOccurrence;
  occurrences: HandbookDuplicateOccurrence[];
};

export type HandbookDuplicateReport = {
  repo: string;
  min_chars: number;
  duplicate_groups: HandbookDuplicateGroup[];
  duplicate_count: number;
};

export type HandbookDuplicateFixReport = HandbookDuplicateReport & {
  applied_fixes: string[];
  skipped_fixes: string[];
  signature_path?: string;
};

type ProseSource = {
  id: string;
  file: string;
  pointer: string;
  parent_pointer: string;
  text: string;
  normalized: string;
  heading_path: string[];
  owner_ref: string;
  owner_rank: number;
  source_kind: "root" | "document";
  root_record_type?: "object" | "assertion" | "resource" | "memory";
  root_record_id?: string;
  resource_ref?: string;
  resource_id?: string;
};

type LoadedDocument = {
  location: string;
  resource_id: string;
  resource_ref: string;
  schema_ref: string;
  title: string;
  doc: YamlMap;
};

type HandbookSourceState = {
  repoRoot: string;
  system: YamlMap;
  docs: LoadedDocument[];
  sources: ProseSource[];
};

export const DEFAULT_DUPLICATE_MIN_CHARS = 80;

const DOC_SKIP_KEYS = new Set(["schema_version", "id", "title", "text", "links"]);
const METADATA_KEYS = new Set([
  "kind",
  "language",
  "media",
  "rendered_ref",
  "resource_ref",
  "role",
  "schema_ref",
  "state",
  "status",
  "syntax",
]);
const RESOURCE_OWNER_RANKS = new Map([
  ["software-architecture", 10],
  ["business-architecture", 20],
  ["workflow-spec", 30],
  ["agent-system-card", 40],
  ["model-card", 50],
  ["dataset-datasheet", 60],
  ["artifact-bom", 70],
  ["decisions", 90],
]);

function isMap(value: unknown): value is YamlMap {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseYamlMap(text: string, label: string): YamlMap {
  const parsed = parseYaml(text);
  if (!isMap(parsed)) throw new Error(`${label} must parse to a YAML object`);
  return parsed;
}

function resolveRepoRoot(input?: string): string {
  let cursor = resolve(input || process.cwd());
  while (true) {
    if (existsSync(join(cursor, ".loopship", "system.yaml"))) return cursor;
    const parent = resolve(cursor, "..");
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error("cannot find .loopship/system.yaml from current directory");
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function pointerToken(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function jsonPointer(tokens: string[]): string {
  return tokens.length ? `/${tokens.map(pointerToken).join("/")}` : "";
}

function pointerValue(root: unknown, pointer: string): unknown {
  if (!pointer) return root;
  let cursor = root;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cursor)) {
      cursor = cursor[Number(token)];
    } else if (isMap(cursor)) {
      cursor = cursor[token];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function normalizeDuplicateText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sourceHash(value: string): string {
  return hashText(value).slice(0, 16);
}

function ownerRankForResource(resourceId: string): number {
  return RESOURCE_OWNER_RANKS.get(resourceId) ?? 80;
}

function ownerTargetRefForDocument(resourceRef: string, pointer: string): string {
  return pointer ? `${resourceRef}#${pointer}` : resourceRef;
}

function resourceRefBase(targetRef: string): string {
  return targetRef.split("#")[0] ?? targetRef;
}

function addUniqueLink(record: YamlMap, relation: string, target: string): void {
  const links = isMap(record.links) ? record.links : {};
  const current = Array.isArray(links[relation])
    ? links[relation].map(String)
    : typeof links[relation] === "string"
      ? [String(links[relation])]
      : [];
  if (!current.includes(target)) current.push(target);
  links[relation] = current;
  record.links = links;
}

function isDiagramBlock(value: YamlMap): boolean {
  return (
    typeof value.kind === "string" &&
    typeof value.syntax === "string" &&
    typeof value.source === "string"
  );
}

function isExampleBlock(value: YamlMap): boolean {
  return (
    typeof value.language === "string" &&
    typeof value.source === "string" &&
    !("syntax" in value)
  );
}

function sourceLabel(source: ProseSource): string {
  return `${source.file}${source.pointer ? `#${source.pointer}` : ""}`;
}

function safeFixReason(source: ProseSource, owner: ProseSource): string {
  if (source.id === owner.id) return "canonical owner selected by default document rank";
  if (
    source.source_kind === "root" &&
    source.root_record_type === "assertion" &&
    owner.owner_ref.startsWith("resource:")
  ) {
    return "root assertion can index the canonical resource section with links.supported_by";
  }
  if (
    source.file === ".loopship/docs/agent/system-card.yaml" &&
    /^\/evaluation\/[^/]+\/text$/.test(source.pointer) &&
    owner.owner_ref.startsWith("resource:")
  ) {
    return "agent evaluation blocks support resource_ref and links.supported_by";
  }
  return "schema-safe automatic rewrite is not known for this source shape";
}

function fixKind(source: ProseSource, owner: ProseSource): "keep" | "safe" | "manual" {
  if (source.id === owner.id) return "keep";
  return safeFixReason(source, owner).startsWith("schema-safe") ? "manual" : "safe";
}

function occurrenceFor(source: ProseSource, owner: ProseSource): HandbookDuplicateOccurrence {
  return {
    id: source.id,
    file: source.file,
    pointer: source.pointer,
    owner_ref: source.owner_ref,
    heading_path: source.heading_path,
    fix: fixKind(source, owner),
    fix_reason: safeFixReason(source, owner),
  };
}

function canonicalDocumentResources(system: YamlMap): YamlMap[] {
  const resources = Array.isArray(system.resources) ? system.resources : [];
  return resources.filter(
    (resource): resource is YamlMap =>
      isMap(resource) &&
      resource.kind === "document" &&
      resource.role === "canonical" &&
      typeof resource.location === "string",
  );
}

function pushSource(
  sources: ProseSource[],
  input: Omit<ProseSource, "id" | "normalized">,
): void {
  if (!input.text.trim()) return;
  const normalized = normalizeDuplicateText(input.text);
  sources.push({
    ...input,
    id: `${input.file}#${input.pointer}`,
    normalized,
  });
}

function collectDocumentValueSources(
  sources: ProseSource[],
  value: unknown,
  context: {
    file: string;
    pointerTokens: string[];
    headingPath: string[];
    resourceId: string;
    resourceRef: string;
  },
): void {
  const pointer = jsonPointer(context.pointerTokens);
  if (typeof value === "string") {
    pushSource(sources, {
      file: context.file,
      pointer,
      parent_pointer: pointer,
      text: value,
      heading_path: context.headingPath,
      owner_ref: ownerTargetRefForDocument(context.resourceRef, pointer),
      owner_rank: ownerRankForResource(context.resourceId),
      source_kind: "document",
      resource_ref: context.resourceRef,
      resource_id: context.resourceId,
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (!isMap(item)) return;
      collectDocumentMapSources(sources, item, {
        ...context,
        pointerTokens: [...context.pointerTokens, String(index)],
        headingPath: [...context.headingPath, `item-${index + 1}`],
      });
    });
    return;
  }
  if (isMap(value)) {
    collectDocumentMapSources(sources, value, context);
  }
}

function collectDocumentMapSources(
  sources: ProseSource[],
  value: YamlMap,
  context: {
    file: string;
    pointerTokens: string[];
    headingPath: string[];
    resourceId: string;
    resourceRef: string;
  },
): void {
  const pointer = jsonPointer(context.pointerTokens);
  if (typeof value.text === "string") {
    pushSource(sources, {
      file: context.file,
      pointer: jsonPointer([...context.pointerTokens, "text"]),
      parent_pointer: pointer,
      text: value.text,
      heading_path: context.headingPath,
      owner_ref: ownerTargetRefForDocument(context.resourceRef, pointer),
      owner_rank: ownerRankForResource(context.resourceId),
      source_kind: "document",
      resource_ref: context.resourceRef,
      resource_id: context.resourceId,
    });
  }
  if (isDiagramBlock(value) || isExampleBlock(value)) return;
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === "text" || childKey === "links" || METADATA_KEYS.has(childKey)) {
      continue;
    }
    collectDocumentValueSources(sources, childValue, {
      ...context,
      pointerTokens: [...context.pointerTokens, childKey],
      headingPath: [...context.headingPath, humanize(childKey)],
    });
  }
}

function collectRootRecordSources(
  sources: ProseSource[],
  records: unknown,
  recordType: "object" | "assertion" | "resource" | "memory",
  pointerKey: string,
  headingTitle: string,
): void {
  if (!Array.isArray(records)) return;
  records.forEach((record, index) => {
    if (!isMap(record) || typeof record.text !== "string") return;
    const id = typeof record.id === "string" ? record.id : `${recordType}-${index + 1}`;
    pushSource(sources, {
      file: ".loopship/system.yaml",
      pointer: jsonPointer([pointerKey, String(index), "text"]),
      parent_pointer: jsonPointer([pointerKey, String(index)]),
      text: record.text,
      heading_path: ["Loopship Handbook", headingTitle, id],
      owner_ref: `${recordType}:${id}`,
      owner_rank: 100,
      source_kind: "root",
      root_record_type: recordType,
      root_record_id: id,
    });
  });
}

function loadHandbookSources(repo?: string): HandbookSourceState {
  const repoRoot = resolveRepoRoot(repo);
  const system = parseYamlMap(
    readText(join(repoRoot, ".loopship", "system.yaml")),
    ".loopship/system.yaml",
  );
  const sources: ProseSource[] = [];
  if (typeof system.text === "string") {
    pushSource(sources, {
      file: ".loopship/system.yaml",
      pointer: "/text",
      parent_pointer: "",
      text: system.text,
      heading_path: ["Loopship Handbook", "Root System"],
      owner_ref: "root:system",
      owner_rank: 100,
      source_kind: "root",
    });
  }
  collectRootRecordSources(sources, system.objects, "object", "objects", "Objects");
  collectRootRecordSources(sources, system.assertions, "assertion", "assertions", "Assertions");
  collectRootRecordSources(sources, system.resources, "resource", "resources", "Resources");
  collectRootRecordSources(sources, system.memories, "memory", "memories", "Memories");

  const docs: LoadedDocument[] = [];
  for (const resource of canonicalDocumentResources(system)) {
    const location = String(resource.location);
    const fullPath = resolve(repoRoot, location);
    if (!existsSync(fullPath)) continue;
    const doc = parseYamlMap(readText(fullPath), location);
    const resourceId = String(resource.id ?? location);
    const resourceRef = `resource:${resourceId}`;
    const title =
      typeof doc.title === "string"
        ? doc.title
        : typeof resource.id === "string"
          ? humanize(resource.id)
          : humanize(location);
    docs.push({
      location,
      resource_id: resourceId,
      resource_ref: resourceRef,
      schema_ref: String(resource.schema_ref ?? ""),
      title,
      doc,
    });
    if (typeof doc.text === "string") {
      pushSource(sources, {
        file: location,
        pointer: "/text",
        parent_pointer: "",
        text: doc.text,
        heading_path: [title],
        owner_ref: resourceRef,
        owner_rank: ownerRankForResource(resourceId),
        source_kind: "document",
        resource_ref: resourceRef,
        resource_id: resourceId,
      });
    }
    for (const [key, value] of Object.entries(doc)) {
      if (DOC_SKIP_KEYS.has(key)) continue;
      collectDocumentValueSources(sources, value, {
        file: location,
        pointerTokens: [key],
        headingPath: [title, humanize(key)],
        resourceId,
        resourceRef,
      });
    }
  }
  return { repoRoot, system, docs, sources };
}

function chooseDuplicateOwner(sources: ProseSource[]): ProseSource {
  return sources.slice().sort((left, right) =>
    left.owner_rank - right.owner_rank ||
    left.file.localeCompare(right.file) ||
    left.pointer.localeCompare(right.pointer)
  )[0];
}

function duplicateReportFromSources(
  repoRoot: string,
  sources: ProseSource[],
  minChars: number,
): HandbookDuplicateReport {
  const byText = new Map<string, ProseSource[]>();
  for (const source of sources) {
    if (source.normalized.length < minChars) continue;
    const current = byText.get(source.normalized) ?? [];
    current.push(source);
    byText.set(source.normalized, current);
  }
  const duplicate_groups = [...byText.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([text, group]) => {
      const owner = chooseDuplicateOwner(group);
      const occurrences = group
        .slice()
        .sort(
          (left, right) =>
            left.file.localeCompare(right.file) ||
            left.pointer.localeCompare(right.pointer),
        )
        .map((source) => occurrenceFor(source, owner));
      return {
        hash: sourceHash(text),
        chars: text.length,
        count: group.length,
        sample: text,
        owner: occurrenceFor(owner, owner),
        occurrences,
      };
    })
    .sort((left, right) => right.chars - left.chars || left.hash.localeCompare(right.hash));
  return {
    repo: repoRoot,
    min_chars: minChars,
    duplicate_groups,
    duplicate_count: duplicate_groups.length,
  };
}

export function detectHandbookDuplicates(
  repo?: string,
  options: { minChars?: number } = {},
): HandbookDuplicateReport {
  const minChars = options.minChars ?? DEFAULT_DUPLICATE_MIN_CHARS;
  const state = loadHandbookSources(repo);
  return duplicateReportFromSources(state.repoRoot, state.sources, minChars);
}

function sourceById(sources: ProseSource[]): Map<string, ProseSource> {
  return new Map(sources.map((source) => [source.id, source]));
}

function applyRootAssertionDuplicateFix(
  state: HandbookSourceState,
  source: ProseSource,
  owner: ProseSource,
): string | null {
  if (
    source.source_kind !== "root" ||
    source.root_record_type !== "assertion" ||
    !owner.owner_ref.startsWith("resource:")
  ) {
    return null;
  }
  const record = pointerValue(state.system, source.parent_pointer);
  if (!isMap(record)) return null;
  record.text = [
    `This index assertion points to ${owner.owner_ref} as the canonical handbook wording`,
    "for the referenced rule.",
  ].join("\n");
  addUniqueLink(record, "supported_by", owner.owner_ref);
  return `${sourceLabel(source)} -> ${owner.owner_ref}`;
}

function applyAgentEvaluationDuplicateFix(
  state: HandbookSourceState,
  source: ProseSource,
  owner: ProseSource,
): string | null {
  if (
    source.file !== ".loopship/docs/agent/system-card.yaml" ||
    !/^\/evaluation\/[^/]+\/text$/.test(source.pointer) ||
    !owner.owner_ref.startsWith("resource:")
  ) {
    return null;
  }
  const doc = state.docs.find((item) => item.location === source.file);
  if (!doc) return null;
  const block = pointerValue(doc.doc, source.parent_pointer);
  if (!isMap(block)) return null;
  const sectionName = humanize(source.parent_pointer.split("/").at(-1) ?? "section");
  block.text = [
    `This evaluation uses ${owner.heading_path.join(" > ")} as the canonical handbook`,
    `source for ${sectionName}.`,
  ].join("\n");
  block.resource_ref = resourceRefBase(owner.owner_ref);
  addUniqueLink(block, "supported_by", owner.owner_ref);
  return `${sourceLabel(source)} -> ${owner.owner_ref}`;
}

function applySafeDuplicateFix(
  state: HandbookSourceState,
  source: ProseSource,
  owner: ProseSource,
): string | null {
  return (
    applyRootAssertionDuplicateFix(state, source, owner) ??
    applyAgentEvaluationDuplicateFix(state, source, owner)
  );
}

export function fixHandbookDuplicates(
  repo?: string,
  options: { minChars?: number } = {},
): HandbookDuplicateFixReport {
  const minChars = options.minChars ?? DEFAULT_DUPLICATE_MIN_CHARS;
  const state = loadHandbookSources(repo);
  const initialReport = duplicateReportFromSources(state.repoRoot, state.sources, minChars);
  const sources = sourceById(state.sources);
  const applied = new Set<string>();
  const applied_fixes: string[] = [];
  const skipped_fixes: string[] = [];

  for (const group of initialReport.duplicate_groups) {
    const owner = sources.get(group.owner.id);
    if (!owner) continue;
    for (const occurrence of group.occurrences) {
      if (occurrence.id === group.owner.id) continue;
      const source = sources.get(occurrence.id);
      if (!source) continue;
      const fix = applySafeDuplicateFix(state, source, owner);
      if (fix) {
        applied.add(source.file);
        applied_fixes.push(fix);
      } else {
        skipped_fixes.push(`${sourceLabel(source)} requires manual dedup to ${owner.owner_ref}`);
      }
    }
  }

  let signaturePath: string | undefined;
  if (applied.has(".loopship/system.yaml")) {
    writeText(join(state.repoRoot, ".loopship", "system.yaml"), renderSystemYaml(state.system));
  }
  for (const doc of state.docs) {
    if (!applied.has(doc.location)) continue;
    writeText(resolve(state.repoRoot, doc.location), renderSystemDocYaml(doc.doc));
  }
  if (applied.size) {
    signaturePath = writeSystemManifest(
      state.repoRoot,
      "handbook-duplicate-fix",
      "system_update",
    );
  }

  const finalReport = detectHandbookDuplicates(state.repoRoot, { minChars });
  return {
    ...finalReport,
    applied_fixes,
    skipped_fixes,
    ...(signaturePath ? { signature_path: signaturePath } : {}),
  };
}

export function renderDuplicateReport(report: HandbookDuplicateReport): string {
  const lines = [
    `handbook duplicates: prose_groups=${report.duplicate_count} min_chars=${report.min_chars}`,
  ];
  for (const group of report.duplicate_groups) {
    lines.push(`- ${group.count}x ${group.chars} chars hash=${group.hash}`);
    lines.push(`  owner: ${group.owner.owner_ref} (${group.owner.file}#${group.owner.pointer})`);
    for (const occurrence of group.occurrences) {
      lines.push(
        `  - ${occurrence.fix}: ${occurrence.file}#${occurrence.pointer} -> ${occurrence.owner_ref}`,
      );
    }
    lines.push(`  sample: ${group.sample}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderFixReport(report: HandbookDuplicateFixReport): string {
  const lines = [renderDuplicateReport(report).trimEnd()];
  if (report.applied_fixes.length) {
    lines.push("applied fixes:");
    for (const fix of report.applied_fixes) lines.push(`- ${fix}`);
  }
  if (report.skipped_fixes.length) {
    lines.push("skipped fixes:");
    for (const fix of report.skipped_fixes) lines.push(`- ${fix}`);
  }
  if (report.signature_path) lines.push(`signature: ${report.signature_path}`);
  return `${lines.join("\n")}\n`;
}
