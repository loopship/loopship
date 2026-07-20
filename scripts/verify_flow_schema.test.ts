import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { V3_STEP_SCHEMAS, v3SchemaFilePath } from "./loopship_schema.ts";

const PACKAGE_ROOT = process.cwd();
const CALL_CATALOG_ROOT = join(PACKAGE_ROOT, "call-catalog");

function resolveFastflowRoot(requiredFiles = ["src/index.mjs", "src/workflow.mjs"]): string {
  const candidates = [
    process.env.LOOPSHIP_FASTFLOW_ROOT,
    join(PACKAGE_ROOT, "node_modules", "@cueintent", "fastflow"),
  ].filter(Boolean) as string[];
  const found = candidates.find((candidate) =>
    existsSync(join(candidate, "package.json")) &&
    requiredFiles.every((file) => existsSync(join(candidate, file))),
  );
  if (!found) throw new Error("could not resolve @cueintent/fastflow");
  return found;
}

function fastflowImport(path: string): string {
  return pathToFileURL(join(resolveFastflowRoot([path]), path)).href;
}

function runNodeCheck(
  source: string,
  args: string[] = [],
  scriptName = "check.mjs",
): string {
  const dir = mkdtempSync(join(tmpdir(), "loopship-flow-schema-"));
  const script = join(dir, scriptName);
  writeFileSync(script, source, "utf8");
  try {
    return execFileSync("node", [script, ...args], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readYamlObject(path: string): Record<string, unknown> {
  const value = parseYaml(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected YAML object: ${path}`);
  }
  return value as Record<string, unknown>;
}

function workflowIds(scopeRoot: string): string[] {
  const index = readYamlObject(join(scopeRoot, "index.yaml"));
  const workflows = index.workflows;
  if (!workflows || typeof workflows !== "object" || Array.isArray(workflows)) {
    return [];
  }
  return Object.keys(workflows).sort();
}

function workflowPath(scopeRoot: string, id: string): string {
  return join(scopeRoot, `${id.replace(/_/g, "-")}.stable.yaml`);
}

function workflowDigestEntries(scopeRoot: string): Array<{
  id: string;
  path: string;
  expectedDigest: string;
}> {
  const index = readYamlObject(join(scopeRoot, "index.yaml"));
  const workflows =
    index.workflows && typeof index.workflows === "object" && !Array.isArray(index.workflows)
      ? (index.workflows as Record<string, unknown>)
      : {};
  return Object.entries(workflows).map(([id, entry]) => {
    const stable =
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).stable
        : null;
    const stableRecord =
      stable && typeof stable === "object" && !Array.isArray(stable)
        ? (stable as Record<string, unknown>)
        : {};
    return {
      id,
      path: workflowPath(scopeRoot, id),
      expectedDigest: String(stableRecord.digest ?? ""),
    };
  });
}

function workflowScopeRoots(): string[] {
  return [
    join(CALL_CATALOG_ROOT, "loopship", "workflow", "service", "step"),
    join(CALL_CATALOG_ROOT, "loopship", "workflow", "service", "flows"),
  ];
}

function rootManifest(): Record<string, unknown> {
  return readYamlObject(join(CALL_CATALOG_ROOT, "index.yaml"));
}

function collectWorkflowFiles(): string[] {
  return workflowScopeRoots().flatMap((scopeRoot) =>
    workflowIds(scopeRoot).map((id) => workflowPath(scopeRoot, id)),
  );
}

describe("Loopship declarative Fastflow catalog", () => {
  it("imports Fastflow cmdproto from a consumer app without auto-running its CLI", () => {
    const output = runNodeCheck(
      `
        await import(${JSON.stringify(fastflowImport("src/cmdproto/app.mjs"))});
        console.log("loopship-consumer-import-ok");
      `,
      [],
      "app.mjs",
    );
    expect(output).toBe("loopship-consumer-import-ok\n");
  });

  it("keeps workflow scope indexes resolved to stable YAML files", () => {
    for (const scopeRoot of workflowScopeRoots()) {
      const ids = workflowIds(scopeRoot);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(existsSync(workflowPath(scopeRoot, id)), `${scopeRoot} ${id}`).toBe(true);
      }
      const looseYaml = readdirSync(scopeRoot).filter((name) =>
        name.endsWith(".yaml") &&
        name !== "index.yaml" &&
        !name.endsWith(".stable.yaml") &&
        !name.endsWith(".dev.yaml"),
      );
      expect(looseYaml).toEqual([]);
    }
  });

  it("validates every Loopship workflow with Fastflow native SWF validators", () => {
    const dir = mkdtempSync(join(tmpdir(), "loopship-flow-schema-workflows-"));
    const dataPath = join(dir, "workflows.json");
    const workflows = Object.fromEntries(
      collectWorkflowFiles().map((file) => [file, readYamlObject(file)]),
    );
    writeFileSync(dataPath, JSON.stringify(workflows), "utf8");
    try {
      runNodeCheck(
        `
          import { readFileSync } from "node:fs";
          import {
            normalizeSwfWorkflow,
            validateFastflowSwfSubset,
            validateFastflowWorkflowSchema,
          } from ${JSON.stringify(fastflowImport("src/workflow.mjs"))};
          const workflows = JSON.parse(readFileSync(process.argv[2], "utf8"));
          for (const [file, workflow] of Object.entries(workflows)) {
            const schemaErrors = [];
            validateFastflowWorkflowSchema(workflow, schemaErrors);
            if (schemaErrors.length) throw new Error(file + " schema: " + schemaErrors.join("; "));
            const subsetErrors = [];
            validateFastflowSwfSubset(workflow, { filePath: file, store: "project" }, subsetErrors);
            if (subsetErrors.length) throw new Error(file + " subset: " + subsetErrors.join("; "));
            const normalizationErrors = [];
            const normalized = normalizeSwfWorkflow(
              workflow,
              { filePath: file, store: "project" },
              normalizationErrors,
            );
            if (normalizationErrors.length) throw new Error(file + " normalize: " + normalizationErrors.join("; "));
            if (!normalized?.name) throw new Error(file + " did not normalize");
          }
        `,
        [dataPath],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates the complete Loopship call catalog through Fastflow", () => {
    const output = runNodeCheck(
      `
        import { validateCallCatalogRoot } from ${JSON.stringify(fastflowImport("src/index.mjs"))};
        const result = await validateCallCatalogRoot(process.argv[2]);
        if (!result.ok) throw new Error(JSON.stringify(result));
        console.log(JSON.stringify(result));
      `,
      [CALL_CATALOG_ROOT],
    );
    expect(JSON.parse(output).calls).toBeGreaterThan(0);
  });

  it("ships rooted call catalog release authorization and prefixes", () => {
    const manifest = rootManifest();
    expect(manifest.schemaVersion).toBe("fastflow/call-catalog-manifest/v3");
    expect(manifest.pathTemplate).toBe("{registry}/{kind}/{target}/{scope}/index.yaml");
    const releaseAuth =
      manifest.release_auth &&
      typeof manifest.release_auth === "object" &&
      !Array.isArray(manifest.release_auth)
        ? (manifest.release_auth as Record<string, unknown>)
        : null;
    const trustedReleasers = Array.isArray(releaseAuth?.trusted_releasers)
      ? releaseAuth.trusted_releasers
      : [];
    expect(trustedReleasers.length).toBeGreaterThan(0);
    const prefixes =
      manifest.prefixes && typeof manifest.prefixes === "object" && !Array.isArray(manifest.prefixes)
        ? (manifest.prefixes as Record<string, unknown>)
        : {};
    expect(Object.keys(prefixes).length).toBeGreaterThan(0);
  });

  it("reports malformed direct stable workflow edits through digest drift", () => {
    const entries = workflowScopeRoots().flatMap((scopeRoot) => workflowDigestEntries(scopeRoot));
    expect(entries.length).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), "loopship-flow-digests-"));
    const dataPath = join(dir, "digests.json");
    writeFileSync(dataPath, JSON.stringify(entries), "utf8");
    try {
      runNodeCheck(
        `
          import { readFileSync } from "node:fs";
          import { hashSwfWorkflow } from ${JSON.stringify(fastflowImport("src/lib/swf-compat.mjs"))};
          import { parseYamlFile } from ${JSON.stringify(fastflowImport("src/lib/workflow-release-ledger.mjs"))};
          const entries = JSON.parse(readFileSync(process.argv[2], "utf8"));
          for (const entry of entries) {
            const workflow = parseYamlFile(entry.path);
            const actualDigest = "sha256:" + hashSwfWorkflow(workflow);
            if (actualDigest !== entry.expectedDigest) {
              throw new Error(
                entry.path +
                  " digest drifted from its scope index; direct edits to *.stable.yaml are malformed. Copy the changes into the matching *.dev.yaml, restore the stable artifact, and continue via Fastflow promotion."
              );
            }
            const rootHash = workflow?.document?.metadata?.rootHash;
            if (typeof rootHash === "string" && rootHash.trim() && rootHash !== actualDigest) {
              throw new Error(
                entry.path +
                  " metadata.rootHash drifted; continue workflow edits in *.dev.yaml, restore the stable artifact, and refresh stable artifacts via promotion instead of hand-editing *.stable.yaml."
              );
            }
          }
        `,
        [dataPath],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps step schema registry declarative", () => {
    expect(V3_STEP_SCHEMAS.length).toBeGreaterThan(0);
    const registeredSchemas: string[] = [...V3_STEP_SCHEMAS].sort();
    const publicStepSchemas = readdirSync(join(PACKAGE_ROOT, "schemas", "steps"))
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => name.slice(0, -".yaml".length))
      .filter((name) => !["afn-action-result", "common"].includes(name))
      .sort();
    expect(registeredSchemas).toEqual(publicStepSchemas);
    for (const name of V3_STEP_SCHEMAS) {
      expect(name).toMatch(/^[a-z0-9-]+$/);
      expect(existsSync(v3SchemaFilePath(name))).toBe(true);
    }
  });
});
