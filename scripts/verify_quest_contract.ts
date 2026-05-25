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
      "--cwd",
      repo,
      "--runtime",
      "codex",
    ]);
    if (init.status !== 0) fail(init.stderr || init.stdout);
    const route = parseJson(init.stdout);
    if (route.kind !== "init_route") fail(`bad init output: ${init.stdout}`);
    const slug = String(route.new_quest.suggested_slug);

    const create = runLoopo(
      repo,
      [
        "quest",
        "next",
        "--slug",
        slug,
        "--cwd",
        repo,
        "--json",
        "@-",
        "--full",
      ],
      {
        step: "select_quest",
        action: "create_quest",
        slug,
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

    const questDir = join(repo, ".loopo", "quests", slug);
    for (const name of [
      "tasks.yaml",
      "plan.yaml",
      "questions.jsonl",
      "plans.jsonl",
      "evidence.jsonl",
      "validation.jsonl",
      "review.jsonl",
      "handoffs.jsonl",
      "hook-events.jsonl",
      "manifest.sign.json",
    ]) {
      if (!existsSync(join(questDir, name))) fail(`missing ${name}`);
    }
    const tasksYaml = readFileSync(join(questDir, "tasks.yaml"), "utf8");
    if (!tasksYaml.includes("schema_version: 3")) {
      fail("tasks.yaml must use v3 state");
    }
    if (tasksYaml.includes("session_id:")) {
      fail("tasks.yaml must not persist public session_id");
    }

    const help = runLoopo(repo, ["quest", "help"]);
    if (help.status !== 0) fail(help.stderr || help.stdout);
    const helpJson = parseJson(help.stdout);
    if (!Array.isArray(helpJson.schemas) || helpJson.schemas.length < 10) {
      fail(`help must list v3 step schemas: ${help.stdout}`);
    }
    if (helpJson.step !== "help" || helpJson.state !== "help") {
      fail(`help must return step-like guidance JSON: ${help.stdout}`);
    }
    if (!helpJson.commands?.hook || !helpJson.commands?.next) {
      fail(`help must include step command catalog: ${help.stdout}`);
    }
    if (!helpJson.guide?.launcher?.includes("loopo init")) {
      fail(`help must include v3 launcher documentation: ${help.stdout}`);
    }
    if (
      !Array.isArray(helpJson.guide.commands) ||
      !helpJson.guide.commands.some(
        (entry: any) => entry.name === "quest next",
      ) ||
      !helpJson.guide.commands.some((entry: any) => entry.name === "hook")
    ) {
      fail(`help must document quest next and hook workflows: ${help.stdout}`);
    }
    if (
      !helpJson.guide?.rules?.includes(
        "Generated hook files only need loopo hook --runtime <runtime>.",
      )
    ) {
      fail(`help must describe compact hook files: ${help.stdout}`);
    }

    const bad = runLoopo(
      repo,
      ["quest", "next", "--slug", slug, "--cwd", repo, "--json", "@-"],
      { step: "child_result" },
    );
    if (bad.status === 0) fail("wrong-step input must fail");

    writeFileSync(
      join(questDir, "tasks.yaml"),
      `${readFileSync(join(questDir, "tasks.yaml"), "utf8")}# tamper\n`,
    );
    const tampered = runLoopo(
      repo,
      ["quest", "next", "--slug", slug, "--cwd", repo, "--json", "@-"],
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
