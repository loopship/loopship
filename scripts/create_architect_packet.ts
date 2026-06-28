#!/usr/bin/env bun

import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const LOOPSHIP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function findOrgsRoot(): string {
  let current = LOOPSHIP_ROOT;
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      existsSync(join(current, "cueintent", "fastflow", "package.json")) &&
      existsSync(join(current, "cueintent", "fastbrowser", "package.json")) &&
      existsSync(join(current, "cueintent", "system-workflows", "package.json"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("could not find AstronLab orgs root for review packet");
}

const ORGS_ROOT = findOrgsRoot();

type RepoSpec = {
  name: string;
  root: string;
  files: string[];
  dirs: string[];
};

const REPOS: RepoSpec[] = [
  {
    name: "fastflow",
    root: resolve(ORGS_ROOT, "cueintent", "fastflow"),
    files: [
      "package.json",
      "src/index.mjs",
      "src/index.d.ts",
      "src/workflow.mjs",
      "src/workflow.d.ts",
      "src/lib/swf-workflow.mjs",
      "src/lib/engine.mjs",
      "src/lib/inference-action.mjs",
      "src/lib/workflow-task-walker.mjs",
      "src/lib/workflows.mjs",
      "src/lib/core-v1.mjs",
      "src/lib/call-catalog.mjs",
      "src/lib/call-catalog-shape.mjs",
      "src/lib/workspace.mjs",
    ],
    dirs: ["schemas", "src/lib/workflow-data"],
  },
  {
    name: "fastbrowser",
    root: resolve(ORGS_ROOT, "cueintent", "fastbrowser"),
    files: [
      "package.json",
      "architecture.md",
      "src/fastflow.mjs",
      "src/runtime.mjs",
      "src/afn-calls.mjs",
      "src/host-script-child.mjs",
      "src/executable-grants.mjs",
      "scripts/generate-call-catalog.mjs",
    ],
    dirs: ["schemas", "call-catalog"],
  },
  {
    name: "system-workflows",
    root: resolve(ORGS_ROOT, "cueintent", "system-workflows"),
    files: ["package.json"],
    dirs: ["call-catalog"],
  },
  {
    name: "loopship",
    root: LOOPSHIP_ROOT,
    files: ["package.json", "README.md", "index.ts"],
    dirs: ["call-catalog", "schemas", "scripts", ".loopship"],
  },
];

function gitHead(root: string): string {
  const proc = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (proc.status !== 0) return "unknown";
  return proc.stdout.trim();
}

function copyFileIfPresent(repo: RepoSpec, relativePath: string, packetRoot: string): void {
  const source = join(repo.root, relativePath);
  if (!existsSync(source)) return;
  const target = join(packetRoot, "repos", repo.name, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
}

function copyDirIfPresent(repo: RepoSpec, relativePath: string, packetRoot: string): void {
  const source = join(repo.root, relativePath);
  if (!existsSync(source)) return;
  const target = join(packetRoot, "repos", repo.name, relativePath);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    filter: (path) => {
      const parts = relative(source, path).split(/[\\/]/).filter(Boolean);
      return !parts.some((part) =>
        [".git", "node_modules", "tmp", "worktrees", "runtime"].includes(part),
      );
    },
  });
}

function listFiles(root: string): string[] {
  const proc = spawnSync("find", [root, "-type", "f"], {
    encoding: "utf8",
  });
  if (proc.status !== 0) return [];
  return proc.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((path) => relative(root, path))
    .sort();
}

function writePacketDocs(packetRoot: string): void {
  const snapshot = REPOS.map((repo) => `- ${repo.name}: \`${gitHead(repo.root)}\``).join("\n");
  writeFileSync(
    join(packetRoot, "PACKET_MANIFEST.md"),
    [
      "# Architect Review Packet",
      "",
      "## Snapshot",
      "",
      snapshot,
      "",
      "## Scope",
      "",
      "Four-repo coherency packet for Fastflow, Fastbrowser, system-workflows, and Loopship.",
      "",
      "Loopship source paths are preserved as package-root paths under `repos/loopship/`:",
      "",
      "- `call-catalog/`",
      "- `schemas/`",
      "- `scripts/`",
      "",
      "There should be no doubled packet paths such as `call-catalog/call-catalog`, `schemas/schemas`, or `scripts/scripts`.",
      "",
      "See `FILES_INCLUDED.txt` for the exact file list.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(packetRoot, "REVIEW_PROMPT.md"),
    [
      "# Review Prompt",
      "",
      "Assume prior Fastflow/Fastbrowser/system-workflows/Loopship review context.",
      "",
      "Review this packet for coherency after the Loopship Fastflow-native hard cut and production-complete lifecycle gate.",
      "",
      "Focus on:",
      "",
      "1. Whether Loopship remains a native Fastflow consumer with root `call-catalog/` as the only executable workflow catalog.",
      "2. Whether `verify:release` and `prepublishOnly` make the focused native lifecycle release set a required release/publish gate.",
      "3. Whether stepper/resume remains internal and absent from public cmdproto.",
      "4. Whether the three-AFN Loopship side-effect boundary remains minimal.",
      "5. Whether any Loopship-specific executable YAML semantics remain that should be converted to Fastflow-native structure.",
      "",
      "Return blockers first, then non-blocking cleanup suggestions.",
      "",
    ].join("\n"),
  );
}

function main(): number {
  const name = process.argv[2] || `architect-review-${gitHead(LOOPSHIP_ROOT)}`;
  const packetRoot = resolve(LOOPSHIP_ROOT, "tmp", name);
  rmSync(packetRoot, { recursive: true, force: true });
  mkdirSync(packetRoot, { recursive: true });

  for (const repo of REPOS) {
    for (const file of repo.files) copyFileIfPresent(repo, file, packetRoot);
    for (const dir of repo.dirs) copyDirIfPresent(repo, dir, packetRoot);
  }

  writePacketDocs(packetRoot);
  writeFileSync(
    join(packetRoot, "FILES_INCLUDED.txt"),
    `${listFiles(packetRoot).join("\n")}\n`,
  );

  const zipPath = `${packetRoot}.zip`;
  rmSync(zipPath, { force: true });
  const zip = spawnSync("zip", ["-qr", zipPath, name], {
    cwd: dirname(packetRoot),
    encoding: "utf8",
  });
  if (zip.status !== 0) {
    process.stderr.write(zip.stderr || zip.stdout);
    return zip.status ?? 1;
  }
  process.stdout.write(`${zipPath}\n`);
  return 0;
}

process.exit(main());
