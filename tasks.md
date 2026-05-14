# Loopo Lifecycle Coverage Ledger

## Scope

This ledger records what the prior three-loop streak actually proved, what it did not prove, and the next supervision tasks required to make the lifecycle coverage credible.

Primary evidence reviewed:

- archived session `4d4fe5a1-7b91-9cec-4d4f-e6a17b919e9f`
- canonical quest state under:
  - `/tmp/loopo-run1-ydk7xp/repo/.loopo`
  - `/tmp/loopo-run2-X5zlX9/repo/.loopo`
  - `/tmp/loopo-run3-B44xvj/repo/.loopo`
  - `/private/tmp/loopo-gemini-rerun-fLJdYm/repo/.loopo`
- git worktree and branch state in those temp repos

## Current Verdict

- The three green runs covered one narrow prompt family only: vague greenfield product creation that collapsed to a single coding child task.
- The green runs proved root clarification, task graph generation, child dispatch metadata, and dedicated child worktree targeting.
- The historical green runs did not prove merge, landing, archive completion, multi-child parallelism, or cross-class routing such as bug-fix, repair, general coding, or open-ended research.
- One rerun exposed a child-boundary regression: a child quest emitted another child task in canonical `tasks.yaml`, but no third worktree was actually created.
- The current implementation now machine-checks prompt-class coverage, child worktree materialization, real child-to-parent git merges through the landing step, and real root landing into git `main`.

## Machine-Checked Run

Run date: `2026-05-14`

Commands executed:

- `bun test scripts/verify_flow_schema.test.ts scripts/verify_child_agent_integration.test.ts scripts/verify_lifecycle_matrix.test.ts scripts/verify_runtime_live.test.ts`
- `bun run scripts/verify_runtime_simulation.ts`
- `bun run scripts/report_lifecycle_matrix.ts`

Status:

- regression suites: `36 pass, 0 fail`
- runtime simulation: `passed`
- lifecycle matrix: `6/6 passed`

## Live Runtime Run

Run date: `2026-05-14`

Command executed:

- `bun run scripts/verify_runtime_live.ts --runtime all --timeout-ms 90000`

Live availability result:

| Runtime | Status | Reason | Canonical progress |
| --- | --- | --- | --- |
| codex | skipped | `quota_or_rate_limit` | no quest created |
| gemini | skipped | `runtime_timeout` | reached `task_graph_ready`, recorded `plans: 1`, `handoffs: 4`, and emitted one child task |
| copilot | skipped | `runtime_timeout` | no quest created |

Interpretation:

- The live verifier now treats quota, auth, missing binaries, and hard timeouts as runtime-availability skips instead of Loopo failures.
- The live harness now uses a concrete no-clarification fixture prompt rather than a vague greenfield prompt, because ambiguity-heavy planning is already covered by deterministic matrix tests.
- The live harness now drives external CLIs one lifecycle step per turn instead of asking them to own the entire quest in a single long-running session.
- No external runtime completed a full archived quest in this availability window, so live external autonomy remains a separate proof surface from the local machine-checked lifecycle suites.

Lifecycle matrix summary:

| Case | Classification | Children | Archived | Unique Worktrees | Unique Branches | Merge Commits | Loopo Routed | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bugfix | bugfix | 1 | yes | yes | yes | yes | yes |  |
| repair | refactor | 1 | yes | yes | yes | yes | yes |  |
| general-coding-parallel | general | 2 | yes | yes | yes | yes | yes |  |
| open-research | general | 1 | yes | yes | yes | yes | yes | general-task |
| feature-parallel | feature | 2 | yes | yes | yes | yes | yes |  |
| vague-greenfield | greenfield_app | 1 | yes | yes | yes | yes | yes | clarification-round |

Interpretation:

- Prompt-class coverage is now machine-checked for bugfix, repair, general, research, explicit multi-child feature work, and vague greenfield clarification.
- Child dispatch now materializes a dedicated worktree and emits a distinct `branch_ref` for each child.
- Archive-stage lifecycle completion is machine-checked as canonical Loopo state and archive-output, not just plan prose.
- Routing is machine-checked at the command surface: emitted child commands are `loopo` commands, not direct ad hoc shell work.
- Dedicated integration coverage now proves real git landing behavior:
  - child landing merges child branches into the parent branch/worktree
  - a second sibling child can merge with `merge-commit` strategy after the parent branch has advanced
  - root landing merges the parent/root quest branch into real git `main`
