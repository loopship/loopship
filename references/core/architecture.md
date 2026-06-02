# Loopo Architecture

This document is the central human architecture reference for Loopo. It keeps
the runtime contract, lifecycle model, hook rules, ops commands, and durable
supervision lessons in one place.

## Launcher And Command Surface

- Loopo is a deterministic V3 workflow launcher for worktree-based quest flows.
- User-facing work enters through:

```bash
loopo init "{request}" --runtime <runtime>
```

- The launcher returns compact JSON step output with schema-backed next actions.
- Quest identity in the public command surface is `wtree`, the base worktree
  name. Session ids are not part of the user contract.
- `loopo quest next --wtree <name> --json <json|@file|@->` is the only
  state-mutating quest command after init.
- `loopo hook --runtime <runtime>` reads hook payload JSON from stdin and
  decides runtime continuation.
- `loopo doctor --fix` repairs system scaffolding, hook installation, shims,
  manifests, and managed drift.
- `loopo sim` provides deterministic selected-flow lifecycle stepping for local
  simulation, while `loopo sim hook` is the explicit passthrough lane for hook
  behavior.
- `loopo cmdproto execjson <path> <payload>` mirrors the current public CLI as
  a machine wrapper and introspection surface; it delegates back to the direct
  Loopo command logic and does not replace the V3 quest lifecycle.
- Agents must never edit `.loopo/**` directly. Root and child state changes must
  go through schema-valid `quest next` payloads for the current step.

## Canonical Storage And Authority

- Worktree-local system index, when a system update is recorded:
  `worktrees/{wtree}/.loopo/system.yaml`
- Worktree-local system docs, when recorded:
  `.loopo/docs/high-level-design.yaml`,
  `.loopo/docs/low-level-design.yaml`, `.loopo/docs/architecture.yaml`,
  `.loopo/docs/system-behaviours.yaml`, and `.loopo/docs/design-system.yaml`
- Worktree-local system manifest, when recorded: `.loopo/manifest.sign.json`
- Quest runtime state: `worktrees/{wtree}/.loopo/runtime/tasks.yaml`,
  `.loopo/runtime/events.jsonl`, and `.loopo/runtime/manifest.sign.json`.
  This runtime state stays local to the source worktree and is gitignored.
- Volatile runtime coordination lives in `worktrees/{wtree}/.loopo/runtime/hook-state.json`
  and the transient per-worktree `lock.json`.
- `tasks.yaml` is authoritative for quest stage, Q&A, detailed plan, task graph,
  validation receipt, verification receipt, and landing receipt.
- `.loopo/system.yaml` indexes every supported system doc and schema.
- `events.jsonl` is compact append-only machine audit history.
- Manifests contain SHA-256 file digests, previous receipt head, current receipt
  head, writer command, and request id.
- Direct edits that do not match the receipt chain are unauthorized/tampered
  state and block continuation.

## Flow Lifecycle

Bundled default root flow `swe`:

```text
planning -> awaiting_user_answers -> plan_review -> task_graph_ready -> validating -> verification_pending -> system_update_pending -> landing_ready -> archived
```

- The flow YAML is authoritative for executable stages and transitions.
- Step YAML in `assets/steps/*.yaml` is authoritative for handler metadata,
  input step, schemas, summary, and instructions.
- Do not add separate lifecycle stage specs for Loopo steps.
- `task_graph_ready` uses the `executing` step definition: it emits ready child
  commands and accepts `child_result` payloads.
- `replanning` is the only detour for adding, removing, splitting, or
  materially changing tasks after `task_graph_ready`.
- Add-task uses the same planning detour, constrained to task graph patch work,
  and returns to `task_graph_ready`.
- Child task flow starts from `task_graph_ready` through
  `children[].commands.init` and returns to the parent through a `child_result`
  payload.

## Root And Child Roles

- The root assistant is coordinator/team lead: intake, planning, assignment,
  monitoring, escalation, and `system_update_pending`.
- Child CLI agents are senior developer agents: implement, test, validate,
  self-review, submit the landing step that merges into the assigned
  `merge_target`, and submit final summary/evidence with the landed commit.
- The root coordinator normally does not merge child code or implement child
  work inline.
- The landing step performs the real git merge for both child-to-parent and
  root-to-main landings.
- Successful archived output reports the landed commit hash and merge strategy.
- Each `tasks.yaml` row maps to exactly one child CLI-agent flow and one child
  worktree; hidden task splitting is rejected.
- Executing prompts must say: "Launch dedicated child CLI agent sessions for
  these independent tasks...".
- The root coordinator launches the emitted child CLI command in a separate
  session and waits for a terminal child result.
- Child quests created from `execute child task ...` are leaf workers by
  default. Recursive child-of-child delegation is a workflow bug unless
  explicitly planned.

## Task, Worktree, And Merge Model

- Minimal task fields are `id`, `title`, `type`, `status`, `acceptance`,
  `dependencies`, `scope_files`, `spec_refs`, `context_refs`, `branch_ref`,
  `worktree_path`, `child_wtree`, `concurrency_group`, `merge_target`,
  `merge_lease_id`, `merge_commit`, and `system_impact_ref`.
- Parallel execution is allowed only when dependencies are satisfied,
  `scope_files` are disjoint, `concurrency_group` does not conflict, and merge
  lease ownership is unambiguous.
- Child lifecycle statuses are `child_received`, `child_executing`,
  `child_validating`, `child_verification_pending`, `child_landing_ready`,
  `child_merged`, and `child_archived`.
- Runtime `child_result` payloads accept child status `passed`, `blocked`, or
  `failed`.
