import { spawn, type ChildProcessByStdio } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
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
  loopshipRoot?: string;
}): Promise<LoopshipTestScheduler> {
  const configuredFastflowRoot = String(process.env.LOOPSHIP_FASTFLOW_ROOT || "").trim();
  const fastflowRoot = resolveFastflowRoot(configuredFastflowRoot);
  const fastflowOverrideEnv: Record<string, string> = configuredFastflowRoot
    ? {
        LOOPSHIP_ENABLE_FASTFLOW_DEV_ROOT: "1",
        LOOPSHIP_FASTFLOW_ROOT: fastflowRoot,
      }
    : {};
  const loopshipRoot = realpathSync(input.loopshipRoot || LOOPSHIP_ROOT);
  const daemonPath = join(loopshipRoot, "bin", "loopship-fastflow-daemon");
  mkdirSync(dirname(input.dbPath), { recursive: true });
  mkdirSync(input.home, { recursive: true });
  const home = realpathSync(input.home);
  const {
    FASTFLOW_APP_MODULE: _ambientAppModule,
    FASTFLOW_SCHEDULER_DB: _ambientSchedulerDb,
    FASTFLOW_SCHEDULER_MODE: _ambientSchedulerMode,
    LOOPSHIP_ENABLE_FASTFLOW_DEV_ROOT: _ambientDevRootOptIn,
    LOOPSHIP_FASTFLOW_ROOT: _ambientFastflowRoot,
    ...baseEnv
  } = process.env;

  // Catalog bundles are producer-signed production content. Tests receive an
  // ephemeral Ed25519 signing key so the daemon can admit the catalog through
  // the same production path production uses. The key lives in the test home
  // so a restart of the same scheduler reuses it: a different key would
  // re-sign the catalog with a new digest and the durable authority would
  // reject the restart as a bundle conflict.
  const catalogSigningKey =
    String(process.env.LOOPSHIP_CATALOG_SIGNING_KEY || "").trim() ||
    signCatalogSigningKey(home);
  const child = spawn("bun", ["--no-install", daemonPath], {
    cwd: loopshipRoot,
    env: {
      ...baseEnv,
      HOME: home,
      LOOPSHIP_HOME: home,
      FASTFLOW_SCHEDULER_MODE: "local-durable",
      FASTFLOW_SCHEDULER_DB: input.dbPath,
      LOOPSHIP_CATALOG_SIGNING_KEY: catalogSigningKey,
      ...fastflowOverrideEnv,
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
      // The daemon writes its runtime descriptor under LOOPSHIP_HOME/scheduler.
      // Clients (including the runFastflowSession child) resolve the descriptor
      // via FASTFLOW_SCHEDULER_DESCRIPTOR, so forward it explicitly. Without
      // it the client falls back to ~/.fastflow and fails with
      // FASTFLOW_SCHEDULER_AUTHORITY_UNAVAILABLE after a slow bind.
      FASTFLOW_SCHEDULER_DESCRIPTOR: join(home, "scheduler", "fastflow.runtime.json"),
      // Client sessions submit against the same signed catalog the scheduler
      // admitted, so they need the same signing key this daemon used.
      ...fastflowOverrideEnv,
      LOOPSHIP_HOME: home,
      LOOPSHIP_CATALOG_SIGNING_KEY: catalogSigningKey,
    },
    stop: () => stopScheduler(child),
  };
}

function signCatalogSigningKey(home: string): string {
  const keyPath = join(home, "loopship-catalog-signing.key");
  if (existsSync(keyPath)) return readFileSync(keyPath, "utf8").trim();
  const { generateKeyPairSync } = require("node:crypto") as {
    generateKeyPairSync: (algorithm: string) => {
      privateKey: { export: (input: Record<string, unknown>) => Buffer };
    };
  };
  const key = generateKeyPairSync("ed25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .subarray(-32)
    .toString("base64");
  mkdirSync(home, { recursive: true });
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

function resolveFastflowRoot(configuredRoot = ""): string {
  const root = configuredRoot
    ? resolve(configuredRoot)
    : join(LOOPSHIP_ROOT, "node_modules", "@cueintent", "fastflow");
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
    const configuredTimeout = Number.parseInt(
      process.env.LOOPSHIP_TEST_SCHEDULER_READY_TIMEOUT_MS || "120000",
      10,
    );
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : 120_000;
    const timeout = setTimeout(() => {
      finish(new Error(`Fastflow scheduler daemon did not become ready: ${stderr || stdout}`));
    }, timeoutMs);

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
