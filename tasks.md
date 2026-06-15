# Worktree Identity Coverage Ledger

This ledger tracks the repo's worktree-first lifecycle coverage after the hard cut.

## Current Coverage

- Public CLI selectors use `wtree` for quest identity.
- Persisted quest state uses `wtree`, `parent_wtree`, and `child_wtree`.
- Canonical quest runtime state is written under `worktrees/<wtree>/.loopship/runtime/`.
- Only `.loopship/system.yaml`, canonical `.loopship/docs/**/*.yaml`, and `.loopship/signature.yaml` are merged back to tracked root `.loopship/**`.
- Hook continuation counters live in worktree-local `.loopship/runtime/hook-state.json`.
- Hook continuation output stays compact and does not expose legacy identity keys.
- Simulation flows and child dispatch flows use `wtree` consistently.
- Legacy quest-state keys fail fast and require manual cleanup or quest recreation.

## Verification Targets

- Keep runtime schemas and emitted payloads worktree-first.
- Prevent tracked source, docs, and tests from reintroducing legacy identity terms.
- Preserve quest-local storage only at `worktrees/<wtree>/.loopship/runtime/...`.