- Child result evidence is appended to the quest evidence log.
- `system_update_pending` is coordinator-led:
  child summary -> bin storage -> root prompt -> `system_update` payload -> bin
  validation and system-doc writes.

## Runtime Hook Continuation

- Hooks cover Codex CLI, Codex Desktop, Gemini CLI, Copilot CLI, and Copilot in
  VS Code.
- Hook quest selection uses an explicit `--wtree`, payload `wtree`,
  payload `loopo_wtree`, or a cwd inside `<repo>/worktrees/<name>`. Repo-root
  hooks and missing, ambiguous, invalid, or conflicting selector signals no-op.
- Decision source priority:
  1. canonical V3 stage and receipts in
     `worktrees/{wtree}/.loopo/runtime/tasks.yaml`
  2. compact audit events in `worktrees/{wtree}/.loopo/runtime/events.jsonl`
  3. current task terminal state derived from the canonical task table
- Continue only when the latest `stop_reason` is exactly `none`.
- Continue as an automatic drain chain across hook-triggered turns until work is
  terminal, all work is stalled, or continuation budget is exhausted.
- Hook duplicate suppression fingerprints `tasks.yaml` plus `events.jsonl`
  excluding prior `hook_decision` entries, so recording a hook audit line does
  not make an identical event look new.
- Stop for every other stop reason.

## Drift, Duplicate, And Budget Guards

- Before any continuation decision, hash all managed quest files: `tasks.yaml`,
  `events.jsonl`, root system docs, and manifests.
- Compare managed file hashes against the current manifest receipts.
- On mismatch, mark `managed_file_drift`, emit no continuation, and use
  `loopo doctor --fix` as the recovery path.
- Ignore only exact same-state duplicate end-events for
  `(runtime, hook_event_name, context_root, wtree, iteration, snapshot_fingerprint)`.
- Keep suppressing duplicates while the snapshot is unchanged, even if events
  are delayed.
- Do not suppress later events once the snapshot has advanced.
- Limit each automatic continuation chain to 12 non-terminal hook-triggered
  turns per `(runtime, context_root, wtree)` chain.
- When budget is reached, emit one final continuation prompt directing manual
  resume.
- The next end-event with unchanged state emits no continuation.

## Runtime Event Mapping

- Codex event: `Stop`
- Codex continue output: `{ "decision": "block", "reason": "..." }`
- Gemini event: `AfterAgent`
- Gemini continue output: `{ "decision": "deny", "reason": "..." }`
- Copilot shared `.github/hooks` lane events: `sessionStart`, `sessionEnd`,
  `agentStop`, and `Stop`
- Copilot VS Code `Stop` output includes `hookSpecificOutput` plus flat
  `decision` and `reason` fields.

## Ops And Verification

Use these commands when installing, repairing, or live-testing lifecycle and
hook behavior:

```bash
bun index.ts init "loopo: build" --runtime all
bun index.ts quest next --wtree build --json @request.json
bun index.ts hook --runtime codex
bun index.ts sim init "loopo: build me a python app" --repo /path/to/repo --runtime codex --flow swe
bun index.ts doctor --fix
bun scripts/setup_runtime_hooks.ts --repo /path/to/repo --runtime all --hook-script /abs/path/to/scripts/loopo_sim.ts
```

Generated durable tracked `.loopo` files include:

- `.loopo/system.yaml`
- `.loopo/docs/*.yaml`
- `.loopo/manifest.sign.json`

Quest-local ignored runtime files include:

- `worktrees/{wtree}/.loopo/runtime/tasks.yaml`
- `worktrees/{wtree}/.loopo/runtime/events.jsonl`
- `worktrees/{wtree}/.loopo/runtime/manifest.sign.json`
- `worktrees/{wtree}/.loopo/runtime/hook-state.json`
- `worktrees/{wtree}/.loopo/runtime/lock.json`

Core verification commands:

```bash
bun scripts/verify_coherency.ts
bun scripts/verify_quest_contract.ts
bun scripts/verify_runtime_hooks.ts
bun scripts/verify_runtime_simulation.ts
bun scripts/verify_runtime_stepper.ts
bun test scripts/verify_child_agent_integration.test.ts
bun run scripts/report_lifecycle_matrix.ts
```

## Supervisor Evidence Rules

- Treat generated apps, child outputs, fixture repos, and landed artifacts as
  evidence about Loopo behavior unless the user explicitly switches scope to
  the generated artifact.
- When agent narration, terminal chatter, and Loopo state disagree, trust
  canonical artifacts first: worktree-local `.loopo/runtime/tasks.yaml`,
  `.loopo/runtime/events.jsonl`, emitted `children[].commands.*`, and git
  worktree state.
- Separate runtime availability failure from Loopo lifecycle failure before
  changing instructions.
- After a clarification round is answered, continue from recorded quest state,
  not from the agent's prose summary.
- Do not treat a streak of green runs as full lifecycle coverage unless
  canonical artifacts prove the end stages under test.
- When landing is part of the lifecycle target, require a canonical landed
  receipt, not just a stage transition.
- Archived output should carry the landed commit and merge strategy.
- For live runtime smoke, use a concrete no-clarification fixture, let the
  supervisor run `loopo init`, execute the emitted `new_quest.command`
  directly, and drive the CLI one lifecycle step per turn.
- Treat quota, auth, missing binaries, and hard timeouts as runtime availability
  outcomes unless canonical quest state proves Loopo itself failed.
- When workflow defects appear, improve Loopo prompts, contracts, hooks,
  validation, or guardrails instead of polishing generated artifacts by default.
