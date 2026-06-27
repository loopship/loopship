#!/usr/bin/env bun

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./loopship_utils.ts";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "loopship.ts");

function fail(message: string): never {
  throw new Error(message);
}

function runLoopship(
  repo: string,
  args: string[],
  input?: Record<string, unknown>,
) {
  return runCommand("bun", [SCRIPT, ...args], {
    cwd: repo,
    timeoutMs: 60_000,
    input: input ? JSON.stringify(input) : undefined,
  });
}

function parseJson(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    fail(`expected JSON output, got: ${stdout}`);
  }
}

function readJsonFile(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main(): number {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopship-v3-")));
  const repo = join(root, "repo");
  try {
    const git = runCommand("git", ["init", repo], { timeoutMs: 15_000 });
    if (git.status !== 0) fail(git.stderr || git.stdout);
    runCommand("git", ["config", "user.email", "loopship-test@example.invalid"], {
      cwd: repo,
    });
    runCommand("git", ["config", "user.name", "Loopship Test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "# loopship v3\n", "utf8");
    runCommand("git", ["add", "README.md"], { cwd: repo });
    runCommand("git", ["commit", "-m", "fixture"], { cwd: repo });

    const init = runLoopship(repo, [
      "init",
      "loopship: verify deterministic v3",
      "--runtime",
      "codex",
    ]);
    if (init.status !== 0) fail(init.stderr || init.stdout);
    const route = parseJson(init.stdout);
    if (route.kind !== "init_route") fail(`bad init output: ${init.stdout}`);
    const wtree = String(route.new_quest.suggested_wtree);

    const create = runLoopship(
      repo,
      [
        "resume",
        "--wtree",
        wtree,
        "--json",
        "@-",
        "--full",
      ],
      {
        step: "select_quest",
        action: "create_quest",
        wtree,
        request: "loopship: verify deterministic v3",
      },
    );
    if (create.status !== 0) fail(create.stderr || create.stdout);
    const created = parseJson(create.stdout);
    if (created.step !== "plan")
      fail(`create should return plan: ${create.stdout}`);
    if ("session_id" in created || "expected_update" in created) {
      fail(`v3 output leaked v2 fields: ${create.stdout}`);
    }

    const rootQuestDir = join(repo, ".loopship", "quests", wtree);
    if (existsSync(rootQuestDir)) {
      fail(`quest state must be worktree-local, found root state: ${rootQuestDir}`);
    }
    const questDir = join(repo, "worktrees", wtree, ".loopship", "runtime");
    for (const name of [
      "tasks.yaml",
      "events.jsonl",
      "manifest.yaml",
      "hook-state.json",
    ]) {
      if (!existsSync(join(questDir, name))) fail(`missing ${name}`);
    }
    for (const legacy of [
      "manifest.sign.json",
      "plan.yaml",
      "questions.jsonl",
      "plans.jsonl",
      "evidence.jsonl",
      "validation.jsonl",
      "review.jsonl",
      "handoffs.jsonl",
      "hook-events.jsonl",
    ]) {
      if (existsSync(join(questDir, legacy))) fail(`unexpected legacy file ${legacy}`);
    }
    const tasksYaml = readFileSync(join(questDir, "tasks.yaml"), "utf8");
    if (!tasksYaml.includes("schema_version: 4")) {
      fail("tasks.yaml must use v4 state");
    }
    if (tasksYaml.includes("session_id:")) {
      fail("tasks.yaml must not persist public session_id");
    }
    const hookStatePath = join(questDir, "hook-state.json");
    const hookStateAfterCreate = readJsonFile(hookStatePath);
    const planSession = hookStateAfterCreate.fastflow_sessions?.["step:plan"];
    if (!planSession?.session_id || !planSession?.nonce) {
      fail("create must persist a native Fastflow session for the plan step");
    }
    if (planSession.workflow_ref !== "loopship.workflow.service.flows.swe") {
      fail(`plan session used wrong workflow ref: ${planSession.workflow_ref}`);
    }
    if (
      !existsSync(
        join(
          repo,
          ".loopship",
          "call-catalog",
          "loopship",
          "workflow",
          "service",
          "step",
          "plan.stable.yaml",
        ),
      )
    ) {
      fail("missing generated Loopship-owned Fastflow step catalog");
    }
    if (
      !existsSync(
        join(
          repo,
          ".loopship",
          "call-catalog",
          "loopship",
          "workflow",
          "service",
          "step",
          "index.yaml",
        ),
      )
    ) {
      fail("missing generated Loopship-owned Fastflow step index");
    }
    if (
      !existsSync(
        join(
          repo,
          ".loopship",
          "call-catalog",
          "loopship",
          "workflow",
          "service",
          "flows",
          "swe.stable.yaml",
        ),
      )
    ) {
      fail("missing generated Loopship-owned Fastflow flow catalog");
    }
    if (
      existsSync(
        join(
          repo,
          ".loopship",
          "call-catalog",
          "loopship",
          "workflow",
          "service",
          "step",
          "step",
        ),
      ) ||
      existsSync(
        join(
          repo,
          ".loopship",
          "call-catalog",
          "loopship",
          "workflow",
          "service",
          "flows",
          "flows",
        ),
      )
    ) {
      fail("generated Loopship workflow catalog must not duplicate scope directories");
    }
    if (
      existsSync(
        join(
          repo,
          ".loopship",
          "call-catalog",
          "loopship",
          "workflow",
          "service",
          "flows",
          "resume.stable.yaml",
        ),
      )
    ) {
      fail("resume must not be modeled as a generated Loopship workflow");
    }

    const validPlan = runLoopship(
      repo,
      ["resume", "--wtree", wtree, "--json", "@-", "--full"],
      {
        step: "plan",
        classification: "greenfield_app",
        scope: "Verify deterministic v3 flow",
        summary: "Ask one required clarification before task decomposition.",
        high_impact_unknowns: ["preferred implementation detail"],
        defaulted_unknowns: [],
        questions: [
          {
            id: "q1",
            question: "Which implementation detail should be preferred?",
          },
        ],
        system_context: {
          relevant_object_refs: [],
          relevant_assertion_refs: [],
          relevant_resource_refs: [],
          relevant_memory_refs: [],
          durable_implications: [],
        },
        verification_targets: ["quest state remains deterministic"],
        task_graph: { tasks: [] },
      },
    );
    if (validPlan.status !== 0) fail(validPlan.stderr || validPlan.stdout);
    const planned = parseJson(validPlan.stdout);
    if (planned.step !== "questions") {
      fail(`valid plan should return questions: ${validPlan.stdout}`);
    }
    const hookStateAfterPlan = readJsonFile(hookStatePath);
    if (hookStateAfterPlan.fastflow_sessions?.["step:plan"]) {
      fail("plan Fastflow session must be consumed by native resume");
    }
    const questionsSession = hookStateAfterPlan.fastflow_sessions?.["step:questions"];
    if (!questionsSession?.session_id || !questionsSession?.nonce) {
      fail("plan continuation must start a native Fastflow session for questions");
    }
    if (questionsSession.workflow_ref !== "loopship.workflow.service.flows.swe") {
      fail(`questions session used wrong workflow ref: ${questionsSession.workflow_ref}`);
    }

    const removedHelp = runLoopship(repo, ["quest", "help"]);
    if (removedHelp.status === 0) {
      fail("quest help must be removed from the public command surface");
    }
    if (!removedHelp.stdout.includes("Usage:")) {
      fail(`removed quest help must print usage: ${removedHelp.stdout}`);
    }

    const bad = runLoopship(
      repo,
      ["resume", "--wtree", wtree, "--json", "@-"],
      { step: "child_result" },
    );
    if (bad.status === 0) fail("wrong-step input must fail");

    writeFileSync(
      join(questDir, "tasks.yaml"),
      `${readFileSync(join(questDir, "tasks.yaml"), "utf8")}# tamper\n`,
    );
    const tampered = runLoopship(
      repo,
      ["resume", "--wtree", wtree, "--json", "@-"],
      {},
    );
    if (tampered.status === 0) fail("tampered YAML must block continuation");

    console.log("loopship quest v3 verification passed");
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
