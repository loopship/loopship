#!/usr/bin/env bun

import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument } from "yaml";
import { verifyRootManifest } from "./loopship_core.ts";
import { validateSchemaPath } from "./loopship_schema.ts";
import { readText } from "./loopship_utils.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_SYSTEM_PATH = resolve(PACKAGE_ROOT, ".loopship", "system.yaml");
const ROOT_SIGNATURE_PATH = resolve(PACKAGE_ROOT, ".loopship", "signature.yaml");
const SEMANTIC_RULES_PATH = resolve(PACKAGE_ROOT, "schemas", "semantic-rules.yaml");

type JsonRecord = Record<string, unknown>;
type RecordType = "object" | "assertion" | "resource" | "memory";
type TypedRef = {
  type: RecordType;
  id: string;
  fragment?: string;
};
type LinkEntry = TypedRef & {
  relation: string;
  ref: string;
};

const REF_PATTERN = /^(?:(object|assertion|memory):([a-z0-9][a-z0-9._-]*)|resource:([a-z0-9][a-z0-9._-]*)(#\/.*)?)$/;
const ALLOWED_LINK_RELATIONS = new Set([
  "about",
  "part_of",
  "uses",
  "constrains",
  "supported_by",
  "derives_from",
  "supersedes",
]);
const PLACEHOLDER_TEXT_PATTERN = /\b(TBD|TODO|No changes|Placeholder|To be filled|Same as title|See root|N\/A)\b/i;
const MULTILINE_PROSE_KEYS = new Set([
  "abstract",
  "text",
  "context",
  "collection",
  "decision",
  "deprecation_policy",
  "environment",
  "labeling",
  "maintenance",
  "rationale",
  "mitigation",
  "meaning",
  "mission",
  "motivation",
  "overview",
  "policy",
  "preprocessing",
  "purpose",
  "access",
  "description",
  "source",
  "solution_strategy",
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

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function readYamlObject(path: string): JsonRecord {
  const value = parseYaml(readText(path));
  const record = asRecord(value);
  if (!record) throw new Error(`YAML document must be an object: ${path}`);
  return record;
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function arrayOfRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((entry): entry is JsonRecord => Boolean(entry))
    : [];
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
}

function collectYamlFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectYamlFiles(absolutePath, relativePath));
    } else if (entry.isFile() && entry.name.endsWith(".yaml")) {
      files.push(relativePath);
    }
  }
  return files;
}

function parseTypedRef(ref: string): TypedRef | null {
  const match = REF_PATTERN.exec(ref);
  if (!match) return null;
  if (match[3]) {
    return {
      type: "resource",
      id: match[3],
      fragment: match[4],
    };
  }
  return {
    type: match[1] as TypedRef["type"],
    id: match[2],
  };
}

function addRecords(
  source: string,
  recordType: RecordType,
  rows: JsonRecord[],
  records: Map<string, JsonRecord>,
  errors: string[],
): void {
  for (const record of rows) {
    const id = stringValue(record.id);
    if (!id) {
      errors.push(`${source} record missing id`);
      continue;
    }
    if (records.has(id)) errors.push(`duplicate record id across loaded system docs: ${id}`);
    records.set(id, { ...record, _record_type: recordType });
  }
}

function schemaPathForResource(schemaRef: string, records: Map<string, JsonRecord>): string {
  if (schemaRef === "self") return "";
  if (schemaRef.startsWith("loopship://schemas/")) return schemaRef.slice("loopship://".length);
  return "";
}

function pointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveJsonPointerValue(value: unknown, fragment: string | undefined): boolean {
  if (!fragment) return true;
  if (!fragment.startsWith("#/")) return false;
  let cursor: unknown = value;
  for (const rawToken of fragment.slice(2).split("/")) {
    const token = pointerToken(rawToken);
    if (Array.isArray(cursor)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return false;
      cursor = cursor[index];
    } else if (cursor && typeof cursor === "object" && token in (cursor as JsonRecord)) {
      cursor = (cursor as JsonRecord)[token];
    } else {
      return false;
    }
  }
  return true;
}

