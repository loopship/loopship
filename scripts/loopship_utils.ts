#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { openExclusiveSqliteTransaction } from "./loopship_sqlite.ts";

export type Runtime = "codex" | "gemini" | "copilot";

export type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  signal: NodeJS.Signals | null;
};

export const HOOK_STATE_FILE = join(".loopship", "runtime", "hook-state.json");
export const HOOK_EVENT_FILE = join(".loopship", "runtime", "events.jsonl");
export const AUTO_CONTINUE_BUDGET = 12;

export function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path;
  return path.startsWith("~/")
    ? join(process.env.HOME ?? "", path.slice(2))
    : path;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function writeText(path: string, text: string): void {
  writeFileAtomically(path, text);
}

export function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readText(path));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function writeJson(path: string, value: unknown): void {
  writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonExclusively(path: string, value: unknown): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: newFileMode(path),
    });
    if (isRuntimeStatePath(path)) chmodSync(tempPath, 0o600);
    try {
      linkSync(tempPath, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function writeFileAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const original = inspectAtomicTarget(path);
  const mode = original ? Number(original.mode) & 0o777 : newFileMode(path);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, content, { encoding: "utf8", mode });
    if (original || isRuntimeStatePath(path)) chmodSync(tempPath, mode);
    assertAtomicTargetUnchanged(path, original);
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function inspectAtomicTarget(path: string): ReturnType<typeof lstatSync> | null {
  let state: ReturnType<typeof lstatSync>;
  try {
    state = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (state.isSymbolicLink()) {
    throw new Error(`refusing to replace symbolic-link target: ${path}`);
  }
  if (!state.isFile()) {
    throw new Error(`atomic write target must be a regular file: ${path}`);
  }
  return state;
}

function assertAtomicTargetUnchanged(
  path: string,
  original: ReturnType<typeof lstatSync> | null,
): void {
  const current = inspectAtomicTarget(path);
  if (!original) {
    if (current) throw new Error(`atomic write target appeared concurrently: ${path}`);
    return;
  }
  if (!current || current.dev !== original.dev || current.ino !== original.ino) {
    throw new Error(`atomic write target changed concurrently: ${path}`);
  }
}

function isRuntimeStatePath(path: string): boolean {
  return /(?:^|[\\/])\.loopship[\\/]runtime(?:[\\/]|$)/u.test(path);
}

function newFileMode(path: string): number {
  return isRuntimeStatePath(path) ? 0o600 : 0o666;
}

export function acquireCrashSafeFileLock(path: string, timeoutMs: number): () => void {
  mkdirSync(dirname(path), { recursive: true });
  return openExclusiveSqliteTransaction(path, timeoutMs);
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function tsRunner(
  script: string,
  args: string[] = [],
): { cmd: string; args: string[] } {
  if (commandExists("bun")) {
    return { cmd: "bun", args: ["--no-install", script, ...args] };
  }
  throw new Error("Loopship application runtime requires Bun");
}

export function tsShellCommand(script: string, args: string[] = []): string {
  const parts = [shellQuote(script), ...args.map(shellQuote)].join(" ");
  return `if command -v bun >/dev/null 2>&1; then exec bun --no-install ${parts}; else echo "Loopship application runtime requires Bun" >&2; exit 127; fi`;
}

export function readStdinText(): string {
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

export function readStdinJson(): any {
  const raw = readStdinText();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

export function resolveCwd(payload: any, explicit?: string | null): string {
  if (explicit) return resolve(expandHome(explicit));
  if (typeof payload?.cwd === "string" && payload.cwd.trim()) {
    return resolve(expandHome(payload.cwd));
  }
  return resolve(process.cwd());
}

export function loadHookState(cwd: string): Record<string, any> {
  const target = join(cwd, HOOK_STATE_FILE);
  const parsed = readJson(target);
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, any>)
    : {};
}

export function saveHookState(cwd: string, state: Record<string, any>): void {
  writeJson(join(cwd, HOOK_STATE_FILE), state);
}

export function writeHookLog(
  cwd: string,
  record: Record<string, unknown>,
): void {
  const target = join(cwd, HOOK_EVENT_FILE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(record, null, 0)}\n`, {
    encoding: "utf8",
    flag: "a",
  });
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    input?: string;
    timeoutMs?: number;
  } = {},
): RunResult {
  const child = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      ...opts.env,
    },
    input: opts.input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: opts.timeoutMs,
  });

  return {
    status: child.status,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    error: child.error ?? undefined,
    signal: child.signal,
  };
}

export function commandExists(cmd: string): boolean {
  return (
    runCommand("bash", ["-lc", `command -v ${shellQuote(cmd)}`], { timeoutMs: 10_000 })
      .status === 0
  );
}
