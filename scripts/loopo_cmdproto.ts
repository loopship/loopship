#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSimCli } from "./loopo_sim.ts";
import { readStdinText } from "./loopo_utils.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "..");
const SCHEMA_PATH = resolve(ROOT_DIR, "assets", "cmdproto", "schema.binpb");
const MANIFEST_PATH = resolve(ROOT_DIR, "assets", "cmdproto", "runtime.binpb");
const CMDPROTO_HELP_COMMANDS = [
  {
    path: "doctor",
    summary: "Run the existing doctor command through the transparent cmdproto wrapper.",
  },
  {
    path: "hook",
    summary: "Invoke the existing hook command with a structured JSON payload.",
  },
  {
    path: "init",
    summary: "Run the existing Loopo init command through the transparent cmdproto wrapper.",
  },
  {
    path: "quest help",
    summary: "Read structured quest help through the existing Loopo help output.",
  },
  {
    path: "quest next",
    summary: "Advance one quest lifecycle step through the existing quest-next command.",
  },
  {
    path: "sim",
    summary: "Run the existing simulation surface through the transparent cmdproto wrapper.",
  },
] as const;
const CMDPROTO_HELP_EXECJSON = {
  name: "cmdproto execjson",
  summary: "Execute a machine JSON payload for a command path.",
  usage: "cmdproto execjson <path> <json|@file|@->",
} as const;

const METHOD = {
  doctor: "loopo.v1.LoopoService.Doctor",
  hook: "loopo.v1.LoopoService.Hook",
  init: "loopo.v1.LoopoService.Init",
  questHelp: "loopo.v1.LoopoService.QuestHelp",
  questNext: "loopo.v1.LoopoService.QuestNext",
  sim: "loopo.v1.LoopoService.Sim",
} as const;

type CapturedCommand = {
  statusCode: number;
  stdout: string;
  stderr: string;
};
type CmdprotoModule = typeof import("cmdproto");
type HandlerMap = import("cmdproto").HandlerMap;

let cmdprotoModulePromise: Promise<CmdprotoModule> | null = null;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function loadLoopoCommands() {
  return await import("./loopo.ts");
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
    "Machine control:",
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

function isCmdprotoMissingPackage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("Cannot find package 'cmdproto'") ||
    message.includes('Cannot find module "cmdproto"') ||
    message.includes("Cannot find module 'cmdproto'")
  );
}

async function loadCmdprotoModule(): Promise<CmdprotoModule> {
  if (!cmdprotoModulePromise) {
    cmdprotoModulePromise = import("cmdproto").catch((error) => {
      cmdprotoModulePromise = null;
      if (isCmdprotoMissingPackage(error)) {
        throw new Error(
          `cmdproto runtime is unavailable. Run \`bun install\` in ${ROOT_DIR} to install the sidecar dependency.`,
        );
      }
      throw error;
    });
  }
  return await cmdprotoModulePromise;
}

async function toCommandOutcome(
  result: Record<string, unknown>,
  statusCode: number,
) {
  const { commandOutcome } = await loadCmdprotoModule();
  return commandOutcome(result, { statusCode });
}

function pushFlag(args: string[], flag: string, value: unknown): void {
  const text = stringValue(value);
  if (text) {
    args.push(flag, text);
  }
}

function pushJsonArg(args: string[], value: unknown): void {
  const payload = objectValue(value);
  if (Object.keys(payload).length === 0) {
    return;
  }
  args.push("--json", JSON.stringify(payload));
}

