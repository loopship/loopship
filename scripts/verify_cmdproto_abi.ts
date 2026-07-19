#!/usr/bin/env bun

import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSystemScaffold } from "./loopship_core.ts";
import { runCommand } from "./loopship_utils.ts";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "loopship.ts");

function fail(message: string): never {
  throw new Error(message);
}

function parseJson(text: string, label: string): Record<string, any> {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`${label} must be a JSON object: ${text}`);
    }
    return parsed as Record<string, any>;
  } catch (error) {
    fail(`${label} must be JSON: ${error instanceof Error ? error.message : String(error)}\n${text}`);
  }
}

function createRepo(root: string): string {
  const repo = join(root, "repo");
  const git = runCommand("git", ["init", repo], { timeoutMs: 15_000 });
  if (git.status !== 0) fail(git.stderr || git.stdout);
  runCommand("git", ["config", "user.email", "loopship-cmdproto@example.invalid"], {
    cwd: repo,
  });
  runCommand("git", ["config", "user.name", "Loopship Cmdproto"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# cmdproto fixture\n", "utf8");
  runCommand("git", ["add", "README.md"], { cwd: repo });
  const commit = runCommand("git", ["commit", "-m", "cmdproto fixture"], {
    cwd: repo,
    timeoutMs: 15_000,
  });
  if (commit.status !== 0) fail(commit.stderr || commit.stdout);
  return repo;
}

function main(): number {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopship-cmdproto-")));
  try {
    const repo = createRepo(root);
    const help = runCommand("bun", [SCRIPT, "cmdproto", "--help", "--json"], {
      cwd: repo,
      timeoutMs: 30_000,
    });
    if (help.status !== 0) fail(help.stderr || help.stdout);
    const helpJson = parseJson(help.stdout, "cmdproto help");
    if (Object.prototype.hasOwnProperty.call(helpJson, "commands")) {
      fail("cmdproto control help must expose only the execjson control surface");
    }
    const publicHelp = runCommand("bun", [SCRIPT, "--help", "--json"], {
      cwd: repo,
      timeoutMs: 30_000,
    });
    if (publicHelp.status !== 0) fail(publicHelp.stderr || publicHelp.stdout);
    const publicHelpJson = parseJson(publicHelp.stdout, "public cmdproto help");
    const commands = Array.isArray(publicHelpJson.commands) ? publicHelpJson.commands : [];
    const commandPaths = commands.map((entry: any) => String(entry.path ?? "")).sort();
    if (
      JSON.stringify(commandPaths) !==
      JSON.stringify(["doctor", "handbook", "hook", "init", "resume"])
    ) {
      fail(`public cmdproto commands are incomplete: ${JSON.stringify(commandPaths)}`);
    }
    if (commandPaths.some((path: string) => path.startsWith("stepper"))) {
      fail("cmdproto help must not expose stepper as a public ABI command");
    }
    if (!commands.some((entry: any) => String(entry.path ?? "") === "resume")) {
      fail("cmdproto help must expose canonical quest recovery through resume");
    }

    ensureSystemScaffold(repo);
    const missingResume = runCommand(
      "bun",
      [
        SCRIPT,
        "cmdproto",
        "execjson",
        "resume",
        JSON.stringify({ repo, wtree: "missing-quest" }),
      ],
      { cwd: repo, timeoutMs: 30_000 },
    );
    if (missingResume.status === 0) {
      fail("cmdproto resume unexpectedly recovered a missing quest");
    }
    if (!missingResume.stderr.includes("Native recovery requires canonical worktree")) {
      fail(`cmdproto resume did not reject a missing canonical worktree: ${missingResume.stderr}`);
    }

    const handbook = runCommand(
      "bun",
      [
        SCRIPT,
        "cmdproto",
        "execjson",
        "handbook",
        JSON.stringify({ repo, duplicates: true, minChars: 80 }),
      ],
      { cwd: repo, timeoutMs: 30_000 },
    );
    if (handbook.status !== 0) fail(handbook.stderr || handbook.stdout);
    const handbookJson = parseJson(handbook.stdout, "cmdproto handbook duplicates");
    if (!Array.isArray(handbookJson.duplicate_groups)) {
      fail(`cmdproto handbook duplicate output is malformed: ${handbook.stdout}`);
    }

    const hook = runCommand(
      "bun",
      [
        SCRIPT,
        "cmdproto",
        "execjson",
        "hook",
        JSON.stringify({
          repo,
          runtime: "codex",
          payload: {
            session_id: "runtime-thread-not-fastflow",
            cwd: repo,
            hook_event_name: "Stop",
          },
        }),
      ],
      { cwd: repo, timeoutMs: 30_000 },
    );
    if (hook.status !== 0) fail(hook.stderr || hook.stdout);
    const hookJson = parseJson(hook.stdout, "cmdproto hook");
    if (Object.keys(hookJson).length !== 0) {
      fail(`cmdproto runtime hook without a route must no-op: ${hook.stdout}`);
    }

    const emptyHook = runCommand(
      "bun",
      [SCRIPT, "cmdproto", "execjson", "hook", JSON.stringify({ repo, payload: {} })],
      { cwd: repo, timeoutMs: 30_000 },
    );
    if (emptyHook.status !== 0) fail(emptyHook.stderr || emptyHook.stdout);
    if (Object.keys(parseJson(emptyHook.stdout, "empty cmdproto hook")).length !== 0) {
      fail(`cmdproto hook with an empty payload must no-op: ${emptyHook.stdout}`);
    }

    console.log("loopship cmdproto ABI verification passed");
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
