#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applySystemUpdate,
  ensureSystemScaffold,
} from "./loopship_core.ts";
import { prepareLoopshipNativeChild } from "./loopship_child_lifecycle.ts";
import { runCommand } from "./loopship_utils.ts";

type Status = "pass" | "fail";

type MatrixResult = {
  id: string;
  status: Status;
  evidence: string;
  error?: string;
};

type Fixture = {
  root: string;
  repo: string;
};

type ChildTask = {
  id: string;
  branch: string;
  worktree: string;
  baseCommit: string;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function runGit(cwd: string, args: string[]): string {
  const result = runCommand("git", args, { cwd, timeoutMs: 30_000 });
  assert(result.status === 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function runGitMayFail(cwd: string, args: string[]) {
  return runCommand("git", args, { cwd, timeoutMs: 30_000 });
}

function createFixture(name: string): Fixture {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), `loopship-adversarial-${name}-`)),
  );
  const repo = join(root, "repo");
  const init = runCommand("git", ["init", "-b", "main", repo], { timeoutMs: 30_000 });
  assert(init.status === 0, init.stderr || init.stdout);
  runGit(repo, ["config", "user.email", "loopship-adversarial@example.invalid"]);
  runGit(repo, ["config", "user.name", "Loopship Adversarial"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "worktrees/\ntmp/\n.loopship/runtime/\n", "utf8");
  writeFileSync(join(repo, "src", "base.txt"), "base\n", "utf8");
  ensureSystemScaffold(repo);
  commitAll(repo, "fixture baseline");
  return { root, repo };
}

function commitAll(cwd: string, message: string): string {
  runGit(cwd, ["add", "."]);
  const status = runGit(cwd, ["status", "--short"]);
  if (!status) return runGit(cwd, ["rev-parse", "HEAD"]);
  runGit(cwd, ["commit", "-m", message]);
  return runGit(cwd, ["rev-parse", "HEAD"]);
}

function prepareChild(fixture: Fixture, id: string): ChildTask {
  const branch = `codex/${id}`;
  const worktree = join(fixture.repo, "worktrees", id);
  mkdirSync(join(fixture.repo, "worktrees"), { recursive: true });
  runGit(fixture.repo, ["worktree", "add", "-b", branch, worktree, "main"]);
  return {
    id,
    branch,
    worktree,
    baseCommit: runGit(worktree, ["rev-parse", "HEAD"]),
  };
}

function writeChildCommit(task: ChildTask, content = task.id): string {
  writeFileSync(join(task.worktree, "src", `${task.id}.txt`), `${content}\n`, "utf8");
  return commitAll(task.worktree, `child ${task.id}`);
}

function receiptErrors(task: ChildTask, receipt: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const head = String(receipt.head_commit ?? "");
  const actualHead = runGit(task.worktree, ["rev-parse", "HEAD"]);
  if (head !== actualHead) {
    errors.push(`receipt HEAD ${head || "(empty)"} does not match worktree HEAD ${actualHead}`);
  }
  if (head === task.baseCommit) {
    errors.push("receipt HEAD equals child base commit");
  }
  const reachable = head
    ? runGitMayFail(task.worktree, ["merge-base", "--is-ancestor", head, task.branch]).status === 0
    : false;
  if (!reachable) {
    errors.push(`receipt HEAD ${head || "(empty)"} is not reachable from ${task.branch}`);
  }
  return errors;
}

function worktreeStateErrors(
  repo: string,
  task: { branch_ref: string; worktree_path: string },
): string[] {
  const errors: string[] = [];
  if (!existsSync(task.worktree_path)) {
    errors.push(`missing worktree ${task.worktree_path}`);
    return errors;
  }
  const listed = runGit(repo, ["worktree", "list", "--porcelain"]);
  if (!listed.includes(`worktree ${task.worktree_path}`)) {
    errors.push(`worktree is not registered: ${task.worktree_path}`);
  }
  const branch = runGit(task.worktree_path, ["branch", "--show-current"]);
  if (branch !== task.branch_ref) {
    errors.push(`worktree branch ${branch || "(detached)"} does not match ${task.branch_ref}`);
  }
  return errors;
}

