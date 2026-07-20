#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const APP_ROOT = process.cwd();
const LOCAL_BUILD_DEPS = path.join(APP_ROOT, ".cmdproto-deps");
const BINARIES = [
  "cmdproto",
  "cmdproto-buf-plugin",
  "cmdproto-runtime-manifest",
];
const requiredPaths = [
  ...BINARIES.map((binary) => path.join(LOCAL_BUILD_DEPS, "bin", binary)),
  path.join(LOCAL_BUILD_DEPS, "proto", "cmdproto", "v1", "options.proto"),
];

if (materializeHoistedCmdproto()) {
  process.exit(0);
}

process.stderr.write(
  "cmdproto local dependencies are missing; running bun install for this worktree.\n",
);
const result = spawnSync("bun", ["install"], {
  cwd: APP_ROOT,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}
if (!materializeHoistedCmdproto()) {
  throw new Error("bun install completed without installing cmdproto.");
}
process.exit(0);

function materializeHoistedCmdproto() {
  let cmdprotoRoot;
  try {
    const requireFromApp = createRequire(path.join(APP_ROOT, "package.json"));
    cmdprotoRoot = fs.realpathSync(resolvePackageRoot(requireFromApp, "cmdproto"));
  } catch (error) {
    if (error?.code === "MODULE_NOT_FOUND") return false;
    throw error;
  }

  const manifest = JSON.parse(
    fs.readFileSync(path.join(cmdprotoRoot, "package.json"), "utf8"),
  );
  ensureRelativeLink(
    path.join(LOCAL_BUILD_DEPS, "proto"),
    path.join(cmdprotoRoot, "proto"),
    "dir",
  );
  for (const binary of BINARIES) {
    const target = manifest.bin?.[binary];
    if (typeof target !== "string" || !target) {
      throw new Error(`Installed cmdproto does not expose '${binary}'.`);
    }
    ensureRelativeLink(
      path.join(LOCAL_BUILD_DEPS, "bin", binary),
      path.resolve(cmdprotoRoot, target),
      "file",
    );
  }
  return requiredPaths.every((entry) => fs.existsSync(entry));
}

function ensureRelativeLink(linkPath, targetPath, type) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Installed cmdproto target is missing: ${targetPath}`);
  }
  let linkExists = true;
  try {
    fs.lstatSync(linkPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    linkExists = false;
  }
  if (linkExists) {
    let currentTarget;
    try {
      currentTarget = fs.realpathSync(linkPath);
    } catch (cause) {
      throw new Error(
        `Refusing to replace conflicting dependency path: ${linkPath}`,
        { cause },
      );
    }
    if (currentTarget === fs.realpathSync(targetPath)) return;
    throw new Error(`Refusing to replace conflicting dependency path: ${linkPath}`);
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(
    path.relative(path.dirname(linkPath), targetPath),
    linkPath,
    type,
  );
}

function resolvePackageRoot(requireFromApp, packageName) {
  for (const modulesPath of requireFromApp.resolve.paths(packageName) ?? []) {
    const packageRoot = path.join(modulesPath, packageName);
    const manifestPath = path.join(packageRoot, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.name === packageName) return packageRoot;
  }
  const error = new Error(`Could not resolve package root for '${packageName}'.`);
  error.code = "MODULE_NOT_FOUND";
  throw error;
}
