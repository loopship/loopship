if (!process.versions.bun) {
  throw Object.assign(
    new Error(
      "loopship_bun_runtime_required: The Loopship Fastflow daemon requires Bun; Node 26.x is reserved for the workflow-script security worker.",
    ),
    { code: "loopship_bun_runtime_required" },
  );
}

const { configureFastflowForLoopship } = await import("./loopship_fastflow.ts");
await configureFastflowForLoopship();
