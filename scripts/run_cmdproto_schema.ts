#!/usr/bin/env bun

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./loopo_utils.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shimDir = resolve(PACKAGE_ROOT, "tmp", "cmdproto-bin");
const shimPath = resolve(shimDir, "loopo");
const cmdprotoBin = resolve(PACKAGE_ROOT, "node_modules", ".bin", "cmdproto");

mkdirSync(shimDir, { recursive: true });
writeFileSync(
  shimPath,
  `#!/usr/bin/env bash
exec bun "${resolve(PACKAGE_ROOT, "index.ts")}" "$@"
`,
  "utf8",
);
chmodSync(shimPath, 0o755);

if (process.env.LOOPO_CMDPROTO_DEBUG === "1") {
  process.stderr.write(`cmdproto=${cmdprotoBin}\n`);
  process.stderr.write(`shim=${shimPath}\n`);
  process.stderr.write(`cwd=${PACKAGE_ROOT}\n`);
  process.stderr.write(`PATH=${shimDir}:${process.env.PATH ?? ""}\n`);
}

const result = runCommand(
  cmdprotoBin,
  ["build", "--app-name", "loopo", "--out-dir", "assets/cmdproto"],
  {
    cwd: PACKAGE_ROOT,
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    },
    timeoutMs: 120_000,
  },
);

process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status);
