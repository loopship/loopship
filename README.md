# @omar391/loopo

Publishable Loopo runtime package for deterministic V3 slug-based quest workflows.

```bash
npx @omar391/loopo init "loopo: build the app" --cwd "$PWD" --runtime codex
node index.ts init "loopo: build the app" --cwd "$PWD" --runtime codex --flow swe
node index.ts quest next --slug build-the-app --json @request.json
node index.ts quest help
node index.ts hook --runtime codex
node index.ts sim start --request "build me a python app" --runtime codex
node index.ts sim next --repo /tmp/loopo-sim/repo
node index.ts sim status --repo /tmp/loopo-sim/repo
node index.ts doctor --fix
node index.ts cmdproto execjson init '{"request":"loopo:build-the-app","cwd":"/repo","runtime":"codex"}'
```

The launcher skill lives in
`/Volumes/Projects/business/AstronLab/omar391/ai-rules/skills/loopo/SKILL.md`.
Lifecycle, prompts, schemas, state, manifests, child subagent flow, and next
actions are owned by this `loopo` package, bundled flow YAML, bundled step
YAML, and `schemas/steps`. Flow and step-definition YAML are schema-backed by
`schemas/flow.v1.json` and `schemas/step-definition.v1.json`.

`cmdproto` is wired in as a transparent command wrapper. `loopo cmdproto`
mirrors the current public command paths through `cmdproto execjson <path>`,
while still delegating to the existing `loopo init`, `loopo quest next`,
`loopo quest help`, `loopo hook`, `loopo doctor`, and `loopo sim` command
logic. The V3 lifecycle state machine and JSON Schema payload contracts remain
authoritative.

Loopo lifecycle guidance lives in `assets/steps/*.yaml`; do not add separate
stage spec files for the same instructions.

For mocked runtime lifecycle stepping, `loopo sim` supports:

- `start`: create an isolated simulated repo, install simulated hooks, and emit the first quest step plus embedded callback schemas
- `next`: execute exactly one simulated hook/callback cycle and print `hook_input`, `hook_output`, `callback_input`, and `callback_output`
- `status`: inspect the current simulated quest stage and current compact output without advancing it
