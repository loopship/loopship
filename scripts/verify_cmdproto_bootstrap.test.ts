import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

const ROOT = process.cwd();
const BOOTSTRAP = join(ROOT, "scripts", "ensure_cmdproto_deps.mjs");
const BINARIES = [
  "cmdproto",
  "cmdproto-buf-plugin",
  "cmdproto-runtime-manifest",
];

function cmdprotoPackageRoot(root = ROOT): string {
  const requireFromRoot = createRequire(join(root, "package.json"));
  for (const modulesPath of requireFromRoot.resolve.paths("cmdproto") ?? []) {
    const candidate = join(modulesPath, "cmdproto");
    if (!existsSync(join(candidate, "package.json"))) continue;
    const manifest = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
    if (manifest.name === "cmdproto") return realpathSync(candidate);
  }
  throw new Error("test fixture could not resolve cmdproto");
}

function writeConsumer(root: string, name: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name, private: true }),
    "utf8",
  );
}

function runBootstrap(root: string, env = process.env) {
  return spawnSync(process.execPath, [BOOTSTRAP], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

describe("cmdproto build dependency bootstrap", () => {
  test("materializes only verified relative links from a hoisted package", () => {
    const root = mkdtempSync(join(tmpdir(), "loopship-cmdproto-hoist-"));
    const appRoot = join(root, "consumer");
    const cmdprotoRoot = cmdprotoPackageRoot();
    try {
      writeConsumer(appRoot, "loopship-cmdproto-hoist-fixture");
      mkdirSync(join(root, "node_modules"), { recursive: true });
      symlinkSync(cmdprotoRoot, join(root, "node_modules", "cmdproto"), "dir");

      const result = runBootstrap(appRoot);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).not.toContain("running bun install");
      expect(existsSync(join(appRoot, "node_modules"))).toBe(false);
      const protoLink = join(appRoot, ".cmdproto-deps", "proto");
      expect(realpathSync(protoLink)).toBe(join(cmdprotoRoot, "proto"));
      expect(isAbsolute(readlinkSync(protoLink))).toBe(false);
      for (const binary of BINARIES) {
        const link = join(appRoot, ".cmdproto-deps", "bin", binary);
        expect(realpathSync(link).startsWith(`${cmdprotoRoot}/`), binary).toBe(true);
        expect(isAbsolute(readlinkSync(link)), binary).toBe(false);
      }
      const rerun = runBootstrap(appRoot);
      expect(rerun.status, rerun.stderr || rerun.stdout).toBe(0);
      expect(rerun.stderr).not.toContain("running bun install");

      const alternateRoot = join(root, "alternate-cmdproto");
      const alternateProto = join(alternateRoot, "proto", "cmdproto", "v1");
      const alternateScripts = join(alternateRoot, "scripts");
      mkdirSync(alternateProto, { recursive: true });
      mkdirSync(alternateScripts, { recursive: true });
      writeFileSync(join(alternateProto, "options.proto"), "alternate", "utf8");
      writeFileSync(
        join(alternateRoot, "package.json"),
        JSON.stringify({
          name: "cmdproto",
          bin: {
            cmdproto: "./scripts/cmdproto.mjs",
            "cmdproto-buf-plugin": "./scripts/buf-plugin-cmdproto",
            "cmdproto-runtime-manifest": "./scripts/runtime-manifest.mjs",
          },
        }),
        "utf8",
      );
      for (const target of [
        "cmdproto.mjs",
        "buf-plugin-cmdproto",
        "runtime-manifest.mjs",
      ]) {
        writeFileSync(join(alternateScripts, target), "alternate", "utf8");
      }
      rmSync(join(root, "node_modules", "cmdproto"), { force: true });
      symlinkSync(alternateRoot, join(root, "node_modules", "cmdproto"), "dir");
      const retargetedHoist = runBootstrap(appRoot);
      expect(retargetedHoist.status).not.toBe(0);
      expect(retargetedHoist.stderr).toContain(
        "Refusing to replace conflicting dependency path",
      );
      expect(realpathSync(protoLink)).toBe(join(cmdprotoRoot, "proto"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed for stale links and regular-file conflicts", () => {
    const root = mkdtempSync(join(tmpdir(), "loopship-cmdproto-conflict-"));
    const cmdprotoRoot = cmdprotoPackageRoot();
    try {
      mkdirSync(join(root, "node_modules"), { recursive: true });
      symlinkSync(cmdprotoRoot, join(root, "node_modules", "cmdproto"), "dir");

      const staleRoot = join(root, "stale-consumer");
      const staleTarget = join(root, "stale-proto");
      writeConsumer(staleRoot, "loopship-cmdproto-stale-fixture");
      mkdirSync(join(staleTarget, "cmdproto", "v1"), { recursive: true });
      writeFileSync(join(staleTarget, "cmdproto", "v1", "options.proto"), "stale", "utf8");
      mkdirSync(join(staleRoot, ".cmdproto-deps"), { recursive: true });
      const staleLink = join(staleRoot, ".cmdproto-deps", "proto");
      symlinkSync(relative(dirname(staleLink), staleTarget), staleLink, "dir");
      const stale = runBootstrap(staleRoot);
      expect(stale.status).not.toBe(0);
      expect(stale.stderr).toContain("Refusing to replace conflicting dependency path");
      expect(realpathSync(staleLink)).toBe(realpathSync(staleTarget));

      const danglingRoot = join(root, "dangling-consumer");
      const danglingLink = join(danglingRoot, ".cmdproto-deps", "proto");
      const missingTarget = join(root, "missing-cmdproto-proto");
      writeConsumer(danglingRoot, "loopship-cmdproto-dangling-fixture");
      mkdirSync(dirname(danglingLink), { recursive: true });
      const danglingTarget = relative(dirname(danglingLink), missingTarget);
      symlinkSync(danglingTarget, danglingLink, "dir");
      const dangling = runBootstrap(danglingRoot);
      expect(dangling.status).not.toBe(0);
      expect(dangling.stderr).toContain("Refusing to replace conflicting dependency path");
      expect(lstatSync(danglingLink).isSymbolicLink()).toBe(true);
      expect(readlinkSync(danglingLink)).toBe(danglingTarget);

      const conflictRoot = join(root, "regular-consumer");
      writeConsumer(conflictRoot, "loopship-cmdproto-regular-fixture");
      const conflict = join(conflictRoot, ".cmdproto-deps", "proto");
      mkdirSync(dirname(conflict), { recursive: true });
      writeFileSync(conflict, "conflict", "utf8");
      const regular = runBootstrap(conflictRoot);
      expect(regular.status).not.toBe(0);
      expect(regular.stderr).toContain("Refusing to replace conflicting dependency path");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("installs only when absent and verifies the installed package", () => {
    const root = mkdtempSync(join(tmpdir(), "loopship-cmdproto-install-"));
    const appRoot = join(root, "consumer");
    const fakeBin = join(root, "fake-bin");
    const fakeBun = join(fakeBin, "bun");
    const cmdprotoRoot = cmdprotoPackageRoot();
    try {
      writeConsumer(appRoot, "loopship-cmdproto-install-fixture");
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(
        fakeBun,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          'const path = require("node:path");',
          'if (process.argv[2] !== "install") process.exit(91);',
          'const modules = path.join(process.cwd(), "node_modules");',
          "fs.mkdirSync(modules, { recursive: true });",
          `fs.symlinkSync(${JSON.stringify(cmdprotoRoot)}, path.join(modules, "cmdproto"), "dir");`,
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(fakeBun, 0o755);

      const result = runBootstrap(appRoot, {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toContain("running bun install");
      expect(realpathSync(join(appRoot, ".cmdproto-deps", "proto"))).toBe(
        join(cmdprotoRoot, "proto"),
      );
      for (const binary of BINARIES) {
        expect(existsSync(join(appRoot, ".cmdproto-deps", "bin", binary)), binary).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runs the public schema entrypoint from a clean packed copy", () => {
    const root = mkdtempSync(join(tmpdir(), "loopship-cmdproto-packed-"));
    const sourceCmdprotoRoot = cmdprotoPackageRoot();
    try {
      const packed = spawnSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", root],
        { cwd: ROOT, encoding: "utf8", timeout: 120_000 },
      );
      expect(packed.status, packed.stderr || packed.stdout).toBe(0);
      const metadata = JSON.parse(packed.stdout) as Array<{ filename: string }>;
      const archive = join(root, metadata[0]?.filename || "");
      const extracted = spawnSync("tar", ["-xzf", archive, "-C", root], {
        encoding: "utf8",
      });
      expect(extracted.status, extracted.stderr || extracted.stdout).toBe(0);
      const appRoot = join(root, "package");
      expect(existsSync(join(appRoot, ".cmdproto-deps"))).toBe(false);
      const sourceManifest = readFileSync(
        join(sourceCmdprotoRoot, "package.json"),
        "utf8",
      );
      expect(JSON.parse(sourceManifest).version).toBe("0.2.0");
      const installedCmdproto = join(appRoot, "node_modules", "cmdproto");
      mkdirSync(dirname(installedCmdproto), { recursive: true });
      cpSync(sourceCmdprotoRoot, installedCmdproto, {
        recursive: true,
        dereference: true,
      });
      const resolvedCmdprotoRoot = cmdprotoPackageRoot(appRoot);
      expect(resolvedCmdprotoRoot).toBe(realpathSync(installedCmdproto));
      expect(resolvedCmdprotoRoot.startsWith(`${realpathSync(appRoot)}${sep}`)).toBe(true);
      expect(resolvedCmdprotoRoot).not.toBe(sourceCmdprotoRoot);
      expect(readFileSync(join(resolvedCmdprotoRoot, "package.json"), "utf8")).toBe(
        sourceManifest,
      );

      const schema = spawnSync(process.execPath, ["--no-install", "run", "cmdproto:schema"], {
        cwd: appRoot,
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(schema.status, schema.stderr || schema.stdout).toBe(0);
      expect(realpathSync(join(appRoot, ".cmdproto-deps", "proto"))).toBe(
        join(resolvedCmdprotoRoot, "proto"),
      );
      expect(existsSync(join(appRoot, "tmp", "cmdproto", "schema.binpb"))).toBe(true);
      expect(existsSync(join(appRoot, "tmp", "cmdproto", "runtime.binpb"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("keeps generated paths package-local and independent of Git worktrees", () => {
    const bootstrap = readFileSync(BOOTSTRAP, "utf8");
    const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const buf = readFileSync(join(ROOT, "buf.yaml"), "utf8");
    expect(bootstrap).not.toContain("git-common-dir");
    expect(bootstrap).not.toContain('"node_modules", ".bin"');
    expect(packageJson.scripts["cmdproto:gen"]).toStartWith(".cmdproto-deps/bin/cmdproto ");
    expect(packageJson.scripts.verify).toContain("bun run cmdproto:schema");
    expect(packageJson.scripts.verify).not.toContain("scripts/run_cmdproto_schema.ts");
    expect(packageJson.files).toContain("buf.yaml");
    expect(packageJson.files).toContain("proto");
    expect(buf).toContain("path: .cmdproto-deps/proto");
    expect(buf).toContain("plugin: ./.cmdproto-deps/bin/cmdproto-buf-plugin");
  });
});
