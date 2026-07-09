#!/usr/bin/env bun

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applySystemUpdate,
  verifyRootManifest,
} from "./loopship_core.ts";
import { runCommand } from "./loopship_utils.ts";

type Status = "pass" | "fail";

type FixtureResult = {
  id: string;
  status: Status;
  evidence: string;
  runtimeMs: number;
  error?: string;
};

type Fixture = {
  root: string;
  repo: string;
  lifecycle: Array<Record<string, unknown>>;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function prose(text: string): string {
  return `${text}\nThis fixture text is intentionally compact but concrete enough for schema-backed canonical documentation.\n`;
}

function runGit(cwd: string, args: string[]): string {
  const result = runCommand("git", args, { cwd, timeoutMs: 30_000 });
  assert(result.status === 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function commitAll(cwd: string, message: string): string {
  runGit(cwd, ["add", "."]);
  const status = runGit(cwd, ["status", "--short"]);
  if (!status) return runGit(cwd, ["rev-parse", "HEAD"]);
  runGit(cwd, ["commit", "-m", message]);
  return runGit(cwd, ["rev-parse", "HEAD"]);
}

function createFixture(id: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `loopship-non-software-${id}-`));
  const repo = join(root, "repo");
  const init = runCommand("git", ["init", "-b", "main", repo], { timeoutMs: 30_000 });
  assert(init.status === 0, init.stderr || init.stdout);
  runGit(repo, ["config", "user.email", "loopship-fixture@example.invalid"]);
  runGit(repo, ["config", "user.name", "Loopship Fixture"]);
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "tmp/\n.loopship/runtime/\n", "utf8");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ type: "module", scripts: { check: "bun run scripts/check.ts" } }, null, 2),
    "utf8",
  );
  return { root, repo, lifecycle: [] };
}

function record(fixture: Fixture, stage: string, evidence: Record<string, unknown>): void {
  fixture.lifecycle.push({ stage, ...evidence });
}

function rootDoc(input: {
  id: string;
  title: string;
  kinds: string[];
  resourceId: string;
  resourceLocation: string;
  schemaRef: string;
}) {
  return {
    schema_version: 2,
    id: input.id,
    title: input.title,
    kinds: input.kinds,
    text: prose(`${input.title} is a tiny non-software fixture for Loopship lifecycle proof.`),
    scope_in: ["Planning, validation, verification, system update, landing, and archive evidence."],
    scope_out: ["Production deployment and external service operation."],
    objects: [
      {
        id: "system-record",
        kind: input.kinds.includes("artifact") ? "asset" : "store",
        text: prose("Canonical fixture state is represented as small files and schema-backed documentation."),
      },
    ],
    assertions: [
      {
        id: "lifecycle-required",
        kind: "rule",
        level: "must",
        text: prose("The fixture must produce validation, verification, system-update, landing, and archive evidence."),
        links: { about: ["object:system-record"] },
      },
    ],
    resources: [
      {
        id: input.resourceId,
        kind: "document",
        role: "canonical",
        location: input.resourceLocation,
        schema_ref: input.schemaRef,
        text: prose("Canonical system documentation for this non-software fixture."),
        links: { about: ["object:system-record"] },
        media: "application/yaml",
      },
    ],
  };
}

function decisionDoc() {
  return {
    schema_version: 2,
    id: "decision-records",
    title: "Decision Records",
    text: prose("Decision log for a documentation-only operating system fixture."),
    standard_alignment: { adr: prose("The fixture follows compact architecture decision record structure.") },
    decisions: {
      use_lightweight_records: {
        state: "accepted",
        date: "2026-07-09",
        title: "Use lightweight decision records",
        context: prose("The team needs durable choices without an application build surface."),
        drivers: [prose("Records must be reviewable through repository validation.")],
        options: {
          markdown: {
            text: prose("Markdown records are easy to author and inspect."),
            tradeoffs: [prose("Markdown needs a small validation script for required headings.")],
          },
        },
        decision: prose("Use a compact repository decision log with deterministic heading checks."),
        rationale: prose("The decision keeps the system documentation-first and cheap to verify."),
        consequences: [prose("Lifecycle proof can land documentation without pretending it is software.")],
      },
    },
  };
}

