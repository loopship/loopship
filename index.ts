#!/usr/bin/env bun

if (!process.versions.bun) {
  throw Object.assign(
    new Error(
      "loopship_bun_runtime_required: Loopship application commands require Bun; Node 26.x is reserved for the workflow-script security worker.",
    ),
    { code: "loopship_bun_runtime_required" },
  );
}

if (import.meta.main) {
  const { main } = await import("./scripts/loopship.ts");
  process.exit(await main(process.argv.slice(2)));
}
