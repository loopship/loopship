#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
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
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nodeSupportsTs(): boolean {
  const version = runCommand(
    "node",
    ["-e", "process.stdout.write(process.versions.node)"],
    { timeoutMs: 5_000 },
  );
  if (version.status !== 0) return false;
  const major = Number(version.stdout.trim().split(".")[0]);
  return Number.isFinite(major) && major >= 26;
}

export function tsRunner(
  script: string,
  args: string[] = [],
): { cmd: string; args: string[] } {
  if (commandExists("bun")) {
    return { cmd: "bun", args: ["--no-install", script, ...args] };
  }
  if (nodeSupportsTs()) return { cmd: "node", args: [script, ...args] };
  if (commandExists("npx"))
    return { cmd: "npx", args: ["-y", "tsx", script, ...args] };
  throw new Error("bun, node, and npx tsx are unavailable");
}

export function tsShellCommand(script: string, args: string[] = []): string {
  const parts = [shellQuote(script), ...args.map(shellQuote)].join(" ");
  const nodeGate = `node -e "const major=Number(process.versions.node.split('.')[0]); process.exit(major >= 26 ? 0 : 1)" >/dev/null 2>&1`;
  return `if command -v bun >/dev/null 2>&1; then exec bun --no-install ${parts}; elif command -v node >/dev/null 2>&1 && ${nodeGate}; then exec node ${parts}; elif command -v npx >/dev/null 2>&1; then exec npx -y tsx ${parts}; else echo "bun, node, and npx tsx are unavailable" >&2; exit 127; fi`;
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