function validateLinks(
  owner: string,
  linksValue: unknown,
  records: Map<string, JsonRecord>,
  canonicalDocsByResourceId: Map<string, JsonRecord>,
  errors: string[],
): LinkEntry[] {
  if (linksValue === undefined) return [];
  const links = asRecord(linksValue);
  if (!links) {
    errors.push(`${owner} links must be a relation-keyed map`);
    return [];
  }
  const entries: LinkEntry[] = [];
  for (const [relation, targets] of Object.entries(links)) {
    if (!ALLOWED_LINK_RELATIONS.has(relation)) {
      errors.push(`${owner} has unsupported link relation: ${relation}`);
      continue;
    }
    const refs = arrayOfStrings(targets);
    if (!refs.length) {
      errors.push(`${owner} link relation must have at least one target: ${relation}`);
      continue;
    }
    for (const ref of refs) {
      const parsed = parseTypedRef(ref);
      if (!parsed) {
        errors.push(`${owner} has malformed typed link ref: ${relation} -> ${ref}`);
        continue;
      }
      const target = records.get(parsed.id);
      if (!target) {
        errors.push(`${owner} link target is unresolved: ${relation} -> ${ref}`);
        continue;
      }
      if (stringValue(target._record_type) !== parsed.type) {
        errors.push(`${owner} link target type mismatch: ${relation} -> ${ref}`);
        continue;
      }
      if (parsed.fragment) {
        if (parsed.type !== "resource") {
          errors.push(`${owner} link fragments are only valid for resource refs: ${relation} -> ${ref}`);
          continue;
        }
        const doc = canonicalDocsByResourceId.get(parsed.id);
        if (!doc) {
          errors.push(`${owner} fragment target must be a loaded canonical document resource: ${relation} -> ${ref}`);
          continue;
        }
        if (!resolveJsonPointerValue(doc, parsed.fragment)) {
          errors.push(`${owner} resource fragment is unresolved: ${relation} -> ${ref}`);
          continue;
        }
      }
      if (relation === "supported_by") {
        if (parsed.type !== "resource") {
          errors.push(`${owner} supported_by target must be a resource ref: ${relation} -> ${ref}`);
        }
        if (target.role === "generated") {
          errors.push(`${owner} must not use generated resource as canonical support: ${relation} -> ${ref}`);
        }
      }
      if (relation === "part_of" && parsed.type !== "object") {
        errors.push(`${owner} part_of target must be an object ref: ${relation} -> ${ref}`);
      }
      entries.push({ relation, ref, ...parsed });
    }
  }
  return entries;
}

function requiredSlotsForKinds(kinds: string[], semanticRules: JsonRecord): Set<string> {
  const byKind = asRecord(semanticRules.required_document_schemas_by_system_kind) ?? {};
  const required = new Set<string>();
  for (const kind of kinds) {
    for (const schemaRef of arrayOfStrings(byKind[kind])) required.add(schemaRef);
  }
  return required;
}

function schemaKeyForSchemaRef(schemaRef: string): string {
  if (!schemaRef.startsWith("loopship://schemas/docs/")) return "";
  return schemaRef.slice("loopship://schemas/docs/".length).replace(/\.yaml$/, "");
}