function validationReceiptErrors(receipt: Record<string, unknown>): string[] {
  const checks = Array.isArray(receipt.checks) ? receipt.checks : [];
  const failedChecks = checks.filter((check) => {
    const row = check && typeof check === "object" ? check as Record<string, unknown> : {};
    return row.status !== "passed" || Number(row.exit_code ?? 0) !== 0;
  });
  if (receipt.status === "passed" && failedChecks.length) {
    return ["validation receipt claims pass while at least one check failed"];
  }
  return [];
}

function landingTargetErrors(repo: string, targetBranch: string, targetWorktree: string): string[] {
  const rootRelative = relative(repo, resolve(targetWorktree));
  const escapesRepo = rootRelative.startsWith("..") || rootRelative.startsWith("/");
  const branchUnsafe = targetBranch !== "main" && !targetBranch.startsWith("release/");
  return [
    ...(escapesRepo ? [`landing target worktree escapes repo: ${targetWorktree}`] : []),
    ...(branchUnsafe ? [`landing target branch is not allowed: ${targetBranch}`] : []),
  ];
}

function baseSystemRoot(resourceLocation = ".loopship/docs/decisions/records.yaml") {
  return {
    schema_version: 2,
    id: "tiny-system",
    title: "Tiny System",
    kinds: ["knowledge"],
    text: "Tiny system used for deterministic Loopship lifecycle security fixtures.\n",
    scope_in: ["Deterministic lifecycle verification."],
    scope_out: ["Production deployment and external services."],
    objects: [
      {
        id: "knowledge-base",
        kind: "store",
        text: "Canonical knowledge state owned by the fixture repository.\n",
      },
    ],
    assertions: [
      {
        id: "docs-stay-canonical",
        kind: "rule",
        level: "must",
        text: "Durable fixture documentation must stay inside the Loopship docs tree.\n",
        links: { about: ["object:knowledge-base"] },
      },
    ],
    resources: [
      {
        id: "decisions",
        kind: "document",
        role: "canonical",
        location: resourceLocation,
        schema_ref: "loopship://schemas/docs/decision-records.yaml",
        text: "Decision records for deterministic Loopship security fixture evidence.\n",
        links: { about: ["object:knowledge-base"] },
        media: "application/yaml",
      },
    ],
  };
}

