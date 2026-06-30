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
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { V3_STEP_SCHEMAS } from "./loopship_schema.ts";

const PACKAGE_ROOT = process.cwd();
const CALL_CATALOG_ROOT = join(PACKAGE_ROOT, "call-catalog");

function resolveFastflowRoot(requiredFiles = ["src/index.mjs", "src/workflow.mjs"]): string {
  const candidates = [
    join(PACKAGE_ROOT, "node_modules", "@cueintent", "fastflow"),
    resolve(PACKAGE_ROOT, "..", "..", "cueintent", "fastflow"),
    resolve(PACKAGE_ROOT, "..", "..", "orgs", "cueintent", "fastflow"),
    resolve(PACKAGE_ROOT, "..", "..", "..", "..", "cueintent", "fastflow"),
    resolve(PACKAGE_ROOT, "..", "..", "..", "..", "orgs", "cueintent", "fastflow"),
  ];
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

function runNodeCheck(source: string, args: string[] = []): string {
  const dir = mkdtempSync(join(PACKAGE_ROOT, "tmp", "flow-schema-"));
  const script = join(dir, "check.mjs");
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

function workflowScopeRoots(): string[] {
  return [
    join(CALL_CATALOG_ROOT, "loopship", "workflow", "service", "step"),
    join(CALL_CATALOG_ROOT, "loopship", "workflow", "service", "flows"),
  ];
}

function collectWorkflowFiles(): string[] {
  return workflowScopeRoots().flatMap((scopeRoot) =>
    workflowIds(scopeRoot).map((id) => workflowPath(scopeRoot, id)),
  );
}

describe("Loopship declarative Fastflow catalog", () => {
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
    const dir = mkdtempSync(join(PACKAGE_ROOT, "tmp", "flow-schema-workflows-"));
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

  it("keeps step schema registry declarative", () => {
    expect(Object.keys(V3_STEP_SCHEMAS).length).toBeGreaterThan(0);
    for (const [name, schema] of Object.entries(V3_STEP_SCHEMAS)) {
      expect(name).toMatch(/^[a-z0-9-]+$/);
      expect(schema).toBeTruthy();
    }
  });
});