function numberValue(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function getPolicyRecord(root: JsonRecord, path: string): JsonRecord | null {
  let cursor: unknown = root;
  for (const segment of path.split(".")) {
    const record = asRecord(cursor);
    if (!record) return null;
    cursor = record[segment];
  }
  return asRecord(cursor);
}

function findMapsByPathPattern(value: unknown, pattern: string): Array<{ path: string; value: JsonRecord }> {
  const segments = pattern.split(".");
  const rows: Array<{ path: string; value: JsonRecord }> = [];
  function walk(cursor: unknown, index: number, currentPath: string[]): void {
    if (index === segments.length) {
      const record = asRecord(cursor);
      if (record) rows.push({ path: currentPath.join("."), value: record });
      return;
    }
    const record = asRecord(cursor);
    if (!record) return;
    const segment = segments[index];
    if (segment === "*") {
      for (const [key, child] of Object.entries(record)) {
        walk(child, index + 1, [...currentPath, key]);
      }
      return;
    }
    walk(record[segment], index + 1, [...currentPath, segment]);
  }
  walk(value, 0, []);
  return rows;
}

function isAllowedKnownTerm(key: string, knownTerms: Set<string>): boolean {
  if (knownTerms.has(key)) return true;
  return key.split("-").every((segment) => knownTerms.has(segment));
}

function validateLocalKey(
  owner: string,
  key: string,
  parentPath: string,
  bannedKeys: Set<string>,
  bannedPatterns: RegExp[],
  knownTerms: Set<string>,
  errors: string[],
): void {
  const normalized = key.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
    errors.push(`${owner} local key must be kebab-case: ${parentPath}.${key}`);
  }
  if (bannedKeys.has(normalized)) {
    errors.push(`${owner} local key is banned as generic bloat: ${parentPath}.${key}`);
  }
  for (const pattern of bannedPatterns) {
    if (pattern.test(normalized)) {
      errors.push(`${owner} local key matches banned generic pattern: ${parentPath}.${key}`);
      break;
    }
  }
  const segments = normalized.split("-").filter(Boolean);
  if (segments.length < 2 && !isAllowedKnownTerm(normalized, knownTerms)) {
    errors.push(`${owner} local key must have at least two semantic segments or be allowlisted: ${parentPath}.${key}`);
  }
  const parentLeaf = parentPath.split(".").pop() ?? "";
  if (normalized === parentLeaf || normalized === parentLeaf.replace(/_/g, "-")) {
    errors.push(`${owner} local key must not merely repeat parent field: ${parentPath}.${key}`);
  }
}

function validateAnchorBudgets(
  owner: string,
  schemaKey: string,
  doc: JsonRecord,
  semanticRules: JsonRecord,
  errors: string[],
): void {
  const policy = getPolicyRecord(semanticRules, "local_key_policy");
  const budget = getPolicyRecord(semanticRules, `local_key_policy.doc_anchor_budgets.${schemaKey}`);
  if (!policy || !budget) return;
  const bannedKeys = new Set(arrayOfStrings(policy.banned_keys).map((key) => key.toLowerCase()));
  const bannedPatterns = arrayOfStrings(policy.banned_patterns).map((pattern) => new RegExp(pattern));
  const knownTerms = new Set(arrayOfStrings(policy.known_terms).map((key) => key.toLowerCase()));
  const maps = asRecord(budget.maps) ?? {};
  let totalLocalKeys = 0;
  for (const [mapPath, rawLimit] of Object.entries(maps)) {
    const limit = numberValue(rawLimit);
    if (limit === null) {
      errors.push(`${owner} local-key budget for ${mapPath} must be numeric`);
      continue;
    }
    for (const row of findMapsByPathPattern(doc, mapPath)) {
      const keys = Object.keys(row.value);
      totalLocalKeys += keys.length;
      if (keys.length > limit) {
        errors.push(`${owner} local-key map exceeds budget: ${row.path} has ${keys.length}, max ${limit}`);
      }
      for (const key of keys) {
        validateLocalKey(owner, key, row.path, bannedKeys, bannedPatterns, knownTerms, errors);
      }
    }
  }
  const maxTotal = numberValue(budget.max_total_local_keys);
  if (maxTotal !== null && totalLocalKeys > maxTotal) {
    errors.push(`${owner} total local-key budget exceeded: ${totalLocalKeys}, max ${maxTotal}`);
  }
}

function collectDocLinks(value: unknown, owner = "document"): Array<{ owner: string; links: unknown }> {
  const rows: Array<{ owner: string; links: unknown }> = [];
  function collect(item: unknown, path: string): void {
    if (Array.isArray(item)) {
      item.forEach((child, index) => collect(child, `${path}[${index}]`));
      return;
    }
    const record = asRecord(item);
    if (!record) return;
    if ("links" in record) rows.push({ owner: path, links: record.links });
    for (const [key, childValue] of Object.entries(record)) {
      if (key === "links") continue;
      collect(childValue, `${path}.${key}`);
    }
  }
  collect(value, owner);
  return rows;
}

