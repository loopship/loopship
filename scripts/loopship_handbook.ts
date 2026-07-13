#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_DUPLICATE_MIN_CHARS,
  detectHandbookDuplicates,
  fixHandbookDuplicates,
  renderDuplicateReport,
  renderFixReport,
} from "./loopship_handbook_duplicates.ts";
import { hashText, readText, writeText } from "./loopship_utils.ts";

export {
  detectHandbookDuplicates,
  fixHandbookDuplicates,
} from "./loopship_handbook_duplicates.ts";

type YamlMap = Record<string, unknown>;

export type HandbookWriteResult = {
  path: string;
  file_url: string;
  markdown: string;
};

const ROOT_SKIP_KEYS = new Set(["schema_version", "id", "title", "kinds", "text"]);
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

function handbookPath(repoRoot: string): string {
  return join(
    tmpdir(),
    "loopship",
    "handbooks",
    hashText(resolve(repoRoot)).slice(0, 16),
    "handbook.md",
  );
}

function heading(level: number, text: string): string {
  return `${"#".repeat(Math.max(1, Math.min(level, 6)))} ${text}`;
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inlineValue(value: unknown): string {
  if (typeof value === "string") {
    const shouldCode =
      /^(object|assertion|resource|memory):/.test(value) ||
      /^[a-z]+:\/\//.test(value) ||
      /^\.?[A-Za-z0-9._-]+[\\/][A-Za-z0-9._/-]+$/.test(value);
    return shouldCode
      ? `\`${value}\``
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function pushProse(lines: string[], value: unknown): void {
  if (typeof value !== "string" || !value.trim()) return;
  lines.push(value.trim(), "");
}

function pushLinks(lines: string[], links: unknown): void {
  if (!isMap(links)) return;
  const entries = Object.entries(links);
  if (!entries.length) return;
  lines.push("**Links**");
  for (const [relation, targets] of entries) {
    const values = Array.isArray(targets) ? targets : [targets];
    lines.push(
      `- **${humanize(relation)}:** ${values.map(inlineValue).join(", ")}`,
    );
  }
  lines.push("");
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

function renderDiagram(
  lines: string[],
  key: string,
  value: YamlMap,
  level: number,
): void {
  lines.push(heading(level, humanize(key)), "");
  if (typeof value.text === "string") pushProse(lines, value.text);
  lines.push(`**Kind:** ${inlineValue(value.kind)}`);
  lines.push(`**Syntax:** ${inlineValue(value.syntax)}`, "");
  lines.push(`\`\`\`${value.syntax}`);
  lines.push(String(value.source).trimEnd());
  lines.push("```", "");
  if (typeof value.rendered_ref === "string") {
    lines.push(`**Rendered Ref:** ${inlineValue(value.rendered_ref)}`, "");
  }
}

function renderExample(
  lines: string[],
  key: string,
  value: YamlMap,
  level: number,
): void {
  lines.push(heading(level, humanize(key)), "");
  if (typeof value.text === "string") pushProse(lines, value.text);
  lines.push(`**Language:** ${inlineValue(value.language)}`, "");
  lines.push(`\`\`\`${value.language}`);
  lines.push(String(value.source).trimEnd());
  lines.push("```", "");
}

function renderArray(
  lines: string[],
  key: string,
  value: unknown[],
  level: number,
): void {
  lines.push(heading(level, humanize(key)), "");
  if (value.every((item) => typeof item !== "object" || item === null)) {
    for (const item of value) lines.push(`- ${inlineValue(item)}`);
    lines.push("");
    return;
  }
  value.forEach((item, index) => {
    if (isMap(item)) {
      renderMap(lines, `item-${index + 1}`, item, level + 1);
    } else {
      lines.push(`- ${inlineValue(item)}`);
    }
  });
  lines.push("");
}

function renderMap(
  lines: string[],
  key: string,
  value: YamlMap,
  level: number,
): void {
  if (isDiagramBlock(value)) {
    renderDiagram(lines, key, value, level);
    return;
  }
  if (isExampleBlock(value)) {
    renderExample(lines, key, value, level);
    return;
  }

  lines.push(heading(level, humanize(key)), "");
  if (typeof value.text === "string") pushProse(lines, value.text);
  if (isMap(value.links)) pushLinks(lines, value.links);

  const metadata = Object.entries(value).filter(
    ([childKey]) =>
      childKey !== "text" && childKey !== "links" && METADATA_KEYS.has(childKey),
  );
  for (const [childKey, childValue] of metadata) {
    lines.push(`**${humanize(childKey)}:** ${inlineValue(childValue)}`);
  }
  if (metadata.length) lines.push("");

  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === "text" || childKey === "links" || METADATA_KEYS.has(childKey)) {
      continue;
    }
    renderValue(lines, childKey, childValue, level + 1);
  }
}

function renderValue(
  lines: string[],
  key: string,
  value: unknown,
  level: number,
): void {
  if (typeof value === "string") {
    lines.push(heading(level, humanize(key)), "");
    pushProse(lines, value);
    return;
  }
  if (Array.isArray(value)) {
    renderArray(lines, key, value, level);
    return;
  }
  if (isMap(value)) {
    renderMap(lines, key, value, level);
    return;
  }
  lines.push(heading(level, humanize(key)), "", inlineValue(value), "");
}

function renderRecords(
  lines: string[],
  title: string,
  records: unknown,
  level: number,
): void {
  if (!Array.isArray(records) || records.length === 0) return;
  lines.push(heading(level, title), "");
  for (const record of records) {
    if (!isMap(record)) continue;
    const id = typeof record.id === "string" ? record.id : "record";
    lines.push(heading(level + 1, id), "");
    if (typeof record.kind === "string") lines.push(`**Kind:** ${record.kind}`);
    if (typeof record.level === "string") lines.push(`**Level:** ${record.level}`);
    if (typeof record.role === "string") lines.push(`**Role:** ${record.role}`);
    if (typeof record.location === "string") {
      lines.push(`**Location:** \`${record.location}\``);
    }
    if (typeof record.schema_ref === "string") {
      lines.push(`**Schema Ref:** \`${record.schema_ref}\``);
    }
    lines.push("");
    pushProse(lines, record.text);
    pushLinks(lines, record.links);
  }
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

function renderSystemRoot(lines: string[], system: YamlMap): void {
  lines.push("# Loopship Handbook", "");
  lines.push(
    "Generated from canonical Loopship YAML. Do not edit this Markdown manually.",
    "",
  );
  lines.push(heading(2, "Root System"), "");
  pushProse(lines, system.text);

  const identity = [
    ["Schema Version", system.schema_version],
    ["ID", system.id],
    ["Title", system.title],
    ["Kinds", Array.isArray(system.kinds) ? system.kinds.join(", ") : ""],
  ];
  lines.push("| Field | Value |", "| --- | --- |");
  for (const [key, value] of identity) {
    lines.push(`| ${key} | ${inlineValue(value)} |`);
  }
  lines.push("");

  for (const [key, value] of Object.entries(system)) {
    if (ROOT_SKIP_KEYS.has(key)) continue;
    if (["objects", "assertions", "resources", "memories"].includes(key)) continue;
    renderValue(lines, key, value, 2);
  }
  renderRecords(lines, "Objects", system.objects, 2);
  renderRecords(lines, "Assertions", system.assertions, 2);
  renderRecords(lines, "Resources", system.resources, 2);
  renderRecords(lines, "Memories", system.memories, 2);
}

function renderDocument(
  lines: string[],
  repoRoot: string,
  resource: YamlMap,
): void {
  const location = String(resource.location);
  const path = resolve(repoRoot, location);
  if (!existsSync(path)) {
    lines.push(`# ${humanize(String(resource.id ?? location))}`, "");
    lines.push(`Missing canonical resource: \`${location}\``, "");
    return;
  }
  const doc = parseYamlMap(readText(path), location);
  const title =
    typeof doc.title === "string"
      ? doc.title
      : typeof resource.id === "string"
        ? humanize(resource.id)
        : humanize(location);
  lines.push(`# ${title}`, "");
  lines.push(`**Source:** \`${location}\``);
  if (typeof resource.schema_ref === "string") {
    lines.push(`**Schema Ref:** \`${resource.schema_ref}\``);
  }
  lines.push("");
  pushProse(lines, doc.text);
  pushLinks(lines, doc.links);
  for (const [key, value] of Object.entries(doc)) {
    if (DOC_SKIP_KEYS.has(key)) continue;
    renderValue(lines, key, value, 2);
  }
}

function renderSourceManifest(lines: string[], repoRoot: string, system: YamlMap): void {
  lines.push("# Source Manifest", "");
  lines.push(`- Root: \`.loopship/system.yaml\``);
  lines.push(`- Signature: \`.loopship/signature.yaml\``);
  for (const resource of canonicalDocumentResources(system)) {
    lines.push(`- Canonical document: \`${String(resource.location)}\``);
  }
  const signaturePath = join(repoRoot, ".loopship", "signature.yaml");
  if (existsSync(signaturePath)) {
    const signature = parseYamlMap(readText(signaturePath), ".loopship/signature.yaml");
    const root = isMap(signature.root) ? signature.root : {};
    if (typeof root.digest === "string") {
      lines.push(`- Root digest: \`${root.digest}\``);
    }
    if (typeof signature.receipt_head === "string") {
      lines.push(`- Receipt head: \`${signature.receipt_head}\``);
    }
  }
  lines.push("");
}

export function renderLoopshipHandbook(repo?: string): string {
  const repoRoot = resolveRepoRoot(repo);
  const system = parseYamlMap(
    readText(join(repoRoot, ".loopship", "system.yaml")),
    ".loopship/system.yaml",
  );
  const lines: string[] = [];
  renderSystemRoot(lines, system);
  for (const resource of canonicalDocumentResources(system)) {
    renderDocument(lines, repoRoot, resource);
  }
  renderSourceManifest(lines, repoRoot, system);
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export function writeLoopshipHandbook(repo?: string): HandbookWriteResult {
  const repoRoot = resolveRepoRoot(repo);
  const markdown = renderLoopshipHandbook(repoRoot);
  const path = handbookPath(repoRoot);
  writeText(path, markdown);
  return {
    path,
    file_url: pathToFileURL(path).href,
    markdown,
  };
}

export function runHandbook(argv: string[]): number {
  let repo = "";
  let raw = false;
  let duplicates = false;
  let fixDuplicates = false;
  let json = false;
  let failOnDuplicates = false;
  let minChars = DEFAULT_DUPLICATE_MIN_CHARS;
  const requiredValue = (index: number, option: string): string => {
    const value = argv[index];
    if (!value || value.startsWith("-")) throw new Error(`${option} requires a value`);
    return value;
  };
  const inlineValue = (token: string, option: string): string => {
    const value = token.slice(`${option}=`.length);
    if (!value) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--repo") {
      repo = requiredValue(++i, "--repo");
      continue;
    }
    if (token?.startsWith("--repo=")) {
      repo = inlineValue(token, "--repo");
      continue;
    }
    if (token === "--raw") {
      raw = true;
      continue;
    }
    if (token === "--duplicates") {
      duplicates = true;
      continue;
    }
    if (token === "--fix-duplicates") {
      fixDuplicates = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--fail-on-duplicates") {
      failOnDuplicates = true;
      continue;
    }
    if (token === "--min-chars") {
      minChars = Number(requiredValue(++i, "--min-chars"));
      if (!Number.isInteger(minChars) || minChars < 1) {
        throw new Error("--min-chars must be a positive integer");
      }
      continue;
    }
    if (token?.startsWith("--min-chars=")) {
      minChars = Number(inlineValue(token, "--min-chars"));
      if (!Number.isInteger(minChars) || minChars < 1) {
        throw new Error("--min-chars must be a positive integer");
      }
      continue;
    }
    throw new Error(`unknown handbook argument: ${token}`);
  }
  if (fixDuplicates) {
    const report = fixHandbookDuplicates(repo, { minChars });
    process.stdout.write(
      json ? `${JSON.stringify(report, null, 2)}\n` : renderFixReport(report),
    );
    return failOnDuplicates && report.duplicate_count > 0 ? 2 : 0;
  }
  if (duplicates) {
    const report = detectHandbookDuplicates(repo, { minChars });
    process.stdout.write(
      json ? `${JSON.stringify(report, null, 2)}\n` : renderDuplicateReport(report),
    );
    return failOnDuplicates && report.duplicate_count > 0 ? 2 : 0;
  }
  if (raw) {
    process.stdout.write(renderLoopshipHandbook(repo));
    return 0;
  }
  const result = writeLoopshipHandbook(repo);
  process.stdout.write(`handbook: ${result.file_url}\n`);
  return 0;
}
