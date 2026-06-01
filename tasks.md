# Worktree Identity Hard-Cut Investigation

Source plans supplied with the request:

- `PLAN.md`
- `PLAN-2.md`

Scope: investigation plus completed follow-up implementation. This ledger
records completed checks, evidence, and the decisions applied after the cut.

## Completed Tasks

- [x] Consolidate both plan files into one investigation checklist.
- [x] Check the public command surface for `wtree`, `slug`, `cwd`, and
  `session` selectors.
- [x] Check generated/schema-facing API fields for `wtree` versus `slug`
  terminology.
- [x] Check persisted quest state and root `.loopo` state behavior.
- [x] Check hook resolution behavior against the parallel worktree design.
- [x] Check existing verification coverage for hard-cut requirements.
- [x] Record implementation gaps without choosing the implementation shape.

## Findings

### Public command selector

- `loopo init` currently rejects `--cwd`, `--slug`, and `--session`; it accepts
  `--repo` and optional `--wtree`. Evidence: `scripts/loopo.ts`
  `parseInitArgs`.
- `loopo quest next` currently rejects `--cwd`, `--slug`, and `--session`; it
  requires `--wtree` or payload `wtree`. Evidence: `scripts/loopo.ts`
  `parseQuestRepoArg` and `runQuestNextV3`.
- `loopo sim` currently rejects `--cwd` and `--slug` and uses `--wtree`.
  Evidence: `scripts/loopo_sim.ts`.
- Step output commands already emit `loopo quest next --wtree <name> --json @-`.
  Evidence: `scripts/loopo.ts` `v3StepOutput`.
- Resolved: `agents/openai.yaml` now describes the worktree-based launcher and
  instructs agents to use repo-root `loopo init ... --runtime <runtime>` plus
  `loopo quest next --wtree <name> --json @-`.

### Schema and API terminology

- Init route output is already `wtree`-first: `suggested_wtree`, candidate
  `wtree`, and create input `wtree`. Evidence:
  `schemas/steps/init-output.v3.json`.
- Step output exposes `wtree` and omits `slug` from compact hook output.
  Evidence: `schemas/steps/step-output.v3.json` and
  `scripts/verify_runtime_hooks.ts`.
- Resolved: persisted task state now requires `wtree` and `parent_wtree`, with
  compatibility reads for legacy `slug` and `parent_quest_slug`. Evidence:
  `schemas/tasks.v3.json` and `scripts/loopo_core.ts`.
- Resolved: quest plan state now requires `wtree`. Evidence:
  `schemas/quest-plan.v3.json`.
- Resolved: child result and child command schemas now require `child_wtree`.
  Evidence: `schemas/steps/child-result-input.v3.json` and
  `schemas/steps/common.v3.json`.

### Storage and root `.loopo` state

- Canonical quest files remain resolved as `.loopo/quests/<name>/...` under
  the repo root, while coordinator worktrees live at `worktrees/<name>`.
  Evidence: `scripts/loopo_core.ts` `questFiles` and
  `coordinatorWorktreePath`.
- The repo-root `.loopo` control plane remains intentional in current code:
  `createV3Quest` calls `ensureSystemScaffold(repoRoot)` before creating the
  coordinator worktree. Evidence: `scripts/loopo.ts`.
- Resolved follow-up: the unused `.loopo/state.json` scaffold exports were
  removed from `scripts/loopo_core.ts`; the current public CLI path did not call
  them.
- No `loopo-active-session` references were found in the repo. Evidence:
  repository-wide search for `loopo-active-session`.

### Hook resolution

- Hook resolution uses one helper that accepts explicit `--wtree`, payload
  `wtree`, payload `loopo_wtree`, or cwd-derived `worktrees/<name>` identity.
  Evidence: `scripts/loopo.ts` `resolveHookWtree`.
- The resolver no-ops with `{}` when it cannot resolve a worktree or when the
  selected worktree has no quest state. Evidence: `scripts/loopo.ts` `runHook`.
- Existing hook verification covers generic installed hooks, continuation from
  `worktrees/<name>`, root cwd with multiple quests, explicit `wtree` plus
  matching cwd, explicit `wtree` plus conflicting cwd, and missing selector
  no-op behavior. Evidence: `scripts/verify_runtime_hooks.ts`.

