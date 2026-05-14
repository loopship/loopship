# Controller Contract

Use this reference when `loopo` executes or audits an active quest.

## Canonical Storage

- Root system index: `.loopo/system.yaml`
- Root system docs: `.loopo/docs/high-level-design.yaml`,
  `.loopo/docs/low-level-design.yaml`, `.loopo/docs/architecture.yaml`,
  `.loopo/docs/system-behaviours.yaml`, `.loopo/docs/design-system.yaml`
- Root manifest: `.loopo/manifest.sign.json`
- Quest state: `.loopo/quests/{slug}/tasks.yaml`, `plan.yaml`, JSONL logs,
  `children/*.yaml`, and `manifest.sign.json`
- Runtime state: `.loopo/state.json`, `.loopo/hook-state.json`,
  `.loopo/hook-events.jsonl`

## Authority Rules

- `tasks.yaml` is authoritative for root quest stage and task state.
- `plan.yaml` is authoritative for the current plan.
- `.loopo/system.yaml` indexes every supported system doc and schema.
- JSONL sidecars are append-only event history.
- Manifests contain SHA-256 file digests, previous receipt head, current receipt
  head, writer command, and request id.
- Direct edits that do not match the receipt chain are unauthorized/tampered
  state and block continuation.

## Flow-Owned Lifecycle

Bundled default root flow `swe`:

`planning -> awaiting_user_answers -> plan_review -> task_graph_ready -> validating -> verification_pending -> system_update_pending -> landing_ready -> archived`

`task_graph_ready` uses the `executing` step definition: it emits ready child
commands and accepts `child_result` payloads.

Controlled detour:

`replanning` is the only way to add, remove, split, or materially change tasks
after `task_graph_ready`.

Step metadata lives in `assets/steps/*.yaml`. The flow YAML is
authoritative for which stages are executable, and the step YAML is authoritative
for lifecycle instructions. Do not add separate lifecycle stage specs for Loopo
steps.

Subflow starts:

- Root flow starts at `loopo init ... --flow swe`.
- Replanning starts as an in-flow detour at stage `replanning` and returns to
  `plan_review`.
- Add-task starts as the same planning detour, constrained to task graph patch
  work, and returns to `task_graph_ready`.
- Child task flow starts from `task_graph_ready` through
  `children[].commands.init`; the child returns to the parent through a
  `child_result` payload.

Child CLI-agent lifecycle:

`child_received -> child_executing -> child_validating -> child_verification_pending -> child_landing_ready -> child_merged -> child_archived`

## Root And Child CLI-Agent Roles

- The root assistant is coordinator/team lead: intake, planning, assignment,
  monitoring, escalation, and `system_update_pending`.
- Child CLI agents are senior developer agents: implement, test, validate,
  self-review, submit the landing step that merges into the assigned
  `merge_target`, and submit final summary/evidence with the landed commit.
- The root coordinator normally does not merge child code.
- The same landing step performs the real git merge for child-to-parent and
  root-to-main landings; successful archived output must report the landed
  commit hash and merge strategy.
- Each `tasks.yaml` row maps to exactly one child CLI-agent flow and one child
  worktree; hidden task splitting is rejected.
- Executing prompts must say: “Launch dedicated child CLI agent sessions for
  these independent tasks…”.
- The root coordinator does not satisfy child work inline in the parent
  session; it launches the emitted child CLI command in a separate session and
  waits for a terminal child result.

## Task Model

Minimal task fields:

- `id`, `title`, `type`, `status`, `acceptance`
- `dependencies`, `scope_files`, `spec_refs`, `context_refs`
- `branch_ref`, `worktree_path`, `child_slug`, `concurrency_group`
- `merge_target`, `merge_lease_id`, `merge_commit`, `system_impact_ref`

Parallel execution is allowed only when dependencies are satisfied,
`scope_files` are disjoint, `concurrency_group` does not conflict, and merge
lease ownership is unambiguous.

## Mutation Contract

- Quest identity is the slug. Do not expose or require session ids.
- `loopo init "{request}" --cwd <cwd> --runtime <runtime>` is the only
  launcher entrypoint for user `loopo:` requests.
- `loopo quest next --slug <slug> --json <json|@file|@->` is the only
  state-mutating quest command.
- Runtime continuation plumbing uses `loopo hook --runtime <runtime>` from the
  repo working directory and reads hook payload JSON from stdin.
- All root and child state mutations go through schema-valid `quest next`
  payloads for the current step.
- Child CLI agents update loopo only through JSON payloads; they never edit
  `.loopo/**` directly.
- `system_update_pending` is coordinator-led:
  child summary -> bin storage -> root prompt -> `system_update` payload -> bin
  validates and writes system docs.
