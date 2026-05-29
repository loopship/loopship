#!/usr/bin/env bun

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTasksYaml, questFiles } from "./loopo_core.ts";
import { scenarioPayloadForStep } from "./sim_product_quest_scenarios.ts";
import { readText, runCommand } from "./loopo_utils.ts";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "loopo.ts");

function fail(message: string): never {
  throw new Error(message);
}

function parseJson(text: string): Record<string, any> {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("expected object");
    }
    return parsed;
  } catch {
    fail(`expected JSON object, got: ${text}`);
  }
}

function stepId(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const id = (value as Record<string, unknown>).id;
    return typeof id === "string" ? id : "";
  }
  return "";
}

function runSim(args: string[]) {
  return runCommand("bun", [SCRIPT, "sim", ...args], {
    timeoutMs: 120_000,
  });
}

function runSimWithInput(args: string[], input: Record<string, unknown>) {
  return runCommand("bun", [SCRIPT, "sim", ...args], {
    input: JSON.stringify(input),
    timeoutMs: 120_000,
  });
}

function assertGuidedStep(step: Record<string, any>, repo: string): void {
  if ("hook_output" in step || "reason_payload" in step) {
    fail(`guided sim must not expose hook internals: ${JSON.stringify(step)}`);
  }
  if ("current_output" in step) {
    fail(`guided sim must expose the current step directly: ${JSON.stringify(step)}`);
  }
  const command = step.commands?.next;
  if (!command || command.cmd !== "loopo") {
    fail(`guided sim step must include commands.next: ${JSON.stringify(step)}`);
  }
  const args = Array.isArray(command.args) ? command.args : [];
  const expected = ["sim", "--repo", repo, "--json", "@-"];
  if (JSON.stringify(args) !== JSON.stringify(expected)) {
    fail(`guided sim commands.next mismatch: ${JSON.stringify(args)}`);
  }
}

function simArgsFromStep(step: Record<string, any>): string[] {
  const args = step.commands?.next?.args;
  if (!Array.isArray(args) || args[0] !== "sim") {
    fail(`missing runnable sim next command: ${JSON.stringify(step.commands)}`);
  }
  return args.slice(1).map(String);
}

function assertLegacyModeGuidance(): void {
  const legacy = runSim(["start", "--request", "loopo: old path"]);
  if (legacy.status === 0) {
    fail(`legacy sim start unexpectedly succeeded: ${legacy.stdout}`);
  }
  const combined = `${legacy.stderr}\n${legacy.stdout}`;
  if (!combined.includes("replaced by the guided sim flow")) {
    fail(`legacy sim start must print migration guidance: ${combined}`);
  }
}

function main(): number {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopo-stepper-")));
  const repo = join(root, "repo");
  const request = "loopo: a fullstack app";
  try {
    assertLegacyModeGuidance();

    const start = runSim([
      request,
      "--repo",
      repo,
      "--runtime",
      "codex",
      "--flow",
      "swe",
    ]);
    if (start.status !== 0) fail(start.stderr || start.stdout);
    let current = parseJson(start.stdout);
    assertGuidedStep(current, repo);
    if (current.slug !== "a-fullstack-app") {
      fail(`unexpected slug from guided sim start: ${start.stdout}`);
    }
    if (current.current_stage !== "planning") {
      fail(`guided sim start must create a planning quest: ${start.stdout}`);
    }

    const seenOutputs: string[] = [stepId(current.step)];
    let sawExecutingChildren = false;
    let planRound = 0;
    let landingRound = 0;
    for (let i = 0; i < 20; i += 1) {
      if (current.done === true) break;
      const requestedStep = stepId(current.step);
      if (!requestedStep) {
        fail(`guided sim missing current step id: ${JSON.stringify(current)}`);
      }
      const quest = parseTasksYaml(readText(questFiles(repo, current.slug).tasks));
      const callbackInput = scenarioPayloadForStep({
        request,
        step: requestedStep,
        quest,
        planRound,
        landingRound,
      });
      if (requestedStep === "plan") planRound += 1;
      if (requestedStep === "landing") landingRound += 1;
      const continued = runSimWithInput(simArgsFromStep(current), callbackInput);
      if (continued.status !== 0) fail(continued.stderr || continued.stdout);
      current = parseJson(continued.stdout);
      assertGuidedStep(current, repo);
      const outputStep = stepId(current.step);
      if (outputStep) seenOutputs.push(outputStep);
      if (
        outputStep === "executing" &&
        Array.isArray(current.children) &&
        current.children.length >= 1
      ) {
        sawExecutingChildren = true;
      }
    }

    const expected = [
      "plan",
      "questions",
      "plan",
      "task_graph",
      "executing",
      "validation",
      "verification",
      "system_update",
      "landing",
      "archived",
    ];
    for (const step of expected) {
      if (!seenOutputs.includes(step)) {
        fail(`guided sim never emitted ${step}: ${JSON.stringify(seenOutputs)}`);
      }
    }
    if (!sawExecutingChildren) {
      fail(
        `guided sim never exposed executing children: ${JSON.stringify(seenOutputs)}`,
      );
    }
    if (current.current_stage !== "archived" || current.done !== true) {
      fail(`guided sim must finish at archived: ${JSON.stringify(current)}`);
    }

    console.log("loopo runtime stepper verification passed");
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
