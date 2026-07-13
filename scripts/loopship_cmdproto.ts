#!/usr/bin/env bun

import { resolve } from "node:path";
import {
  detectHandbookDuplicates,
  fixHandbookDuplicates,
  renderLoopshipHandbook,
  writeLoopshipHandbook,
} from "./loopship_handbook.ts";
import { expandHome, readStdinText, readText } from "./loopship_utils.ts";

const CMDPROTO_HELP_COMMANDS = [
  {
    path: "doctor",
    summary: "Inspect or repair Loopship runtime scaffolding.",
  },
  {
    path: "handbook",
    summary: "Render or inspect the standalone Loopship handbook from canonical YAML.",
  },
  {
    path: "hook",
    summary: "Handle a runtime hook event payload.",
  },
  {
    path: "init",
    summary: "Start a Loopship quest from an objective.",
  },
  {
    path: "resume",
    summary: "Resume a handoff or recover an interrupted quest from canonical state.",
  },
] as const;
const CMDPROTO_HELP_EXECJSON = {
  name: "cmdproto execjson",
  summary: "Execute a machine JSON payload for a command path.",
  usage: "cmdproto execjson <path> <json|@file|@->",
} as const;

type CapturedCommand = {
  statusCode: number;
  stdout: string;
  stderr: string;
};

type CommandExecution = {
  statusCode: number;
  stdout: string;
  stderr: string;
};

export type LoopshipCmdprotoHandlers = {
  runInit(argv: string[]): Promise<number>;
  runResume(argv: string[]): Promise<number>;
  runHook(argv: string[]): Promise<number>;
  runDoctor(argv: string[]): number;
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isHelpFlag(value: string): boolean {
  return value === "--help" || value === "-h";
}

function isJsonFlag(value: string): boolean {
  return value === "--json";
}

function isHelpOnlyArgv(argv: string[]): boolean {
  return argv.some(isHelpFlag) && argv.every((token) => isHelpFlag(token) || isJsonFlag(token));
}

function cmdprotoHelpPayload(control: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    execjson: CMDPROTO_HELP_EXECJSON,
  };
  if (!control) {
    payload.commands = [...CMDPROTO_HELP_COMMANDS];
  }
  return payload;
}

function cmdprotoHelpText(): string {
  return [
    "Machine execjson:",
    "",
    `  ${CMDPROTO_HELP_EXECJSON.usage} ${CMDPROTO_HELP_EXECJSON.summary}`,
    "",
  ].join("\n");
}

function writeCmdprotoHelp(argv: string[], control: boolean): number {
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(cmdprotoHelpPayload(control))}\n`);
  } else {
    process.stdout.write(cmdprotoHelpText());
  }
  return 0;
}

function pushFlag(args: string[], flag: string, value: unknown): void {
  const text = stringValue(value);
  if (text) {
    args.push(flag, text);
  }
}

function pushJsonArg(args: string[], value: unknown): void {
  const payload = objectValue(value);
  args.push("--json", JSON.stringify(payload));
}

async function withCapturedOutput(run: () => number | Promise<number>): Promise<CapturedCommand> {
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;

  const capture =
    (parts: string[]) =>
    (chunk: unknown, encoding?: BufferEncoding, callback?: (error?: Error | null) => void) => {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString(encoding)
            : String(chunk ?? "");
      parts.push(text);
      callback?.(null);
      return true;
    };

  const writeStdout = capture(stdoutParts);
  const writeStderr = capture(stderrParts);

  process.stdout.write = writeStdout as typeof process.stdout.write;
  process.stderr.write = writeStderr as typeof process.stderr.write;
  console.log = (...args: unknown[]) => {
    stdoutParts.push(`${args.map(String).join(" ")}\n`);
  };
  console.error = (...args: unknown[]) => {
    stderrParts.push(`${args.map(String).join(" ")}\n`);
  };
  console.warn = (...args: unknown[]) => {
    stderrParts.push(`${args.map(String).join(" ")}\n`);
  };

  try {
    return {
      statusCode: await run(),
      stdout: stdoutParts.join(""),
      stderr: stderrParts.join(""),
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  }
}

function parseJsonOutput(
  output: CapturedCommand,
  fallbackLabel: string,
): Record<string, unknown> {
  const trimmed = output.stdout.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch (error) {
    throw new Error(
      `${fallbackLabel} produced non-JSON stdout: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function normalizeJsonStdout(
  output: CapturedCommand,
  fallbackLabel: string,
): string {
  parseJsonOutput(output, fallbackLabel);
  const trimmed = output.stdout.trim();
  return trimmed ? `${trimmed}\n` : "{}\n";
}

