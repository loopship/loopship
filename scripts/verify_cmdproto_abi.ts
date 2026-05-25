#!/usr/bin/env bun

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoopoShim } from "./loopo_core.ts";
import { runCommand } from "./loopo_utils.ts";
import { validateSchemaId, v3SchemaId } from "./loopo_schema.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "loopo.ts");
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

function expectSchema(payload: Record<string, any>, schemaId: string): void {
  const errors = validateSchemaId(payload, schemaId);
  if (errors.length) {
    fail(`${schemaId} validation failed: ${errors.join("; ")}`);
  }
}

function runLoopo(
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
    LOOPO_GLOBAL_BIN: join(root, "bin", "loopo"),
    LOOPO_SCRIPT: SCRIPT,
  };
  const initGit = runCommand("git", ["init", repo], { timeoutMs: 15_000 });
  if (initGit.status !== 0) fail(initGit.stderr || initGit.stdout);
  runGit(repo, ["config", "user.email", "loopo-test@example.invalid"], env);
  runGit(repo, ["config", "user.name", "Loopo Cmdproto"], env);
  writeFileSync(join(repo, "README.md"), "# loopo cmdproto fixture\n", "utf8");
  runGit(repo, ["add", "README.md"], env);
  runGit(repo, ["commit", "-m", "fixture"], env);
  return { root, repo, env };
}

function main(): number {
  const help = runLoopo(
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
    "hook",
    "init",
    "quest help",
    "quest next",
    "sim",
  ];
  if (JSON.stringify(commandPaths.sort()) !== JSON.stringify(expectedPaths.sort())) {
    fail(
      `cmdproto help must expose ${expectedPaths.join(", ")}; got ${commandPaths.join(", ")}`,
    );
  }
  if (helpJson.execjson?.usage !== "cmdproto execjson <path> <json|@file|@->") {
    fail(`unexpected root execjson usage: ${JSON.stringify(helpJson.execjson)}`);
  }

  const controlHelp = runLoopo(
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
  const controlHelpText = runLoopo(
    process.cwd(),
    ["cmdproto", "--help"],
    undefined,
    process.env as Record<string, string>,
  );
  if (controlHelpText.status !== 0) fail(controlHelpText.stderr || controlHelpText.stdout);
  if (!controlHelpText.stdout.includes("cmdproto execjson <path> <json|@file|@->")) {
    fail(`unexpected cmdproto text help: ${JSON.stringify(controlHelpText.stdout)}`);
  }

  const fixture = createFixture("loopo-cmdproto-");
  try {
    createLoopoShim(fixture.env.LOOPO_GLOBAL_BIN, SCRIPT);
    const shimUsage = runCommand(fixture.env.LOOPO_GLOBAL_BIN, [], {
      cwd: fixture.repo,
      env: fixture.env,
      timeoutMs: 120_000,
    });
    if (shimUsage.status !== 1) {
      fail(`loopo shim without args must exit 1; got ${shimUsage.status}`);
    }
    if (!shimUsage.stdout.includes("Usage:")) {
      fail(`loopo shim without args must print usage; got ${JSON.stringify(shimUsage.stdout)}`);
    }

    const directHelp = runLoopo(
      fixture.repo,
      ["quest", "help"],
      undefined,
      fixture.env,
    );
    if (directHelp.status !== 0) fail(directHelp.stderr || directHelp.stdout);
    const directHelpJson = parseJson(directHelp.stdout);
    expectSchema(directHelpJson, v3SchemaId("help-output"));

    const abiHelp = runLoopo(
      fixture.repo,
      ["cmdproto", "execjson", "quest", "help", "{}"],
      undefined,
      fixture.env,
    );
    if (abiHelp.status !== 0) fail(abiHelp.stderr || abiHelp.stdout);
    const abiHelpJson = parseJson(abiHelp.stdout);
    if (JSON.stringify(abiHelpJson) !== JSON.stringify(directHelpJson)) {
      fail("cmdproto quest help must return the direct help JSON payload");
    }

    const init = runLoopo(
      fixture.repo,
      [
        "cmdproto",
        "execjson",
        "init",
        JSON.stringify({
          request: "loopo: build the app",
          cwd: fixture.repo,
          runtime: "codex",
          flow: "swe",
        }),
      ],
      undefined,
      fixture.env,
    );
    if (init.status !== 0) fail(init.stderr || init.stdout);
    const route = parseJson(init.stdout);
    expectSchema(route as Record<string, any>, v3SchemaId("init-output"));

    const newQuest = route.new_quest as Record<string, any> | undefined;
    if (!newQuest || typeof newQuest !== "object") fail("init route missing new_quest");
    const slug = String(newQuest.suggested_slug ?? "");
    if (!slug) fail("init route missing suggested_slug");
    const nextPayload = newQuest.input as Record<string, unknown> | undefined;
    if (!nextPayload || typeof nextPayload !== "object") {
      fail("init route missing next input payload");
    }

    const next = runLoopo(
      fixture.repo,
      [
        "cmdproto",
        "execjson",
        "quest",
        "next",
        JSON.stringify({
          slug,
          cwd: fixture.repo,
          payload: nextPayload,
        }),
      ],
      undefined,
      fixture.env,
    );
    if (next.status !== 0) fail(next.stderr || next.stdout);
    const step = parseJson(next.stdout);
    expectSchema(step as Record<string, any>, v3SchemaId("step-output"));

    const questDir = join(fixture.repo, ".loopo", "quests", slug);
    if (!existsSync(join(questDir, "tasks.yaml"))) {
      fail("cmdproto quest next must still create the canonical quest state");
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }

  console.log("loopo cmdproto ABI verification passed");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
