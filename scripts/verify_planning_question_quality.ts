#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

type AuditResult = {
  id: string;
  status: "pass" | "fail";
  evidence: string;
};

const stepRoot = resolve("call-catalog", "loopship", "workflow", "service", "step");
const planPath = join(stepRoot, "plan.stable.yaml");
const questionsPath = join(stepRoot, "questions.stable.yaml");
const planText = readFileSync(planPath, "utf8");
const questionsText = readFileSync(questionsPath, "utf8");
const plan = parseYaml(planText) as Record<string, any>;
const questions = parseYaml(questionsText) as Record<string, any>;

function has(text: string, needle: string): boolean {
  return text.includes(needle);
}

function hasPattern(text: string, pattern: RegExp): boolean {
  return pattern.test(text.replace(/\s+/g, " "));
}

function groupRoute(workflow: Record<string, any>, group: string): string[] {
  return workflow.document?.metadata?.inference?.groups?.[group]?.try ?? [];
}

const results: AuditResult[] = [
  {
    id: "planning-route",
    status: groupRoute(plan, "loopship_planning").includes("llm.cli.codex.gpt-5.5.max") ? "pass" : "fail",
    evidence: `plan uses ${groupRoute(plan, "loopship_planning").join(" -> ")}`,
  },
  {
    id: "questions-route",
    status: groupRoute(questions, "loopship_planning").includes("llm.cli.codex.gpt-5.5.max") ? "pass" : "fail",
    evidence: `questions uses ${groupRoute(questions, "loopship_planning").join(" -> ")}`,
  },
  {
    id: "repo-system-scout",
    status:
      has(planText, "Read `.loopship/system.yaml` when it exists before grilling") &&
      has(planText, "`.loopship/docs/**/*.yaml` before asking questions")
        ? "pass"
        : "fail",
    evidence: "plan prompt requires system.yaml and canonical docs scouting before questions",
  },
  {
    id: "infer-before-ask",
    status:
      hasPattern(planText, /Eliminate unknowns by discovering repo facts before asking the user/) &&
      hasPattern(planText, /If a question can be answered by exploring the codebase, explore instead/)
        ? "pass"
        : "fail",
    evidence: "discoverable facts are resolved from repo evidence before user questions",
  },
  {
    id: "clarify-before-decompose",
    status:
      has(planText, "Run the Plan Gate before any task decomposition") &&
      has(planText, "ask: submit `questions`, omit `task_graph`, and stop") &&
      has(planText, "Do not submit executable decomposition while high-impact ambiguity remains")
        ? "pass"
        : "fail",
    evidence: "material unknowns block task graph creation",
  },
  {
    id: "question-breadth-without-noise",
    status:
      has(planText, "Emit as many independent material questions") &&
      has(planText, "Do not cap the Loopship `questions` payload") &&
      has(planText, "Question text should grill the missing decision, not survey preferences")
        ? "pass"
        : "fail",
    evidence: "questions must be complete, grouped, material, and non-survey",
  },
  {
    id: "unknown-ledger",
    status:
      has(planText, "high_impact_unknowns") &&
      has(planText, "defaulted_unknowns") &&
      has(planText, "verification_targets")
        ? "pass"
        : "fail",
    evidence: "plan schema records high-impact, defaulted, and verification unknown handling",
  },
  {
    id: "questions-no-auto-answer",
    status:
      has(questionsText, "Do not auto-answer unresolved") &&
      has(questionsText, "wait for human-provided answers")
        ? "pass"
        : "fail",
    evidence: "questions step records answers only and does not invent user responses",
  },
];

const lines = [
  "# Planning Question Quality Audit",
  "",
  "| Check | Status | Evidence |",
  "| --- | --- | --- |",
  ...results.map((result) => `| ${result.id} | ${result.status} | ${result.evidence.replace(/\|/g, "/")} |`),
  "",
];

process.stdout.write(lines.join("\n"));
if (results.some((result) => result.status !== "pass")) {
  process.exitCode = 1;
}
