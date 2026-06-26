#!/usr/bin/env bun

import {
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

function parseJson(text: string): Record<string, any> {
  try {
    return JSON.parse(text);
  } catch {
    fail(`expected JSON: ${text}`);
  }
}

function assertHookNoop(label: string, hook: ReturnType<typeof runLoopship>): void {
  if (hook.status !== 0) fail(hook.stderr || hook.stdout);
  if (hook.stdout.trim() !== "{}") {
    fail(`${label} must emit an empty object: ${hook.stdout}`);
  }
}

function assertHookContinuation(
  label: string,
  hook: ReturnType<typeof runLoopship>,
): Record<string, any> {
  if (hook.status !== 0) fail(hook.stderr || hook.stdout);
  const parsed = parseJson(hook.stdout);
  const reason = parseJson(String(parsed.reason ?? ""));
  const step =
    typeof reason.step === "string"
      ? reason.step
      : String(reason.step?.id ?? "");
  if (
    parsed.decision !== "block" ||
    reason.command !== "fastflow.resume" ||
    step !== "plan"
  ) {
    fail(`${label} must wrap Fastflow resume output: ${hook.stdout}`);
  }
  return { parsed, reason };
}

function collectHookCommands(
  value: unknown,
  commands: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectHookCommands(item, commands);
    return commands;
  }
  if (!value || typeof value !== "object") return commands;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      (key === "command" || key === "bash") &&
      typeof child === "string" &&
      child.trim()
    ) {
      commands.push(child);
      continue;
    }
    collectHookCommands(child, commands);
  }
  return commands;
}

