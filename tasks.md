# Worktree Identity Hard-Cut Investigation

Source plans supplied with the request:

- `PLAN.md`
- `PLAN-2.md`

Scope: investigation only. This ledger records completed checks and evidence
before deciding the implementation cut.

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
- Gap: `agents/openai.yaml` still says "slug-based" and instructs agents to use
  `loopo init ... --cwd` and `loopo quest next --slug <slug>`.

### Schema and API terminology

- Init route output is already `wtree`-first: `suggested_wtree`, candidate
  `wtree`, and create input `wtree`. Evidence:
  `schemas/steps/init-output.v3.json`.
- Step output exposes `wtree` and omits `slug` from compact hook output.
  Evidence: `schemas/steps/step-output.v3.json` and
  `scripts/verify_runtime_hooks.ts`.
- Gap: persisted task state still requires `slug` and `parent_quest_slug`.
  Evidence: `schemas/tasks.v3.json`.
- Gap: quest plan state still requires `slug`. Evidence:
  `schemas/quest-plan.v3.json`.
- Gap: child result and child command schemas still require `child_slug`.
  Evidence: `schemas/steps/child-result-input.v3.json` and
  `schemas/steps/common.v3.json`.

### Storage and root `.loopo` state

- Canonical quest files are still resolved as `.loopo/quests/<name>/...` under
  the repo root, while coordinator worktrees live at `worktrees/<name>`.
  Evidence: `scripts/loopo_core.ts` `questFiles` and
  `coordinatorWorktreePath`.
- The repo-root `.loopo` control plane is still intentional in current code:
  `createV3Quest` calls `ensureSystemScaffold(repoRoot)` before creating the
  coordinator worktree. Evidence: `scripts/loopo.ts`.
- Gap: `.loopo/state.json` scaffolding still exists on `main`
  (`LOOPO_STATE_FILE`, `loadState`, `saveState`, `activeQuestFiles`), although
  the current public CLI path does not call it. Evidence: `scripts/loopo_core.ts`
  plus repository-wide `rg` for those helpers.
- No `loopo-active-session` references were found in the repo. Evidence:
  repository-wide search for `loopo-active-session`.

### Hook resolution

- Hook resolution uses one helper that accepts explicit `--wtree`, payload
  `wtree`, payload `loopo_wtree`, or cwd-derived `worktrees/<name>` identity.
  Evidence: `scripts/loopo.ts` `resolveHookWtree`.
- The resolver no-ops with `{}` when it cannot resolve a worktree or when the
  selected worktree has no quest state. Evidence: `scripts/loopo.ts` `runHook`.
- Existing hook verification covers generic installed hooks and continuation
  from `worktrees/<name>`. Evidence: `scripts/verify_runtime_hooks.ts`.
- Gap: existing tests do not yet cover the full plan matrix for root cwd with
  multiple quests, explicit `wtree` plus matching cwd, explicit `wtree` plus
  conflicting cwd, or missing cwd/payload selector.

### Documentation and generated behavior text

- `references/core/architecture.md` and `assets/base-system-behaviours.yaml`
  still describe quest storage and child identity with `slug` terminology.
- `assets/base-system-behaviours.yaml` still claims compact step output includes
  `slug`, while current compact output intentionally omits it.
- `assets/base-system-behaviours.yaml` still documents `.loopo/state.json` in
  the explicit worktree-resolution behavior.

## Implementation Gaps To Decide Next

- Rename persisted state fields from `slug` / `parent_quest_slug` to
  `wtree` / `parent_wtree`, with only deliberate compatibility reads if needed.
- Rename public child payloads from `child_slug` to `child_wtree`.
- Remove `.loopo/state.json` scaffold code from the landed `main` branch.
- Update agent config and behavior docs so they no longer instruct rejected
  `--cwd` or `--slug` usage.
- Add hook tests for conflicting explicit/cwd selectors, root cwd no-op, and
  missing selector no-op.
- Decide whether repo-root `.loopo` remains the control plane or whether quest
  state must move inside each worktree; current code uses repo-root `.loopo`.
