import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  LOOPSHIP_CALL_CATALOG_ROOT,
  LOOPSHIP_SUPERVISOR_GUIDANCE,
  createLoopshipFastflowAdapters,
} from "./loopship_fastflow.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOOPSHIP_ROOT = resolve(SCRIPT_DIR, "..");
const SCRATCH_CALL_CATALOG_ROOT = resolve(LOOPSHIP_ROOT, ".loopship", "call-catalog");
const FASTFLOW_ROOT = resolve(
  LOOPSHIP_ROOT,
  "..",
  "..",
  "..",
  "..",
  "cueintent",
  "fastflow",
);
const FASTFLOW_LIFECYCLE_SCRIPT = resolve(
  FASTFLOW_ROOT,
  "scripts",
  "fastflow-internal-lifecycle.mjs",
);

function rewriteWorkspaceRefsToLoopshipText(text: string): string {
  return text
    .replaceAll("workspace.workflow.service.step.", "loopship.workflow.service.step.")
    .replaceAll("workspace.workflow.service.flows.", "loopship.workflow.service.flows.");
}

function rewriteWorkspaceRefsToLoopshipValue(value: unknown): unknown {
  if (typeof value === "string") {
    return rewriteWorkspaceRefsToLoopshipText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteWorkspaceRefsToLoopshipValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rewriteWorkspaceRefsToLoopshipValue(entry)]),
    );
  }
  return value;
}

function parseWorkflowRef(workflowRef: unknown): {
  registry: string;
  kind: string;
  target: string;
  scope: string;
  name: string;
} | null {
  const parts = String(workflowRef || "").trim().split(".");
  if (parts.length !== 5) return null;
  const [registry, kind, target, scope, name] = parts;
  if (!registry || !kind || !target || !scope || !name) return null;
  return { registry, kind, target, scope, name };
}

export async function syncPromotedWorkspaceRelease(result: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const { hashSwfWorkflow } = await import(
    pathToFileURL(resolve(FASTFLOW_ROOT, "src", "lib", "swf-compat.mjs")).href
  );
  const { refreshStableCatalogScopeAttestation } = await import(
    pathToFileURL(resolve(FASTFLOW_ROOT, "src", "lib", "stable-catalog-attestation.mjs")).href
  );
  const parsed = parseWorkflowRef(result.workflowRef);
  if (
    result.promoted !== true ||
    !parsed ||
    parsed.registry !== "workspace" ||
    parsed.kind !== "workflow" ||
    parsed.target !== "service" ||
    !["flows", "step"].includes(parsed.scope)
  ) {
    return null;
  }
  const promotedStablePath = String(result.stablePath || "").trim();
  if (!promotedStablePath) return null;
  const rootedDir = resolve(LOOPSHIP_CALL_CATALOG_ROOT, "loopship", parsed.kind, parsed.target, parsed.scope);
  const rootedStablePath = resolve(rootedDir, `${parsed.name}.stable.yaml`);
  const rootedDevPath = resolve(rootedDir, `${parsed.name}.dev.yaml`);
  const rootedIndexPath = resolve(rootedDir, "index.yaml");
  const promotedStableText = readFileSync(promotedStablePath, "utf8");
  const rootedStableText = rewriteWorkspaceRefsToLoopshipText(promotedStableText);
  writeFileSync(rootedStablePath, rootedStableText, "utf8");
  const rootedStableWorkflow = parseYaml(rootedStableText);
  const rootedDigest = `sha256:${hashSwfWorkflow(rootedStableWorkflow)}`;
  const workspaceIndexPath = resolve(dirname(promotedStablePath), "index.yaml");
  const workspaceIndex = parseYaml(readFileSync(workspaceIndexPath, "utf8"));
  const rootedIndex = rewriteWorkspaceRefsToLoopshipValue(workspaceIndex) as Record<string, any>;
  const stableEntry = rootedIndex?.workflows?.[parsed.name]?.stable;
  if (stableEntry && typeof stableEntry === "object") {
    stableEntry.digest = rootedDigest;
  }
  writeFileSync(rootedIndexPath, stringifyYaml(rootedIndex), "utf8");
  await refreshStableCatalogScopeAttestation({ scopeIndexPath: rootedIndexPath });
  rmSync(rootedDevPath, { force: true });
  return {
    synced: true,
    stablePath: rootedStablePath,
    indexPath: rootedIndexPath,
    digest: rootedDigest,
    release: stableEntry?.release ?? null,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { configureFastflowApp } = await import("@cueintent/fastflow");
    const { runInternalLifecycle } = await import(
      pathToFileURL(FASTFLOW_LIFECYCLE_SCRIPT).href
    );
    configureFastflowApp({
      appName: "loopship",
      systemWorkflowsDir: SCRATCH_CALL_CATALOG_ROOT,
      callCatalogRoots: [SCRATCH_CALL_CATALOG_ROOT, LOOPSHIP_CALL_CATALOG_ROOT],
      supervisorGuidance: LOOPSHIP_SUPERVISOR_GUIDANCE,
      adapters: createLoopshipFastflowAdapters(),
    });
    const result = await runInternalLifecycle(process.argv.slice(2));
    const rootedSync = await syncPromotedWorkspaceRelease(result);
    if (rootedSync) {
      result.rootedSync = rootedSync;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    rmSync(SCRATCH_CALL_CATALOG_ROOT, { recursive: true, force: true });
  }
}
