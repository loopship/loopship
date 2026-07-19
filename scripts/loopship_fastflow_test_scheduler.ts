import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const LOOPSHIP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type SchedulerChild = ChildProcessByStdio<null, Readable, Readable>;

export type LoopshipTestScheduler = {
  dbPath: string;
  env: Record<string, string>;
  stop(): Promise<void>;
};

export async function startLoopshipTestScheduler(input: {
  dbPath: string;
  home: string;
}): Promise<LoopshipTestScheduler> {
  const fastflowRoot = resolveFastflowRoot();
  const daemonPath = join(LOOPSHIP_ROOT, "bin", "loopship-fastflow-daemon");
  mkdirSync(dirname(input.dbPath), { recursive: true });
  const {
    FASTFLOW_APP_MODULE: _ambientAppModule,
    FASTFLOW_SCHEDULER_DB: _ambientSchedulerDb,
    FASTFLOW_SCHEDULER_MODE: _ambientSchedulerMode,
    LOOPSHIP_FASTFLOW_ROOT: _ambientFastflowRoot,
    ...baseEnv
  } = process.env;

  const child = spawn("bun", ["--no-install", daemonPath], {
    cwd: LOOPSHIP_ROOT,
    env: {
      ...baseEnv,
      HOME: input.home,
      FASTFLOW_SCHEDULER_MODE: "local-durable",
      FASTFLOW_SCHEDULER_DB: input.dbPath,
      LOOPSHIP_FASTFLOW_ROOT: fastflowRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForReady(child);
  } catch (error) {
    await stopScheduler(child);
    throw error;
  }

  return {
    dbPath: input.dbPath,
    env: {
      FASTFLOW_SCHEDULER_MODE: "local-durable",
      FASTFLOW_SCHEDULER_DB: input.dbPath,
      LOOPSHIP_FASTFLOW_ROOT: fastflowRoot,
    },
    stop: () => stopScheduler(child),
  };
}

function resolveFastflowRoot(): string {
  const root = join(LOOPSHIP_ROOT, "node_modules", "@cueintent", "fastflow");
  if (
    !existsSync(join(root, "package.json")) ||
    !existsSync(join(root, "scripts", "fastflow-scheduler-daemon.mjs"))
  ) {
    throw new Error("could not resolve the Fastflow scheduler daemon");
  }
  return resolve(root);
}

function waitForReady(child: SchedulerChild): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error(`Fastflow scheduler daemon did not become ready: ${stderr || stdout}`));
    }, 30_000);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectReady(error);
      else resolveReady();
    };

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      for (const line of stdout.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        try {
          const ready = JSON.parse(line) as Record<string, unknown>;
          if (ready.ok === true && ready.profile === "local-durable") {
            finish();
            return;
          }
        } catch {
          // Wait for a complete readiness line.
        }
      }
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      finish(
        new Error(
          `Fastflow scheduler daemon exited before readiness (${signal || code}): ${stderr || stdout}`,
        ),
      );
    });
  });
}

async function stopScheduler(child: SchedulerChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await waitForExit(child, 10_000);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child, 10_000);
  }
}

function waitForExit(child: SchedulerChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const finish = (exited: boolean) => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    child.once("exit", onExit);
  });
}
