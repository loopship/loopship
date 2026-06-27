# @omar391/loopship

Spec workflows, looped until shipped.

Publishable Loopship runtime package for deterministic V3 worktree-based quest workflows.

```bash
npx @omar391/loopship init "loopship: build the app" --runtime codex
node index.ts init "loopship: build the app" --runtime codex --flow swe
node index.ts hook --runtime codex
node index.ts sim init "loopship: build me a python app" --runtime codex --flow swe
node index.ts sim step --wtree build-me-a-python-app --json @request.json
node index.ts sim hook --runtime codex
node index.ts doctor --fix
node index.ts handbook
node index.ts handbook --raw
node index.ts handbook --duplicates --json
node index.ts handbook --fix-duplicates --json
node index.ts cmdproto execjson init '{"request":"loopship:build-the-app","repo":"/repo","runtime":"codex"}'
node index.ts cmdproto execjson handbook '{"repo":"/repo","duplicates":true}'
```

The launcher skill lives in
`/Volumes/Projects/business/AstronLab/omar391/ai-rules/skills/loopship/SKILL.md`.
Lifecycle, prompts, schemas, state, manifests, child subagent flow, and next
actions are owned by this `loopship` package through Fastflow-native generated
workflows, the Loopship Fastflow consumer adapter, YAML/JSONL workflow-data
operations, and `schemas/steps`.

The reusable Fastflow consumer facade is exported at `@omar391/loopship/fastflow`.
The legacy workflow runner is validation tooling only and is not exported as a
package API.

`cmdproto` is wired in as a transparent command wrapper. `loopship cmdproto`
mirrors the current public command paths through `cmdproto execjson <path> <payload>`,
while still delegating to `loopship init`, `loopship hook`, `loopship doctor`,
and `loopship handbook` command logic. Local simulation remains CLI-only via
`loopship sim`.
The hidden `resume` command is an internal continuation bridge emitted by
Loopship route and hook responses; it is not a public cmdproto or documented
automation ABI. Fastflow-native generated workflows, the Loopship Fastflow
consumer adapter, and JSON Schema payload contracts are the lifecycle contract.

`loopship handbook` renders a standalone generated Markdown handbook from
`.loopship/system.yaml` and canonical document resources. By default it writes to a
recoverable system temp path and prints a `file://` URL. Use
`loopship handbook --raw` to print the Markdown to stdout.
`loopship handbook --duplicates` reports exact normalized duplicate prose from the
canonical YAML sources with owner recommendations. `loopship handbook
--fix-duplicates` applies only schema-safe reference rewrites and reports any
remaining manual cases. The handbook is generated output, not canonical truth.

Loopship lifecycle guidance lives in `assets/workflows/steps/*.stable.yaml`; do not add
separate stage spec files for the same instructions.

For mocked runtime lifecycle stepping, `loopship sim` supports:

- `loopship sim init "loopship: <request>" --repo <repo> --flow swe --runtime codex`: start a simulation and emit the first selected-flow step
- `loopship sim step --wtree <name> --repo <repo> --json @-`: submit the next step payload and stop at the next selected-flow step
- `loopship sim hook --repo <repo> --runtime codex --json @-`: explicitly exercise runtime hook passthrough behavior
