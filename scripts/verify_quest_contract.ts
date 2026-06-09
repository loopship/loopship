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
import { runCommand } from "./loopo_utils.ts";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "loopo.ts");

function fail(message: string): never {
  throw new Error(message);
}

function runLoopo(
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

function main(): number {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopo-v3-")));
  const repo = join(root, "repo");
  try {
    const git = runCommand("git", ["init", repo], { timeoutMs: 15_000 });
    if (git.status !== 0) fail(git.stderr || git.stdout);
    runCommand("git", ["config", "user.email", "loopo-test@example.invalid"], {
      cwd: repo,
    });
    runCommand("git", ["config", "user.name", "Loopo Test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "# loopo v3\n", "utf8");
    runCommand("git", ["add", "README.md"], { cwd: repo });
    runCommand("git", ["commit", "-m", "fixture"], { cwd: repo });

    const init = runLoopo(repo, [
      "init",
      "loopo: verify deterministic v3",
      "--runtime",
      "codex",
    ]);
    if (init.status !== 0) fail(init.stderr || init.stdout);
    const route = parseJson(init.stdout);
    if (route.kind !== "init_route") fail(`bad init output: ${init.stdout}`);
    const wtree = String(route.new_quest.suggested_wtree);

    const create = runLoopo(
      repo,
      [
        "quest",
        "next",
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
        request: "loopo: verify deterministic v3",
      },
    );
    if (create.status !== 0) fail(create.stderr || create.stdout);
    const created = parseJson(create.stdout);
    if (created.step !== "plan")
      fail(`create should return plan: ${create.stdout}`);
    if ("session_id" in created || "expected_update" in created) {
      fail(`v3 output leaked v2 fields: ${create.stdout}`);
    }

    const rootQuestDir = join(repo, ".loopo", "quests", wtree);
    if (existsSync(rootQuestDir)) {
      fail(`quest state must be worktree-local, found root state: ${rootQuestDir}`);
    }
    const questDir = join(repo, "worktrees", wtree, ".loopo", "runtime");
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

    const removedHelp = runLoopo(repo, ["quest", "help"]);
    if (removedHelp.status === 0) {
      fail("quest help must be removed from the public command surface");
    }
    if (!removedHelp.stdout.includes("Usage:")) {
      fail(`removed quest help must print usage: ${removedHelp.stdout}`);
    }

    const bad = runLoopo(
      repo,
      ["quest", "next", "--wtree", wtree, "--json", "@-"],
      { step: "child_result" },
    );
    if (bad.status === 0) fail("wrong-step input must fail");

    writeFileSync(
      join(questDir, "tasks.yaml"),
      `${readFileSync(join(questDir, "tasks.yaml"), "utf8")}# tamper\n`,
    );
    const tampered = runLoopo(
      repo,
      ["quest", "next", "--wtree", wtree, "--json", "@-"],
      {},
    );
    if (tampered.status === 0) fail("tampered YAML must block continuation");

    console.log("loopo quest v3 verification passed");
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
