#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./loopship_utils.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function fail(message: string): never {
  throw new Error(message);
}

function main(): number {
  const stepper = runCommand("bun", [resolve(SCRIPT_DIR, "verify_runtime_stepper.ts")], {
    cwd: resolve(SCRIPT_DIR, ".."),
    timeoutMs: 300_000,
  });
  if (stepper.status !== 0) fail(stepper.stderr || stepper.stdout);
  console.log("loopship native runtime simulation verification passed");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
