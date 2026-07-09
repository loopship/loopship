# Loopship Universality Benchmark

Date: 2026-07-09

Scope: non-deployment benchmark evidence for the "any system / any scale" claim. Deployment realism remains out of scope.

## Phase 0 Audit

- Root `main` was clean at `1a1e2f2 test(lifecycle): add deterministic stress matrix`.
- Existing `worktrees/uflow-plan` had unrelated README/`uflow.md` planning edits and no unmerged commits over `main`.
- Prior deterministic stress work was already landed on `main`; new benchmark work ran in `worktrees/universality-benchmark` on branch `loopship-universality-benchmark`.

## Inference Registry

| Lifecycle role | Registry/group evidence | Route used in this benchmark |
| --- | --- | --- |
| Planning/questions | `loopship_planning`: `llm.cli.codex.gpt-5.5.max -> aitl.chat -> hitl.review` | live planning sample used `gpt-5.5`, xhigh |
| Review/validation/system-update | `loopship_review`: `llm.cli.codex.gpt-5.3-codex-spark.max -> aitl.chat -> hitl.review` | deterministic verifiers plus existing review-route audit |
| Child implementation | `loopship_child_implementation`: `aitl.subagent -> hitl.review` | live child samples used `aitl.subagent` workers with `gpt-5.4-mini`, xhigh |

## Live Child-Agent Microbenchmark

| Request | Group/model | Repo/worktree | Commit | Checks | Receipt evidence | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `build a project TODO scanner` | `loopship_child_implementation` via `aitl.subagent`; `gpt-5.4-mini` xhigh | `tmp/live-agent-samples/todo-scanner` on `codex/live-todo-scanner` | `e1b7a81 feat: add TODO scanner CLI` | `bun run check` passed locally after receipt | artifacts: `src/todo-scan.ts`, worker receipt, clean branch | pass |
| `create a lightweight team decision log` | `loopship_child_implementation` via `aitl.subagent`; `gpt-5.4-mini` xhigh | `tmp/live-agent-samples/decision-log` on `codex/live-decision-log` | `dc7611a Add lightweight team decision log` | `bun run check` passed locally after receipt | artifacts: `decisions/log.json`, `.loopship/system.yaml`/canonical docs check | pass |
| `add import validation to this tiny data schema repo` | `loopship_child_implementation` via `aitl.subagent`; `gpt-5.4-mini` xhigh | `tmp/live-agent-samples/import-validation` on `codex/live-import-validation` | `efaf889 Add import validation` | `bun run check` passed locally after receipt | artifacts: `scripts/validate-import.ts`, good/bad input evidence | pass |

Proof boundary: real child agents implemented, committed, ran local validation, and returned receipts in isolated tiny repos. This proves the subagent implementation route can perform child work. It does not yet prove a full native `loopship init -> emitted child CLI command -> child_result callback -> parent landing` run with live model tokens.

## Adversarial/Security Matrix

Command: `bun run scripts/verify_lifecycle_adversarial_matrix.ts`

| Scenario | Result | Evidence |
| --- | --- | --- |
| `tampered-child-receipt` | pass | receipt commit not matching/reachable from child branch rejected |
| `stale-local-work-receipt` | pass | stale receipt HEAD rejected against actual worktree HEAD |
| `path-traversal-system-update` | pass | external doc path escaping `.loopship/docs` rejected without changing `.loopship/system.yaml` |
| `secret-leakage-system-doc` | pass | token-like secret material rejected before durable write |
| `malicious-child-payload` | pass | child-result schema rejects unexpected command/stage fields |
| `tampered-worktree-state` | pass | branch/worktree mismatch blocks acceptance |
| `poisoned-validation` | pass | pass-shaped receipt with failed check rejected by verifier |
| `unsafe-landing-target` | pass | target worktree outside repo boundary rejected by verifier |

Patch made: `applySystemUpdate` now validates the full system-update payload, rejects token-like secret material, enforces external docs under `.loopship/docs/**/*.yaml`, and preflights external doc operations before rewriting `.loopship/system.yaml`.

## Non-Software Fixture Matrix

Command: `bun run scripts/verify_non_software_fixture_matrix.ts`