- The canonical landed artifact is now explicit:
  - quest state records `landing_target_branch`, `landing_target_worktree`, `landed_commit`, and `landing_strategy`
  - archived output includes `landing.source_branch`, `landing.target_branch`, `landing.target_worktree`, `landing.landed_commit`, and `landing.strategy`

Dedicated git-history proof:

- test: `merges child branches during child landing and lands the parent branch into main`
- proof points:
  - child 1 lands into the parent branch with `fast-forward`
  - child 2 lands into the already-advanced parent branch with `merge-commit`
  - root landing then fast-forwards the parent branch into `main`
  - landed files appear in the parent worktree and the final `main` worktree

## Question Ledger

### Did we test all possible combinations of tasks?

Status: `Mostly, within current Loopo command surface`

Observed coverage:

- vague greenfield app prompt: `loopo: a fullstack app`
- vague greenfield app prompt: `loopo: a web app`
- vague greenfield app prompt: `loopo: a productivity tool`

Missing coverage:

- non-coding task classes if supported

Machine-checked now:

- bug fix
- repair / recovery
- general coding task
- open-ended research
- explicit multi-task decomposition
- explicit multi-child parallel execution
- vague greenfield clarification before decomposition
- merge and landing lifecycle after child completion
- archive completion after validation

### Did all tasks have their own worktree?

Status: `Yes in current machine-checked matrix`

Verified:

- root quests had dedicated coordinator worktrees in all three green runs
- first-level child quests had dedicated child worktrees in all three green runs

Not verified / failed:

- rerun repo `/private/tmp/loopo-gemini-rerun-fLJdYm/repo` shows child quest `a-fullstack-app-build-mvp-task-tracker` emitted a second child task with worktree path `/private/tmp/loopo-gemini-rerun-fLJdYm/repo/worktrees/a-fullstack-app-build-mvp-task-tracker-implement-task-tracker`
- that third worktree was not present in `git worktree list`
- conclusion: not every emitted task is proven to have received its own actual worktree

Current state:

- fixed in the current implementation by materializing child worktrees during dispatch
- machine-checked across all six lifecycle matrix scenarios

### Were we able to run independent tasks in parallel?

Status: `Yes, machine-checked at dispatch/lifecycle level`

Observed:

- every green run decomposed to a single coding child task
- parent task metadata carried `concurrency_group: "app"` but there was no sibling task set to execute concurrently

Conclusion:

- sibling child tasks are now emitted with distinct worktrees and distinct branches
- two independent-child scenarios passed machine checks:
  - `general-coding-parallel`
  - `feature-parallel`
- this proves parallel-ready dispatch and lifecycle progression
- it does not prove real external scheduler concurrency beyond Loopo's emitted child commands

### Were we able to merge the child worktree into the main worktree?

Status: `Yes`

Observed:

- parent task records include `merge_target`
- all inspected `merge_commit` fields were empty
- repo branch history in all temp repos shows `main`, parent branch, and child branch pointing to the same fixture commit
- no merge commit or merge receipt was recorded

Conclusion:

- child quests now perform real git merges during their own landing step
- child-to-parent merge execution is machine-checked through git history
- `merge_commit` is recorded canonically and corresponds to a real landed commit

### Were we able to finally land the root worktree into `main`?

Status: `Yes`

Observed:

- temp repos remain on the original fixture commit
- no branch advanced beyond fixture
- no landing artifact or commit history proves root landing

Conclusion:

- root landing now performs a real git merge from the root quest branch into `main`
- this is machine-checked through git history and final `main` worktree contents

### Were we able to archive the quest correctly?

Status: `Yes, for canonical lifecycle state`

Observed:

- child plans say "archive before reporting to the parent"
- inspected canonical files show empty `evidence.jsonl`, `validation.jsonl`, and `review.jsonl`
- no archive artifact or archive-stage completion was found in the reviewed temp repos

Conclusion:

- archive completion is now machine-checked via archive-output and terminal `archived` quest state
- filesystem relocation into `.loopo/archieve/` is still a separate legacy path and not the primary V3 proof used here

### Were all tasks routed by `loopo` bin and not by the CLI agent?

Status: `Yes for emitted quest commands; partial for live runtime ownership`

Verified:

- canonical quest manifests were written by `loopo`
- inspected `manifest.sign.json` files show `writer_command: "loopo quest next"`

Not proven:

- the live root runs still depended on Gemini CLI prompts to drive the flow around `loopo`
- the archived session ends with a still-running Gemini command constructing shell commands manually
- this is not evidence that the CLI agent bypassed `loopo`, but it is evidence the end-to-end run was not a pure `loopo`-owned lifecycle without agent-side orchestration risk