function containsOldIdTextArray(value: unknown): boolean {
  if (Array.isArray(value)) {
    if (
      value.some((item) => {
        const record = asRecord(item);
        return Boolean(record && "id" in record && "text" in record);
      })
    ) {
      return true;
    }
    return value.some(containsOldIdTextArray);
  }
  const record = asRecord(value);
  if (!record) return false;
  return Object.values(record).some(containsOldIdTextArray);
}

function collectMeaningfulStrings(value: unknown, key = ""): string[] {
  if (typeof value === "string") {
    return ["id", "state"].includes(key) ? [] : [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => collectMeaningfulStrings(item));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as JsonRecord).flatMap(([childKey, childValue]) =>
    collectMeaningfulStrings(childValue, childKey),
  );
}

function scalarTypeName(node: unknown): string {
  return String((node as { type?: unknown } | null)?.type ?? "");
}

function validateBlockProseScalar(path: string, owner: string, node: unknown, errors: string[]): void {
  if (!isScalar(node) || typeof node.value !== "string") {
    errors.push(`${path} ${owner} must be a YAML block scalar`);
    return;
  }
  const type = scalarTypeName(node);
  if (!type.startsWith("BLOCK_")) {
    errors.push(`${path} ${owner} must use multiline YAML block scalar syntax`);
  }
  if (!node.value.includes("\n")) {
    errors.push(`${path} ${owner} must contain multiline prose`);
  }
}

function validateYamlProseStyle(path: string, errors: string[]): void {
  const doc = parseDocument(readText(path), { keepSourceTokens: true });
  function walk(node: unknown, key = "", owner = ""): void {
    if (MULTILINE_PROSE_KEYS.has(key) && isScalar(node)) {
      validateBlockProseScalar(path, owner || key, node, errors);
    }
    if (MULTILINE_PROSE_MAP_KEYS.has(key) && isMap(node)) {
      for (const pair of node.items) {
        const childKey = isScalar(pair.key) ? String(pair.key.value ?? "") : "";
        if (NON_PROSE_METADATA_KEYS.has(childKey)) continue;
        if (isScalar(pair.value) && typeof pair.value.value === "string") {
          validateBlockProseScalar(path, `${owner || key}.${childKey}`, pair.value, errors);
        }
      }
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        const childKey = isScalar(pair.key) ? String(pair.key.value ?? "") : "";
        const childOwner = owner ? `${owner}.${childKey}` : childKey;
        walk(pair.value, childKey, childOwner);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, index) => walk(item, "", `${owner}[${index}]`));
    }
  }
  walk(doc.contents);
}

function validateDocText(
  path: string,
  doc: JsonRecord,
  errors: string[],
): void {
  for (const banned of ["sections", "objects", "assertions", "resources", "memories", "slots"]) {
    if (banned in doc) errors.push(`${path} must not contain shell field: ${banned}`);
  }
  if (PLACEHOLDER_TEXT_PATTERN.test(stringValue(doc.text))) {
    errors.push(`${path} contains placeholder document text`);
  }
  if (containsOldIdTextArray(doc)) {
    errors.push(`${path} must not use old id/text array sections in concrete industry docs`);
  }
  const totalText = collectMeaningfulStrings(doc)
    .join("\n")
    .trim().length;
  if (totalText < 160) {
    errors.push(`${path} text is too thin for a canonical system doc`);
  }
  for (const text of collectMeaningfulStrings(doc)) {
    if (PLACEHOLDER_TEXT_PATTERN.test(text)) {
      errors.push(`${path} contains placeholder prose`);
      break;
    }
  }
  if (asRecord(doc.decisions)) {
    for (const [decisionId, decision] of Object.entries(asRecord(doc.decisions) ?? {})) {
      const record = asRecord(decision);
      if (!record) continue;
      const context = stringValue(record.context).toLowerCase();
      const chosen = stringValue(record.decision).toLowerCase();
      if (context && context === chosen) {
        errors.push(`${path} decision ${decisionId} context must not equal decision`);
      }
    }
  }
}

