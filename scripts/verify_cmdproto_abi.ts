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
import { createLoopshipShim, questFiles } from "./loopship_core.ts";
import { runCommand } from "./loopship_utils.ts";
import { validateSchemaPath, v3SchemaPath } from "./loopship_schema.ts";
import { DEFAULT_RUNTIME_REQUEST } from "./runtime_supervisor.ts";
import { scenarioPayloadForStep } from "./sim_product_quest_scenarios.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "loopship.ts");
const ENTRYPOINT = resolve(ROOT, "index.ts");

type Fixture = {
  root: string;
  repo: string;
  env: Record<string, string>;
};

function fail(message: string): never {
  throw new Error(message);
}

function parseJson(text: string): Record<string, any> {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("expected a JSON object");
    }
    return parsed as Record<string, any>;
  } catch (error) {
    fail(
      `invalid JSON output: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function expectSchema(payload: Record<string, any>, schemaPath: string): void {
  const errors = validateSchemaPath(payload, schemaPath);
  if (errors.length) {
    fail(`${schemaPath} validation failed: ${errors.join("; ")}`);
  }
}

function stepId(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const id = (value as Record<string, unknown>).id;
    return typeof id === "string" ? id : "";
  }
  return "";
}

function runLoopship(
  repo: string,
  args: string[],
  input: Record<string, unknown> | undefined,
  env: Record<string, string>,
) {
  return runCommand("node", [ENTRYPOINT, ...args], {
    cwd: repo,
    env,
    input: input === undefined ? undefined : `${JSON.stringify(input)}\n`,
    timeoutMs: 120_000,
  });
}

function runGit(
  repo: string,
  args: string[],
  env: Record<string, string> = {},
): void {
  const proc = runCommand("git", args, { cwd: repo, env, timeoutMs: 15_000 });
  if (proc.status !== 0) fail(proc.stderr || proc.stdout || `git ${args.join(" ")} failed`);
}

function createFixture(prefix: string): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repo = join(root, "repo");
  const env = {
    HOME: join(root, "home"),
    LOOPSHIP_GLOBAL_BIN: join(root, "bin", "loopship"),
    LOOPSHIP_SCRIPT: SCRIPT,
  };
  const initGit = runCommand("git", ["init", repo], { timeoutMs: 15_000 });
  if (initGit.status !== 0) fail(initGit.stderr || initGit.stdout);
  runGit(repo, ["config", "user.email", "loopship-test@example.invalid"], env);
  runGit(repo, ["config", "user.name", "Loopship Cmdproto"], env);
  writeFileSync(join(repo, "README.md"), "# loopship cmdproto fixture\n", "utf8");
  runGit(repo, ["add", "README.md"], env);
  runGit(repo, ["commit", "-m", "fixture"], env);
  return { root, repo, env };
}

function prepareExistingGitRepoFixture(
  repo: string,
  env: Record<string, string>,
): void {
  const initGit = runCommand("git", ["init", repo], { timeoutMs: 15_000 });
  if (initGit.status !== 0) fail(initGit.stderr || initGit.stdout);
  runGit(repo, ["config", "user.email", "loopship-sim@example.invalid"], env);
  runGit(repo, ["config", "user.name", "Loopship Sim Fixture"], env);
  runGit(repo, ["checkout", "-B", "main"], env);
  runGit(repo, ["commit", "--allow-empty", "-m", "sim fixture"], env);
}

function main(): number {
  const help = runLoopship(
    process.cwd(),
    ["--help", "--json"],
    undefined,
    process.env as Record<string, string>,
  );
  if (help.status !== 0) fail(help.stderr || help.stdout);
  const helpJson = parseJson(help.stdout);
  const commandPaths = Array.isArray(helpJson.commands)
    ? helpJson.commands.map((entry: any) => String(entry.path))
    : [];
  const expectedPaths = [
    "doctor",
    "handbook",
    "hook",
    "init",
    "quest next",
    "sim hook",
    "sim init",
    "sim quest next",
  ];
  if (JSON.stringify(commandPaths.sort()) !== JSON.stringify(expectedPaths.sort())) {
    fail(
      `cmdproto help must expose ${expectedPaths.join(", ")}; got ${commandPaths.join(", ")}`,
    );
  }
  if (helpJson.execjson?.usage !== "cmdproto execjson <path> <json|@file|@->") {
    fail(`unexpected root execjson usage: ${JSON.stringify(helpJson.execjson)}`);
  }

  const controlHelp = runLoopship(
    process.cwd(),
    ["cmdproto", "--help", "--json"],
    undefined,
    process.env as Record<string, string>,
  );
  if (controlHelp.status !== 0) fail(controlHelp.stderr || controlHelp.stdout);
  const controlHelpJson = parseJson(controlHelp.stdout);
  if (controlHelpJson.execjson?.usage !== "cmdproto execjson <path> <json|@file|@->") {
    fail(`unexpected cmdproto control help: ${JSON.stringify(controlHelpJson.execjson)}`);
  }
  const controlHelpText = runLoopship(
    process.cwd(),
    ["cmdproto", "--help"],
    undefined,
    process.env as Record<string, string>,
  );
  if (controlHelpText.status !== 0) fail(controlHelpText.stderr || controlHelpText.stdout);
  if (!controlHelpText.stdout.includes("cmdproto execjson <path> <json|@file|@->")) {
    fail(`unexpected cmdproto text help: ${JSON.stringify(controlHelpText.stdout)}`);
  }

  const handbook = runLoopship(
    process.cwd(),
    ["handbook", "--repo", process.cwd()],
    undefined,
    process.env as Record<string, string>,
  );
  if (handbook.status !== 0) fail(handbook.stderr || handbook.stdout);
  if (!handbook.stdout.startsWith("handbook: file://")) {
    fail(`handbook must print a file URL: ${JSON.stringify(handbook.stdout)}`);
  }
  const handbookUrl = handbook.stdout.trim().slice("handbook: ".length);
  const handbookPath = fileURLToPath(handbookUrl);
  if (!existsSync(handbookPath)) {
    fail(`handbook file must exist: ${handbookPath}`);
  }
  const handbookMarkdown = readFileSync(handbookPath, "utf8");
    if (
      !handbookMarkdown.includes("# Loopship Handbook") ||
      !handbookMarkdown.includes("# Software Architecture")
    ) {
      fail(`handbook file missing rendered sections: ${handbookMarkdown.slice(0, 400)}`);
    }
    if (handbookMarkdown.includes("\n## Text\n")) {
      fail("handbook must render document text as introductory prose, not a raw Text section");
    }

  const rawHandbook = runLoopship(
    process.cwd(),
    ["handbook", "--repo", process.cwd(), "--raw"],
    undefined,
    process.env as Record<string, string>,
  );
  if (rawHandbook.status !== 0) fail(rawHandbook.stderr || rawHandbook.stdout);
    if (
      !rawHandbook.stdout.includes("# Loopship Handbook") ||
      !rawHandbook.stdout.includes("# Workflow Specification")
    ) {
      fail(`raw handbook must print Markdown: ${rawHandbook.stdout.slice(0, 400)}`);
    }
  if (rawHandbook.stdout.includes("\n## Text\n")) {
    fail("raw handbook must not render document text as a raw Text section");
  }

  const duplicateReport = runLoopship(
    process.cwd(),
    ["handbook", "--repo", process.cwd(), "--duplicates", "--json"],
    undefined,
    process.env as Record<string, string>,
  );
  if (duplicateReport.status !== 0) fail(duplicateReport.stderr || duplicateReport.stdout);
  const duplicateReportJson = parseJson(duplicateReport.stdout);
  if (
    duplicateReportJson.duplicate_count !== 0 ||
    !Array.isArray(duplicateReportJson.duplicate_groups)
  ) {
    fail(`handbook duplicate report must be empty for canonical sources: ${duplicateReport.stdout}`);
  }

  const cmdprotoHandbook = runLoopship(
    process.cwd(),
    [
      "cmdproto",
      "execjson",
      "handbook",
      JSON.stringify({
        repo: process.cwd(),
      }),
    ],
    undefined,
    process.env as Record<string, string>,
  );
  if (cmdprotoHandbook.status !== 0) {
    fail(cmdprotoHandbook.stderr || cmdprotoHandbook.stdout);
  }
  const cmdprotoHandbookJson = parseJson(cmdprotoHandbook.stdout);
  if (
    typeof cmdprotoHandbookJson.file_url !== "string" ||
    !String(cmdprotoHandbookJson.file_url).startsWith("file://") ||
    typeof cmdprotoHandbookJson.path !== "string" ||
    !existsSync(String(cmdprotoHandbookJson.path))
  ) {
    fail(`cmdproto handbook must return path and file_url: ${cmdprotoHandbook.stdout}`);
  }

  const cmdprotoRawHandbook = runLoopship(
    process.cwd(),
    [
      "cmdproto",
      "execjson",
      "handbook",
      JSON.stringify({
        repo: process.cwd(),
        raw: true,
      }),
    ],
    undefined,
    process.env as Record<string, string>,
  );
  if (cmdprotoRawHandbook.status !== 0) {
    fail(cmdprotoRawHandbook.stderr || cmdprotoRawHandbook.stdout);
  }
  const cmdprotoRawJson = parseJson(cmdprotoRawHandbook.stdout);
  if (
    typeof cmdprotoRawJson.markdown !== "string" ||
    !cmdprotoRawJson.markdown.includes("# Agent System Card")
  ) {
    fail(`cmdproto raw handbook must return Markdown JSON: ${cmdprotoRawHandbook.stdout}`);
  }

  const cmdprotoDuplicateReport = runLoopship(
    process.cwd(),
    [
      "cmdproto",
      "execjson",
      "handbook",
      JSON.stringify({
        repo: process.cwd(),
        duplicates: true,
      }),
    ],
    undefined,
    process.env as Record<string, string>,
  );
  if (cmdprotoDuplicateReport.status !== 0) {
    fail(cmdprotoDuplicateReport.stderr || cmdprotoDuplicateReport.stdout);
  }
  const cmdprotoDuplicateJson = parseJson(cmdprotoDuplicateReport.stdout);
  if (
    cmdprotoDuplicateJson.duplicate_count !== 0 ||
    !Array.isArray(cmdprotoDuplicateJson.duplicate_groups)
  ) {
    fail(`cmdproto handbook duplicate report must be JSON: ${cmdprotoDuplicateReport.stdout}`);
  }

  const fixture = createFixture("loopship-cmdproto-");
  try {
    createLoopshipShim(fixture.env.LOOPSHIP_GLOBAL_BIN, SCRIPT);
    const shimUsage = runCommand(fixture.env.LOOPSHIP_GLOBAL_BIN, [], {
      cwd: fixture.repo,
      env: fixture.env,
      timeoutMs: 120_000,
    });
    if (shimUsage.status !== 1) {
      fail(`loopship shim without args must exit 1; got ${shimUsage.status}`);
    }
    if (!shimUsage.stdout.includes("Usage:")) {
      fail(`loopship shim without args must print usage; got ${JSON.stringify(shimUsage.stdout)}`);
    }

    const removedHelp = runLoopship(
      fixture.repo,
      ["cmdproto", "execjson", "quest", "help", "{}"],
      undefined,
      fixture.env,
    );
    if (removedHelp.status === 0) {
      fail("cmdproto quest help must be removed");
    }
    const removedSimHelp = runLoopship(
      fixture.repo,
      ["cmdproto", "execjson", "sim", "quest", "help", "{}"],
      undefined,
      fixture.env,
    );
    if (removedSimHelp.status === 0) {
      fail("cmdproto sim quest help must be removed");
    }

    const init = runLoopship(
      fixture.repo,
      [
        "cmdproto",
        "execjson",
        "init",
        JSON.stringify({
          request: "loopship: build the app",
          repo: fixture.repo,
          runtime: "codex",
          flow: "swe",
        }),
      ],
      undefined,
      fixture.env,
    );
    if (init.status !== 0) fail(init.stderr || init.stdout);
    const route = parseJson(init.stdout);
    expectSchema(route as Record<string, any>, v3SchemaPath("init-output"));

    const newQuest = route.new_quest as Record<string, any> | undefined;
    if (!newQuest || typeof newQuest !== "object") fail("init route missing new_quest");
    const wtree = String(newQuest.suggested_wtree ?? "");
    if (!wtree) fail("init route missing suggested_wtree");
    const nextPayload = newQuest.input as Record<string, unknown> | undefined;
    if (!nextPayload || typeof nextPayload !== "object") {
      fail("init route missing next input payload");
    }

    const next = runLoopship(
      fixture.repo,
      [
        "cmdproto",
        "execjson",
        "quest",
        "next",
        JSON.stringify({
          wtree,
          repo: fixture.repo,
          payload: nextPayload,
        }),
      ],
      undefined,
      fixture.env,
    );
    if (next.status !== 0) fail(next.stderr || next.stdout);
    const step = parseJson(next.stdout);
    expectSchema(step as Record<string, any>, v3SchemaPath("step-output"));

    const files = questFiles(fixture.repo, wtree);
    if (!existsSync(files.tasks)) {
      fail("cmdproto quest next must create worktree-local canonical quest state");
    }

    const simRepo = join(fixture.root, "sim-repo");
    prepareExistingGitRepoFixture(simRepo, fixture.env);
    const simStart = runLoopship(
      fixture.repo,
      [
        "cmdproto",
        "execjson",
        "sim",
        "init",
        JSON.stringify({
          request: DEFAULT_RUNTIME_REQUEST,
          repo: simRepo,
          runtime: "codex",
          flow: "swe",
        }),
      ],
      undefined,
      fixture.env,
    );
    if (simStart.status !== 0) fail(simStart.stderr || simStart.stdout);
    const simStarted = parseJson(simStart.stdout);
    if (stepId(simStarted.step) !== "plan") {
      fail(`cmdproto sim start must return the guided plan step: ${simStart.stdout}`);
    }
    const simCommandArgs = simStarted.commands?.next?.args;
    if (
      JSON.stringify(simCommandArgs) !==
      JSON.stringify([
        "sim",
        "quest",
        "next",
        "--wtree",
        simStarted.wtree,
        "--json",
        "@-",
      ])
    ) {
      fail(`cmdproto sim must return guided sim continuation command: ${simStart.stdout}`);
    }

    const simPlanPayload = scenarioPayloadForStep({
      request: DEFAULT_RUNTIME_REQUEST,
      step: "plan",
      quest: {},
      planRound: 0,
      landingRound: 0,
    });
    const simNext = runLoopship(
      fixture.repo,
      [
        "cmdproto",
        "execjson",
        "sim",
        "quest",
        "next",
        JSON.stringify({
          repo: simRepo,
          wtree: simStarted.wtree,
          payload: simPlanPayload,
        }),
      ],
      undefined,
      fixture.env,
    );
    if (simNext.status !== 0) fail(simNext.stderr || simNext.stdout);
    const simAdvanced = parseJson(simNext.stdout);
    if (stepId(simAdvanced.step) !== "task_graph") {
      fail(`cmdproto sim payload must advance to task_graph: ${simNext.stdout}`);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }

  console.log("loopship cmdproto ABI verification passed");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
