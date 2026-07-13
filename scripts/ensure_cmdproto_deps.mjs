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

function sharedNodeModulesRoot() {
  const commonDir = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: root, encoding: "utf8" },
  );
  if (commonDir.status !== 0) return null;
  const repoRoot = path.dirname(commonDir.stdout.trim());
  const modules = path.join(repoRoot, "node_modules");
  return repoRoot !== root && fs.existsSync(modules) ? modules : null;
}

function ensureCmdprotoLinks() {
  if (hasCmdprotoDeps()) return true;
  const shared = sharedNodeModulesRoot();
  if (!shared) return false;
  const sharedPackage = path.join(shared, "cmdproto");
  const sharedBin = path.join(shared, ".bin", "cmdproto");
  if (!fs.existsSync(sharedPackage) || !fs.existsSync(sharedBin)) return false;
  const localPackage = path.join(root, "node_modules", "cmdproto");
  const localBin = path.join(root, "node_modules", ".bin", "cmdproto");
  fs.mkdirSync(path.dirname(localPackage), { recursive: true });
  fs.mkdirSync(path.dirname(localBin), { recursive: true });
  fs.rmSync(localPackage, { recursive: true, force: true });
  fs.rmSync(localBin, { force: true });
  fs.symlinkSync(sharedPackage, localPackage, "dir");
  fs.symlinkSync(sharedBin, localBin, "file");
  return hasCmdprotoDeps();
}

function hasFastflowDeps() {
  return fs.existsSync(fastflowPackagePath);
}

if (ensureCmdprotoLinks() && hasFastflowDeps()) {
  process.exit(0);
}

process.stderr.write("Loopship dependencies are missing; running bun install for this worktree.\n");
const result = spawnSync("bun", ["install"], {
  cwd: root,
  stdio: "inherit",
});

const cmdprotoReady = ensureCmdprotoLinks();
const fastflowReady = hasFastflowDeps();
if (cmdprotoReady && fastflowReady) {
  process.exit(0);
}

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
