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

function runSimWithInput(
  args: string[],
  input: Record<string, unknown>,
) {
  return runCommand("bun", [SCRIPT, "sim", ...args], {
    input: JSON.stringify(input),
    timeoutMs: 120_000,
  });
}

function main(): number {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopo-stepper-")));
  const repo = join(root, "repo");
  try {
    const start = runSim([
      "start",
      "--repo",
      repo,
      "--request",
      "loopo: a fullstack app",
      "--runtime",
      "codex",
    ]);
    if (start.status !== 0) fail(start.stderr || start.stdout);
    const started = parseJson(start.stdout);
    if (started.slug !== "a-fullstack-app") {
      fail(`unexpected slug from start: ${start.stdout}`);
    }
    if (started.current_stage !== "planning") {
      fail(`start must create a planning quest: ${start.stdout}`);
    }

    const seenOutputs: string[] = [];
    let sawExecutingChildren = false;
    let planRound = 0;
    let landingRound = 0;
    for (let i = 0; i < 20; i += 1) {
      const next = runSim(["next", "--repo", repo]);
      if (next.status !== 0) fail(next.stderr || next.stdout);
      const step = parseJson(next.stdout);
      if ("current_output" in step) {
        fail(`sim next must stop at the hook boundary: ${next.stdout}`);
      }
      const reasonPayload =
        step.reason_payload && typeof step.reason_payload === "object"
          ? (step.reason_payload as Record<string, any>)
          : null;
      if (!reasonPayload) {
        if (step.done === true) break;
        fail(`stepper missing continuation reason: ${next.stdout}`);
      }
      const requestedStep = stepId(reasonPayload.step);
      if (!requestedStep) {
        fail(`stepper missing requested step id: ${next.stdout}`);
      }
      const quest = parseTasksYaml(readText(questFiles(repo, started.slug).tasks));
      const callbackInput = scenarioPayloadForStep({
        request: "loopo: a fullstack app",
        step: requestedStep,
        quest,
        planRound,
        landingRound,
      });
      if (requestedStep === "plan") planRound += 1;
      if (requestedStep === "landing") landingRound += 1;
      const callbackRun = runSimWithInput(
        ["callback", "--repo", repo, "--json", "@-"],
        callbackInput,
      );
      if (callbackRun.status !== 0) fail(callbackRun.stderr || callbackRun.stdout);
      const callbackOutput = parseJson(callbackRun.stdout);
      const outputStep = stepId(callbackOutput.step);
      if (outputStep) seenOutputs.push(outputStep);
      if (
        outputStep === "executing" &&
        Array.isArray(callbackOutput.children) &&
        callbackOutput.children.length >= 1
      ) {
        sawExecutingChildren = true;
      }
      if (
        String(
          parseTasksYaml(readText(questFiles(repo, started.slug).tasks)).stage ??
            "",
        ) === "archived"
      ) {
        seenOutputs.push("archived");
        break;
      }
    }

    const expected = [
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
        fail(`stepper never emitted ${step}: ${JSON.stringify(seenOutputs)}`);
      }
    }
    if (!sawExecutingChildren) {
      fail(
        `stepper never exposed executing children: ${JSON.stringify(seenOutputs)}`,
      );
    }

    const status = runSim(["status", "--repo", repo]);
    if (status.status !== 0) fail(status.stderr || status.stdout);
    const current = parseJson(status.stdout);
    if ("current_output" in current) {
      fail(`sim status must not call quest next: ${status.stdout}`);
    }
    if (current.current_stage !== "archived" || current.done !== true) {
      fail(
        `status must report archived after the stepped run: ${status.stdout}`,
      );
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
