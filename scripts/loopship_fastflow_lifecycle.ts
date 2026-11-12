import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  configureFastflowForLoopship,
  LOOPSHIP_ROOT,
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
    const repoRoot = resolve(process.env.LOOPSHIP_REPO_ROOT || LOOPSHIP_ROOT);
    const hostRuntime = await configureFastflowForLoopship(repoRoot);
    const result = await runInternalLifecycle(process.argv.slice(2), hostRuntime);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
