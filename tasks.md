# Worktree Identity Coverage Ledger

This ledger tracks the repo's worktree-first lifecycle coverage after the hard cut.

## Current Coverage

- Public CLI selectors use `wtree` for quest identity.
- Persisted quest state uses `wtree`, `parent_wtree`, and `child_wtree`.
- Canonical quest runtime state is written under `worktrees/<wtree>/.loopship/runtime/`.
- Only `.loopship/system.yaml`, canonical `.loopship/docs/**/*.yaml`, and `.loopship/signature.yaml` are merged back to tracked root `.loopship/**`.
- Hook continuation counters live in worktree-local `.loopship/runtime/hook-state.json`.
- Explicit worktree hook input transfers the soft runtime-thread binding while preserving the Fastflow resume handle.
- Hook routing stores runtime thread IDs separately from Fastflow session IDs and resolves an
  exact worktree through `runtime + thread_id`; explicit `wtree` can transfer ownership, while
  `WTREE` is an initial-binding fallback only.
- Runtime `all` remains unbound until a hook supplies a concrete runtime and thread identity.
- Built-in hook installation covers Codex, Gemini, and Copilot; manually configured runtimes use
  the same runtime-neutral hook command and native thread-id normalization.
- Hook continuation output stays compact and does not expose legacy identity keys.
- Simulation flows and Native child DAG preparation use `wtree` consistently.
- Prior quest-state schemas and legacy keys fail explicitly with
  `legacy_execution_unsupported`; users must abandon or cancel the old run and resubmit it.

## Verification Targets

- Keep runtime schemas and emitted payloads worktree-first.
- Prevent tracked source, docs, and tests from reintroducing legacy identity terms.
- Preserve quest-local storage only at `worktrees/<wtree>/.loopship/runtime/...`.
