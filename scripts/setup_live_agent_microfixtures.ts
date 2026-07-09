#!/usr/bin/env bun

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureSystemScaffold } from "./loopship_core.ts";
import { runCommand } from "./loopship_utils.ts";

type Sample = {
  id: string;
  request: string;
  repo: string;
  branch: string;
  check: string;
};

const root = resolve("tmp", "live-agent-samples");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function runGit(cwd: string, args: string[]): string {
  const result = runCommand("git", args, { cwd, timeoutMs: 30_000 });
  assert(result.status === 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function initRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  const init = runCommand("git", ["init", "-b", "main", repo], { timeoutMs: 30_000 });
  assert(init.status === 0, init.stderr || init.stdout);
  runGit(repo, ["config", "user.email", "loopship-live@example.invalid"]);
  runGit(repo, ["config", "user.name", "Loopship Live Fixture"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\ntmp/\n.loopship/runtime/\n", "utf8");
}

function commitAll(repo: string, message: string): string {
  runGit(repo, ["add", "."]);
  const status = runGit(repo, ["status", "--short"]);
  if (status) runGit(repo, ["commit", "-m", message]);
  return runGit(repo, ["rev-parse", "HEAD"]);
}

function writePackage(repo: string, checkScript = "bun run scripts/check.ts"): void {
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ type: "module", scripts: { check: checkScript } }, null, 2),
    "utf8",
  );
}

function setupTodoScanner(): Sample {
  const repo = join(root, "todo-scanner");
  initRepo(repo);
  writePackage(repo);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "sample.ts"), "// TODO: wire scanner fixture\nexport const sample = true;\n", "utf8");
  writeFileSync(
    join(repo, "scripts", "check.ts"),
    [
      "import { existsSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      "if (!existsSync('src/todo-scan.ts')) throw new Error('src/todo-scan.ts missing');",
      "const proc = spawnSync('bun', ['run', 'src/todo-scan.ts', 'src'], { encoding: 'utf8' });",
      "if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout || 'scanner failed');",
      "const rows = JSON.parse(proc.stdout);",
      "if (!Array.isArray(rows) || !rows.some((row) => String(row.text || '').includes('wire scanner fixture'))) throw new Error('TODO not found');",
    ].join("\n"),
    "utf8",
  );
  const branch = "codex/live-todo-scanner";
  commitAll(repo, "fixture baseline");
  runGit(repo, ["checkout", "-b", branch]);
  return { id: "todo-scanner", request: "build a project TODO scanner", repo, branch, check: "bun run check" };
}

function setupDecisionLog(): Sample {
  const repo = join(root, "decision-log");
  initRepo(repo);
  writePackage(repo);
  ensureSystemScaffold(repo);
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "README.md"), "# Team Docs\n", "utf8");
  writeFileSync(
    join(repo, "scripts", "check.ts"),
    [
      "import { existsSync, readFileSync } from 'node:fs';",
      "for (const path of ['decisions/log.json', '.loopship/system.yaml', '.loopship/docs/decisions/records.yaml']) {",
      "  if (!existsSync(path)) throw new Error(`${path} missing`);",
      "}",
      "const log = JSON.parse(readFileSync('decisions/log.json', 'utf8'));",
      "if (!Array.isArray(log.decisions) || !log.decisions.length) throw new Error('decision entries missing');",
      "if (!readFileSync('.loopship/system.yaml', 'utf8').includes('decision')) throw new Error('system doc not updated');",
    ].join("\n"),
    "utf8",
  );
  const branch = "codex/live-decision-log";
  commitAll(repo, "fixture baseline");
  runGit(repo, ["checkout", "-b", branch]);
  return { id: "decision-log", request: "create a lightweight team decision log", repo, branch, check: "bun run check" };
}

function setupImportValidation(): Sample {
  const repo = join(root, "import-validation");
  initRepo(repo);
  writePackage(repo);
  mkdirSync(join(repo, "examples"), { recursive: true });
  writeFileSync(join(repo, "schema.json"), JSON.stringify({ required: ["id", "name"] }, null, 2), "utf8");
  writeFileSync(join(repo, "examples", "good.json"), JSON.stringify({ id: "1", name: "Ada" }, null, 2), "utf8");
  writeFileSync(join(repo, "examples", "bad.json"), JSON.stringify({ id: "2" }, null, 2), "utf8");
  writeFileSync(
    join(repo, "scripts", "check.ts"),
    [
      "import { existsSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      "if (!existsSync('scripts/validate-import.ts')) throw new Error('validator missing');",
      "const good = spawnSync('bun', ['run', 'scripts/validate-import.ts', 'examples/good.json'], { encoding: 'utf8' });",
      "if (good.status !== 0) throw new Error(`good input failed: ${good.stderr || good.stdout}`);",
      "const bad = spawnSync('bun', ['run', 'scripts/validate-import.ts', 'examples/bad.json'], { encoding: 'utf8' });",
      "if (bad.status === 0) throw new Error('bad input accepted');",
    ].join("\n"),
    "utf8",
  );
  const branch = "codex/live-import-validation";
  commitAll(repo, "fixture baseline");
  runGit(repo, ["checkout", "-b", branch]);
  return { id: "import-validation", request: "add import validation to this tiny data schema repo", repo, branch, check: "bun run check" };
}

const samples = [setupTodoScanner(), setupDecisionLog(), setupImportValidation()];
writeFileSync(join(root, "manifest.json"), JSON.stringify({ samples }, null, 2), "utf8");
process.stdout.write(`${JSON.stringify({ root, samples }, null, 2)}\n`);
