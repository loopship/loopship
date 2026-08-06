#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CmdProtoError,
  commandOutcome,
  createRuntimeFromFile,
  runMain,
  type CommandOutcome,
  type HandlerMap,
  type HumanRenderer,
} from "cmdproto";

import {
  executeLoopshipCommand,
  LoopshipCommandError,
} from "./loopship_command_core.ts";
import {
  renderDuplicateReport,
  renderFixReport,
  type HandbookDuplicateFixReport,
  type HandbookDuplicateReport,
} from "./loopship_handbook_duplicates.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const LOOPSHIP_SCHEMA_PATH = join(
  SCRIPT_DIR,
  "../dist/cmdproto/schema.binpb",
);
export const LOOPSHIP_MANIFEST_PATH = join(
  SCRIPT_DIR,
  "../dist/cmdproto/runtime.binpb",
);

export const LOOPSHIP_METHODS = Object.freeze({
  init: "loopship.v1.LoopshipService.Init",
  resume: "loopship.v1.LoopshipService.Resume",
  hook: "loopship.v1.LoopshipService.Hook",
  doctor: "loopship.v1.LoopshipService.Doctor",
  handbook: "loopship.v1.LoopshipService.Handbook",
});

const COMMAND_BY_METHOD = new Map([
  [LOOPSHIP_METHODS.init, "init"],
  [LOOPSHIP_METHODS.resume, "resume"],
  [LOOPSHIP_METHODS.hook, "hook"],
  [LOOPSHIP_METHODS.doctor, "doctor"],
  [LOOPSHIP_METHODS.handbook, "handbook"],
]);

function asJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function asObject(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

function normalizeCmdprotoErrorCode(code: unknown): string {
  if (code === "invalid-request" || code === "INVALID_REQUEST") {
    return "INVALID_ARGUMENT";
  }
  if (code === "unsupported-command") {
    return "METHOD_NOT_FOUND";
  }
  return (
    String(code || "INTERNAL")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase() || "INTERNAL"
  );
}

function toCmdprotoError(error: unknown): unknown {
  if (error instanceof CmdProtoError) return error;
  if (error instanceof LoopshipCommandError) {
    return new CmdProtoError(
      normalizeCmdprotoErrorCode(error.code),
      error.message,
      error.details === undefined ? undefined : asJsonValue(error.details),
    );
  }
  if (error instanceof Error && "code" in error) {
    const code = (error as Error & { code?: unknown }).code;
    return new CmdProtoError(normalizeCmdprotoErrorCode(code), error.message);
  }
  return error;
}

function handlerFor(commandPath: string): HandlerMap[string] {
  return async (params) => {
    try {
      const result = await executeLoopshipCommand(commandPath, params);
      return commandOutcome(asJsonValue(result.result), {
        statusCode: result.statusCode,
      });
    } catch (error) {
      throw toCmdprotoError(error);
    }
  };
}

export const handlers: HandlerMap = Object.fromEntries(
  [...COMMAND_BY_METHOD].map(([methodName, commandPath]) => [
    methodName,
    handlerFor(commandPath),
  ]),
) as HandlerMap;

export function createLoopshipRuntime({
  schemaPath = LOOPSHIP_SCHEMA_PATH,
  manifestPath = LOOPSHIP_MANIFEST_PATH,
} = {}) {
  return createRuntimeFromFile(handlers, schemaPath, manifestPath, renderHuman);
}

function ensureLoopshipCmdprotoAssets(
  schemaPath: string,
  manifestPath: string,
): void {
  for (const path of [schemaPath, manifestPath]) {
    if (!existsSync(path)) {
      throw new Error(
        `Loopship cmdproto runtime asset is missing: ${path}. Run 'bun run cmdproto:schema'.`,
      );
    }
  }
}

export async function runLoopshipCmdprotoCli(
  argv = process.argv.slice(2),
  {
    schemaPath = LOOPSHIP_SCHEMA_PATH,
    manifestPath = LOOPSHIP_MANIFEST_PATH,
    stdin,
  }: {
    schemaPath?: string;
    manifestPath?: string;
    stdin?: string;
  } = {},
) {
  ensureLoopshipCmdprotoAssets(schemaPath, manifestPath);
  return runMain({
    handlers,
    schemaPath,
    manifestPath,
    renderHuman,
    argv,
    stdin,
  });
}

function renderJson(value: JsonValue, pretty = false): string {
  return `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`;
}

function renderInit(outcome: CommandOutcome): string {
  const result = asObject(outcome.result);
  if (result.mode === "installer") {
    const lines = [
      `loopship init: repo=${String(result.repo ?? "")}`,
      "loopship init: mode=installer",
    ];
    if (Array.isArray(result.files)) {
      for (const path of result.files) lines.push(`- ${String(path)}`);
    }
    return `${lines.join("\n")}\n`;
  }
  return renderJson(outcome.result);
}

function renderDoctor(outcome: CommandOutcome): string {
  const result = asObject(outcome.result);
  const lines = [
    `loopship doctor: status=${String(result.status ?? "issues")} repo=${String(result.repo ?? "")}`,
  ];
  if (Array.isArray(result.items)) {
    for (const item of result.items) lines.push(`- ${String(item)}`);
  }
  if (result.rerun_with_fix === true) {
    lines.push("loopship doctor: rerun with --fix");
  }
  return `${lines.join("\n")}\n`;
}

function renderHandbook(
  outcome: CommandOutcome,
  params: Record<string, JsonValue>,
): string {
  const result = asObject(outcome.result);
  if (params.outputJson === true) return renderJson(outcome.result, true);
  if (params.raw === true && typeof result.markdown === "string") {
    return `${result.markdown}\n`.replace(/\n{3,}$/g, "\n\n");
  }
  if (params.fixDuplicates === true) {
    return renderFixReport(result as unknown as HandbookDuplicateFixReport);
  }
  if (params.duplicates === true) {
    return renderDuplicateReport(result as unknown as HandbookDuplicateReport);
  }
  return `handbook: ${String(result.file_url ?? result.path ?? "")}\n`;
}

const renderHuman: HumanRenderer = (outcome, context) => {
  const params = asObject(context.request.params ?? {});
  let stdout: string;
  switch (context.methodName) {
    case LOOPSHIP_METHODS.init:
      stdout = renderInit(outcome);
      break;
    case LOOPSHIP_METHODS.doctor:
      stdout = renderDoctor(outcome);
      break;
    case LOOPSHIP_METHODS.handbook:
      stdout = renderHandbook(outcome, params);
      break;
    case LOOPSHIP_METHODS.hook:
    case LOOPSHIP_METHODS.resume:
      stdout = renderJson(outcome.result);
      break;
    default:
      stdout = renderJson(outcome.result);
      break;
  }
  return {
    statusCode: outcome.statusCode,
    stdout,
    stderr: "",
  };
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runLoopshipCmdprotoCli();
}
