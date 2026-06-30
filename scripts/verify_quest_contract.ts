#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./loopship_utils.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOOPSHIP = resolve(SCRIPT_DIR, "loopship.ts");

function fail(message: string): never {
  throw new Error(message);
}

function main(): number {
  const stepper = runCommand("bun", [resolve(SCRIPT_DIR, "verify_runtime_stepper.ts")], {
    cwd: resolve(SCRIPT_DIR, ".."),
    timeoutMs: 300_000,
  });
  if (stepper.status !== 0) fail(stepper.stderr || stepper.stdout);

  const removedResume = runCommand("bun", [LOOPSHIP, "resume", "--json", "{}"], {
    cwd: resolve(SCRIPT_DIR, ".."),
    timeoutMs: 30_000,
  });
  if (removedResume.status === 0) {
    fail("loopship resume must be removed from the public command parser");
  }
  if (!/Usage:/.test(removedResume.stdout)) {
    fail(`removed resume command must fall through to usage: ${removedResume.stderr || removedResume.stdout}`);
  }

  console.log("loopship native quest contract verification passed");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
