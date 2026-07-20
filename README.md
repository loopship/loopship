# @omar391/loopship

Spec workflows, looped until shipped.

Publishable Loopship runtime package for deterministic V3 worktree-based quest workflows.
Bun is the canonical application and daemon runtime. Shared modules stay portable
by using Node-standard APIs, while runtime-specific SQLite access is isolated
behind a small Bun/Node adapter. Node 26.x is required only as Fastflow's
separate workflow-script security worker for pinned, operator-approved scripts.
Its process boundary and verified permission-model probe are defense in depth for
trusted code; Node's permission model does not isolate arbitrary hostile code.
Bun may replace it only after matching this tested boundary. Node is not a second
supported Loopship application host.
Fastflow contains the complete executable proof of concept and is Loopship's sole
workflow engine. CueIntent is architecture/spec-only today; any future extraction
moves non-engine facilities to CueIntent while workflow execution remains in Fastflow.

```bash
bunx @omar391/loopship init "loopship: build the app" --runtime codex
bun index.ts init "loopship: build the app" --runtime codex --flow swe
bun index.ts resume --repo /repo --wtree build-the-app
bun index.ts resume --repo /repo --json @fastflow-resume.json
bun index.ts hook --runtime codex
bun index.ts stepper init "loopship: build me a python app" --runtime codex --flow swe
bun index.ts stepper step --json @fastflow-resume.json
bun index.ts stepper hook --runtime codex
bun index.ts doctor --fix
bun index.ts handbook
bun index.ts handbook --raw
bun index.ts handbook --duplicates --json
bun index.ts handbook --fix-duplicates --json
bun index.ts cmdproto execjson init '{"request":"loopship:build-the-app","repo":"/repo","runtime":"codex"}'
bun index.ts cmdproto execjson resume '{"repo":"/repo","wtree":"build-the-app"}'
bun index.ts cmdproto execjson handbook '{"repo":"/repo","duplicates":true}'
```

Init installs or refreshes the launcher skill under `LOOPSHIP_SKILL_HOME`, when
set, or `~/.agents/skills/loopship` by default. `--skill-home <path>` overrides
that location for one invocation.
Lifecycle, prompts, schemas, state, manifests, child subagent flow, and next
actions are owned by Fastflow workflows and workflow-data operations. Loopship
is the consumer layer: CLI parsing, repo/runtime bootstrap, Fastflow app
configuration, and Loopship AFN adapter registration.

The reusable Fastflow consumer facade is exported at `@omar391/loopship/fastflow`.
Native v1 is the sole execution path. Each stage request binds one immutable
Fastflow `PinnedPlan`, keeps the same execution and effect identities across its waits
and recovery, and receives a fresh execution identity only after the preceding
stage reaches a terminal result. Loopship does not expose an `executeAfn`
compatibility runner or select between execution engines.

The root package resolution pins local development to an immutable commit
from the private Fastflow GitHub repository. Published Loopship artifacts list Fastflow in
`bundledDependencies`, so the production package vendors that exact runtime and
does not require consumer access to the private repository. Update the Fastflow
commit and `bun.lock` together, then run the release verification before
publishing.

`LOOPSHIP_FASTFLOW_ROOT` is only a source-linked development/test hook. It is
rejected unless the same process explicitly sets
`LOOPSHIP_ENABLE_FASTFLOW_DEV_ROOT=1`; production must leave both unset and load
the Fastflow runtime bundled in the Loopship package. A configured source root
must be complete or startup fails without falling back to the bundled runtime.

`cmdproto` is wired in as a transparent command wrapper. `loopship cmdproto`
mirrors the current public command paths through `cmdproto execjson <path> <payload>`,
while still delegating to `loopship init`, `loopship resume`, `loopship hook`,
`loopship doctor`, and `loopship handbook` command logic. Local guided stepping remains CLI-only via
`loopship stepper` and emits native Fastflow run/resume responses.
Every `loopship.v1.LoopshipService` method remains local and default-deny for
remote access. Loopship is a client only of Fastflow's six descriptor-derived,
allowlisted `fastflow.scheduler.v1.SchedulerControlService` unary Connect methods.
AFN-host bootstrap uses `CreateAfnSessionTicket`; Loopship does not reimplement
the service or expose REST aliases.
Fastflow workflow run/resume responses, the Loopship Fastflow consumer adapter,
and JSON Schema payload contracts are the lifecycle contract.

`loopship resume` has two explicit recovery modes. `--json` forwards the
`sessionId`, `nonce`, `workspaceRoot`, and exact `response` envelope from a Fastflow
handoff response. `--wtree` starts a new Fastflow process against an existing
canonical quest after an unexpected inline-process interruption. It resubmits
the exact pending Native request from the durable per-request ledger with the
same idempotency key; Loopship never retries a failed submission automatically.
Loopship writes only quest-state schema v5 and Native execution-ledger/identity
schema v2. State from earlier releases, including task schema v4 or execution
ledger v1, fails with `legacy_execution_unsupported`; it must be abandoned or
cancelled and resubmitted as a new Native execution.

Production uses Fastflow's `local-durable` scheduler profile and requires a
supervised scheduler daemon. Start Loopship's packaged daemon before accepting
work. Configure the daemon's SQLite path before startup:

```bash
export FASTFLOW_SCHEDULER_DB=/durable/path/native-v1.sqlite
loopship-fastflow-daemon
```

