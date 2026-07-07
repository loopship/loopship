import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const FASTFLOW_ROOT = process.env.LOOPSHIP_FASTFLOW_ROOT
  ? resolve(process.env.LOOPSHIP_FASTFLOW_ROOT)
  : resolve(LOOPSHIP_ROOT, "..", "..", "..", "..", "cueintent", "fastflow");
const FASTFLOW_LIFECYCLE_SCRIPT = resolve(FASTFLOW_ROOT, "scripts", "fastflow-internal-lifecycle.mjs");

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

function mergePlainObjects(base: any, next: any): any {
  if (!base || typeof base !== "object" || Array.isArray(base)) {
    return next;
  }
  if (!next || typeof next !== "object" || Array.isArray(next)) {
    return base;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    merged[key] = mergePlainObjects(merged[key], value);
  }
  return merged;
}

function rewriteWorkspaceManifestPrefixKeys(manifest: any): any {
  const rewritten = rewriteWorkspaceRefsToLoopshipValue(manifest) as any;
  const prefixes = rewritten?.prefixes;
  if (prefixes?.workspace) {
    prefixes.loopship = mergePlainObjects(prefixes.loopship || {}, prefixes.workspace);
    delete prefixes.workspace;
  }
  return rewritten;
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

export async function syncPromotedWorkspaceRelease(
  result: Record<string, unknown>,
  options: {
    scratchCallCatalogRoot?: string;
    loopshipCallCatalogRoot?: string;
    fastflowRoot?: string;
    refreshAttestation?: boolean;
  } = {},
): Promise<Record<string, unknown> | null> {
  const fastflowRoot = options.fastflowRoot ? resolve(options.fastflowRoot) : FASTFLOW_ROOT;
  const scratchCallCatalogRoot = options.scratchCallCatalogRoot
    ? resolve(options.scratchCallCatalogRoot)
    : SCRATCH_CALL_CATALOG_ROOT;
  const loopshipCallCatalogRoot = options.loopshipCallCatalogRoot
    ? resolve(options.loopshipCallCatalogRoot)
    : LOOPSHIP_CALL_CATALOG_ROOT;
  const { hashSwfWorkflow } = await import(
    pathToFileURL(resolve(fastflowRoot, "src", "lib", "swf-compat.mjs")).href
  );
  const { parseYamlFile } = await import(
    pathToFileURL(resolve(fastflowRoot, "src", "lib", "workflow-release-ledger.mjs")).href
  );
  const workspaceModule = await import(
    pathToFileURL(resolve(fastflowRoot, "src", "lib", "workspace.mjs")).href
  );
  const withGeneratedReleaseArtifactNotice =
    typeof workspaceModule.withGeneratedReleaseArtifactNotice === "function"
      ? workspaceModule.withGeneratedReleaseArtifactNotice
      : (text: string) => text;
  const { refreshStableCatalogScopeAttestation } = await import(
    pathToFileURL(resolve(fastflowRoot, "src", "lib", "stable-catalog-attestation.mjs")).href
  );
  if (result.promoted !== true) {
    return null;
  }

  const releases = Array.isArray(result.releases)
    ? result.releases
    : [{ workflowRef: result.workflowRef, stablePath: result.stablePath, release: result.release }];
  const syncedItems: Array<Record<string, unknown>> = [];
  const touchedScopes = new Set<string>();

  for (const release of releases) {
    const row = release && typeof release === "object" ? release as Record<string, unknown> : {};
    const parsed = parseWorkflowRef(row.workflowRef);
    if (
      !parsed ||
      !["workspace", "loopship"].includes(parsed.registry) ||
      parsed.kind !== "workflow" ||
      parsed.target !== "service" ||
      !["flows", "step"].includes(parsed.scope)
    ) {
      continue;
    }
    const promotedStablePath = String(row.stablePath || "").trim();
    if (!promotedStablePath) continue;

    const rootedDir = resolve(loopshipCallCatalogRoot, "loopship", parsed.kind, parsed.target, parsed.scope);
    const rootedStablePath = resolve(rootedDir, `${parsed.name}.stable.yaml`);
    const rootedDevPath = resolve(rootedDir, `${parsed.name}.dev.yaml`);
    const rootedIndexPath = resolve(rootedDir, "index.yaml");
    mkdirSync(rootedDir, { recursive: true });

    const promotedStableText = readFileSync(promotedStablePath, "utf8");
    const rootedStableText = parsed.registry === "workspace"
      ? rewriteWorkspaceRefsToLoopshipText(promotedStableText)
      : promotedStableText;
    writeFileSync(rootedStablePath, rootedStableText, "utf8");
    const rootedStableWorkflow = parseYamlFile(rootedStablePath);
    const rootedDigest = `sha256:${hashSwfWorkflow(rootedStableWorkflow)}`;

    const promotedIndexPath = resolve(dirname(promotedStablePath), "index.yaml");
    const promotedIndex = parseYaml(readFileSync(promotedIndexPath, "utf8"));
    const rootedIndex = parsed.registry === "workspace"
      ? rewriteWorkspaceRefsToLoopshipValue(promotedIndex) as Record<string, any>
      : promotedIndex as Record<string, any>;
    const stableEntry = rootedIndex?.workflows?.[parsed.name]?.stable;
    if (stableEntry && typeof stableEntry === "object") {
      stableEntry.digest = rootedDigest;
      delete stableEntry.workflow_digest;
    }
    writeFileSync(rootedIndexPath, withGeneratedReleaseArtifactNotice(`${stringifyYaml(rootedIndex)}\n`), "utf8");
    rmSync(rootedDevPath, { force: true });
    touchedScopes.add(`${parsed.kind}.${parsed.target}.${parsed.scope}`);
    syncedItems.push({
      workflowRef: `loopship.${parsed.kind}.${parsed.target}.${parsed.scope}.${parsed.name}`,
      stablePath: rootedStablePath,
      indexPath: rootedIndexPath,
      digest: rootedDigest,
      release: stableEntry?.release ?? row.release ?? null,
    });
  }

  if (syncedItems.length === 0) {
    return null;
  }

  const scratchRootIndexPath = resolve(scratchCallCatalogRoot, "index.yaml");
  const rootedRootIndexPath = resolve(loopshipCallCatalogRoot, "index.yaml");
  try {
    const scratchRootIndex = rewriteWorkspaceManifestPrefixKeys(parseYaml(readFileSync(scratchRootIndexPath, "utf8"))) as any;
    const rootedRootIndex = parseYaml(readFileSync(rootedRootIndexPath, "utf8")) as any;
    const mergedRootIndex = {
      ...rootedRootIndex,
      ...scratchRootIndex,
      ...(rootedRootIndex?.release_auth ? { release_auth: rootedRootIndex.release_auth } : {}),
      prefixes: mergePlainObjects(rootedRootIndex?.prefixes || {}, scratchRootIndex?.prefixes || {}),
    };
    writeFileSync(
      rootedRootIndexPath,
      withGeneratedReleaseArtifactNotice(`${stringifyYaml(mergedRootIndex)}\n`),
      "utf8",
    );
  } catch {
    // Older Fastflow promotion paths may not materialize a scratch root manifest.
  }

  if (options.refreshAttestation !== false) {
    for (const scope of touchedScopes) {
      const [, target, name] = scope.split(".");
      await refreshStableCatalogScopeAttestation({
        scopeIndexPath: resolve(loopshipCallCatalogRoot, "loopship", "workflow", target, name, "index.yaml"),
      });
    }
  }

  return {
    synced: true,
    items: syncedItems,
    stablePath: syncedItems[0]?.stablePath ?? null,
    indexPath: syncedItems[0]?.indexPath ?? null,
    digest: syncedItems[0]?.digest ?? null,
    release: syncedItems[0]?.release ?? null,
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