function renderJsonStdout(payload: Record<string, unknown>): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function parseInstallerOutput(output: CapturedCommand): Record<string, unknown> {
  const lines = output.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const repo = lines
    .find((line) => line.startsWith("loopship init: repo="))
    ?.slice("loopship init: repo=".length);
  const mode = lines
    .find((line) => line.startsWith("loopship init: mode="))
    ?.slice("loopship init: mode=".length);
  const files = lines
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
  return {
    mode: mode || "installer",
    ...(repo ? { repo } : {}),
    files,
  };
}

function parseDoctorOutput(output: CapturedCommand): Record<string, unknown> {
  const lines = output.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const header = lines.find((line) => line.startsWith("loopship doctor: status="));
  const match = header?.match(/^loopship doctor: status=([^\s]+) repo=(.+)$/);
  const items = lines
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
  return {
    status: match?.[1] ?? (output.statusCode === 0 ? "healthy" : "issues"),
    ...(match?.[2] ? { repo: match[2] } : {}),
    items,
    rerun_with_fix: lines.some((line) => line === "loopship doctor: rerun with --fix"),
  };
}

function readJsonSource(raw: string): Record<string, unknown> {
  let text = raw;
  if (raw === "@-") {
    text = readStdinText();
  } else if (raw.startsWith("@")) {
    text = readText(resolve(expandHome(raw.slice(1))));
  }
  if (!text.trim()) {
    return {};
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("cmdproto execjson requires a JSON object payload");
  }
  return parsed as Record<string, unknown>;
}

function parseExecJsonInvocation(argv: string[]): {
  pathTokens: string[];
  payload: Record<string, unknown>;
} {
  if (argv[0] !== "execjson") {
    throw new Error(`Unknown cmdproto command: ${argv.join(" ")}`);
  }
  const execjsonArgv = argv.slice(1);
  if (execjsonArgv.length < 2) {
    throw new Error(`Usage: ${CMDPROTO_HELP_EXECJSON.usage}`);
  }
  return {
    pathTokens: execjsonArgv.slice(0, -1),
    payload: readJsonSource(execjsonArgv[execjsonArgv.length - 1]),
  };
}

async function invokeInit(
  params: Record<string, unknown>,
  handlers: LoopshipCmdprotoHandlers,
): Promise<CommandExecution> {
  const args: string[] = [];
  const request = stringValue(params.request);
  if (request) {
    args.push(request);
  }
  pushFlag(args, "--repo", params.repo);
  pushFlag(args, "--runtime", params.runtime);
  pushFlag(args, "--flow", params.flow);
  pushFlag(args, "--wtree", params.wtree);
  pushFlag(args, "--source-branch", params.sourceBranch ?? params.source_branch);
  pushFlag(args, "--parent-wtree", params.parentWtree ?? params.parent_wtree);
  pushFlag(args, "--parent-task-id", params.parentTaskId ?? params.parent_task_id);
  pushFlag(
    args,
    "--parent-context-ref",
    params.parentContextRef ?? params.parent_context_ref,
  );
  pushFlag(args, "--target-branch", params.targetBranch ?? params.target_branch);
  pushFlag(args, "--target-worktree", params.targetWorktree ?? params.target_worktree);
  pushFlag(args, "--skill-home", params.skillHome ?? params.skill_home);
  const output = await withCapturedOutput(() => handlers.runInit(args));
  const stdout = output.stdout.trim().startsWith("{")
    ? normalizeJsonStdout(output, "loopship init")
    : renderJsonStdout(parseInstallerOutput(output));
  return { statusCode: output.statusCode, stdout, stderr: output.stderr };
}

async function invokeHook(
  params: Record<string, unknown>,
  handlers: LoopshipCmdprotoHandlers,
): Promise<CommandExecution> {
  const payload = objectValue(params.payload);
  const args: string[] = [];
  pushFlag(args, "--repo", params.repo);
  pushFlag(args, "--runtime", params.runtime);
  pushFlag(args, "--wtree", params.wtree);
  pushJsonArg(args, payload);
  const output = await withCapturedOutput(() => handlers.runHook(args));
  return {
    statusCode: output.statusCode,
    stdout: normalizeJsonStdout(output, "loopship hook"),
    stderr: output.stderr,
  };
}