function withCapturedOutput(run: () => number): CapturedCommand {
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
      statusCode: run(),
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

function parseInstallerOutput(output: CapturedCommand): Record<string, unknown> {
  const lines = output.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const repo = lines
    .find((line) => line.startsWith("loopo init: repo="))
    ?.slice("loopo init: repo=".length);
  const mode = lines
    .find((line) => line.startsWith("loopo init: mode="))
    ?.slice("loopo init: mode=".length);
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
  const header = lines.find((line) => line.startsWith("loopo doctor: status="));
  const match = header?.match(/^loopo doctor: status=([^\s]+) repo=(.+)$/);
  const items = lines
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
  return {
    status: match?.[1] ?? (output.statusCode === 0 ? "healthy" : "issues"),
    ...(match?.[2] ? { repo: match[2] } : {}),
    items,
    rerun_with_fix: lines.some((line) => line === "loopo doctor: rerun with --fix"),
  };
}

async function invokeInit(params: Record<string, unknown>) {
  const { runInit } = await loadLoopoCommands();
  const args: string[] = [];
  const request = stringValue(params.request);
  if (request) {
    args.push(request);
  }
  pushFlag(args, "--cwd", params.cwd);
  pushFlag(args, "--runtime", params.runtime);
  pushFlag(args, "--flow", params.flow);
  pushFlag(args, "--slug", params.slug);
  const output = withCapturedOutput(() => runInit(args));
  const result = output.stdout.trim().startsWith("{")
    ? parseJsonOutput(output, "loopo init")
    : parseInstallerOutput(output);
  return await toCommandOutcome(result, output.statusCode);
}

async function invokeQuestNext(params: Record<string, unknown>) {
  const { runQuestNextV3 } = await loadLoopoCommands();
  const args: string[] = [];
  pushFlag(args, "--slug", params.slug);
  pushFlag(args, "--cwd", params.cwd);
  pushJsonArg(args, params.payload);
  const output = withCapturedOutput(() => runQuestNextV3(args));
  return await toCommandOutcome(
    parseJsonOutput(output, "loopo quest next"),
    output.statusCode,
  );
}

async function invokeQuestHelp(params: Record<string, unknown>) {
  const { runQuestHelpV3 } = await loadLoopoCommands();
  const args: string[] = [];
  const query = stringValue(params.query);
  if (query) {
    args.push(query);
  }
  const output = withCapturedOutput(() => runQuestHelpV3(args));
  return await toCommandOutcome(
    parseJsonOutput(output, "loopo quest help"),
    output.statusCode,
  );
}

async function invokeHook(params: Record<string, unknown>) {
  const { runHook } = await loadLoopoCommands();
  const args: string[] = [];
  pushFlag(args, "--runtime", params.runtime);
  pushFlag(args, "--cwd", params.cwd);
  pushFlag(args, "--repo", params.repo);
  pushFlag(args, "--slug", params.slug);
  pushJsonArg(args, params.payload);
  const output = withCapturedOutput(() => runHook(args));
  return await toCommandOutcome(
    parseJsonOutput(output, "loopo hook"),
    output.statusCode,
  );
}

async function invokeDoctor(params: Record<string, unknown>) {
  const { runDoctor } = await loadLoopoCommands();
  const args: string[] = [];
  pushFlag(args, "--repo", params.repo);
  pushFlag(args, "--runtime", params.runtime);
  if (params.fix === true) {
    args.push("--fix");
  }
  const output = withCapturedOutput(() => runDoctor(args));
  return await toCommandOutcome(parseDoctorOutput(output), output.statusCode);
}

async function invokeSim(params: Record<string, unknown>) {
  const args: string[] = [];
  const mode = stringValue(params.mode);
  if (mode) {
    args.push(mode);
  }
  pushFlag(args, "--repo", params.repo);
  pushFlag(args, "--runtime", params.runtime);
  pushFlag(args, "--request", params.request);
  pushFlag(args, "--flow", params.flow);
  pushJsonArg(args, params.payload);
  const output = withCapturedOutput(() => runSimCli(args));
  return await toCommandOutcome(parseJsonOutput(output, "loopo sim"), output.statusCode);
}

export const handlers: HandlerMap = {
  [METHOD.init](params) {
    return invokeInit(objectValue(params));
  },
  [METHOD.questNext](params) {
    return invokeQuestNext(objectValue(params));
  },
  [METHOD.questHelp](params) {
    return invokeQuestHelp(objectValue(params));
  },
  [METHOD.hook](params) {
    return invokeHook(objectValue(params));
  },
  [METHOD.doctor](params) {
    return invokeDoctor(objectValue(params));
  },
  [METHOD.sim](params) {
    return invokeSim(objectValue(params));
  },
};

async function createLoopoCmdprotoRuntime() {
  const { createRuntimeFromFile } = await loadCmdprotoModule();
  return createRuntimeFromFile(handlers, SCHEMA_PATH, MANIFEST_PATH);
}

export async function runLoopoCmdproto(
  argv: string[],
  options: { control?: boolean } = {},
): Promise<number> {
  const control = options.control !== false;
  if (isHelpOnlyArgv(argv)) {
    return writeCmdprotoHelp(argv, control);
  }
  const runtime = await createLoopoCmdprotoRuntime();
  const { runCli } = await loadCmdprotoModule();
  const stdin = process.stdin.isTTY ? "" : readStdinText();
  const effectiveArgv = control ? ["cmdproto", ...argv] : argv;
  const result = await runCli(runtime, effectiveArgv, stdin);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.statusCode;
}
