#!/usr/bin/env bun

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

export const LOOPO_DIR = ".loopo";
export const LOOPO_QUESTS_DIR = join(LOOPO_DIR, "quests");
export const LOOPO_ARCHIEVE_DIR = join(LOOPO_DIR, "archieve");
export const LOOPO_STATE_FILE = join(LOOPO_DIR, "state.json");
export const LOOPO_SYSTEM_FILE = join(LOOPO_DIR, "system.yaml");
export const LOOPO_DOCS_DIR = join(LOOPO_DIR, "docs");
export const LOOPO_ROOT_MANIFEST_FILE = join(LOOPO_DIR, "manifest.sign.json");
export const LOOPO_SYSTEM_BEHAVIOURS_FILE = join(
  LOOPO_DOCS_DIR,
  "system-behaviours.yaml",
);
export const LOOPO_HOOK_STATE_FILE = join(LOOPO_DIR, "hook-state.json");
export const LOOPO_HOOK_EVENT_FILE = join(LOOPO_DIR, "hook-events.jsonl");
export const LOOPO_BIN_FILE = join(LOOPO_DIR, "bin", "loopo");
export const LOOPO_GLOBAL_BIN_ENV = "LOOPO_GLOBAL_BIN";
export const LOOPO_SCRIPT_ENV = "LOOPO_SCRIPT";
export const STORAGE_VERSION = 1;
export const CANONICAL_QUEST_RE =
  /(?:^|[\\/])\.loopo[\\/]quests[\\/][^\\/]+[\\/]tasks\.yaml$/i;
const STALL_STATUSES = new Set(["blocked", "deferred", "failed"]);

type QuestRegistryItem = {
  slug: string;
  tasks_path: string;
  evidence_path: string;
  handoffs_path: string;
  branch_ref?: string | null;
  worktree_path?: string | null;
  managed_hashes: Record<string, string>;
  updated_at: string;
};

export type LoopoReceipt = {
  receipt_id: string;
  request_id: string;
  quest_slug: string | null;
  timestamp: string;
  mutated_files: string[];
  managed_hashes: Record<string, string>;
};

export type LoopoState = {
  storage_version: number;
  active_quest_slug: string | null;
  quests: Record<string, QuestRegistryItem>;
  receipts: LoopoReceipt[];
};

export type QuestFiles = {
  slug: string;
  dir: string;
  tasks: string;
  plan: string;
  manifest: string;
  children_dir: string;
  questions: string;
  plans: string;
  evidence: string;
  validation: string;
  review: string;
  handoffs: string;
  hook_events: string;
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
  child_slug: string;
  concurrency_group: string;
  merge_target: string;
  merge_lease_id: string;
  merge_commit: string;
  system_impact_ref: string;
  acceptance: string;
  blocker?: string;
};

export type QuestState = {
  schema_version: 3;
  slug: string;
  quest_id: string;
  flow_id: string;
  flow_version: number;
  stage: string;
  prompt: string;
  context_root: string;
  resolution_source: string;
  coordinator_branch: string;
  coordinator_worktree: string;
  parent_quest_slug: string;
  landing_target_branch: string;
  landing_target_worktree: string;
  landed_commit: string;
  landing_strategy: string;
  assumptions: string[];
  constraints: string[];
  tasks: QuestTask[];
};

export type QuestWorkspace = {
  branch_ref: string;
  worktree_path: string;
  mode: "git" | "directory";
};

export type QuestArchiveResult = {
  archived_slug: string | null;
  archived_path: string | null;
};

export type StrayIterationReport = {
  has_stray: boolean;
  task_block_count: number;
  evidence_block_count: number;
  total_block_count: number;
  task_blocks: string[];
  evidence_blocks: string[];
};

type EvidenceStatusSource = "transition" | "import";

export type EvidenceTaskStatus = {
  status: string;
  source: EvidenceStatusSource;
  line: number;
  raw: string;
};

export type HandoffCanonicalization = {
  text: string;
  changed: boolean;
  reordered: boolean;
  deduped: boolean;
  latest_iteration_id: string | null;
  latest_stop_reason: string | null;
};

export type TaskEvidenceMismatch = {
  task_id: string;
  task_status: string;
  evidence_status: string;
  evidence_source: EvidenceStatusSource;
};

export type QuestCoherencyScan = {
  mismatches: TaskEvidenceMismatch[];
  handoff_done_candidates: string[];
  handoff_non_monotonic: boolean;
  latest_iteration_id: string | null;
  latest_stop_reason: string | null;
  task_fallback: "unknown" | "all_done" | "all_stalled" | "continue";
  terminal_mismatch: boolean;
  stray: StrayIterationReport;
};

export type QuestCoherencyRepair = {
  touched_files: string[];
  stray_blocks_moved: number;
  handoff_reordered: boolean;
  handoff_deduped: boolean;
  task_updates: Record<string, { from: string; to: string }>;
  evidence_reconciliations: Record<string, string[]>;
  latest_iteration_id: string | null;
  latest_stop_reason: string | null;
};

