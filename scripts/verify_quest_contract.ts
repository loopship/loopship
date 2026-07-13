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

  const resume = runCommand("bun", [LOOPSHIP, "resume"], {
    cwd: resolve(SCRIPT_DIR, ".."),
    timeoutMs: 30_000,
  });
  if (resume.status === 0) {
    fail("loopship resume without --wtree or --json must fail");
  }
  if (!/requires --wtree or --json/.test(resume.stderr)) {
    fail(`loopship resume must explain its required recovery input: ${resume.stderr || resume.stdout}`);
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
