# Loopship Architecture

This document is the central human architecture reference for Loopship. The
schema-backed canonical architecture source is
`.loopship/docs/software/architecture.yaml`; this Markdown keeps the runtime
contract, lifecycle model, hook rules, ops commands, and durable supervision
lessons readable in one place.

## Launcher And Command Surface

- Loopship is a deterministic V3 workflow launcher for worktree-based quest flows.
- User-facing work enters through:

```bash
loopship init "{request}" --runtime <runtime>
```

- The launcher returns compact JSON step output with schema-backed next actions.
- Quest identity in the public command surface is `wtree`, the base worktree
  name. Session ids are not part of the user contract.
- `loopship quest next --wtree <name> --json <json|@file|@->` is the only
  state-mutating quest command after init.
- `loopship hook --runtime <runtime>` reads hook payload JSON from stdin and
  decides runtime continuation.
- `loopship doctor --fix` repairs system scaffolding, hook installation, shims,
  manifests, and managed drift.
- `loopship sim` provides deterministic selected-flow lifecycle stepping for local
  simulation, while `loopship sim hook` is the explicit passthrough lane for hook
  behavior.
- `loopship cmdproto execjson <path> <payload>` mirrors the current public CLI as
  a machine wrapper and introspection surface; it delegates back to the direct
  Loopship command logic and does not replace the V3 quest lifecycle.
- Agents must never edit `.loopship/**` directly. Root and child state changes must
  go through schema-valid `quest next` payloads for the current step.

## Canonical Storage And Authority

- Durable semantic root, when a system update is recorded:
  `.loopship/system.yaml`
- Canonical external durable docs, when recorded:
  `.loopship/docs/**/*.yaml`. They are referenced from root `resources[]`
  records and are not discovered by filename alone.
- Durable signature sidecar, when recorded: `.loopship/signature.yaml`
- Quest runtime state: `worktrees/{wtree}/.loopship/runtime/tasks.yaml`,
  `.loopship/runtime/events.jsonl`, and `.loopship/runtime/manifest.yaml`.
  This runtime state stays local to the source worktree and is gitignored.
- Volatile runtime coordination lives in `worktrees/{wtree}/.loopship/runtime/hook-state.json`
  and the transient per-worktree `lock.json`.
- `tasks.yaml` is authoritative for quest stage, co-located Q&A inside
  `question_rounds[].questions[]`, detailed plan, task graph, validation
  receipt, verification receipt, and landing receipt.
- `.loopship/system.yaml` is the canonical semantic frontier. It stores four
  mental-model blocks: `objects[]`, `assertions[]`, `resources[]`, and
  `memories[]`. Every record carries compact `text` and may declare outgoing
  relation-keyed `links` maps such as `part_of: [object:system-model]` or
  `supported_by: [resource:software-architecture#/constraints]`.
- The required system-model schema surface is exactly `schemas/system.yaml`,
  `schemas/signature.yaml`, `schemas/system-pack.yaml`, `schemas/semantic-rules.yaml`,
  and concrete `schemas/docs/*.yaml` document schemas. Resource records are
  bounded by their `schema_ref` field, not by ad hoc descriptor schemas.
- Shipped schemas use stable `loopship://schemas/...` IDs for cross-schema refs;
  runtime may load them from local paths, but schema identity is path-stable.
- Canonical external docs are declared in `resources[]` with
  `role: canonical`, validated through concrete schema refs such as
  `loopship://schemas/docs/software-architecture.yaml`, and signed by the root
  signature. Generated resources are useful render outputs, not source of truth.
- Required canonical docs are schema-based by system kind. For Loopship's current
  `kinds: [software, workflow, agent]`, the verifier requires software
  architecture, decision records, workflow specification, and agent system card docs.
  The concrete schema refs are `schemas/docs/software-architecture.yaml`,
  `schemas/docs/decision-records.yaml`, `schemas/docs/workflow-spec.yaml`,
  and `schemas/docs/agent-system-card.yaml`.
- `schemas/system-pack.yaml` is only for real record sharding when
  objects/assertions/resources/memories outgrow first-read root context.
- `events.jsonl` is compact append-only machine audit history.
- Manifests contain SHA-256 file digests, previous receipt head, current receipt
  head, writer command, and request id.
- Signature sidecars are YAML files. Root state uses `.loopship/signature.yaml`;
  quest-local runtime receipts remain `.loopship/runtime/manifest.yaml`.