function main(): number {
  const errors: string[] = [];
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
  for (const legacyPath of legacyPaths) {
    if (existsSync(resolve(PACKAGE_ROOT, legacyPath))) {
      errors.push(`legacy durable path must not exist after hard cut: ${legacyPath}`);
    }
  }

  const root = readYamlObject(ROOT_SYSTEM_PATH);
  validateYamlProseStyle(ROOT_SYSTEM_PATH, errors);
  const semanticRules = readYamlObject(SEMANTIC_RULES_PATH);
  const rootSchemaErrors = validateSchemaPath(root, "schemas/system.yaml");
  if (rootSchemaErrors.length) {
    errors.push(`root system schema validation failed: ${rootSchemaErrors.join("; ")}`);
  }
  for (const oldField of [
    "status",
    "summary",
    "purpose",
    "write_policy",
    "generated_policy",
    "manifest_ref",
    "memory_policy",
    "relations",
    "records",
    "slots",
  ]) {
    if (oldField in root) errors.push(`.loopship/system.yaml must not contain root field: ${oldField}`);
  }

  const signature = readYamlObject(ROOT_SIGNATURE_PATH);
  const signatureSchemaErrors = validateSchemaPath(signature, "schemas/signature.yaml");
  if (signatureSchemaErrors.length) {
    errors.push(`root signature schema validation failed: ${signatureSchemaErrors.join("; ")}`);
  }

  const manifestCheck = verifyRootManifest(PACKAGE_ROOT);
  if (!manifestCheck.ok) errors.push(...manifestCheck.errors);

  if (arrayOfStrings(root.kinds)[0] !== "software") {
    errors.push("Loopship primary kind must be kinds[0]=software");
  }

  const records = new Map<string, JsonRecord>();
  addRecords("root objects", "object", arrayOfRecords(root.objects), records, errors);
  addRecords("root assertions", "assertion", arrayOfRecords(root.assertions), records, errors);
  addRecords("root resources", "resource", arrayOfRecords(root.resources), records, errors);
  addRecords("root memories", "memory", arrayOfRecords(root.memories), records, errors);
  const canonicalDocsByResourceId = new Map<string, JsonRecord>();

  const rootResources = arrayOfRecords(root.resources);
  const canonicalDocs = rootResources
    .filter((record) => record.kind === "document" && record.role === "canonical")
    .filter((record) => stringValue(record.location));
  const canonicalDocLocations = new Set(canonicalDocs.map((record) => stringValue(record.location)));

  for (const relativeDoc of collectYamlFiles(resolve(PACKAGE_ROOT, ".loopship", "docs"))) {
    const location = `.loopship/docs/${relativeDoc}`;
    if (!canonicalDocLocations.has(location)) {
      errors.push(`canonical docs file has no root resource: ${location}`);
    }
  }

  const requiredSchemas = requiredSlotsForKinds(arrayOfStrings(root.kinds), semanticRules);
  const providedSchemas = new Set<string>();
  for (const resource of canonicalDocs) {
    providedSchemas.add(stringValue(resource.schema_ref));
  }
  for (const schemaRef of requiredSchemas) {
    if (!providedSchemas.has(schemaRef)) {
      errors.push(`missing canonical document schema for system kinds: ${schemaRef}`);
    }
  }

  for (const resource of canonicalDocs) {
    const path = stringValue(resource.location);
    const fullPath = resolve(PACKAGE_ROOT, path);
    if (!existsSync(fullPath)) {
      errors.push(`missing canonical resource file: ${path}`);
      continue;
    }
    validateYamlProseStyle(fullPath, errors);
    const doc = readYamlObject(fullPath);
    const schemaRef = stringValue(resource.schema_ref);
    const schemaPath = schemaPathForResource(schemaRef, records);
    if (!schemaPath) {
      errors.push(`canonical document resource must resolve schema: ${path}`);
    } else {
      const schemaErrors = validateSchemaPath(doc, schemaPath);
      if (schemaErrors.length) {
        errors.push(`schema validation failed for ${path}: ${schemaErrors.join("; ")}`);
      }
    }
    const docId = stringValue(doc.id);
    if (!docId) errors.push(`${path} document missing id`);
    if (schemaRef === "loopship://schemas/system-pack.yaml") {
      addRecords(path, "object", arrayOfRecords(doc.objects), records, errors);
      addRecords(path, "assertion", arrayOfRecords(doc.assertions), records, errors);
      addRecords(path, "resource", arrayOfRecords(doc.resources), records, errors);
      addRecords(path, "memory", arrayOfRecords(doc.memories), records, errors);
    } else {
      canonicalDocsByResourceId.set(stringValue(resource.id), doc);
      validateDocText(path, doc, errors);
      validateAnchorBudgets(path, schemaKeyForSchemaRef(schemaRef), doc, semanticRules, errors);
    }
  }

  for (const [id, record] of records) {
    const kind = stringValue(record.kind);
    const recordType = stringValue(record._record_type);
    const links = validateLinks(`record ${id}`, record.links, records, canonicalDocsByResourceId, errors);

    if (recordType === "resource") {
      const schemaRef = stringValue(record.schema_ref);
      if (!schemaRef) {
        errors.push(`resource ${id} requires schema_ref`);
      } else if (schemaRef === "self") {
        if (kind !== "schema") errors.push(`resource ${id} can use schema self only when kind=schema`);
      } else {
        const schemaPath = schemaPathForResource(schemaRef, records);
        if (!schemaPath) {
          errors.push(`resource ${id} schema_ref must point to a loopship schema URI: ${schemaRef}`);
        } else if (!existsSync(resolve(PACKAGE_ROOT, schemaPath))) {
          errors.push(`resource ${id} unresolved schema_ref: ${schemaRef}`);
        }
      }
      const location = stringValue(record.location);
      if (location.startsWith("references/archive/")) {
        errors.push(`resource ${id} must not reference archived Markdown as live guidance: ${location}`);
      }
      if (record.role === "canonical" && location.startsWith("docs/generated")) {
        errors.push(`canonical resource ${id} must not point to generated docs: ${location}`);
      }
      if (record.role === "canonical" && location && !location.startsWith("http") && !existsSync(resolve(PACKAGE_ROOT, location))) {
        errors.push(`canonical resource ${id} references missing local file: ${location}`);
      }
    }

    if (recordType === "assertion") {
      const state = stringValue(record.state) || "active";
      if (state === "active" && record.level === "must" && !["assumption", "limitation"].includes(kind)) {
        const hasSupport = links.some((link) => link.relation === "supported_by");
        if (!hasSupport) errors.push(`active must assertion ${id} requires a supported_by resource link`);
      }
      if (kind === "behaviour" && /rationale|alternative/i.test(stringValue(record.text))) {
        errors.push(`behaviour assertion ${id} must not act as decision history`);
      }
    }

    if (recordType === "memory" && /\bmust\b/i.test(stringValue(record.text))) {
      errors.push(`memory ${id} appears binding; promote it to an assertion`);
    }
  }

  for (const resource of canonicalDocs) {
    const path = stringValue(resource.location);
    const fullPath = resolve(PACKAGE_ROOT, path);
    if (!existsSync(fullPath)) continue;
    const doc = readYamlObject(fullPath);
    for (const entry of collectDocLinks(doc, `document ${path}`)) {
      validateLinks(entry.owner, entry.links, records, canonicalDocsByResourceId, errors);
    }
  }

  const docsDir = resolve(PACKAGE_ROOT, ".loopship", "docs");
  if (existsSync(docsDir)) {
    for (const entry of readdirSync(docsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!["software", "workflow", "agent", "decisions", "knowledge", "data", "model", "organization", "artifacts", "packs"].includes(entry.name)) {
        errors.push(`unexpected durable docs directory: .loopship/docs/${entry.name}`);
      }
    }
  }

  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
  console.log("system model verified");
  return 0;
}

process.exit(main());
