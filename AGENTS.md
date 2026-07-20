<!-- markdownlint-disable MD025 -->
<!-- BEGIN rules:spec:common -->

# Shared Rules

- **Worktree isolation:** never edit, stage, or commit directly on `main`; use a dedicated task worktree first.
- Put all code changes in `<repo>/worktrees/<name>/` and switch before editing.
- Keep the repo-owned `/worktrees/*` path gitignored.
- Follow any runtime skill's worktree naming, branch naming, or reconcile flow.
- One worktree = one coherent task.
- Remove temporary worktrees and branches after landing.
- Use per-worktree tool envs (`bin/`, `.venv/`, `.codex-rotate/bin/`).
- Maintain a real, gitignored `<worktree>/tmp/` agent workspace; before editing, ensure `tmp/tasks.md` and `tmp/plan.md` exist and `git check-ignore tmp/tasks.md tmp/plan.md` passes.
- Treat `tmp/tasks.md` as the canonical execution ledger for the current worktree; do not land while any item remains incomplete.
- If `tmp/plan.md` is missing or empty, create or update it before implementation; use Codex Plan mode when available, otherwise write the plan directly.
- Keep heavy/generated temporary assets outside the repo or inside ignored `tmp/`; never commit `temp`, `tmp`, `_temp`, `_tmp`, `.tmp`, or `.temp` paths.
- Run relevant tests/builds/checks before landing.
- **Token discipline:** no user-facing prose unless needed to complete the requested action. Avoid mid-task updates unless blocked or coordination-critical. Act from context; ask only when needed. End with compact `what changed / how / checks` when applicable. Omit logs, diffs, and repeated context unless requested.

<!-- END rules:spec:common -->
<!-- BEGIN rules:spec:coding -->

# Coding Baseline

- Default to the `mre` skill: build for the current proven need; choose the highest safe rung: no change, deletion, reuse, platform/stdlib, installed dependency, new code, then new dependency.
- Keep edits scoped and follow repo idioms.
- Prefer TDD/BDD: write or update tests before (or alongside) the implementation for behavior changes. Apply SOLID only when it reduces churn.
- **Integration tests must use isolated live environments** (sandboxed databases, test accounts, ephemeral services). Never run integration tests against a production runtime or data store.
- Optimize for agentic locality: prefer cohesive production files ~300-500 lines; treat 500+ as a smell and 1,000+ as a split candidate in multi-file modules unless generated, declarative, or inherently cohesive.
- Split by semantic boundary, for example types, I/O, validation, domain logic, UI state/view, CLI parsing/execution, test helpers, or test scenarios.
- Avoid splits where the pieces must always be read or changed together.

<!-- END rules:spec:coding -->
<!-- BEGIN rules:spec:ts -->

# TypeScript Rules

- Use explicit boundary types; avoid new `any` without a repo exception.
- Keep external-input/config validators and TS types aligned; update adjacent type/compile checks for public API changes.

<!-- END rules:spec:ts -->
<!-- BEGIN rules:local -->

# Loopship Agent Guide

## Working Rules

- This repo is `@omar391/loopship`, a deterministic V3 workflow launcher for worktree-based quest flows.
- Prefer `bun` for local execution and tests. The main verification commands are the scripts listed in `package.json`.
- Do not edit `.loopship/**` state files directly unless you are intentionally repairing canonical runtime state.
- For `loopship:` requests, use `loopship init "{request}" --runtime <runtime>` from the repo root and follow compact JSON step output.
- Use `loopship init`, `loopship quest next`, `loopship hook`, `loopship sim`, and `loopship doctor --fix` to exercise lifecycle behavior instead of hand-editing runtime outputs.
- Keep changes aligned with the schema-backed workflow files in `schemas/**`, `assets/**`, and `scripts/**`.
- When changing lifecycle logic, update or run the relevant verification scripts before finishing.
- Treat `tasks.md` as the repo's lifecycle coverage ledger, not as a transient task checklist, unless the user explicitly asks to repurpose it.
- Treat `.loopship/quests/*/tasks.yaml`, quest JSONL files, Native execution ledgers, pinned child-DAG decisions and receipts, and git worktree state as canonical evidence when prose and state disagree. Emitted child commands and callback payloads are unsupported legacy state.
- Keep parent/root sessions coordinator-only during child execution; pinned Native child-workflow instances own implementation work in dedicated worktrees.
- Keep edits ASCII unless a file already uses non-ASCII characters.
- Avoid destructive git commands and do not revert unrelated user changes.

## Helpful References

- `README.md` for the user-facing CLI surface.
- `tasks.md` for current lifecycle coverage notes.
- `.loopship/docs/software/architecture.yaml`, `.loopship/docs/workflow/spec.yaml`, and `.loopship/docs/agent/system-card.yaml` for controller, lifecycle, runtime hook, ops, and supervisor contracts.
- `references/core/analytical-framework.md` for rigorous reasoning checks.
- `references/core/optimization-framework.md` for deterministic execution discipline.
- `agents/openai.yaml` for the Codex default invocation contract.

## Verification

- Run `bun run scripts/verify_coherency.ts` after documentation, lifecycle, schema, or reference changes.
- Run `bun run scripts/verify_quest_contract.ts` after quest state, schema, or command-surface changes.
- Run `bun run scripts/verify_runtime_hooks.ts` after hook, continuation, drift, or doctor changes.
- Run `bun run verify` before finishing broad lifecycle or architecture changes.

<!-- END rules:local -->

Load on-demand specs: [`code-review`](~/.agents/skills/agent-md/assets/specs/code-review.md), [`sharia`](~/.agents/skills/agent-md/assets/specs/sharia.md)
