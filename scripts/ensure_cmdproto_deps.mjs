#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const requiredPaths = [
  path.join(root, "node_modules", ".bin", "cmdproto"),
  path.join(root, "node_modules", "cmdproto", "proto", "cmdproto", "v1", "options.proto"),
];
const fastflowPackagePath = path.join(
  root,
  "node_modules",
  "@cueintent",
  "fastflow",
  "package.json",
);

function hasCmdprotoDeps() {
  return requiredPaths.every((entry) => fs.existsSync(entry));
}

function findFastflowRoot() {
  const candidates = [
    path.resolve(root, "../../orgs/cueintent/fastflow"),
    path.resolve(root, "../../../../cueintent/fastflow"),
    path.resolve(root, "../../../../orgs/cueintent/fastflow"),
    path.resolve(root, "../../../orgs/cueintent/fastflow"),
  ];
  return candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "package.json")),
  );
}

function ensureFastflowLink() {
  if (fs.existsSync(fastflowPackagePath)) return true;
  const source = findFastflowRoot();
  if (!source) return false;
  const scopeDir = path.join(root, "node_modules", "@cueintent");
  const target = path.join(scopeDir, "fastflow");
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.symlinkSync(source, target, "dir");
  return true;
}

if (hasCmdprotoDeps() && ensureFastflowLink()) {
  process.exit(0);
}

process.stderr.write(
  "cmdproto local dependencies are missing; running bun install for this worktree.\n",
);
const result = spawnSync("bun", ["install"], {
  cwd: root,
  stdio: "inherit",
});

const cmdprotoReady = hasCmdprotoDeps();
const fastflowReady = ensureFastflowLink();
if (cmdprotoReady && fastflowReady) {
  process.exit(0);
}

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