function datasetDoc() {
  return {
    schema_version: 2,
    id: "dataset-datasheet",
    title: "Import Examples Datasheet",
    text: prose("Datasheet for tiny JSON import examples and validation fixtures."),
    standard_alignment: { datasheets: prose("The fixture records dataset motivation, fields, quality, and maintenance.") },
    identity: {
      title: "Tiny Import Examples",
      version: "1.0.0",
      creators: ["Loopship Fixture"],
      publisher: "Loopship Fixture",
      identifiers: { local: "tiny-import-examples" },
    },
    motivation: prose("The data fixture proves schemas and bad-input evidence are first-class lifecycle artifacts."),
    composition: {
      overview: prose("Two JSON files cover a valid record and an intentionally invalid record."),
      fields: { name: { type: "string", text: prose("Human-readable item name required by the validator.") } },
      size: { rows: 2, bytes: 128, text: prose("The examples are intentionally tiny for deterministic verification.") },
    },
    collection: prose("Examples are synthetic and created inside the fixture repository."),
    preprocessing: prose("No preprocessing is needed beyond JSON parsing in the validator."),
    labeling: prose("The bad input is explicitly labeled by expected validator failure."),
    splits: { examples: prose("All records are used as local validation examples.") },
    quality: { invalid_rejected: prose("The bad fixture must fail validation for the case to pass.") },
    uses: {
      intended: [prose("Use for proving Loopship can validate data and schema systems.")],
      prohibited: [prose("Do not use as production data or user-derived records.")],
    },
    distribution: {
      access: prose("The dataset is stored in the local fixture repository."),
      license: "UNLICENSED",
      location_ref: "resource:dataset-datasheet",
    },
    maintenance: prose("Maintenance is limited to deterministic fixture updates."),
    ethics_privacy: { synthetic: prose("No personal data is present in the synthetic examples.") },
    provenance: { generated: prose("The examples are generated by this verifier script.") },
  };
}

function artifactBomDoc() {
  return {
    schema_version: 2,
    id: "artifact-bom",
    title: "Artifact Manifest BOM",
    text: prose("Bill of materials for a generated artifact manifest fixture."),
    standard_alignment: { sbom: prose("The document records composition, provenance, checksums, and lifecycle status.") },
    identity: {
      name: "tiny-artifact-manifest",
      version: "1.0.0",
      kind: "manifest",
      supplier: "Loopship Fixture",
      authors: ["Loopship Fixture"],
      text: prose("The artifact is a deterministic manifest generated inside the fixture repository."),
    },
    composition: {
      components: {
        manifest: {
          name: "manifest.json",
          version: "1.0.0",
          type: "json",
          license: "UNLICENSED",
          text: prose("The JSON manifest lists generated artifact names and provenance."),
        },
      },
    },
    dependencies: { none: prose("The artifact fixture has no runtime dependency graph.") },
    build: {
      environment: prose("The artifact is generated by a local Bun script in the fixture repository."),
      toolchain: [prose("Bun executes the check script and Node-compatible JSON parsing.")],
      commands: ["bun run scripts/check.ts"],
    },
    provenance: { generated: prose("The manifest content is generated by this deterministic fixture.") },
    licenses: { local: prose("The fixture is repository-local and not distributed.") },
    security: {
      vulnerabilities: { none: prose("No executable dependency is shipped in the generated manifest.") },
      attestations: { local: { text: prose("The verifier checks the manifest shape and checksum field.") } },
    },
    distribution: {
      locations: ["resource:artifact-bom"],
      checksums: { manifest: { algorithm: "sha256", value: "fixture-checksum" } },
    },
    verification: { manifest_shape: prose("Verification requires the manifest to contain artifact and provenance fields.") },
    lifecycle: { status: "active", text: prose("The artifact fixture is active for deterministic lifecycle verification.") },
  };
}

function knowledgeDoc() {
  return {
    schema_version: 2,
    id: "design-system-report",
    title: "Design System Token Report",
    text: prose("Knowledge report for a design-token and component documentation fixture."),
    standard_alignment: { design_tokens: prose("The report captures token sources, claims, evidence, and reproducibility.") },
    abstract: prose("The fixture proves design-system documentation can move through the lifecycle without app code."),
    background: { tokens: prose("Design tokens and component docs are durable system artifacts.") },
    research_questions: { coverage: prose("Do tokens and component docs expose enough evidence for review?") },
    methods: { inspection: { text: prose("The verifier reads token JSON and component Markdown for required fields.") } },
    sources: { local: { text: prose("The source files are committed in the fixture repository."), resource_ref: "resource:design-system-report" } },
    claims: { validated: { text: prose("The fixture validates required color and spacing token names."), confidence: "high" } },
    evidence: { check: { kind: "audit", text: prose("The check script confirms token and component documentation shape.") } },
    results: { passed: prose("The token and component documentation checks pass deterministically.") },
    discussion: { scope: prose("The fixture covers documentation and tokens, not rendered UI implementation.") },
    limitations: { no_app: prose("No application build is exercised because the target is a design-system document update.") },
    reproducibility: { script: { kind: "audit", text: prose("Run bun run scripts/check.ts to reproduce the validation result.") } },
    references: { local: prose("All references are local fixture files.") },
  };
}