function normalizeCommand(command: string): string {
  return command.replace(/['"]/g, " ").replace(/\s+/g, " ").trim();
}

function assertSimpleHookConfig(
  label: string,
  config: unknown,
  runtime: string,
) {
  const commands = collectHookCommands(config).map(normalizeCommand);
  if (!commands.length) fail(`${label} must include hook commands`);
  if (!commands.some((cmd) => cmd.includes(`hook --runtime ${runtime}`))) {
    fail(
      `${label} must use the simplified hook command: ${commands.join(" | ")}`,
    );
  }
  if (commands.some((cmd) => cmd.includes("--json"))) {
    fail(`${label} must not require --json: ${commands.join(" | ")}`);
  }
  if (commands.some((cmd) => cmd.includes("node -e"))) {
    fail(`${label} must not shell through node -e: ${commands.join(" | ")}`);
  }
  if (commands.some((cmd) => cmd.includes("--cwd") || cmd.includes("--repo"))) {
    fail(`${label} must not embed a repo path: ${commands.join(" | ")}`);
  }
}

function main(): number {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopship-v3-hooks-")));
  const repo = join(root, "repo");
  try {
    const git = runCommand("git", ["init", repo], { timeoutMs: 15_000 });
    if (git.status !== 0) fail(git.stderr || git.stdout);
    runCommand("git", ["config", "user.email", "loopship-test@example.invalid"], {
      cwd: repo,
    });
    runCommand("git", ["config", "user.name", "Loopship Test"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "# loopship hooks\n", "utf8");
    runCommand("git", ["add", "README.md"], { cwd: repo });
    runCommand("git", ["commit", "-m", "fixture"], { cwd: repo });

    const init = runLoopship(repo, [
      "init",
      "loopship: hook check",
      "--runtime",
      "all",
    ]);
    if (init.status !== 0) fail(init.stderr || init.stdout);
    const wtree = String(parseJson(init.stdout).new_quest.suggested_wtree);
    const create = runLoopship(
      repo,
      ["resume", "--wtree", wtree, "--json", "@-"],
      {
        step: "select_quest",
        action: "create_quest",
        wtree,
        request: "loopship: hook check",
      },
    );
    if (create.status !== 0) fail(create.stderr || create.stdout);
    const otherWtree = "hook-check-other";
    const createOther = runLoopship(
      repo,
      ["resume", "--wtree", otherWtree, "--json", "@-"],
      {
        step: "select_quest",
        action: "create_quest",
        wtree: otherWtree,
        request: "loopship: other hook check",
      },
    );
    if (createOther.status !== 0) fail(createOther.stderr || createOther.stdout);

    assertSimpleHookConfig(
      ".codex/hooks.json",
      parseJson(readFileSync(join(repo, ".codex", "hooks.json"), "utf8")),
      "codex",
    );
    assertSimpleHookConfig(
      ".gemini/settings.json",
      parseJson(readFileSync(join(repo, ".gemini", "settings.json"), "utf8")),
      "gemini",
    );
    assertSimpleHookConfig(
      ".github/hooks/loopship.json",
      parseJson(
        readFileSync(join(repo, ".github", "hooks", "loopship.json"), "utf8"),
      ),
      "copilot",
    );

    assertHookNoop(
      "repo-root hook with multiple quests",
      runLoopship(repo, ["hook", "--runtime", "codex"], {
        cwd: repo,
        hook_event_name: "RootStop",
      }),
    );

    const matching = assertHookContinuation(
      "explicit wtree plus matching cwd hook",
      runLoopship(repo, ["hook", "--runtime", "codex", "--wtree", wtree], {
        cwd: join(repo, "worktrees", wtree),
        hook_event_name: "ExplicitMatchStop",
      }),
    );
    if (matching.reason.wtree) {
      fail(`compact hook reason must omit full wtree metadata: ${JSON.stringify(matching.reason)}`);
    }

    assertHookNoop(
      "explicit wtree plus conflicting cwd hook",
      runLoopship(repo, ["hook", "--runtime", "codex", "--wtree", wtree], {
        cwd: join(repo, "worktrees", otherWtree),
        hook_event_name: "ExplicitConflictStop",
      }),
    );

    assertHookNoop(
      "missing selector hook",
      runLoopship(repo, ["hook", "--runtime", "codex", "--repo", repo], {
        hook_event_name: "MissingSelectorStop",
      }),
    );

    const hook = runLoopship(repo, ["hook", "--runtime", "codex"], {
      cwd: join(repo, "worktrees", wtree),
      hook_event_name: "Stop",
    });
    const { reason } = assertHookContinuation("cwd-derived hook", hook);
    if (
      "schema_version" in reason ||
      "kind" in reason ||
      "schema_path" in reason ||
      ["sl", "ug"].join("") in reason ||
      "flow_id" in reason ||
      "flow_version" in reason ||
      "state" in reason ||
      "summary" in reason ||
      "context" in reason ||
      "docs" in reason ||
      "allowed_transitions" in reason
    ) {
      fail(`hook resume output must stay compact: ${hook.stdout}`);
    }
    if (
      reason.step &&
      typeof reason.step === "object" &&
      "summary" in reason.step
    ) {
      fail(`hook resume step must omit summary: ${hook.stdout}`);
    }
    if (
      !reason.output_schema ||
      typeof reason.output_schema !== "object" ||
      reason.output_schema.$id !==
        "schemas/steps/plan-input.yaml"
    ) {
      fail(`hook resume output must embed output schema: ${hook.stdout}`);
    }
    if ("input_schema" in reason) {
      fail(`hook resume output must use output_schema: ${hook.stdout}`);
    }

    const duplicate = runLoopship(repo, ["hook", "--runtime", "codex"], {
      cwd: join(repo, "worktrees", wtree),
      hook_event_name: "Stop",
    });
    if (duplicate.status !== 0) fail(duplicate.stderr || duplicate.stdout);
    if (duplicate.stdout.trim() !== "{}") {
      fail(`duplicate hook event must be suppressed: ${duplicate.stdout}`);
    }

    const copilot = runLoopship(repo, ["hook", "--runtime", "copilot"], {
      cwd: join(repo, "worktrees", wtree),
      hook_event_name: "Stop",
    });
    if (copilot.status !== 0) fail(copilot.stderr || copilot.stdout);
    const copilotJson = parseJson(copilot.stdout);
    if (!copilotJson.hookSpecificOutput) {
      fail(`copilot hook must include hookSpecificOutput: ${copilot.stdout}`);
    }

    console.log("loopship v3 hook verification passed");
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
