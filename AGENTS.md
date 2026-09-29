<!-- markdownlint-disable MD025 -->
<!-- BEGIN rules:spec:common -->

# Shared Rules

- Keep one coherent task per worktree, use worktree-local tool environments, and remove temporary worktrees and branches after landing.
- Maintain a real gitignored `<worktree>/tmp/` for scratch and task-local state. Managed-goal artifact bundles are owned and initialized by `$goal-prompt-optimizer`; do not create placeholder planning or goal files as a generic worktree preflight.
- Keep heavy or generated scratch assets outside the repository or in ignored `tmp/`; never commit `temp`, `tmp`, `_temp`, `_tmp`, `.tmp`, or `.temp` paths.
- Run relevant tests, builds, and checks before landing.
- **User-facing messages:** During substantive work, remain silent unless user input or approval is required. Do not announce starts or narrate routine actions, tool calls, or intermediate progress. Final reports should state only the outcome, relevant checks, and unresolved issues. Reduced narration must not reduce reasoning, investigation, execution, or verification.

<!-- END rules:spec:common -->
<!-- BEGIN rules:spec:coding -->

# Coding Baseline

- Default to `mre`: prefer no code when it safely satisfies the proven need; when existing code must change, make the smallest surgical, coherent change and preserve repo conventions, safeguards, and risk-proportional verification.
- Organize new production code into cohesive, idiomatic modules, packages, classes, or functions with clear ownership. Prefer feature/domain-first folders when no stronger convention exists; avoid flat dumps and generic catch-alls (`utils`, `helpers`, `common`, `misc`). Shared code needs a specific owner and purpose.
- Give modules narrow public entry points, private internals, acyclic dependencies, and shallow imports. Separate domain/policy logic from UI, transport, persistence, and integrations when they change or test independently.
- Use SOLID, separation of concerns, Clean Architecture, and established patterns when they reduce coupling or testing cost; do not add speculative layers or abstractions.
- For touched legacy code, improve boundaries when safe and proportional, never deepen structural debt, and reserve broad restructuring for explicit refactor scope.
- Prefer TDD/BDD. Follow repo test conventions; otherwise co-locate unit/component tests with their module and place integration/contract/E2E tests in dedicated suites. Keep fixtures/helpers near consumers until shared.
- **Integration tests must use isolated live environments** (sandboxed databases, test accounts, ephemeral services). Never run integration tests against a production runtime or data store.
- Prefer cohesive files ~300–500 lines; review 500+ and consider splitting 1,000+ unless generated, declarative, or inherently cohesive. Split by semantic boundary; keep co-changing code together.

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
