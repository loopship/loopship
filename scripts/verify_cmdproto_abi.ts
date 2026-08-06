#!/usr/bin/env bun

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSystemScaffold } from "./loopship_core.ts";
import { runCommand, shellQuote } from "./loopship_utils.ts";

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

    const initHelp = runCommand("bun", [SCRIPT, "init", "--help", "--json"], {
      cwd: repo,
      timeoutMs: 30_000,
    });
    if (initHelp.status !== 0) fail(initHelp.stderr || initHelp.stdout);
    const initHelpJson = parseJson(initHelp.stdout, "init help");
    const initPayloadSchema = initHelpJson.payload_json_schema as Record<string, any>;
    if (!initPayloadSchema.properties?.maxConcurrency) {
      fail("generated init help must expose maxConcurrency");
    }

    const hookHelp = runCommand("bun", [SCRIPT, "hook", "--help"], {
      cwd: repo,
      timeoutMs: 30_000,
    });
    if (hookHelp.status !== 0) fail(hookHelp.stderr || hookHelp.stdout);
    const renderedHookExample = hookHelp.stdout.match(
      /loopship hook --runtime codex --json \{\}/,
    )?.[0];
    if (!renderedHookExample) {
      fail("generated hook help must expose a shell-valid normal command example");
    }
    const renderedHook = runCommand(
      "zsh",
      [
        "-c",
        renderedHookExample.replace(/^loopship\b/, "bun " + shellQuote(SCRIPT)),
      ],
      { cwd: repo, timeoutMs: 30_000 },
    );
    if (renderedHook.status !== 0 || renderedHook.stderr.trim()) {
      fail(
        "generated hook example must execute under zsh: stdout=" +
          renderedHook.stdout +
          " stderr=" +
          renderedHook.stderr,
      );
    }

    const handbookHelp = runCommand("bun", [SCRIPT, "handbook", "--help", "--json"], {
      cwd: repo,
      timeoutMs: 30_000,
    });
    if (handbookHelp.status !== 0) fail(handbookHelp.stderr || handbookHelp.stdout);
    const handbookHelpJson = parseJson(handbookHelp.stdout, "handbook help");
    const handbookPayloadSchema = handbookHelpJson.payload_json_schema as Record<string, any>;
    if (!handbookPayloadSchema.properties?.outputJson) {
      fail("generated handbook help must expose outputJson");
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
    if (
      !missingResume.stdout.includes(
        '"message":"Native recovery requires canonical worktree',
      ) ||
      missingResume.stderr.trim()
    ) {
      fail(
        `cmdproto resume did not emit the canonical machine error envelope: stdout=${missingResume.stdout} stderr=${missingResume.stderr}`,
      );
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

    const request = JSON.stringify({ repo, duplicates: true, minChars: 80 });
    const requestPath = join(root, "handbook-request.json");
    writeFileSync(requestPath, request, "utf8");
    const handbookFromFile = runCommand(
      "bun",
      [SCRIPT, "cmdproto", "execjson", "handbook", `@${requestPath}`],
      { cwd: repo, timeoutMs: 30_000 },
    );
    if (handbookFromFile.status !== 0) {
      fail(handbookFromFile.stderr || handbookFromFile.stdout);
    }
    const handbookFileJson = parseJson(handbookFromFile.stdout, "file handbook request");
    if (JSON.stringify(handbookFileJson) !== JSON.stringify(handbookJson)) {
      fail("inline and @file handbook requests must reach the same handler");
    }

    const handbookFromStdin = runCommand(
      "bun",
      [SCRIPT, "cmdproto", "execjson", "handbook", "@-"],
      { cwd: repo, timeoutMs: 30_000, input: request },
    );
    if (handbookFromStdin.status !== 0) {
      fail(handbookFromStdin.stderr || handbookFromStdin.stdout);
    }
    const handbookStdinJson = parseJson(handbookFromStdin.stdout, "stdin handbook request");
    if (JSON.stringify(handbookStdinJson) !== JSON.stringify(handbookJson)) {
      fail("inline and @- handbook requests must reach the same handler");
    }

    const humanOutputJson = runCommand(
      "bun",
      [SCRIPT, "handbook", "--repo", repo, "--duplicates", "--output-json"],
      { cwd: repo, timeoutMs: 30_000 },
    );
    if (humanOutputJson.status !== 0) {
      fail(humanOutputJson.stderr || humanOutputJson.stdout);
    }
    if (JSON.stringify(parseJson(humanOutputJson.stdout, "human output-json")) !== JSON.stringify(handbookJson)) {
      fail("human --output-json and execjson handbook requests must reach the same handler");
    }

    const legacyHandbookJson = runCommand(
      "bun",
      [SCRIPT, "handbook", "--json"],
      { cwd: repo, timeoutMs: 30_000 },
    );
    if (legacyHandbookJson.status === 0 || !legacyHandbookJson.stderr.includes("Unknown flag: --json")) {
      fail("legacy handbook --json must be rejected");
    }

    const unknownField = runCommand(
      "bun",
      [SCRIPT, "cmdproto", "execjson", "handbook", JSON.stringify({ repo, unknown: true })],
      { cwd: repo, timeoutMs: 30_000 },
    );
    if (
      unknownField.status === 0 ||
      !unknownField.stdout.includes('"code":"INVALID_ARGUMENT"') ||
      unknownField.stderr.trim()
    ) {
      fail("unknown machine fields must use the canonical JSON error envelope");
    }

    const extraInit = runCommand(
      "bun",
      [SCRIPT, "init", "loopship: one objective", "unexpected"],
      { cwd: repo, timeoutMs: 30_000 },
    );
    if (extraInit.status === 0 || !extraInit.stderr.includes("Unexpected positional argument")) {
      fail("init must reject extra positional arguments");
    }

    const missingHookPayload = runCommand(
      "bun",
      [SCRIPT, "hook", "--runtime", "codex"],
      {
        cwd: repo,
        input: JSON.stringify({ event: "Stop", stop_reason: "none" }),
        timeoutMs: 30_000,
      },
    );
    if (
      missingHookPayload.status === 0 ||
      !missingHookPayload.stderr.includes("hook requires --json")
    ) {
      fail("human hook must require an explicit --json payload binding");
    }

    const explicitHookPayload = runCommand(
      "bun",
      [SCRIPT, "hook", "--runtime", "codex", "--json", "@-"],
      {
        cwd: repo,
        input: JSON.stringify({ event: "Stop", stop_reason: "none" }),
        timeoutMs: 30_000,
      },
    );
    if (explicitHookPayload.status !== 0 || explicitHookPayload.stderr.trim()) {
      fail(
        `human hook with --json @- must reach the handler: stdout=${explicitHookPayload.stdout} stderr=${explicitHookPayload.stderr}`,
      );
    }

    const invalidFlowHome = join(root, "invalid-flow-home");
    const invalidFlowBin = join(root, "invalid-flow-bin", "loopship");
    const invalidFlow = runCommand(
      "bun",
      [
        SCRIPT,
        "cmdproto",
        "execjson",
        "init",
        JSON.stringify({
          request: "loopship: invalid flow",
          repo,
          runtime: "codex",
          flow: "not-a-flow",
          skillHome: join(root, "invalid-flow-skills"),
        }),
      ],
      {
        cwd: repo,
        env: { HOME: invalidFlowHome, LOOPSHIP_GLOBAL_BIN: invalidFlowBin },
        timeoutMs: 30_000,
      },
    );
    if (
      invalidFlow.status === 0 ||
      !invalidFlow.stdout.includes('"code":"INVALID_ARGUMENT"') ||
      invalidFlow.stderr.trim() ||
      existsSync(join(repo, ".codex")) ||
      existsSync(join(invalidFlowHome, ".agents")) ||
      existsSync(join(root, "invalid-flow-skills")) ||
      existsSync(invalidFlowBin)
    ) {
      fail(
        `invalid init flow must be INVALID_ARGUMENT with no runtime side effects: stdout=${invalidFlow.stdout} stderr=${invalidFlow.stderr}`,
      );
    }

    const doctorHome = join(root, "doctor-home");
    const doctorBin = join(root, "doctor-bin", "loopship");
    mkdirSync(doctorHome, { recursive: true });
    mkdirSync(dirname(doctorBin), { recursive: true });
    writeFileSync(join(doctorHome, "custom-hook.ts"), "", "utf8");
    mkdirSync(join(repo, ".codex"), { recursive: true });
    writeFileSync(
      join(repo, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "loopship hook --runtime codex" }] },
            { hooks: [{ type: "command", command: "loopship hook --runtime codex --json @-" }] },
            { hooks: [{ type: "command", command: "node -e console.log('unrelated')" }] },
            { hooks: [{ type: "command", command: "bun scripts/tasks_loop_hook.ts" }] },
          ],
        },
      }),
      "utf8",
    );
    writeFileSync(doctorBin, "#!/bin/sh\n", "utf8");
    const mixedDoctor = runCommand(
      "bun",
      [SCRIPT, "doctor", "--repo", repo, "--runtime", "codex"],
      {
        cwd: repo,
        env: { HOME: doctorHome, LOOPSHIP_GLOBAL_BIN: doctorBin },
        timeoutMs: 30_000,
      },
    );
    if (
      mixedDoctor.status !== 2 ||
      !mixedDoctor.stdout.includes("does not bind hook stdin with --json @-") ||
      !mixedDoctor.stdout.includes("uses tasks_loop_hook") ||
      mixedDoctor.stdout.includes("shells through node -e")
    ) {
      fail(`doctor must detect one stale hook among current hooks: ${mixedDoctor.stdout}`);
    }

    mkdirSync(join(repo, ".gemini"), { recursive: true });
    writeFileSync(
      join(repo, ".gemini", "settings.json"),
      JSON.stringify({
        hooksConfig: { enabled: true },
        hooks: {
          AfterAgent: [
            { hooks: [{ type: "command", command: "loopship hook --runtime gemini" }] },
            { hooks: [{ type: "command", command: "loopship hook --runtime gemini --json=@-" }] },
            { hooks: [{ type: "command", command: "node -e console.log('unrelated')" }] },
            { hooks: [{ type: "command", command: "bun scripts/tasks_loop_hook.py" }] },
          ],
        },
      }),
      "utf8",
    );
    const mixedGeminiDoctor = runCommand(
      "bun",
      [SCRIPT, "doctor", "--repo", repo, "--runtime", "gemini"],
      {
        cwd: repo,
        env: { HOME: doctorHome, LOOPSHIP_GLOBAL_BIN: doctorBin },
        timeoutMs: 30_000,
      },
    );
    if (
      mixedGeminiDoctor.status !== 2 ||
      !mixedGeminiDoctor.stdout.includes("does not bind hook stdin with --json @-") ||
      !mixedGeminiDoctor.stdout.includes("uses tasks_loop_hook") ||
      mixedGeminiDoctor.stdout.includes("shells through node -e")
    ) {
      fail(`doctor must detect one stale Gemini hook among current hooks: ${mixedGeminiDoctor.stdout}`);
    }

    mkdirSync(join(repo, ".github", "hooks"), { recursive: true });
    writeFileSync(
      join(repo, ".github", "hooks", "loopship.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [{ type: "command", bash: "loopship hook --runtime copilot" }],
          Stop: [{ type: "command", bash: "loopship hook --runtime copilot --json=@-" }],
          sessionEnd: [{ type: "command", bash: "node -e console.log('unrelated')" }],
          agentStop: [{ type: "command", bash: "bun scripts/tasks_loop_hook.ts" }],
        },
      }),
      "utf8",
    );
    const mixedCopilotDoctor = runCommand(
      "bun",
      [SCRIPT, "doctor", "--repo", repo, "--runtime", "copilot"],
      {
        cwd: repo,
        env: { HOME: doctorHome, LOOPSHIP_GLOBAL_BIN: doctorBin },
        timeoutMs: 30_000,
      },
    );
    if (
      mixedCopilotDoctor.status !== 2 ||
      !mixedCopilotDoctor.stdout.includes("does not bind hook stdin with --json @-") ||
      !mixedCopilotDoctor.stdout.includes("uses tasks_loop_hook") ||
      mixedCopilotDoctor.stdout.includes("shells through node -e")
    ) {
      fail(`doctor must detect one stale Copilot hook among current hooks: ${mixedCopilotDoctor.stdout}`);
    }

    const humanHookScriptDoctor = runCommand(
      "bun",
      [
        SCRIPT,
        "doctor",
        "--repo",
        repo,
        "--runtime",
        "codex",
        "--fix",
        "--hook-script",
        "~/custom-hook.ts",
      ],
      {
        cwd: repo,
        env: { HOME: doctorHome, LOOPSHIP_GLOBAL_BIN: doctorBin },
        timeoutMs: 30_000,
      },
    );
    const humanHookConfig = readFileSync(join(repo, ".codex", "hooks.json"), "utf8");
    if (
      humanHookScriptDoctor.status !== 0 ||
      !humanHookConfig.includes(join(doctorHome, "custom-hook.ts")) ||
      humanHookConfig.includes("~/custom-hook.ts") ||
      humanHookConfig.includes("tasks_loop_hook")
    ) {
      fail(`human doctor --hook-script must expand ~: ${humanHookConfig}`);
    }

    const execjsonDoctorRoot = mkdtempSync(join(root, "execjson-doctor-"));
    const execjsonDoctorRepo = createRepo(execjsonDoctorRoot);
    const execjsonHookScriptDoctor = runCommand(
      "bun",
      [
        SCRIPT,
        "cmdproto",
        "execjson",
        "doctor",
        JSON.stringify({
          repo: execjsonDoctorRepo,
          runtime: "codex",
          fix: true,
          hookScript: "~/custom-hook.ts",
        }),
      ],
      {
        cwd: execjsonDoctorRepo,
        env: { HOME: doctorHome, LOOPSHIP_GLOBAL_BIN: doctorBin },
        timeoutMs: 30_000,
      },
    );
    const execjsonHookConfig = readFileSync(
      join(execjsonDoctorRepo, ".codex", "hooks.json"),
      "utf8",
    );
    if (
      execjsonHookScriptDoctor.status !== 0 ||
      !execjsonHookConfig.includes(join(doctorHome, "custom-hook.ts")) ||
      execjsonHookConfig.includes("~/custom-hook.ts")
    ) {
      fail(`execjson doctor --hook-script must expand ~: ${execjsonHookConfig}`);
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