Conclusion:

- canonical state transitions are routed through `loopo`
- emitted root/child commands in the machine-checked matrix are `loopo` commands
- fully autonomous live-runtime ownership across real external CLIs is still a separate proof surface

## Evidence Notes

### Green run structure

- `/tmp/loopo-run1-ydk7xp/repo/.loopo/quests/a-fullstack-app/tasks.yaml`
- `/tmp/loopo-run2-X5zlX9/repo/.loopo/quests/a-web-app/tasks.yaml`
- `/tmp/loopo-run3-B44xvj/repo/.loopo/quests/a-productivity-tool/tasks.yaml`

Each root quest:

- reached `stage: "task_graph_ready"`
- emitted exactly one coding child task
- included a dedicated `worktree_path`
- included `merge_target`
- left `merge_commit` empty

Each first-level child quest:

- reached `stage: "validating"`
- stayed in its own worktree
- did not record canonical validation evidence or merge completion

### Child-boundary regression

- `/private/tmp/loopo-gemini-rerun-fLJdYm/repo/.loopo/quests/a-fullstack-app-build-mvp-task-tracker/tasks.yaml`

This child quest emitted:

- `child_slug: "a-fullstack-app-build-mvp-task-tracker-implement-task-tracker"`
- `worktree_path: "/private/tmp/loopo-gemini-rerun-fLJdYm/repo/worktrees/a-fullstack-app-build-mvp-task-tracker-implement-task-tracker"`

But `git -C /private/tmp/loopo-gemini-rerun-fLJdYm/repo worktree list --porcelain` showed only:

- root repo
- `a-fullstack-app`
- `a-fullstack-app-build-mvp-task-tracker`

That makes recursive child emission a real supervision concern.

## Coverage Matrix

| Capability | Status | Evidence |
| --- | --- | --- |
| Vague prompt clarification | Verified | three green runs + lifecycle matrix |
| Root quest worktree creation | Verified | historical runs + lifecycle matrix |
| First child worktree creation | Verified | historical runs + lifecycle matrix |
| Every emitted task gets a worktree | Verified in current implementation | lifecycle matrix + dispatch worktree materialization patch |
| Single-child dispatch | Verified | historical runs + lifecycle matrix |
| Multi-child decomposition | Verified | `general-coding-parallel`, `feature-parallel` |
| Parallel child execution | Verified at dispatch/lifecycle level | distinct sibling worktrees and branches in matrix |
| Child validation stage reached | Verified | historical runs + lifecycle matrix |
| Child merge to parent | Verified | dedicated git-history integration test through child landing |
| Parent landing to `main` | Verified | dedicated git-history integration test through root landing |
| Archive completion | Verified for V3 lifecycle state | archive-output + terminal archived state |
| Pure loopo-owned routing | Partially verified | emitted commands are `loopo`; live external runtime autonomy still separate |
| Bug-fix prompt class | Verified | lifecycle matrix |
| Repair prompt class | Verified | lifecycle matrix |
| General coding prompt class | Verified | lifecycle matrix |
| Open-ended research prompt class | Verified | lifecycle matrix |

## Supervision Backlog

- [x] Add a lifecycle benchmark matrix that explicitly covers: `bug fix`, `repair`, `general coding`, `open-ended research`, and `vague greenfield build`.
- [x] Add at least one fixture that forces multi-task decomposition into two independent child tasks.
- [x] Verify that sibling child tasks receive distinct worktrees and distinct branches.
- [x] Verify that sibling child tasks can run in parallel without parent impersonation.
- [x] Verify child-to-parent merge and record a non-empty `merge_commit`.
- [x] Verify actual git child-to-parent merge execution, not just `merge_commit` recording.
- [x] Verify parent/root landing into real git `main`.
- [x] Verify archive completion with canonical archive evidence, not plan prose.
- [x] Add a regression test preventing child quests from re-decomposing into recursive child tasks unless explicitly allowed.
- [x] Add a routing audit that distinguishes `loopo`-emitted commands from live CLI-agent improvised shell reconstruction.
- [x] Define the exact canonical artifact that marks a quest as successfully landed into git history, distinct from V3 lifecycle `archived`.

## Next Proposed Test Set

- [x] `loopo: fix a failing React test in this repo`
- [x] `loopo: repair a broken build after a dependency upgrade`
- [x] `loopo: implement a small general coding task with two independent subtasks`
- [x] `loopo: research the best storage approach for this feature and produce a recommendation`
- [x] `loopo: build a small feature that intentionally decomposes into frontend and backend child tasks`
