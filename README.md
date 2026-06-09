# @omar391/loopo

Publishable Loopo runtime package for deterministic V3 worktree-based quest workflows.

```bash
npx @omar391/loopo init "loopo: build the app" --runtime codex
node index.ts init "loopo: build the app" --runtime codex --flow swe
node index.ts quest next --wtree build-the-app --json @request.json
node index.ts hook --runtime codex
node index.ts sim init "loopo: build me a python app" --runtime codex --flow swe
node index.ts sim quest next --wtree build-me-a-python-app --json @request.json
node index.ts sim hook --runtime codex
node index.ts doctor --fix
node index.ts handbook
node index.ts handbook --raw
node index.ts cmdproto execjson init '{"request":"loopo:build-the-app","repo":"/repo","runtime":"codex"}'
node index.ts cmdproto execjson handbook '{"repo":"/repo","raw":false}'
```

The launcher skill lives in
`/Volumes/Projects/business/AstronLab/omar391/ai-rules/skills/loopo/SKILL.md`.
Lifecycle, prompts, schemas, state, manifests, child subagent flow, and next
actions are owned by this `loopo` package, SWF-shaped bundled flow YAML,
reusable single-step workflow YAML, and `schemas/steps`. The canonical flow
profile is `schemas/loopo-flow.schema.yaml`.

The reusable loader/validator facade is exported at
`@omar391/loopo/workflow-runner` and mirrors the fast-browser-style
`loadWorkflowRecord` / `validateWorkflowRecord` contract for shared runner work.

`cmdproto` is wired in as a transparent command wrapper. `loopo cmdproto`
mirrors the current public command paths through `cmdproto execjson <path> <payload>`,
while still delegating to the existing `loopo init`, `loopo quest next`,
`loopo hook`, `loopo doctor`, `loopo handbook`, and `loopo sim` command logic.
The V3 lifecycle state machine and JSON Schema payload contracts remain
authoritative.

`loopo handbook` renders a standalone generated Markdown handbook from
`.loopo/system.yaml` and canonical document resources. By default it writes to a
recoverable system temp path and prints a `file://` URL. Use
`loopo handbook --raw` to print the Markdown to stdout. The handbook is
generated output, not canonical truth.

Loopo lifecycle guidance lives in `assets/workflows/steps/*.yaml`; do not add
separate stage spec files for the same instructions.

For mocked runtime lifecycle stepping, `loopo sim` supports:

- `loopo sim init "loopo: <request>" --repo <repo> --flow swe --runtime codex`: start a simulation and emit the first selected-flow step
- `loopo sim quest next --wtree <name> --repo <repo> --json @-`: submit the next step payload and stop at the next selected-flow step
- `loopo sim hook --repo <repo> --runtime codex --json @-`: explicitly exercise runtime hook passthrough behavior