- Direct edits that do not match the receipt chain are unauthorized/tampered
  state and block continuation.
- Quest dossiers use `tasks.yaml` schema v4, with answers co-located in
  `question_rounds[].questions[]` instead of a top-level `answers[]` block.

## Flow Lifecycle

Bundled default root flow `swe`:

```text
planning -> awaiting_user_answers -> plan_review -> task_graph_ready -> validating -> verification_pending -> system_update_pending -> landing_ready -> archived
```

- The SWF-shaped flow YAML is authoritative for executable stages and transitions.
- Reusable single-step workflows in `assets/workflows/steps/*.yaml` are
  authoritative for handler metadata, input step, input/output schemas,
  summary, and instructions.
- Do not add separate lifecycle stage specs for Loopship steps.
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
  validation and canonical doc writes.

## Runtime Hook Continuation

- Hooks cover Codex CLI, Codex Desktop, Gemini CLI, Copilot CLI, and Copilot in
  VS Code.
- Hook quest selection uses an explicit `--wtree`, payload `wtree`,
  payload `loopship_wtree`, or a cwd inside `<repo>/worktrees/<name>`. Repo-root
  hooks and missing, ambiguous, invalid, or conflicting selector signals no-op.
- Decision source priority:
  1. canonical V3 stage and receipts in
     `worktrees/{wtree}/.loopship/runtime/tasks.yaml`
  2. compact audit events in `worktrees/{wtree}/.loopship/runtime/events.jsonl`
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
  `loopship doctor --fix` as the recovery path.
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
bun index.ts init "loopship: build" --runtime all
bun index.ts quest next --wtree build --json @request.json
bun index.ts hook --runtime codex
bun index.ts sim init "loopship: build me a python app" --repo /path/to/repo --runtime codex --flow swe
bun index.ts doctor --fix
bun scripts/setup_runtime_hooks.ts --repo /path/to/repo --runtime all --hook-script /abs/path/to/scripts/loopship_sim.ts
```

Generated durable tracked `.loopship` files include:

- `.loopship/system.yaml`
- `.loopship/docs/**/*.yaml`
- `.loopship/signature.yaml`

Quest-local ignored runtime files include:

- `worktrees/{wtree}/.loopship/runtime/tasks.yaml`
- `worktrees/{wtree}/.loopship/runtime/events.jsonl`
- `worktrees/{wtree}/.loopship/runtime/manifest.yaml`
- `worktrees/{wtree}/.loopship/runtime/hook-state.json`
- `worktrees/{wtree}/.loopship/runtime/lock.json`

Core verification commands:

```bash
bun scripts/verify_coherency.ts
bun scripts/verify_quest_contract.ts
bun scripts/verify_runtime_hooks.ts
bun scripts/verify_runtime_simulation.ts
bun scripts/verify_runtime_stepper.ts
bun run test:integration
bun run scripts/report_lifecycle_matrix.ts
```

## Supervisor Evidence Rules

- Treat generated apps, child outputs, fixture repos, and landed artifacts as
  evidence about Loopship behavior unless the user explicitly switches scope to
  the generated artifact.
- When agent narration, terminal chatter, and Loopship state disagree, trust
  canonical artifacts first: worktree-local `.loopship/runtime/tasks.yaml`,
  `.loopship/runtime/events.jsonl`, emitted `children[].commands.*`, and git
  worktree state.
- Separate runtime availability failure from Loopship lifecycle failure before
  changing instructions.
- After a clarification round is answered, continue from recorded quest state,
  not from the agent's prose summary.
- Do not treat a streak of green runs as full lifecycle coverage unless
  canonical artifacts prove the end stages under test.
- When landing is part of the lifecycle target, require a canonical landed
  receipt, not just a stage transition.
- Archived output should carry the landed commit and merge strategy.
- For live runtime smoke, use a concrete no-clarification fixture, let the
  supervisor run `loopship init`, execute the emitted `new_quest.command`
  directly, and drive the CLI one lifecycle step per turn.
- Treat quota, auth, missing binaries, and hard timeouts as runtime availability
  outcomes unless canonical quest state proves Loopship itself failed.
- When workflow defects appear, improve Loopship prompts, contracts, hooks,
  validation, or guardrails instead of polishing generated artifacts by default.