function compactLines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function extractSection(text: string, heading: string): string {
  const lines = compactLines(text).split("\n");
  const headingRe = new RegExp(
    `^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
    "i",
  );
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headingRe.test(lines[i].trim())) {
      start = i;
      break;
    }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

export function parseHandoffBlocksAnywhere(text: string): string[] {
  const lines = compactLines(text).split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^###\s*iteration\s*=/.test(lines[i].trim())) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (
        /^###\s*iteration\s*=/.test(lines[j].trim()) ||
        /^##\s+/.test(lines[j].trim())
      ) {
        end = j;
        break;
      }
    }
    const block = lines.slice(i, end).join("\n").trim();
    if (block) blocks.push(block);
    i = end - 1;
  }
  return blocks;
}

type ExtractBlocksResult = {
  blocks: string[];
  cleaned_text: string;
};

function collapseBlankLines(text: string): string {
  const compact = compactLines(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return compact ? `${compact}\n` : "";
}

function stripHandoffHeadings(text: string): string {
  const lines = compactLines(text).split("\n");
  const kept = lines.filter(
    (line) => !/^\s*#{1,3}\s*iteration\s+handoffs\b/i.test(line.trim()),
  );
  return collapseBlankLines(kept.join("\n"));
}

export function extractIterationBlocksAndClean(
  text: string,
): ExtractBlocksResult {
  const lines = compactLines(text).split("\n");
  const blocks: string[] = [];
  const ranges: Array<[number, number]> = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!/^###\s*iteration\s*=/.test(lines[i].trim())) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (
        /^###\s*iteration\s*=/.test(lines[j].trim()) ||
        /^##\s+/.test(lines[j].trim())
      ) {
        end = j;
        break;
      }
    }
    const block = lines.slice(i, end).join("\n").trim();
    if (block) blocks.push(block);
    ranges.push([i, end]);
    i = end - 1;
  }

  if (!ranges.length) {
    return {
      blocks,
      cleaned_text: collapseBlankLines(text),
    };
  }

  const drop = new Set<number>();
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i += 1) drop.add(i);
  }
  const kept = lines.filter((_, idx) => !drop.has(idx));
  const stripped = stripHandoffHeadings(kept.join("\n"));
  return {
    blocks,
    cleaned_text: collapseBlankLines(stripped),
  };
}

function blockFingerprint(block: string): string {
  return compactLines(block)
    .trim()
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n");
}

function parseBracketList(value: string): string[] {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "[]") return [];
  const wrapped = trimmed.match(/^\[(.*)\]$/);
  const source = wrapped ? wrapped[1] : trimmed;
  if (!source.trim()) return [];
  return source
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIterationId(value: string): number {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : Number.MIN_SAFE_INTEGER;
}

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

export function taskAssignmentBranchRef(slug: string, taskId: string): string {
  return `${slug}-${normalizeTaskPathSegment(taskId)}`;
}

export function taskAssignmentWorktreePath(
  repoRoot: string,
  slug: string,
  taskId: string,
): string {
  return resolve(repoRoot, "worktrees", taskAssignmentBranchRef(slug, taskId));
}

function evaluateTaskFallback(
  statuses: string[],
): "unknown" | "all_done" | "all_stalled" | "continue" {
  if (!statuses.length) return "unknown";
  if (statuses.every((status) => status === "done")) return "all_done";
  if (statuses.every((status) => STALL_STATUSES.has(status)))
    return "all_stalled";
  return "continue";
}

function parseTaskTable(tasksText: string): {
  lines: string[];
  rows: Array<{
    line_index: number;
    id: string;
    status: string;
    cols: string[];
    id_idx: number;
    status_idx: number;
  }>;
  status_by_id: Record<string, string>;
  branch_ref_idx: number;
  worktree_path_idx: number;
} {
  const lines = compactLines(tasksText).split("\n");
  const rows: Array<{
    line_index: number;
    id: string;
    status: string;
    cols: string[];
    id_idx: number;
    status_idx: number;
  }> = [];
  const status_by_id: Record<string, string> = {};

  let inTasks = false;
  let header: string[] | null = null;
  let idIdx = -1;
  let statusIdx = -1;
  let branchRefIdx = -1;
  let worktreePathIdx = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const stripped = line.trim();
    if (/^##\s+tasks\b/i.test(stripped)) {
      inTasks = true;
      header = null;
      idIdx = -1;
      statusIdx = -1;
      branchRefIdx = -1;
      worktreePathIdx = -1;
      continue;
    }
    if (inTasks && /^##\s+/.test(stripped)) break;
    if (!inTasks || !stripped.startsWith("|")) continue;
    const cols = stripped
      .slice(1, stripped.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((c) => c.trim());
    if (!cols.length) continue;
    if (header === null) {
      header = cols.map((c) => c.toLowerCase());
      idIdx = header.indexOf("id");
      statusIdx = header.indexOf("status");
      branchRefIdx = header.indexOf("branch_ref");
      worktreePathIdx = header.indexOf("worktree_path");
      continue;
    }
    if (cols.every((c) => /^[-: ]*$/.test(c))) continue;
    if (idIdx < 0 || statusIdx < 0) continue;
    if (idIdx >= cols.length || statusIdx >= cols.length) continue;
    const id = cols[idIdx].replace(/`/g, "").trim();
    const status = cols[statusIdx].replace(/`/g, "").trim().toLowerCase();
    if (!id) continue;
    rows.push({
      line_index: i,
      id,
      status,
      cols,
      id_idx: idIdx,
      status_idx: statusIdx,
    });
    status_by_id[id] = status;
  }

  return {
    lines,
    rows,
    status_by_id,
    branch_ref_idx: branchRefIdx,
    worktree_path_idx: worktreePathIdx,
  };
}

export function rewriteTaskAssignments(
  repoRoot: string,
  slug: string,
  tasksText: string,
): {
  text: string;
  applied: Record<string, { branch_ref: string; worktree_path: string }>;
} {
  const parsed = parseTaskTable(tasksText);
  if (!parsed.rows.length) {
    return {
      text: `${parsed.lines.join("\n").trimEnd()}\n`,
      applied: {},
    };
  }

  const lines = [...parsed.lines];
  const applied: Record<string, { branch_ref: string; worktree_path: string }> =
    {};
  for (const row of parsed.rows) {
    const branchRef = taskAssignmentBranchRef(slug, row.id);
    const worktreePath = taskAssignmentWorktreePath(repoRoot, slug, row.id);
    if (
      parsed.branch_ref_idx >= 0 &&
      parsed.branch_ref_idx < row.cols.length &&
      row.cols[parsed.branch_ref_idx] !== branchRef
    ) {
      row.cols[parsed.branch_ref_idx] = branchRef;
    }
    if (
      parsed.worktree_path_idx >= 0 &&
      parsed.worktree_path_idx < row.cols.length &&
      row.cols[parsed.worktree_path_idx] !== worktreePath
    ) {
      row.cols[parsed.worktree_path_idx] = worktreePath;
    }
    lines[row.line_index] = `| ${row.cols.join(" | ")} |`;
    applied[row.id] = {
      branch_ref: branchRef,
      worktree_path: worktreePath,
    };
  }

  return {
    text: `${lines.join("\n").trimEnd()}\n`,
    applied,
  };
}

function rewriteTaskStatuses(
  tasksText: string,
  updates: Record<string, string>,
): {
  text: string;
  applied: Record<string, { from: string; to: string }>;
} {
  const parsed = parseTaskTable(tasksText);
  const lines = [...parsed.lines];
  const applied: Record<string, { from: string; to: string }> = {};

  for (const row of parsed.rows) {
    const next = updates[row.id]?.trim().toLowerCase();
    if (!next || next === row.status) continue;
    row.cols[row.status_idx] = next;
    lines[row.line_index] = `| ${row.cols.join(" | ")} |`;
    applied[row.id] = { from: row.status, to: next };
  }

  return {
    text: `${lines.join("\n").trimEnd()}\n`,
    applied,
  };
}

export function parseLatestEvidenceTaskStatuses(
  evidenceText: string,
): Record<string, EvidenceTaskStatus> {
  const lines = compactLines(evidenceText).split("\n");
  const latest: Record<string, EvidenceTaskStatus> = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let match = line.match(/task=([^ ]+).*?\b([a-z_]+)->([a-z_]+)\b/i);
    if (match) {
      const ids = match[1]
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const next = match[3].trim().toLowerCase();
      for (const id of ids) {
        latest[id] = {
          status: next,
          source: "transition",
          line: i + 1,
          raw: line,
        };
      }
      continue;
    }
    match = line.match(/task=([^ ]+)\s+imported\s+status=([a-z_]+)/i);
    if (!match) continue;
    const ids = match[1]
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const next = match[2].trim().toLowerCase();
    for (const id of ids) {
      latest[id] = {
        status: next,
        source: "import",
        line: i + 1,
        raw: line,
      };
    }
  }
  return latest;
}

export function canonicalizeHandoffBlocks(
  handoffText: string,
): HandoffCanonicalization {
  const originalBlocks = parseHandoffBlocksAnywhere(handoffText);
  const dedupedBlocks: Array<{
    block: string;
    fingerprint: string;
    iteration: number;
    index: number;
  }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < originalBlocks.length; i += 1) {
    const block = originalBlocks[i].trim();
    if (!block) continue;
    const fingerprint = blockFingerprint(block);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const iterationId = block
      .replace(/^###\s*iteration\s*=\s*/i, "")
      .split("\n")[0]
      .trim();
    dedupedBlocks.push({
      block,
      fingerprint,
      iteration: parseIterationId(iterationId),
      index: i,
    });
  }

  const sorted = [...dedupedBlocks].sort((a, b) => {
    if (a.iteration !== b.iteration) return a.iteration - b.iteration;
    return a.index - b.index;
  });
  const sortedBlocks = sorted.map((entry) => entry.block);
  const text = sortedBlocks.length
    ? `# Iteration Handoffs\n\n${sortedBlocks.join("\n\n")}\n`
    : "# Iteration Handoffs\n";

  let reordered = false;
  if (originalBlocks.length === sortedBlocks.length) {
    for (let i = 0; i < originalBlocks.length; i += 1) {
      if (originalBlocks[i].trim() !== sortedBlocks[i].trim()) {
        reordered = true;
        break;
      }
    }
  } else {
    reordered = true;
  }
  const deduped = originalBlocks.length !== sortedBlocks.length;
  const latest = parseLatestHandoffFromText(text);
  return {
    text,
    changed: text.trimEnd() !== compactLines(handoffText).trimEnd(),
    reordered,
    deduped,
    latest_iteration_id: latest?.iteration_id?.trim() || null,
    latest_stop_reason: latest?.stop_reason?.trim().toLowerCase() || null,
  };
}

export function parseHandoffDoneCandidates(handoffText: string): string[] {
  const blocks = parseHandoffBlocksAnywhere(handoffText);
  const active = new Set<string>();
  const ordered = blocks
    .map((block, index) => {
      const iterationId = block
        .replace(/^###\s*iteration\s*=\s*/i, "")
        .split("\n")[0]
        .trim();
      const advancedRaw =
        block.match(/^\s*-\s*advanced_tasks\s*:\s*(.+)$/im)?.[1] ?? "";
      const rolledRaw =
        block.match(/^\s*-\s*rolled_back_tasks\s*:\s*(.+)$/im)?.[1] ?? "";
      return {
        index,
        iteration: parseIterationId(iterationId),
        advanced: parseBracketList(advancedRaw),
        rolled: parseBracketList(rolledRaw),
      };
    })
    .sort((a, b) =>
      a.iteration === b.iteration
        ? a.index - b.index
        : a.iteration - b.iteration,
    );

  for (const block of ordered) {
    for (const id of block.advanced) active.add(id);
    for (const id of block.rolled) active.delete(id);
  }
  return [...active];
}

export function scanQuestCoherency(files: QuestFiles): QuestCoherencyScan {
  const tasksText = readText(files.tasks);
  const evidenceText = readText(files.evidence);
  const handoffText = readText(files.handoffs);
  const tasks = parseTaskTable(tasksText).status_by_id;
  const taskFallback = evaluateTaskFallback(Object.values(tasks));
  const evidence = parseLatestEvidenceTaskStatuses(evidenceText);
  const handoffDone = new Set(parseHandoffDoneCandidates(handoffText));

  const blocks = parseHandoffBlocksAnywhere(handoffText);
  let nonMonotonic = false;
  let lastIter = Number.MIN_SAFE_INTEGER;
  for (const block of blocks) {
    const iterationId = block
      .replace(/^###\s*iteration\s*=\s*/i, "")
      .split("\n")[0]
      .trim();
    const iter = parseIterationId(iterationId);
    if (iter < lastIter) {
      nonMonotonic = true;
      break;
    }
    lastIter = iter;
  }
  const latest = parseLatestHandoffFromText(handoffText);
  const latestStopReason = latest?.stop_reason?.trim().toLowerCase() || null;
  const terminalMismatch =
    !!latestStopReason &&
    ((latestStopReason === "all_done" && taskFallback !== "all_done") ||
      (latestStopReason === "all_blocked_or_deferred" &&
        taskFallback !== "all_stalled"));

  const mismatches: TaskEvidenceMismatch[] = [];
  for (const [taskId, taskStatus] of Object.entries(tasks)) {
    const ev = evidence[taskId];
    if (!ev) continue;
    if (ev.status === taskStatus) continue;
    mismatches.push({
      task_id: taskId,
      task_status: taskStatus,
      evidence_status: ev.status,
      evidence_source: ev.source,
    });
  }

  return {
    mismatches,
    handoff_done_candidates: [...handoffDone],
    handoff_non_monotonic: nonMonotonic,
    latest_iteration_id: latest?.iteration_id?.trim() || null,
    latest_stop_reason: latestStopReason,
    task_fallback: taskFallback,
    terminal_mismatch: terminalMismatch,
    stray: detectStrayIterationPlacement(files),
  };
}

export function repairQuestCoherency(
  files: QuestFiles,
  nowTimestamp = nowIso(),
): QuestCoherencyRepair {
  const touched = new Set<string>();
  const stray = repairStrayIterationPlacement(files);
  for (const file of stray.touched_files) touched.add(file);

  let tasksText = readText(files.tasks);
  let evidenceText = readText(files.evidence);
  const handoffText = readText(files.handoffs);
  const handoffCanonical = canonicalizeHandoffBlocks(handoffText);
  if (handoffCanonical.changed) {
    writeText(files.handoffs, handoffCanonical.text);
    touched.add(files.handoffs);
  }

  const scan = scanQuestCoherency(files);
  const handoffDone = new Set(scan.handoff_done_candidates);
  const taskUpdates: Record<string, string> = {};
  const evidenceReconcile: Record<string, string[]> = {};

  for (const mismatch of scan.mismatches) {
    if (
      mismatch.evidence_status === "done" &&
      mismatch.task_status !== "done" &&
      handoffDone.has(mismatch.task_id)
    ) {
      taskUpdates[mismatch.task_id] = "done";
      continue;
    }
    (evidenceReconcile[mismatch.task_status] ??= []).push(mismatch.task_id);
  }

  const appliedUpdates: Record<string, { from: string; to: string }> = {};
  if (Object.keys(taskUpdates).length) {
    const rewritten = rewriteTaskStatuses(tasksText, taskUpdates);
    tasksText = rewritten.text;
    for (const [taskId, delta] of Object.entries(rewritten.applied)) {
      appliedUpdates[taskId] = delta;
    }
    if (Object.keys(rewritten.applied).length) {
      writeText(files.tasks, tasksText);
      touched.add(files.tasks);
    }
  }

  const reconciliationEntries: string[] = [];
  for (const [status, taskIds] of Object.entries(evidenceReconcile)) {
    if (!taskIds.length) continue;
    const sortedIds = [...taskIds].sort();
    reconciliationEntries.push(
      `- [${nowTimestamp}] task=${sortedIds.join(",")} reconciled evidence->${status} type=reconcile ref="${files.tasks}" summary="reconciled stale evidence status to canonical task table"`,
    );
  }
  if (reconciliationEntries.length) {
    appendEvidence(files.evidence, reconciliationEntries);
    evidenceText = readText(files.evidence);
    touched.add(files.evidence);
  }

  const latest = parseLatestHandoffFromText(readText(files.handoffs));
  return {
    touched_files: [...touched],
    stray_blocks_moved: stray.moved_block_count,
    handoff_reordered: handoffCanonical.reordered,
    handoff_deduped: handoffCanonical.deduped,
    task_updates: appliedUpdates,
    evidence_reconciliations: evidenceReconcile,
    latest_iteration_id: latest?.iteration_id?.trim() || null,
    latest_stop_reason: latest?.stop_reason?.trim().toLowerCase() || null,
  };
}

export function detectStrayIterationPlacement(
  files: QuestFiles,
): StrayIterationReport {
  const tasksExtract = extractIterationBlocksAndClean(readText(files.tasks));
  const evidenceExtract = extractIterationBlocksAndClean(
    readText(files.evidence),
  );
  const task_block_count = tasksExtract.blocks.length;
  const evidence_block_count = evidenceExtract.blocks.length;
  const total_block_count = task_block_count + evidence_block_count;
  return {
    has_stray: total_block_count > 0,
    task_block_count,
    evidence_block_count,
    total_block_count,
    task_blocks: tasksExtract.blocks,
    evidence_blocks: evidenceExtract.blocks,
  };
}

export function repairStrayIterationPlacement(files: QuestFiles): {
  had_stray: boolean;
  moved_block_count: number;
  touched_files: string[];
} {
  const touched = new Set<string>();
  const tasksOriginal = readText(files.tasks);
  const evidenceOriginal = readText(files.evidence);
  const handoffsOriginal = readText(files.handoffs);

  const tasksExtract = extractIterationBlocksAndClean(tasksOriginal);
  const evidenceExtract = extractIterationBlocksAndClean(evidenceOriginal);
  const movedBlocks = [...tasksExtract.blocks, ...evidenceExtract.blocks];
  if (!movedBlocks.length) {
    return { had_stray: false, moved_block_count: 0, touched_files: [] };
  }

  if (tasksExtract.cleaned_text !== collapseBlankLines(tasksOriginal)) {
    writeText(
      files.tasks,
      tasksExtract.cleaned_text || "# Quest\n\n## Tasks\n",
    );
    touched.add(files.tasks);
  }
  if (evidenceExtract.cleaned_text !== collapseBlankLines(evidenceOriginal)) {
    writeText(files.evidence, evidenceExtract.cleaned_text || "# Evidence\n");
    touched.add(files.evidence);
  }

  const handoffPrefix = handoffsOriginal.trim()
    ? handoffsOriginal.trimEnd()
    : "# Iteration Handoffs";
  const existing = new Set(
    parseHandoffBlocksAnywhere(handoffsOriginal).map(blockFingerprint),
  );
  const appendable = movedBlocks.filter(
    (block) => !existing.has(blockFingerprint(block)),
  );
  if (appendable.length) {
    writeText(
      files.handoffs,
      `${handoffPrefix}\n\n${appendable.join("\n\n").trim()}\n`,
    );
    touched.add(files.handoffs);
  }

  return {
    had_stray: true,
    moved_block_count: movedBlocks.length,
    touched_files: [...touched],
  };
}

export function slugify(input: string): string {
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

export function questFiles(repoRoot: string, slug: string): QuestFiles {
  const dir = resolve(repoRoot, LOOPO_QUESTS_DIR, slug);
  return {
    slug,
    dir,
    tasks: resolve(dir, "tasks.yaml"),
    plan: resolve(dir, "plan.yaml"),
    manifest: resolve(dir, "manifest.sign.json"),
    children_dir: resolve(dir, "children"),
    questions: resolve(dir, "questions.jsonl"),
    plans: resolve(dir, "plans.jsonl"),
    evidence: resolve(dir, "evidence.jsonl"),
    validation: resolve(dir, "validation.jsonl"),
    review: resolve(dir, "review.jsonl"),
    handoffs: resolve(dir, "handoffs.jsonl"),
    hook_events: resolve(dir, "hook-events.jsonl"),
  };
}

type SystemDocDef = {
  id: string;
  type: string;
  file: string;
  schema: string;
};

export const SYSTEM_DOCS: SystemDocDef[] = [
  {
    id: "high-level-design",
    type: "high-level-design",
    file: "high-level-design.yaml",
    schema: "system-high-level-design.v1.json",
  },
  {
    id: "low-level-design",
    type: "low-level-design",
    file: "low-level-design.yaml",
    schema: "system-low-level-design.v1.json",
  },
  {
    id: "architecture",
    type: "architecture",
    file: "architecture.yaml",
    schema: "system-architecture.v1.json",
  },
  {
    id: "system-behaviours",
    type: "system-behaviours",
    file: "system-behaviours.yaml",
    schema: "system-behaviours.v1.json",
  },
  {
    id: "design-system",
    type: "design-system",
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
    `type: ${yamlScalar(doc.type)}`,
    `title: ${yamlScalar(title)}`,
    "status: draft",
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
    lines.push(`    type: ${yamlScalar(doc.type)}`);
    lines.push(`    path: ${yamlScalar(`.loopo/docs/${doc.file}`)}`);
    lines.push(
      `    schema_id: ${yamlScalar(`https://loopo.dev/schemas/${doc.schema}`)}`,
    );
    lines.push(`    digest: ${yamlScalar(hashText(readText(path)))}`);
    lines.push("    status: draft");
    lines.push(`    updated_at: ${yamlScalar("managed")}`);
  }
  return `${lines.join("\n")}\n`;
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
    files[file] = hashText(readText(file));
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
  for (const file of rootManagedFiles(repoRoot)) {
    const expected = files[file];
    if (!expected) {
      errors.push(`root manifest missing file entry: ${file}`);
      continue;
    }
    const actual = hashText(readText(file));
    if (actual !== expected)
      errors.push(`unauthorized/tampered root file: ${file}`);
  }
  for (const file of Object.keys(files)) {
    if (!rootManagedFiles(repoRoot).includes(file)) {
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
    lines.push(`  - id: ${yamlScalar(slugify(id))}`);
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
          `  - id: ${yamlScalar(slugify(String(behaviour.id ?? "behaviour")))}`,
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
    `type: ${yamlScalar(doc.type)}`,
    `title: ${yamlScalar(title)}`,
    "status: active",
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
    'When user prompt is `loopo: {request}`, invoke `loopo init "{request}" --cwd <cwd> --runtime <runtime>` and follow the instructions from output.',
    "",
    "```bash",
    'loopo init "loopo: build the app" --cwd "$PWD" --runtime codex',
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

export function renderTasksYaml(state: QuestState): string {
  const lines = [
    "schema_version: 3",
    `slug: ${yamlScalar(state.slug)}`,
    `quest_id: ${yamlScalar(state.quest_id || state.slug)}`,
    `flow_id: ${yamlScalar(state.flow_id || "swe")}`,
    `flow_version: ${Number.isInteger(state.flow_version) ? state.flow_version : 1}`,
    `stage: ${yamlScalar(state.stage)}`,
    `prompt: ${yamlScalar(state.prompt)}`,
    `context_root: ${yamlScalar(state.context_root)}`,
    `resolution_source: ${yamlScalar(state.resolution_source)}`,
    `coordinator_branch: ${yamlScalar(state.coordinator_branch)}`,
    `coordinator_worktree: ${yamlScalar(state.coordinator_worktree)}`,
    `parent_quest_slug: ${yamlScalar(state.parent_quest_slug)}`,
    `landing_target_branch: ${yamlScalar(state.landing_target_branch)}`,
    `landing_target_worktree: ${yamlScalar(state.landing_target_worktree)}`,
    `landed_commit: ${yamlScalar(state.landed_commit)}`,
    `landing_strategy: ${yamlScalar(state.landing_strategy)}`,
    `assumptions: ${yamlStringList(state.assumptions)}`,
    `constraints: ${yamlStringList(state.constraints)}`,
    "tasks:",
  ];
  if (!state.tasks.length) {
    lines.push("  []");
  } else {
    for (const task of state.tasks) {
      lines.push(`  - id: ${yamlScalar(task.id)}`);
      lines.push(`    title: ${yamlScalar(task.title)}`);
      lines.push(`    type: ${yamlScalar(task.type)}`);
      lines.push(`    status: ${yamlScalar(task.status)}`);
      lines.push(`    dependencies: ${yamlStringList(task.dependencies)}`);
      lines.push(`    scope_files: ${yamlStringList(task.scope_files)}`);
      lines.push(`    spec_refs: ${yamlStringList(task.spec_refs)}`);
      lines.push(`    context_refs: ${yamlStringList(task.context_refs)}`);
      lines.push(`    branch_ref: ${yamlScalar(task.branch_ref)}`);
      lines.push(`    worktree_path: ${yamlScalar(task.worktree_path)}`);
      lines.push(`    child_slug: ${yamlScalar(task.child_slug)}`);
      lines.push(
        `    concurrency_group: ${yamlScalar(task.concurrency_group)}`,
      );
      lines.push(`    merge_target: ${yamlScalar(task.merge_target)}`);
      lines.push(`    merge_lease_id: ${yamlScalar(task.merge_lease_id)}`);
      lines.push(`    merge_commit: ${yamlScalar(task.merge_commit)}`);
      lines.push(
        `    system_impact_ref: ${yamlScalar(task.system_impact_ref)}`,
      );
      lines.push(`    acceptance: ${yamlScalar(task.acceptance)}`);
      if (task.blocker) lines.push(`    blocker: ${yamlScalar(task.blocker)}`);
    }
  }
  return `${lines.join("\n")}\n`;
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
    child_slug: "",
    concurrency_group: "",
    merge_target: "",
    merge_lease_id: "",
    merge_commit: "",
    system_impact_ref: "",
    acceptance: "",
  };
}

export function parseTasksYaml(text: string): Partial<QuestState> {
  const result: Partial<QuestState> = {};
  const tasks: QuestTask[] = [];
  let currentTask: QuestTask | null = null;
  for (const line of compactLines(text).split("\n")) {
    const match = line.match(/^([a-z_]+):\s*(.*)$/);
    if (match) {
      const key = match[1] as keyof QuestState;
      const value = parseYamlScalar(match[2] ?? "");
      if (
        [
          "slug",
          "quest_id",
          "flow_id",
          "stage",
          "prompt",
          "context_root",
          "resolution_source",
          "coordinator_branch",
          "coordinator_worktree",
          "parent_quest_slug",
          "landing_target_branch",
          "landing_target_worktree",
          "landed_commit",
          "landing_strategy",
        ].includes(key)
      ) {
        (result as Record<string, unknown>)[key] = value;
      } else if (key === "flow_version") {
        const version = Number(value);
        (result as Record<string, unknown>)[key] =
          Number.isInteger(version) && version > 0 ? version : 1;
      } else if (key === "assumptions" || key === "constraints") {
        (result as Record<string, unknown>)[key] = parseYamlStringList(
          match[2] ?? "",
        );
      }
      continue;
    }
    const taskStart = line.match(/^\s{2}- id:\s*(.*)$/);
    if (taskStart) {
      currentTask = emptyQuestTask(parseYamlScalar(taskStart[1] ?? ""));
      tasks.push(currentTask);
      continue;
    }
    const taskField = line.match(/^\s{4}([a-z_]+):\s*(.*)$/);
    if (taskField && currentTask) {
      const key = taskField[1] as keyof QuestTask;
      const raw = taskField[2] ?? "";
      if (
        ["dependencies", "scope_files", "spec_refs", "context_refs"].includes(
          key,
        )
      ) {
        (currentTask as Record<string, unknown>)[key] =
          parseYamlStringList(raw);
      } else if (key === "type") {
        currentTask.type =
          parseYamlScalar(raw) === "general" ? "general" : "coding";
      } else {
        (currentTask as Record<string, unknown>)[key] = parseYamlScalar(raw);
      }
    }
  }
  if (tasks.length) result.tasks = tasks;
  if (!result.quest_id && result.slug) result.quest_id = result.slug;
  if (!result.flow_id) result.flow_id = "swe";
  if (!result.flow_version) result.flow_version = 1;
  if (!result.parent_quest_slug) result.parent_quest_slug = "";
  if (!result.landing_target_branch) result.landing_target_branch = "main";
  if (!result.landing_target_worktree) result.landing_target_worktree = "";
  if (!result.landed_commit) result.landed_commit = "";
  if (!result.landing_strategy) result.landing_strategy = "";
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
  const childFiles = existsSync(files.children_dir)
    ? readdirSync(files.children_dir)
        .filter((name) => name.endsWith(".yaml") || name.endsWith(".jsonl"))
        .map((name) => resolve(files.children_dir, name))
    : [];
  return [
    files.tasks,
    files.plan,
    files.questions,
    files.plans,
    files.evidence,
    files.validation,
    files.review,
    files.handoffs,
    files.hook_events,
    ...childFiles,
  ];
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
    hashes[file] = hashText(readText(file));
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
  const managedSet = new Set(managed);
  const errors: string[] = [];
  for (const file of managed) {
    const expected = recorded[file];
    if (!expected) {
      errors.push(`quest manifest missing file entry: ${file}`);
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
  const slug = String(state.slug ?? "quest");
  const rawId = String(input.id ?? input.task_id ?? `task-${index + 1}`);
  const id = slugify(rawId);
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
      slugify(id),
    ),
    scope_files: asStringList(input.scope_files ?? input.scope),
    spec_refs: asStringList(input.spec_refs ?? input.specs),
    context_refs: asStringList(input.context_refs ?? input.context),
    branch_ref: String(
      input.branch_ref ?? (leafChild ? coordinatorBranch : `codex/${slug}-${id}`),
    ),
    worktree_path: String(
      input.worktree_path ??
        (leafChild
          ? coordinatorWorktree
          : resolve(contextRoot, "worktrees", `${slug}-${id}`)),
    ),
    child_slug: String(input.child_slug ?? (leafChild ? "" : `${slug}-${id}`)),
    concurrency_group: String(input.concurrency_group ?? ""),
    merge_target: String(input.merge_target ?? coordinatorBranch),
    merge_lease_id: String(
      input.merge_lease_id ?? (leafChild ? "" : `lease-${slug}-${id}`),
    ),
    merge_commit: String(input.merge_commit ?? ""),
    system_impact_ref: String(
      input.system_impact_ref ??
        (leafChild ? "" : `.loopo/quests/${slug}/children/${id}.yaml`),
    ),
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
    slug: files.slug,
    quest_id: String(state.quest_id ?? files.slug),
    flow_id: String(state.flow_id ?? "swe"),
    flow_version: Number(state.flow_version ?? 1),
    stage: String(state.stage ?? "planning"),
    prompt: String(state.prompt ?? ""),
    context_root: String(state.context_root ?? ""),
    resolution_source: String(state.resolution_source ?? ""),
    coordinator_branch: String(state.coordinator_branch ?? "main"),
    coordinator_worktree: String(state.coordinator_worktree ?? ""),
    parent_quest_slug: String(state.parent_quest_slug ?? ""),
    landing_target_branch: String(state.landing_target_branch ?? "main"),
    landing_target_worktree: String(state.landing_target_worktree ?? ""),
    landed_commit: String(state.landed_commit ?? ""),
    landing_strategy: String(state.landing_strategy ?? ""),
    assumptions: asStringList(plan?.assumptions),
    constraints: asStringList(plan?.constraints),
    tasks: taskInputs.map((task, index) =>
      normalizePlanTask(state, task, index),
    ),
  };
  writeText(files.tasks, renderTasksYaml(nextState));
  return nextState;
}

export function renderPlanYaml(input: {
  slug: string;
  questId: string;
  prompt: string;
  plan?: Record<string, unknown> | null;
}): string {
  const summary = String(input.plan?.summary ?? "").trim();
  const taskInputs = Array.isArray(input.plan?.tasks)
    ? (input.plan!.tasks as Array<Record<string, unknown>>)
    : [];
  const lines = [
    "schema_version: 3",
    `slug: ${yamlScalar(input.slug)}`,
    `quest_id: ${yamlScalar(input.questId)}`,
    `prompt: ${yamlScalar(input.prompt)}`,
    `summary: ${yamlScalar(summary)}`,
    `assumptions: ${yamlStringList(asStringList(input.plan?.assumptions))}`,
    "tasks:",
  ];
  if (!taskInputs.length) {
    lines.push("  []");
  } else {
    taskInputs.forEach((task, index) => {
      const id = slugify(
        String(task.id ?? task.task_id ?? `task-${index + 1}`),
      );
      lines.push(`  - id: ${yamlScalar(id)}`);
      lines.push(
        `    title: ${yamlScalar(String(task.title ?? task.name ?? id))}`,
      );
      lines.push(
        `    type: ${yamlScalar(task.type === "general" ? "general" : "coding")}`,
      );
      lines.push(
        `    acceptance: ${yamlScalar(planTaskAcceptance(task.acceptance ?? task.acceptance_criteria))}`,
      );
      lines.push(
        `    spec_refs: ${yamlStringList(asStringList(task.spec_refs ?? task.specs))}`,
      );
      lines.push(
        `    context_refs: ${yamlStringList(asStringList(task.context_refs ?? task.context))}`,
      );
    });
  }
  lines.push("");
  return lines.join("\n");
}

export function writeQuestPlan(
  files: QuestFiles,
  state: Partial<QuestState>,
  plan: Record<string, unknown> | null,
): void {
  writeText(
    files.plan,
    renderPlanYaml({
      slug: files.slug,
      questId: String(state.quest_id ?? files.slug),
      prompt: String(state.prompt ?? ""),
      plan,
    }),
  );
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
  const taskId = slugify(update.id);
  const nextState: QuestState = {
    schema_version: 3,
    slug: files.slug,
    quest_id: String(state.quest_id ?? files.slug),
    flow_id: String(state.flow_id ?? "swe"),
    flow_version: Number(state.flow_version ?? 1),
    stage: String(state.stage ?? "planning"),
    prompt: String(state.prompt ?? ""),
    context_root: String(state.context_root ?? ""),
    resolution_source: String(state.resolution_source ?? ""),
    coordinator_branch: String(state.coordinator_branch ?? "main"),
    coordinator_worktree: String(state.coordinator_worktree ?? ""),
    parent_quest_slug: String(state.parent_quest_slug ?? ""),
    landing_target_branch: String(state.landing_target_branch ?? "main"),
    landing_target_worktree: String(state.landing_target_worktree ?? ""),
    landed_commit: String(state.landed_commit ?? ""),
    landing_strategy: String(state.landing_strategy ?? ""),
    assumptions: asStringList(state.assumptions),
    constraints: asStringList(state.constraints),
    tasks: (Array.isArray(state.tasks) ? state.tasks : []).map((task) => {
      if (task.id !== taskId) return task;
      return {
        ...task,
        status: update.status,
        child_slug: childTaskValue(update.child_slug, task.child_slug),
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
      | "parent_quest_slug"
      | "landing_target_branch"
      | "landing_target_worktree"
      | "landed_commit"
      | "landing_strategy"
    >
  >,
): QuestState {
  const nextState: QuestState = {
    schema_version: 3,
    slug: files.slug,
    quest_id: String(state.quest_id ?? files.slug),
    flow_id: String(state.flow_id ?? "swe"),
    flow_version: Number(state.flow_version ?? 1),
    stage: String(state.stage ?? "planning"),
    prompt: String(state.prompt ?? ""),
    context_root: String(state.context_root ?? ""),
    resolution_source: String(state.resolution_source ?? ""),
    coordinator_branch: String(state.coordinator_branch ?? "main"),
    coordinator_worktree: String(state.coordinator_worktree ?? ""),
    parent_quest_slug: String(
      receipt.parent_quest_slug ?? state.parent_quest_slug ?? "",
    ),
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
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
  };
  writeText(files.tasks, renderTasksYaml(nextState));
  return nextState;
}

export function createQuest(input: {
  repoRoot: string;
  slug: string;
  prompt: string;
  resolutionSource: string;
  workspace: QuestWorkspace;
  flowId?: string;
  flowVersion?: number;
  parentQuestSlug?: string;
  landingTargetBranch?: string;
  landingTargetWorktree?: string;
  landedCommit?: string;
  landingStrategy?: string;
}): { files: QuestFiles; state: QuestState } {
  const files = questFiles(input.repoRoot, input.slug);
  if (existsSync(files.tasks) || existsSync(files.plan)) {
    throw new Error(`quest slug already exists: ${input.slug}`);
  }
  const state: QuestState = {
    schema_version: 3,
    slug: input.slug,
    quest_id: input.slug,
    flow_id: input.flowId ?? "swe",
    flow_version: input.flowVersion ?? 1,
    stage: "planning",
    prompt: input.prompt,
    context_root: input.repoRoot,
    resolution_source: input.resolutionSource,
    coordinator_branch: input.workspace.branch_ref,
    coordinator_worktree: input.workspace.worktree_path,
    parent_quest_slug: String(input.parentQuestSlug ?? ""),
    landing_target_branch: String(input.landingTargetBranch ?? "main"),
    landing_target_worktree: String(input.landingTargetWorktree ?? ""),
    landed_commit: String(input.landedCommit ?? ""),
    landing_strategy: String(input.landingStrategy ?? ""),
    assumptions: [],
    constraints: [],
    tasks: [],
  };
  writeText(files.tasks, renderTasksYaml(state));
  writeText(
    files.plan,
    renderPlanYaml({
      slug: input.slug,
      questId: input.slug,
      prompt: input.prompt,
      plan: null,
    }),
  );
  mkdirSync(files.children_dir, { recursive: true });
  for (const file of [
    files.questions,
    files.plans,
    files.evidence,
    files.validation,
    files.review,
    files.handoffs,
    files.hook_events,
  ]) {
    if (!existsSync(file)) writeText(file, "");
  }
  appendJsonl(files.handoffs, {
    event: "quest_started",
    quest_id: input.slug,
    stage: state.stage,
    iteration: 0,
    stop_reason: "none",
  });
  writeQuestManifest(files, `start-${input.slug}`, "loopo quest next");
  return { files, state };
}

export function findLatestQuest(
  repoRoot: string,
): { files: QuestFiles; state: Partial<QuestState> } | null {
  const questsDir = resolve(repoRoot, LOOPO_QUESTS_DIR);
  if (!existsSync(questsDir)) return null;
  const entries = readdirSync(questsDir)
    .map((slug) => {
      const files = questFiles(repoRoot, slug);
      if (!existsSync(files.tasks)) return null;
      return { files, mtimeMs: statSync(files.tasks).mtimeMs };
    })
    .filter((entry): entry is { files: QuestFiles; mtimeMs: number } =>
      Boolean(entry),
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const first = entries[0];
  if (!first) return null;
  return {
    files: first.files,
    state: parseTasksYaml(readText(first.files.tasks)),
  };
}

export function updateQuestStage(
  files: QuestFiles,
  nextStage: string,
  requestId = "quest-stage",
  writerCommand = "loopo quest next",
): Partial<QuestState> {
  const currentText = readText(files.tasks);
  const nextText = /^stage:\s*.*$/m.test(currentText)
    ? currentText.replace(/^stage:\s*.*$/m, `stage: ${yamlScalar(nextStage)}`)
    : `${currentText.trimEnd()}\nstage: ${yamlScalar(nextStage)}\n`;
  writeText(files.tasks, nextText.endsWith("\n") ? nextText : `${nextText}\n`);
  const state = parseTasksYaml(readText(files.tasks));
  appendJsonl(files.handoffs, {
    event: "stage_changed",
    quest_id: state.quest_id ?? files.slug,
    stage: nextStage,
  });
  writeQuestManifest(files, requestId, writerCommand);
  return parseTasksYaml(readText(files.tasks));
}

export function extractSlugFromTasksPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const questMatch = normalized.match(
    /(?:^|\/)\.loopo\/quests\/([a-z0-9]+(?:-[a-z0-9]+)*)\/tasks\.yaml$/i,
  );
  return questMatch?.[1] ?? null;
}

export function defaultState(): LoopoState {
  return {
    storage_version: STORAGE_VERSION,
    active_quest_slug: null,
    quests: {},
    receipts: [],
  };
}

export function loadState(repoRoot: string): LoopoState {
  const path = resolve(repoRoot, LOOPO_STATE_FILE);
  const parsed = readJson(path);
  if (!parsed || typeof parsed !== "object") return defaultState();
  const state = parsed as Partial<LoopoState>;
  return {
    storage_version:
      typeof state.storage_version === "number"
        ? state.storage_version
        : STORAGE_VERSION,
    active_quest_slug:
      typeof state.active_quest_slug === "string" &&
      state.active_quest_slug.trim()
        ? state.active_quest_slug.trim()
        : null,
    quests:
      state.quests && typeof state.quests === "object"
        ? (state.quests as Record<string, QuestRegistryItem>)
        : {},
    receipts: Array.isArray(state.receipts)
      ? (state.receipts as LoopoReceipt[])
      : [],
  };
}

export function saveState(repoRoot: string, state: LoopoState): void {
  writeJson(resolve(repoRoot, LOOPO_STATE_FILE), state);
}

export function managedFiles(files: QuestFiles): string[] {
  return [files.tasks, files.evidence, files.handoffs];
}

export function managedHashes(files: QuestFiles): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const file of managedFiles(files)) {
    hashes[file] = hashText(readText(file));
  }
  return hashes;
}

export function activeQuestFiles(
  repoRoot: string,
  state: LoopoState,
  explicitSlug?: string | null,
): QuestFiles | null {
  const slug = explicitSlug?.trim() || state.active_quest_slug;
  if (!slug) return null;
  return questFiles(repoRoot, slug);
}

export function ensureStateScaffold(repoRoot: string): LoopoState {
  const state = loadState(repoRoot);
  saveState(repoRoot, state);
  return state;
}

function hasGitCommit(repoRoot: string): boolean {
  return (
    runCommand("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repoRoot,
      timeoutMs: 10_000,
    }).status === 0
  );
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

export function coordinatorWorktreePath(
  repoRoot: string,
  slug: string,
): string {
  return resolve(repoRoot, "worktrees", slug);
}

export function landingTargetWorktreePath(
  repoRoot: string,
  branchRef: string,
): string {
  return resolve(repoRoot, "worktrees", `landing-${slugify(branchRef)}`);
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
  slug: string,
): QuestWorkspace {
  return ensureNamedWorkspace(repoRoot, slug, coordinatorWorktreePath(repoRoot, slug));
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
    "if command -v bun >/dev/null 2>&1; then",
    '  exec bun "$SCRIPT" "$@"',
    "fi",
    "if command -v node >/dev/null 2>&1; then",
    "  if node -e \"const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 6) ? 0 : 1)\" >/dev/null 2>&1; then",
    '    exec node "$SCRIPT" "$@"',
    "  fi",
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
  if (worktreeMatch) {
    return resolve(worktreeMatch[1], worktreeMatch[2]);
  }
  return normalized;
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
  slug: string,
  objective: string,
): QuestFiles {
  const files = questFiles(repoRoot, slug);
  if (!existsSync(files.tasks)) {
    writeText(files.tasks, renderEmptyTasksDocument({ objective }));
  }
  if (!existsSync(files.evidence)) {
    writeText(files.evidence, "# Evidence\n");
  }
  if (!existsSync(files.handoffs)) {
    writeText(
      files.handoffs,
      [
        "# Iteration Handoffs",
        "",
        "### iteration=0",
        `- session_end_timestamp: ${nowIso()}`,
        "- stop_reason: none",
        "- advanced_tasks: []",
        "- rolled_back_tasks: []",
        "- new_blockers: []",
        "- next_queue: []",
        '- next_plan: ["initialize first tasks"]',
        "- known_risks: []",
        "",
      ].join("\n"),
    );
  }
  return files;
}

export function rewriteQuestMeta(
  tasksText: string,
  patch: Partial<{
    objective: string;
    scope: string;
    constraints: string;
    assumptions: string;
  }>,
): string {
  const lines = compactLines(tasksText).split("\n");
  const next = [...lines];
  const keys = ["objective", "scope", "constraints", "assumptions"] as const;
  for (const key of keys) {
    const idx = next.findIndex((line) =>
      new RegExp(`^\\s*-\\s*${key}\\s*:`).test(line.trim()),
    );
    if (idx >= 0 && typeof patch[key] === "string") {
      next[idx] = `- ${key}: ${patch[key]}`;
    }
  }
  return next.join("\n");
}

export function replaceTasksSection(
  repoRoot: string,
  slug: string,
  tasksText: string,
  newTable: string,
): string {
  const lines = compactLines(tasksText).split("\n");
  let start = lines.findIndex((line) => /^##\s+Tasks\b/i.test(line.trim()));
  if (start < 0) {
    return rewriteTaskAssignments(
      repoRoot,
      slug,
      `${tasksText.trim()}\n\n## Tasks\n${newTable.trim()}\n`,
    ).text;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  const replacement = ["## Tasks", ...newTable.trim().split("\n")];
  return rewriteTaskAssignments(
    repoRoot,
    slug,
    [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n"),
  ).text;
}

export function appendEvidence(file: string, entries: string[]): void {
  const lines = compactLines(readText(file));
  const prefix = lines.trim() ? lines.trimEnd() : "# Evidence";
  const body = entries
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n");
  writeText(file, `${prefix}\n${body}\n`);
}

export function renderHandoffBlock(input: Record<string, unknown>): string {
  const iteration =
    String(input.iteration ?? input.iteration_id ?? "").trim() || "0";
  const fields: Array<[string, unknown]> = [
    ["session_end_timestamp", input.session_end_timestamp ?? nowIso()],
    ["stop_reason", input.stop_reason ?? "none"],
    ["advanced_tasks", input.advanced_tasks ?? []],
    ["rolled_back_tasks", input.rolled_back_tasks ?? []],
    ["new_blockers", input.new_blockers ?? []],
    ["next_queue", input.next_queue ?? []],
    ["next_plan", input.next_plan ?? []],
    ["known_risks", input.known_risks ?? []],
  ];
  const body = fields.map(([key, value]) => {
    if (Array.isArray(value)) return `- ${key}: [${value.join(", ")}]`;
    return `- ${key}: ${String(value)}`;
  });
  return [`### iteration=${iteration}`, "", ...body].join("\n");
}

export function appendHandoff(
  file: string,
  handoff: Record<string, unknown>,
): void {
  const text = readText(file).trim();
  const prefix = text || "# Iteration Handoffs";
  const block = renderHandoffBlock(handoff);
  writeText(file, `${prefix}\n\n${block}\n`);
}

export function parseLatestHandoffFromText(
  text: string,
): Record<string, string> | null {
  const lines = compactLines(text).split("\n");
  let latest = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^###\s*iteration\s*=/.test(lines[i].trim())) latest = i;
  }
  if (latest < 0) return null;
  const data: Record<string, string> = {
    iteration_id: lines[latest].replace(/^###\s*iteration\s*=\s*/i, "").trim(),
  };
  for (const line of lines.slice(latest + 1)) {
    if (/^###\s*iteration\s*=/.test(line.trim())) break;
    const match = line.match(/^\s*-\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/);
    if (match) data[match[1].toLowerCase()] = match[2].trim();
  }
  return data;
}

export function parseStatusesFromTasks(tasksText: string): string[] {
  const lines = compactLines(tasksText).split("\n");
  const statuses: string[] = [];
  let inTasks = false;
  let header: string[] | null = null;
  let statusIdx = -1;

  for (const line of lines) {
    const stripped = line.trim();
    if (/^##\s+tasks\b/i.test(stripped)) {
      inTasks = true;
      header = null;
      statusIdx = -1;
      continue;
    }
    if (inTasks && /^##\s+/.test(stripped)) break;
    if (!inTasks || !stripped.startsWith("|")) continue;
    const cols = stripped
      .slice(1, stripped.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((c) => c.trim());
    if (!cols.length) continue;
    if (header === null) {
      header = cols.map((c) => c.toLowerCase());
      statusIdx = header.indexOf("status");
      continue;
    }
    if (cols.every((c) => /^[-: ]*$/.test(c))) continue;
    if (statusIdx < 0 || statusIdx >= cols.length) continue;
    const value = cols[statusIdx].replace(/`/g, "").trim().toLowerCase();
    if (value) statuses.push(value);
  }
  return statuses;
}

function archiveRetentionCutoff(now: Date): number {
  const cutoff = new Date(now.getTime());
  cutoff.setMonth(cutoff.getMonth() - 6);
  return cutoff.getTime();
}

export function pruneOldQuestArchives(
  repoRoot: string,
  now = new Date(),
): string[] {
  const archieveDir = resolve(repoRoot, LOOPO_ARCHIEVE_DIR);
  if (!existsSync(archieveDir)) return [];
  const cutoff = archiveRetentionCutoff(now);
  const deleted: string[] = [];
  for (const name of readdirSync(archieveDir).sort()) {
    const path = join(archieveDir, name);
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    if (!stat.isDirectory() || stat.mtimeMs >= cutoff) continue;
    rmSync(path, { recursive: true, force: true });
    deleted.push(path);
  }
  return deleted;
}

export function isQuestArchiveReady(files: QuestFiles): boolean {
  const statuses = parseStatusesFromTasks(readText(files.tasks));
  if (!statuses.length || !statuses.every((status) => status === "done")) {
    return false;
  }
  const latest = parseLatestHandoffFromText(readText(files.handoffs));
  const stopReason = String(latest?.stop_reason ?? "")
    .trim()
    .toLowerCase();
  return stopReason === "all_done";
}

export function archiveQuestIfComplete(
  repoRoot: string,
  state: LoopoState,
  files: QuestFiles,
  now = new Date(),
): QuestArchiveResult {
  if (!existsSync(files.tasks) || !isQuestArchiveReady(files)) {
    return { archived_slug: null, archived_path: null };
  }
  const sourceDir = dirname(files.tasks);
  const targetDir = resolve(repoRoot, LOOPO_ARCHIEVE_DIR, files.slug);
  mkdirSync(dirname(targetDir), { recursive: true });
  rmSync(targetDir, { recursive: true, force: true });
  renameSync(sourceDir, targetDir);
  utimesSync(targetDir, now, now);
  delete state.quests[files.slug];
  if (state.active_quest_slug === files.slug) state.active_quest_slug = null;
  return { archived_slug: files.slug, archived_path: targetDir };
}

export function findCanonicalQuestFiles(dir: string): string[] {
  const questsDir = join(dir, "quests");
  if (!existsSync(questsDir)) return [];
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of readdirSync(questsDir).sort()) {
    const questDir = join(questsDir, name);
    if (!existsSync(questDir) || !statSync(questDir).isDirectory()) continue;
    const path = join(questDir, "tasks.yaml");
    if (!existsSync(path)) continue;
    files.push({ path, mtimeMs: statSync(path).mtimeMs });
  }
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
    .map((entry) => entry.path);
}

export function updateQuestRegistry(
  state: LoopoState,
  files: QuestFiles,
  workspace?: Partial<QuestWorkspace> | null,
): LoopoState {
  const existing = state.quests[files.slug];
  state.quests[files.slug] = {
    slug: files.slug,
    tasks_path: files.tasks,
    evidence_path: files.evidence,
    handoffs_path: files.handoffs,
    branch_ref: workspace?.branch_ref ?? existing?.branch_ref ?? null,
    worktree_path: workspace?.worktree_path ?? existing?.worktree_path ?? null,
    managed_hashes: managedHashes(files),
    updated_at: nowIso(),
  };
  return state;
}

export function detectManagedDrift(
  state: LoopoState,
  files: QuestFiles,
): { drifted: boolean; files: string[]; hashes: Record<string, string> } {
  const current = managedHashes(files);
  const expected = state.quests[files.slug]?.managed_hashes ?? {};
  const driftedFiles = Object.keys(current).filter(
    (file) => expected[file] && expected[file] !== current[file],
  );
  return {
    drifted: driftedFiles.length > 0,
    files: driftedFiles,
    hashes: current,
  };
}

export function recordReceipt(
  state: LoopoState,
  receipt: LoopoReceipt,
): LoopoState {
  state.receipts = [...state.receipts.slice(-49), receipt];
  return state;
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