async function invokeResume(
  params: Record<string, unknown>,
  handlers: LoopshipCmdprotoHandlers,
): Promise<CommandExecution> {
  const args: string[] = [];
  pushFlag(args, "--repo", params.repo);
  pushFlag(args, "--wtree", params.wtree);
  const payload = objectValue(params.payload);
  if (Object.keys(payload).length) {
    pushJsonArg(args, payload);
  }
  const output = await withCapturedOutput(() => handlers.runResume(args));
  return {
    statusCode: output.statusCode,
    stdout: normalizeJsonStdout(output, "loopship resume"),
    stderr: output.stderr,
  };
}

async function invokeDoctor(
  params: Record<string, unknown>,
  handlers: LoopshipCmdprotoHandlers,
): Promise<CommandExecution> {
  const args: string[] = [];
  pushFlag(args, "--repo", params.repo);
  pushFlag(args, "--runtime", params.runtime);
  if (params.fix === true) {
    args.push("--fix");
  }
  pushFlag(args, "--hook-script", params.hookScript ?? params.hook_script);
  const output = await withCapturedOutput(() => handlers.runDoctor(args));
  return {
    statusCode: output.statusCode,
    stdout: renderJsonStdout(parseDoctorOutput(output)),
    stderr: output.stderr,
  };
}

async function invokeHandbook(
  params: Record<string, unknown>,
): Promise<CommandExecution> {
  const repo = stringValue(params.repo);
  const rawMinChars = params.minChars ?? params.min_chars;
  const minChars =
    typeof rawMinChars === "number" && Number.isInteger(rawMinChars)
      ? rawMinChars
      : undefined;
  if (minChars !== undefined && minChars < 1) {
    throw new Error("min_chars must be a positive integer");
  }
  const failOnDuplicates =
    params.failOnDuplicates === true || params.fail_on_duplicates === true;
  if (params.fixDuplicates === true || params.fix_duplicates === true) {
    const payload = fixHandbookDuplicates(repo, { minChars });
    return {
      statusCode: failOnDuplicates && payload.duplicate_count > 0 ? 2 : 0,
      stdout: renderJsonStdout(payload),
      stderr: "",
    };
  }
  if (params.duplicates === true) {
    const payload = detectHandbookDuplicates(repo, { minChars });
    return {
      statusCode: failOnDuplicates && payload.duplicate_count > 0 ? 2 : 0,
      stdout: renderJsonStdout(payload),
      stderr: "",
    };
  }
  const payload =
    params.raw === true
      ? { markdown: renderLoopshipHandbook(repo) }
      : (() => {
          const result = writeLoopshipHandbook(repo);
          return {
            path: result.path,
            file_url: result.file_url,
          };
        })();
  return {
    statusCode: 0,
    stdout: renderJsonStdout(payload),
    stderr: "",
  };
}

async function runExecJsonCommand(
  argv: string[],
  handlers: LoopshipCmdprotoHandlers,
): Promise<CommandExecution> {
  const { pathTokens, payload } = parseExecJsonInvocation(argv);
  const path = pathTokens.join(" ");
  if (path === "init") return await invokeInit(payload, handlers);
  if (path === "doctor") return await invokeDoctor(payload, handlers);
  if (path === "handbook") return await invokeHandbook(payload);
  if (path === "hook") return await invokeHook(payload, handlers);
  if (path === "resume") return await invokeResume(payload, handlers);
  throw new Error(`Unknown command: ${path}`);
}

export async function runLoopshipCmdproto(
  argv: string[],
  options: {
    control?: boolean;
    handlers?: LoopshipCmdprotoHandlers;
  } = {},
): Promise<number> {
  const control = options.control !== false;
  if (isHelpOnlyArgv(argv)) {
    return writeCmdprotoHelp(argv, control);
  }
  if (!control) {
    throw new Error("cmdproto control commands must be invoked as `loopship cmdproto ...`");
  }
  if (!options.handlers) {
    throw new Error("cmdproto command handlers are not configured");
  }
  const result = await runExecJsonCommand(argv, options.handlers);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.statusCode;
}