function runScenario(id: string, run: () => string): MatrixResult {
  try {
    return { id, status: "pass", evidence: run() };
  } catch (error) {
    return {
      id,
      status: "fail",
      evidence: "scenario failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const scenarios: Array<[string, () => string]> = [
  [
    "tampered-child-receipt",
    () => {
      const fixture = createFixture("tampered-child-receipt");
      try {
        const task = prepareChild(fixture, "receipt");
        writeChildCommit(task);
        const errors = receiptErrors(task, {
          task_id: task.id,
          head_commit: "0".repeat(40),
        });
        assert(errors.some((error) => error.includes("not reachable")), "tampered receipt was not rejected");
        return errors.join("; ");
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  ],
  [
    "stale-local-work-receipt",
    () => {
      const fixture = createFixture("stale-local-work-receipt");
      try {
        const task = prepareChild(fixture, "stale");
        const firstHead = writeChildCommit(task, "first");
        writeChildCommit(task, "second");
        const errors = receiptErrors(task, { task_id: task.id, head_commit: firstHead });
        assert(errors.some((error) => error.includes("does not match worktree HEAD")), "stale receipt was not rejected");
        return errors.join("; ");
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  ],
  [
    "path-traversal-system-update",
    () => {
      const fixture = createFixture("path-traversal-system-update");
      try {
        const before = readFileSync(join(fixture.repo, ".loopship", "system.yaml"), "utf8");
        const outside = join(fixture.root, "outside.yaml");
        let rejected = false;
        try {
          applySystemUpdate(
            fixture.repo,
            {
              schema_version: 1,
              mode: "replace",
              summary: "attempt path traversal",
              root: baseSystemRoot("../outside.yaml"),
              external_docs: [{ op: "delete", resource_ref: "resource:decisions" }],
            },
            "path-traversal",
          );
        } catch {
          rejected = true;
        }
        assert(rejected, "path traversal update was accepted");
        assert(!existsSync(outside), "path traversal wrote outside repo");
        assert(readFileSync(join(fixture.repo, ".loopship", "system.yaml"), "utf8") === before, "root changed after rejected update");
        return "rejected before writing outside repo or changing .loopship/system.yaml";
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  ],
  [
    "secret-leakage-system-doc",
    () => {
      const fixture = createFixture("secret-leakage-system-doc");
      try {
        const before = readFileSync(join(fixture.repo, ".loopship", "system.yaml"), "utf8");
        let rejected = false;
        try {
          applySystemUpdate(
            fixture.repo,
            {
              schema_version: 1,
              mode: "replace",
              summary: "attempt secret persistence",
              root: {
                ...baseSystemRoot(),
                text: "Attempt to persist api_key = sk-1234567890abcdefghijklmnopqrstuv in docs.\n",
              },
            },
            "secret-leakage",
          );
        } catch {
          rejected = true;
        }
        assert(rejected, "token-like secret material was accepted");
        assert(readFileSync(join(fixture.repo, ".loopship", "system.yaml"), "utf8") === before, "root changed after rejected secret");
        return "token-like secret material rejected before durable write";
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  ],
  [
    "native-child-identity",
    () => {
      const fixture = createFixture("native-child-identity");
      try {
        const parent = prepareChild(fixture, "parent");
        const rejectedFields: string[] = [];
        for (const [field, value] of [
          ["branch_ref", "codex/attacker-controlled"],
          ["worktree_path", join(fixture.root, "attacker-controlled")],
        ] as const) {
          let message = "";
          try {
            prepareLoopshipNativeChild({
              repo: fixture.repo,
              wtree: "parent",
              target_branch: parent.branch,
              target_worktree: parent.worktree,
              dry_run: true,
              task: {
                id: "t001",
                title: "Verify canonical Native child identity",
                [field]: value,
              },
            });
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          assert(
            message.includes(`non-canonical ${field}`),
            `conflicting Native child ${field} was not rejected: ${message || "no error"}`,
          );
          rejectedFields.push(field);
        }
        return `rejected conflicting ${rejectedFields.join(" and ")} identities`;
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  ],
  [
    "tampered-worktree-state",
    () => {
      const fixture = createFixture("tampered-worktree-state");
      try {
        const task = prepareChild(fixture, "state");
        const errors = worktreeStateErrors(fixture.repo, {
          branch_ref: "codex/expected-state",
          worktree_path: task.worktree,
        });
        assert(errors.some((error) => error.includes("does not match")), "tampered worktree state was not rejected");
        return errors.join("; ");
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  ],
  [
    "poisoned-validation",
    () => {
      const errors = validationReceiptErrors({
        schema_version: "loopship.validation.receipt/v1",
        status: "passed",
        checks: [{ name: "test", status: "failed", exit_code: 1 }],
      });
      assert(errors.length > 0, "poisoned validation receipt was accepted");
      return errors.join("; ");
    },
  ],
  [
    "unsafe-landing-target",
    () => {
      const fixture = createFixture("unsafe-landing-target");
      try {
        const errors = landingTargetErrors(fixture.repo, "main", resolve(fixture.root, "..", "outside-target"));
        assert(errors.some((error) => error.includes("escapes repo")), "unsafe landing target was not rejected");
        return errors.join("; ");
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  ],
];

const results = scenarios.map(([id, run]) => runScenario(id, run));
const lines = [
  "# Lifecycle Adversarial Matrix",
  "",
  "| Scenario | Status | Evidence |",
  "| --- | --- | --- |",
  ...results.map(
    (result) =>
      `| ${result.id} | ${result.status} | ${(result.error || result.evidence).replace(/\|/g, "/")} |`,
  ),
  "",
  `Package root: ${PACKAGE_ROOT}`,
  "",
];

process.stdout.write(lines.join("\n"));
if (results.some((result) => result.status !== "pass")) {
  process.exitCode = 1;
}