| Fixture | Result | Evidence |
| --- | --- | --- |
| docs-only system | pass | planning, validation, system-update, verification, landing, archive; canonical decision records |
| data/schema system | pass | schema, good/bad examples, validator check, dataset datasheet doc |
| artifact/BOM system | pass | generated manifest, BOM doc, provenance/checksum checks |
| design-system doc update | pass | token JSON, component docs, knowledge-report canonical doc |

## Scale Ceiling Matrix

Command: `bun run scripts/verify_lifecycle_stress_matrix.ts`

| Scenario | Tasks/DAG | Runtime | Git ops | Result |
| --- | --- | ---: | ---: | --- |
| `parallel-20-clean` | 20 independent | 8.734s | 228 | pass |
| `parallel-100-clean` | 100 independent | 42.972s | 1108 | pass |
| `dag-depth-20` | 20-node chain | 9.270s | 227 | pass |
| `wide-and-deep-mixed-dag` | 40 nodes, 4 waves of 10 | 16.183s | 447 | pass |
| `lock-contention-many-ready` | 50 ready tasks, serialized shared lock | 20.449s | 557 | pass |
| `concurrent-coordinator-resume-smoke` | 12 tasks, interrupt after 6 | 2.262s | 140 | pass |

Proof boundary: deterministic scripted ceiling is now above `parallel-20-*`, with `parallel-100-clean` landed/validated/verified/archived. Actual safe parallel landing remains deliberately serialized where shared locks or merge contention apply.

## Planning/Question Quality

| Sample | Group/model | Result |
| --- | --- | --- |
| Prompt audit | `loopship_planning` route check | pass: plan prompt requires repo/system-doc scouting, infer-before-ask, clarify-before-decompose, grouped material questions, unknown ledgers |
| Live planning sample: `make this useful for the team` | `gpt-5.5` xhigh | pass: inspected `.loopship/system.yaml`, signature, canonical docs, AGENTS, package/check scripts, docs, and decision log; inferred/defaulted discoverable facts; asked 3 material questions; `task_graph_created=false` |

## Hook And System-Doc Evidence

- `bun run scripts/verify_runtime_hooks.ts`: passed; `loopship hook --runtime codex --repo <repo> --json @resume.json` parity verified.
- `bun run scripts/verify_runtime_stepper.ts`: passed; native stepper paused/resumed under `superviseStep` before child execution.
- `bun run scripts/verify_system_model.ts`: passed; repo root `.loopship/system.yaml`, canonical docs, and `.loopship/signature.yaml` validate.
- `bun run verify`: passed under sandbox escalation because existing tests write the Loopship shim to `/Users/omar/.local/bin/loopship`.
- System-update payloads are schema-validated against `schemas/system-update.yaml`; step payload schema exists at `schemas/steps/system-update-input.yaml`; stable workflow is `call-catalog/loopship/workflow/service/step/system-update.stable.yaml`.

## Cost/Performance Summary

- Live model usage was bounded to three child implementation samples and one planning sample.
- Broad adversarial, non-software, recovery, and scale coverage used deterministic fixtures only.
- Largest deterministic case: `parallel-100-clean`, 100 child worktrees, 42.972s, 1108 git ops, 83ms check time.
- Total deterministic stress matrix runtime was about 105s on this machine.

## What Is Proven Now

- Loopship has landed prior deterministic lifecycle substrate work and this branch extends evidence without deployment scope.
- System-update rejects full-payload schema violations, path traversal, and token-like secret persistence before durable writes.
- Non-software systems can pass the same planning, validation, verification, system-update, landing, archive, and manifest evidence pattern.
- Deterministic scale evidence now covers 100 independent child worktrees, depth-20 DAGs, mixed DAG waves, shared-lock serialization, and interrupted resume.
- Live subagent child workers can implement, validate, commit, and report small software, documentation/data, and schema tasks.
- Planning prompt and live planning sample show useful questions without premature task graph creation when material unknowns remain.

## Remaining Gaps Before "Any System / Any Scale"

- Full native live-child Loopship flow remains open: emitted child command, live child execution, child_result callback, parent verification, parent landing/archive in one canonical run.
- Cross-runtime confidence remains thin beyond Codex-oriented hook/stepper verification.
- Scale evidence is filesystem/git-heavy but still local and scripted; distributed execution and large-repo contention are not proven.
- Security fixtures now prove local guards and schema rejection, but production flow-level poisoned-validation and receipt reachability checks should be promoted into reusable AFNs before the strongest safety claim.
- Deployment realism remains intentionally out of scope.
