# @omar391/loopship

Spec workflows, looped until shipped.

Publishable Loopship runtime package for deterministic V3 worktree-based quest workflows.

```bash
npx @omar391/loopship init "loopship: build the app" --runtime codex
node index.ts init "loopship: build the app" --runtime codex --flow swe
node index.ts hook --runtime codex
node index.ts stepper init "loopship: build me a python app" --runtime codex --flow swe
node index.ts stepper step --json @fastflow-resume.json
node index.ts stepper hook --runtime codex
node index.ts doctor --fix
node index.ts handbook
node index.ts handbook --raw
node index.ts handbook --duplicates --json
node index.ts handbook --fix-duplicates --json
node index.ts cmdproto execjson init '{"request":"loopship:build-the-app","repo":"/repo","runtime":"codex"}'
node index.ts cmdproto execjson handbook '{"repo":"/repo","duplicates":true}'
```

The launcher skill lives in
`/Volumes/Projects/business/AstronLab/personal/devtools/ai-rules/skills/loopship/SKILL.md`.
Lifecycle, prompts, schemas, state, manifests, child subagent flow, and next
actions are owned by Fastflow workflows and workflow-data operations. Loopship
is the consumer layer: CLI parsing, repo/runtime bootstrap, Fastflow app
configuration, and Loopship AFN adapter registration.

The reusable Fastflow consumer facade is exported at `@omar391/loopship/fastflow`.
The legacy workflow runner is validation tooling only and is not exported as a
package API.

`cmdproto` is wired in as a transparent command wrapper. `loopship cmdproto`
mirrors the current public command paths through `cmdproto execjson <path> <payload>`,
while still delegating to `loopship init`, `loopship hook`, `loopship doctor`,
and `loopship handbook` command logic. Local guided stepping remains CLI-only via
`loopship stepper` and emits native Fastflow run/resume responses.
The old hidden `resume` continuation bridge has been removed.
Fastflow workflow run/resume responses, the Loopship Fastflow consumer adapter,
and JSON Schema payload contracts are the lifecycle contract.

`loopship handbook` renders a standalone generated Markdown handbook from
`.loopship/system.yaml` and canonical document resources. By default it writes to a
recoverable system temp path and prints a `file://` URL. Use
`loopship handbook --raw` to print the Markdown to stdout.
`loopship handbook --duplicates` reports exact normalized duplicate prose from the
canonical YAML sources with owner recommendations. `loopship handbook
--fix-duplicates` applies only schema-safe reference rewrites and reports any
remaining manual cases. The handbook is generated output, not canonical truth.

Loopship executable lifecycle workflows live in the root `call-catalog/`. The
`call-catalog/loopship/workflow/service/flows/swe.stable.yaml` workflow is the
authoritative SWE flow, and `call-catalog/loopship/workflow/service/step/*.stable.yaml`
contains the reusable step subworkflows. Do not add a parallel executable
workflow source tree.

For mocked runtime lifecycle stepping, `loopship stepper` supports:

- `loopship stepper init "loopship: <request>" --repo <repo> --flow <id> --runtime codex`: run the configured Fastflow workflow with `superviseStep: true`
- `loopship stepper step --repo <repo> --json @-`: resume a native Fastflow pause using `sessionId`, optional `nonce`, and the pause-specific `decision` or supervisor decision fields
- `loopship stepper hook --repo <repo> --json @-`: explicitly exercise native Fastflow resume passthrough behavior

Fastflow owns the stepper `nextCall` resume command and decision payload.
Loopship only contributes concise supervisor guidance through Fastflow app
configuration; it does not render continuation commands.

Runtime hooks keep the agent thread ID separate from Fastflow's `sessionId`.
Each paused run stores `runtime`, `thread_id`, `wtree`, and the Fastflow resume
handle in the worktree-local `.loopship/runtime/hook-state.json`. Runtime-provided
thread environment variables bind automatically; `loopship hook --wtree <name>`
or a payload `wtree` explicitly transfers that soft binding between runtime
threads without replacing the Fastflow resume handle. A process-scoped
`WTREE=<name>` may bind unowned state but cannot transfer an existing binding.
Later hooks resolve the exact worktree by `runtime + thread_id` and no-op when
that identity is missing or ambiguous.
In `superviseStep` mode, coordinator quests launch at most one child at a time,
while ordinary `loopship init` runs may still dispatch multiple children in
parallel. Supervised child launches use `loopship stepper init` so the child
pauses on its own internal lifecycle steps before the next child starts.
Flow-internal cleanup uses `loopship.afn.service.landing.cleanup-landed-worktrees` after durable
landing evidence exists. Cleanup is intentionally not a public CLI command;
retries should go through the same Fastflow/AFN lifecycle surface.

Routine verification keeps lifecycle checks focused and bounded:

```bash
bun run verify
```

Release/publish verification runs the focused native lifecycle release set,
including single-child, multi-child, clarification, child callback, validation,
verification, system-update, landing, and archive paths:

```bash
bun run verify:release
```

The package `prepublishOnly` hook runs the release gate.
