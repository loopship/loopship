import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LOOPSHIP_CALL_CATALOG_ROOT,
  LOOPSHIP_SUPERVISOR_GUIDANCE,
  createLoopshipFastflowAdapters,
} from "./loopship_fastflow.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOOPSHIP_ROOT = resolve(SCRIPT_DIR, "..");
const FASTFLOW_ROOT = process.env.LOOPSHIP_FASTFLOW_ROOT
  ? resolve(process.env.LOOPSHIP_FASTFLOW_ROOT)
  : resolve(LOOPSHIP_ROOT, "node_modules", "@cueintent", "fastflow");
const FASTFLOW_INDEX = resolve(FASTFLOW_ROOT, "src", "index.mjs");
const FASTFLOW_LIFECYCLE_SCRIPT = resolve(FASTFLOW_ROOT, "scripts", "fastflow-internal-lifecycle.mjs");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { configureFastflowApp } = await import(pathToFileURL(FASTFLOW_INDEX).href);
    const { runInternalLifecycle } = await import(
      pathToFileURL(FASTFLOW_LIFECYCLE_SCRIPT).href
    );
    configureFastflowApp({
      appName: "loopship",
      systemWorkflowsDir: LOOPSHIP_CALL_CATALOG_ROOT,
      callCatalogRoots: [LOOPSHIP_CALL_CATALOG_ROOT],
      supervisorGuidance: LOOPSHIP_SUPERVISOR_GUIDANCE,
      adapters: createLoopshipFastflowAdapters(),
    });
    const result = await runInternalLifecycle(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
