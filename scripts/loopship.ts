#!/usr/bin/env bun

import { runLoopshipCmdprotoCli } from "./loopship_cmdproto.ts";
import { runStepperCli } from "./loopship_stepper.ts";

export { nativeResumeRequest } from "./loopship_resume.ts";

export async function runCliCommand(argv: string[]): Promise<number> {
  if (argv[0] === "stepper") {
    return runStepperCli(argv.slice(1));
  }
  const result = await runLoopshipCmdprotoCli(argv);
  return result.statusCode;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    if (!process.versions.bun) {
      throw Object.assign(
        new Error(
          "loopship_bun_runtime_required: Loopship application commands require Bun; Node 26.x is reserved for the workflow-script security worker.",
        ),
        { code: "loopship_bun_runtime_required" },
      );
    }
    return await runCliCommand(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
