import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LOOPSHIP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FASTFLOW_REQUIRED_EXPORTS = [
  "createBunSqliteFastflowNode",
  "loadWorkflowRecord",
  "bindNativeWorkflow",
  "createMemoryCatalogBundleRegistry",
  "createCatalogBundleMountResolver",
  "createRegistryMountTable",
  "digestAfnContract",
  "createAfnDispatchPort",
  "createResourceHandle",
  "createResourceLease",
  "createResourceLeaseManager",
  "validateResourceLease",
];

export async function createFastflowSchedulerNode({
  schedulerDbPath,
  descriptorPath,
  env = process.env,
}) {
  assertAbsolutePath(schedulerDbPath, "schedulerDbPath");
  if (descriptorPath !== undefined) assertAbsolutePath(descriptorPath, "descriptorPath");
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new TypeError("Fastflow scheduler node env must be an object");
  }

  const source = resolveFastflowSource(env);
  const fastflow = await import(source.specifier);
  for (const name of FASTFLOW_REQUIRED_EXPORTS) {
    if (typeof fastflow[name] !== "function") {
      throw new Error(`Selected Fastflow source does not expose ${name}`);
    }
  }

  const loopship = await import("./loopship_fastflow.ts");
  const catalogRoot = await loopship.ensureLoopshipFastflowWorkflowCatalog(
    loopship.LOOPSHIP_ROOT,
  );
  const { configureFastflowRuntime } = await import(
    pathToFileURL(resolve(source.root, "src", "lib", "runtime-shell.mjs")).href,
  );
  const catalog = await loopship.prepareLoopshipFastflowCatalog({
    fastflowRoot: source.root,
    fastflowApi: fastflow,
    catalogRoot,
    workspaceRoot: LOOPSHIP_ROOT,
    // Loopship catalogs are producer-signed, so the daemon cannot start
    // without the operator key; resolve it here for an explicit failure.
    signingKey: loopship.resolveLoopshipCatalogSigningKey().toString("base64"),
  });
  // Producer-signed catalog policy: the Fastflow SQLite registry admits only
  // production-signed bundles, and the Fastbrowser adapter takes the same
  // shape. Loopship catalogs are signed at build time by
  // requireLoopshipCatalogTrustSigningPayload; the trust root is the public
  // half of that same key, derived inside createLoopshipCatalogTrustPolicy.
  const catalogTrustPolicy = loopship.createLoopshipCatalogTrustPolicy();
  const configuredRuntime = configureFastflowRuntime({
    appName: "loopship",
    supervisorGuidance: loopship.LOOPSHIP_SUPERVISOR_GUIDANCE,
    workflowResumeCommand: loopship.LOOPSHIP_WORKFLOW_RESUME_COMMAND,
    integrations: {
      ...loopship.createLoopshipRuntimeIntegrations(fastflow),
      catalogRegistry: catalog.registry,
      catalogMounts: catalog.mounts,
      catalogResolver: catalog.resolver,
      authoringRoot: LOOPSHIP_ROOT,
    },
  });
  const ports = loopship.createLoopshipExecutorPorts(fastflow, {
    resourceLeaseStatePath: `${schedulerDbPath}.resource-leases.json`,
  });

  return fastflow.createBunSqliteFastflowNode({
    identity: "loopship/scheduler",
    schedulerDbPath,
    catalogDbPath: `${schedulerDbPath}.catalog.sqlite`,
    descriptorPath,
    catalogs: {
      mounts: catalog.mounts,
      registrations: [{
        bytes: catalog.bytes,
        expectedDigest: catalog.bundleDigest,
        trustPolicy: catalogTrustPolicy,
      }],
    },
    trust: { mode: "production", owner: "loopship", catalogs: catalogTrustPolicy },
    authority: {
      executorPort: ports.executorPort,
      resourceLeasePort: ports.resourceLeasePort,
      runtimeReconstructionPort: {
        createExecutionContext: configuredRuntime.createExecutionContext.bind(configuredRuntime),
      },
    },
  });
}

function resolveFastflowSource(env) {
  const configuredRoot = String(
    env.LOOPSHIP_FASTFLOW_ROOT || env.FASTFLOW_SOURCE_DIR || "",
  ).trim();
  if (configuredRoot) {
    const root = resolve(configuredRoot);
    const entry = resolve(root, "src", "index.mjs");
    if (!existsSync(resolve(root, "package.json")) || !existsSync(entry)) {
      throw new Error(`Selected Fastflow source is incomplete: ${root}`);
    }
    return { root, specifier: pathToFileURL(entry).href };
  }

  let entry;
  try {
    entry = fileURLToPath(import.meta.resolve("@cueintent/fastflow"));
  } catch (error) {
    throw new Error(
      `Could not resolve the installed @cueintent/fastflow package: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return {
    root: resolve(dirname(entry), ".."),
    specifier: "@cueintent/fastflow",
  };
}

function assertAbsolutePath(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new TypeError(`${name} must be an absolute path`);
  }
}