The supervised Bun daemon owns the private loopback scheduler authority and its
atomically published runtime descriptor and is the only process that opens the
scheduler database. Loopship commands discover that descriptor and use
Fastflow's six allowlisted finite unary Connect controls; they never open or
advance scheduler SQLite directly. The daemon registers Loopship's exact finite
AFN handler offer under one package-identity-derived logical host id, obtains a
short-lived single-use ticket through the descriptor-derived Connect method,
and initiates an authenticated binary `fastflow.afn.v1` session back to that
authority. AFN invocations, cancellations, receipts, capacity, and decisions
never use newline JSON, generic LoopshipService commands, or an ad hoc HTTP
route. LoopshipService remains local and default-deny.

Loopship's hosted filesystem and Git AFNs are bounded atomic effects and do not
claim cooperative cancellation after dispatch. Their host cancellation result
is explicitly `accepted: false`; the scheduler's durable cancellation intent
remains authoritative, and a completion that races it is handled as a late
decision without reopening the execution. Long-lived inference and wait work
remains scheduler-owned rather than hidden inside these handlers.

The scheduler database and Loopship runtime locks must be on a verified local,
persistent filesystem. Startup fails with
`FASTFLOW_UNSUPPORTED_DURABLE_FILESYSTEM` when the host reports a known remote,
distributed, memory-backed, or unverified filesystem type. Operators must also
keep durable state out of cloud-synced folders, mapped network drives, and
mounts that mask remote behavior; filesystem-type probes cannot reliably
identify every path-level sync layer or masked mount.

When set, `LOOPSHIP_HOME` must be absolute so callers, child sessions, and the
daemon resolve the same default scheduler authority regardless of working directory.
Loopship's authoritative ledgers, hook routes, effect receipts, quest documents,
and manifests sync file contents and directory entries before reporting a write
as complete.

Before upgrading Loopship or Fastflow, stop new submissions and let pending
executions finish. If an execution must be interrupted, restore its exact pinned
Loopship/Fastflow release long enough to finish or cancel it, then deploy the new
release and resubmit the work. An incompatible pinned plan remains fail-closed
with `FASTFLOW_PLAN_INCOMPATIBLE`; Loopship never rebinds or migrates it.

The process-local scheduler is available only through an explicit `embedded`
or `test` profile. Production does not fall back to `setTimeout` or process-local
wake behavior when the durable daemon is absent.

Production control calls are finite. A submit or resume may therefore return a
`workflow_result` with `status: "running"` while the daemon continues from its
durable runnable queue. Loopship does not poll or open SQLite to wait for it;
the caller can later use canonical `loopship resume --wtree <name>` recovery to
inspect the same execution and obtain its next pause or terminal result.

Fastflow sessions and their configured CLI agents run with the canonical quest
worktree as the process working directory. Question rounds pause only through
a durable `hitl.review` Native scheduler handoff. A failed validation or verification
transition pauses through an `aitl.subagent` repair handoff, then resumes by
re-reading canonical state; it does not return a successful nonterminal result
or require another `init`.

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

- `loopship stepper init "loopship: <request>" --repo <repo> --flow <id> --runtime codex --max-concurrency <1-32>`: run the configured Fastflow workflow with `superviseStep: true`
- `loopship stepper step --json @-`: resume a native Fastflow pause using required `sessionId`, `nonce`, and `workspaceRoot` plus exactly one `response.answer` or `response.decision: "ok"`
- `loopship stepper hook --repo <repo> --json @-`: explicitly exercise native Fastflow resume passthrough behavior

Fastflow owns the handoff schema, nonce validation, and decision payload.
Loopship configures the app-owned `nextCall.command` wrapper so a fresh process
restores Loopship adapters before invoking that Fastflow contract.

Runtime hooks keep the agent thread ID separate from Fastflow's `sessionId`.
Loopship installs and diagnoses hooks for Codex, Gemini, and Copilot. The hook
router itself is runtime-neutral: manually configured Claude, Antigravity, or
other integrations invoke `loopship hook --runtime <runtime>` and provide their
native thread identifier in the hook payload.
Each paused run stores `runtime`, `thread_id`, `wtree`, and the Fastflow resume
handle in the worktree-local `.loopship/runtime/hook-state.json`. Runtime-provided
thread environment variables bind automatically when they identify a concrete
runtime. `loopship hook --wtree <name>` or a payload `wtree` explicitly
transfers that soft binding between runtime
threads without replacing the Fastflow resume handle. A process-scoped
`WTREE=<name>` may bind unowned state but cannot transfer an existing binding.
Later hooks resolve the exact worktree by `runtime + thread_id` and no-op when
that identity is missing or ambiguous.
The Native child DAG defaults to a finite concurrency ceiling of 4; callers may
set `--max-concurrency` from 1 through 32. `superviseStep` always lowers the
effective ceiling to 1. Every ready node runs the pinned internal `swe-child`
workflow; no emitted child command or callback path exists.
Each child must declare a non-empty repository-relative scope; missing,
malformed, absolute, escaping, overlapping, or otherwise unordered ownership
returns the graph to replanning before any child is dispatched.
Flow-internal cleanup uses `loopship.afn.service.landing.cleanup-landed-worktrees` after durable
landing evidence exists. Cleanup is intentionally not a public CLI command;
retries should go through the same Fastflow/AFN lifecycle surface.

Routine verification keeps lifecycle checks focused and bounded:

```bash
bun run verify
```

Release/publish verification runs the focused native lifecycle release set and
the multi-node Native `PinnedPlan` stress matrix, including single-child,
multi-child, clarification, Native child lifecycle, validation, verification,
system-update, landing, and archive paths:

```bash
bun run verify:release
```

The package `prepublishOnly` hook runs the release gate.