### Documentation and generated behavior text

- `references/core/architecture.md` and `assets/base-system-behaviours.yaml`
  now describe quest storage and child identity with `wtree` terminology.
- `assets/base-system-behaviours.yaml` now describes compact step output as
  `wtree`-based and confirms the full metadata remains behind `--full`.
- The stale `.loopo/state.json` continuation note was removed from
  `assets/base-system-behaviours.yaml`.

## Implementation Decisions Applied

- [x] Rename persisted state fields from `slug` / `parent_quest_slug` to
  `wtree` / `parent_wtree`, keeping compatibility reads only for existing
  quest state.
- [x] Rename public child payloads from `child_slug` to `child_wtree`.
- [x] Remove unused `.loopo/state.json` scaffold exports from the landed branch.
- [x] Update agent config and behavior docs so they no longer instruct rejected
  `--cwd` or `--slug` usage.
- [x] Add hook tests for conflicting explicit/cwd selectors, root cwd no-op,
  explicit matching selector/cwd, and missing selector no-op.
- [x] Record the current repo-root `.loopo` control-plane behavior as the state
  before migration, not the target design.

## Superseding Migration Plan

The next coherent change should move canonical quest state into the quest's own
coordinator worktree so parallel parent and child quests do not mutate the same
repo-root `.loopo` files.

### Target model

- `wtree` remains the public quest identity.
- `loopo init` allocates a unique base worktree name before emitting
  `suggested_wtree`.
- A quest's state root becomes `worktrees/<wtree>/.loopo`.
- Canonical quest files move from `.loopo/quests/<wtree>/...` to
  `worktrees/<wtree>/.loopo/quests/<wtree>/...`.
- Child quests are independent coordinator worktrees with independent `.loopo`
  roots. The parent stores only `child_wtree`, branch, and worktree path.
- Landing merges the quest branch, so tracked `.loopo/**` artifacts arrive on
  the landing branch through git rather than through direct root mutation.

### Unique worktree allocation

The allocator must reject or suffix a candidate when it conflicts with any live
worktree basename, non-empty `worktrees/<name>` path, branch of the same name,
legacy `.loopo/quests/<name>` state, legacy `.loopo/archieve/<name>` state, or a
reserved basename such as `main`, `master`, `landing-*`, `tmp`, `.git`,
`.loopo`, or `worktrees`.

Automatic names should use deterministic suffixes like `<base>`, `<base>-2`,
and `<base>-3`. Explicit `--wtree` conflicts should fail with a structured
response and alternatives rather than silently changing the requested identity.

### Implementation phases

1. Add the unique `wtree` allocator and a short non-tracked allocation lock
   under `.git/loopo/locks/wtrees/`.
2. Introduce a quest context object containing `repoRoot`, `wtree`,
   `worktreePath`, `loopoRoot`, and `questRoot`.
3. Route `questFiles`, `ensureSystemScaffold`, hook state, manifests, and
   quest sidecars through the quest context.
4. Change create/continue paths so the coordinator worktree is created before
   `.loopo` state is written.
5. Resolve parent-child state through `child_wtree` plus `worktree_path`, never
   through a shared root `.loopo/quests/<child>`.
6. Keep root `.loopo` access only as a read-only legacy migration path until
   existing quests can be copied into their local worktree `.loopo`.
7. Update docs, schemas, and tests to assert quest-local state and parallel
   child isolation.

### Verification requirements

- Init contract: two parallel identical prompts produce different wtrees and
  create state only under each worktree-local `.loopo`.
- Quest continuation: `quest next --wtree <name>` reads
  `worktrees/<name>/.loopo/quests/<name>/tasks.yaml`.
- Hook routing: explicit, cwd-derived, conflicting, and missing-local-state
  cases are covered.
- Child isolation: parent and child tasks mutate separate `.loopo` roots, and
  parent completion reads the child through `child_wtree`.
- Landing: no tracked `worktrees/**` paths, and merged branches carry only
  tracked `.loopo/**` artifacts into the target branch.
