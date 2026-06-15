#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome, runCommand, tsRunner } from "./loopship_utils.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOOPSHIP_SCRIPT = resolve(SCRIPT_DIR, "loopship.ts");

function parseArgs(argv: string[]): {
  repo: string;
  runtime: "codex" | "gemini" | "copilot" | "all";
  hookScript: string | null;
} {
  let repo = "";
  let runtime: "codex" | "gemini" | "copilot" | "all" = "all";
  let hookScript: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") repo = argv[++i] ?? "";
    else if (arg === "--runtime")
      runtime = (argv[++i] as typeof runtime) ?? runtime;
    else if (arg === "--hook-script")
      hookScript = resolve(expandHome(argv[++i] ?? ""));
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Install loopship runtime hooks\n\nUsage: bun|node|npx tsx setup_runtime_hooks.ts --repo <path> --runtime <codex|gemini|copilot|all> [--hook-script <path>]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!repo) throw new Error("--repo is required");
  if (!["codex", "gemini", "copilot", "all"].includes(runtime)) {
    throw new Error("--runtime must be codex, gemini, copilot, or all");
  }
  return {
    repo: resolve(expandHome(repo)),
    runtime,
    hookScript: hookScript || null,
  };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const launcher = tsRunner(LOOPSHIP_SCRIPT, [
    "doctor",
    "--repo",
    args.repo,
    "--runtime",
    args.runtime,
    "--fix",
  ]);
  if (args.hookScript) {
    launcher.args.push("--hook-script", args.hookScript);
  }
  const proc = runCommand(launcher.cmd, launcher.args, { timeoutMs: 60_000 });
  if (proc.status !== 0) {
    throw new Error(proc.stderr || proc.stdout || "loopship doctor failed");
  }
  process.stdout.write(proc.stdout);
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
