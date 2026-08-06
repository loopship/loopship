#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(path.join(tmpdir(), "loopship-cmdproto-assets-"));

try {
  execFileSync(
    path.join(root, ".cmdproto-deps", "bin", "cmdproto"),
    [
      "build",
      "--app-name",
      "loopship",
      "--buf-config",
      "buf.yaml",
      "--out-dir",
      temporary,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  for (const filename of ["schema.binpb", "runtime.binpb"]) {
    const tracked = readFileSync(path.join(root, "dist", "cmdproto", filename));
    const generated = readFileSync(path.join(temporary, filename));
    if (!tracked.equals(generated)) {
      throw new Error(
        `dist/cmdproto/${filename} is stale; run bun run cmdproto:schema`,
      );
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
