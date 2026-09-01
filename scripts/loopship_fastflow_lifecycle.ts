import { fileURLToPath, pathToFileURL } from "node:url";
import {
  configureFastflowForLoopship,
  resolveLoopshipFastflowRoot,
} from "./loopship_fastflow.ts";

const FASTFLOW_ROOT = resolveLoopshipFastflowRoot([
  "src/index.mjs",
  "scripts/fastflow-internal-lifecycle.mjs",
]);
const FASTFLOW_LIFECYCLE_SCRIPT = fileURLToPath(new URL(
  "./scripts/fastflow-internal-lifecycle.mjs",
  pathToFileURL(`${FASTFLOW_ROOT}/`),
));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { runInternalLifecycle } = await import(
      pathToFileURL(FASTFLOW_LIFECYCLE_SCRIPT).href
    );
    await configureFastflowForLoopship();
    const result = await runInternalLifecycle(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
