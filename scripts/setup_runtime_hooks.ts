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
  const requiredValue = (index: number, option: string): string => {
    const value = argv[index];
    if (!value || value.startsWith("-")) throw new Error(`${option} requires a value`);
    return value;
  };
  const inlineValue = (argument: string, option: string): string => {
    const value = argument.slice(`${option}=`.length);
    if (!value) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") repo = requiredValue(++i, "--repo");
    else if (arg?.startsWith("--repo=")) repo = inlineValue(arg, "--repo");
    else if (arg === "--runtime")
      runtime = requiredValue(++i, "--runtime") as typeof runtime;
    else if (arg?.startsWith("--runtime="))
      runtime = inlineValue(arg, "--runtime") as typeof runtime;
    else if (arg === "--hook-script")
      hookScript = resolve(expandHome(requiredValue(++i, "--hook-script")));
    else if (arg?.startsWith("--hook-script="))
      hookScript = resolve(expandHome(inlineValue(arg, "--hook-script")));
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Install loopship runtime hooks\n\nUsage: bun setup_runtime_hooks.ts --repo <path> --runtime <codex|gemini|copilot|all> [--hook-script <path>]",
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