function runCheck(repo: string): Record<string, unknown> {
  const result = runCommand("bun", ["run", "check"], { cwd: repo, timeoutMs: 30_000 });
  return {
    name: "check",
    status: result.status === 0 ? "passed" : "failed",
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function runLifecycle(
  id: string,
  setup: (fixture: Fixture) => {
    root: Record<string, unknown>;
    document: Record<string, unknown>;
    resourceRef: string;
    requiredPaths: string[];
  },
): FixtureResult {
  const started = performance.now();
  const fixture = createFixture(id);
  try {
    record(fixture, "planning", {
      inspected: [".loopship/system.yaml", "package.json"],
      unknowns: { answered: [], inferred: ["non-software tiny fixture"], defaulted: ["local-only validation"], deferred: [] },
    });
    const prepared = setup(fixture);
    const validation = runCheck(fixture.repo);
    record(fixture, "validation", { receipt: validation });
    assert(validation.status === "passed", "fixture validation failed");
    const touched = applySystemUpdate(
      fixture.repo,
      {
        schema_version: 1,
        mode: "replace",
        summary: `record ${id} canonical docs`,
        root: prepared.root,
        external_docs: [{ op: "upsert", resource_ref: prepared.resourceRef, document: prepared.document }],
      },
      id,
    );
    record(fixture, "system-update", { touched: touched.map((path) => path.replace(fixture.repo, "<repo>")) });
    const missing = prepared.requiredPaths.filter((path) => !existsSync(join(fixture.repo, path)));
    assert(missing.length === 0, `verification missing paths: ${missing.join(", ")}`);
    const manifest = verifyRootManifest(fixture.repo);
    assert(manifest.ok, manifest.errors.join("; "));
    record(fixture, "verification", { status: "passed", required_paths: prepared.requiredPaths });
    const landedCommit = commitAll(fixture.repo, `fixture ${id}`);
    record(fixture, "landing", { landed_commit: landedCommit });
    record(fixture, "archive", { status: "passed", lifecycle_events: fixture.lifecycle.length });
    return {
      id,
      status: "pass",
      evidence: `stages=${fixture.lifecycle.map((entry) => entry.stage).join(">")} commit=${landedCommit.slice(0, 12)}`,
      runtimeMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      id,
      status: "fail",
      evidence: "fixture failed",
      runtimeMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

const results = [
  runLifecycle("docs-only-system", (fixture) => {
    mkdirSync(join(fixture.repo, "records"), { recursive: true });
    writeFileSync(join(fixture.repo, "records", "decisions.md"), "# Decisions\n\n- Use lightweight records.\n", "utf8");
    writeFileSync(
      join(fixture.repo, "scripts", "check.ts"),
      "import { readFileSync } from 'node:fs';\nconst text = readFileSync('records/decisions.md', 'utf8');\nif (!text.includes('Use lightweight records')) throw new Error('decision missing');\n",
      "utf8",
    );
    return {
      root: rootDoc({
        id: "docs-only-system",
        title: "Docs Only System",
        kinds: ["knowledge", "workflow"],
        resourceId: "decision-records",
        resourceLocation: ".loopship/docs/decisions/records.yaml",
        schemaRef: "loopship://schemas/docs/decision-records.yaml",
      }),
      document: decisionDoc(),
      resourceRef: "resource:decision-records",
      requiredPaths: ["records/decisions.md", ".loopship/docs/decisions/records.yaml", ".loopship/signature.yaml"],
    };
  }),
  runLifecycle("data-schema-system", (fixture) => {
    mkdirSync(join(fixture.repo, "examples"), { recursive: true });
    writeFileSync(join(fixture.repo, "schema.json"), JSON.stringify({ required: ["name"] }, null, 2), "utf8");
    writeFileSync(join(fixture.repo, "examples", "good.json"), JSON.stringify({ name: "Ada" }), "utf8");
    writeFileSync(join(fixture.repo, "examples", "bad.json"), JSON.stringify({ label: "missing name" }), "utf8");
    writeFileSync(
      join(fixture.repo, "scripts", "check.ts"),
      [
        "import { readFileSync } from 'node:fs';",
        "const good = JSON.parse(readFileSync('examples/good.json', 'utf8'));",
        "const bad = JSON.parse(readFileSync('examples/bad.json', 'utf8'));",
        "if (typeof good.name !== 'string') throw new Error('good input rejected');",
        "if (typeof bad.name === 'string') throw new Error('bad input accepted');",
        "console.log(JSON.stringify({ good: true, badRejected: true }));",
      ].join("\n"),
      "utf8",
    );
    return {
      root: rootDoc({
        id: "data-schema-system",
        title: "Data Schema System",
        kinds: ["data"],
        resourceId: "dataset-datasheet",
        resourceLocation: ".loopship/docs/data/datasheet.yaml",
        schemaRef: "loopship://schemas/docs/dataset-datasheet.yaml",
      }),
      document: datasetDoc(),
      resourceRef: "resource:dataset-datasheet",
      requiredPaths: ["schema.json", "examples/good.json", "examples/bad.json", ".loopship/docs/data/datasheet.yaml"],
    };
  }),
  runLifecycle("artifact-bom-system", (fixture) => {
    mkdirSync(join(fixture.repo, "dist"), { recursive: true });
    writeFileSync(join(fixture.repo, "dist", "manifest.json"), JSON.stringify({ artifact: "tiny", provenance: "generated" }), "utf8");
    writeFileSync(
      join(fixture.repo, "scripts", "check.ts"),
      "import { readFileSync } from 'node:fs';\nconst manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));\nif (manifest.artifact !== 'tiny' || manifest.provenance !== 'generated') throw new Error('bad manifest');\n",
      "utf8",
    );
    return {
      root: rootDoc({
        id: "artifact-bom-system",
        title: "Artifact BOM System",
        kinds: ["artifact"],
        resourceId: "artifact-bom",
        resourceLocation: ".loopship/docs/artifacts/bom.yaml",
        schemaRef: "loopship://schemas/docs/artifact-bom.yaml",
      }),
      document: artifactBomDoc(),
      resourceRef: "resource:artifact-bom",
      requiredPaths: ["dist/manifest.json", ".loopship/docs/artifacts/bom.yaml"],
    };
  }),
  runLifecycle("design-system-doc-update", (fixture) => {
    mkdirSync(join(fixture.repo, "design"), { recursive: true });
    writeFileSync(join(fixture.repo, "design", "tokens.json"), JSON.stringify({ color: { primary: "#2255aa" }, space: { sm: 4 } }, null, 2), "utf8");
    writeFileSync(join(fixture.repo, "design", "components.md"), "# Components\n\nButton uses color.primary and space.sm.\n", "utf8");
    writeFileSync(
      join(fixture.repo, "scripts", "check.ts"),
      [
        "import { readFileSync } from 'node:fs';",
        "const tokens = JSON.parse(readFileSync('design/tokens.json', 'utf8'));",
        "const components = readFileSync('design/components.md', 'utf8');",
        "if (!tokens.color?.primary || !tokens.space?.sm) throw new Error('tokens incomplete');",
        "if (!components.includes('Button')) throw new Error('component docs incomplete');",
      ].join("\n"),
      "utf8",
    );
    return {
      root: rootDoc({
        id: "design-system-doc-update",
        title: "Design System Documentation",
        kinds: ["knowledge", "artifact"],
        resourceId: "design-system-report",
        resourceLocation: ".loopship/docs/design-system/report.yaml",
        schemaRef: "loopship://schemas/docs/knowledge-report.yaml",
      }),
      document: knowledgeDoc(),
      resourceRef: "resource:design-system-report",
      requiredPaths: ["design/tokens.json", "design/components.md", ".loopship/docs/design-system/report.yaml"],
    };
  }),
];

const lines = [
  "# Non-Software Fixture Matrix",
  "",
  "| Fixture | Status | Runtime ms | Evidence |",
  "| --- | --- | ---: | --- |",
  ...results.map(
    (result) =>
      `| ${result.id} | ${result.status} | ${result.runtimeMs} | ${(result.error || result.evidence).replace(/\|/g, "/")} |`,
  ),
  "",
  `Package root: ${PACKAGE_ROOT}`,
  "",
];

process.stdout.write(lines.join("\n"));
if (results.some((result) => result.status !== "pass")) {
  process.exitCode = 1;
}
