# Cmdproto Transparent Wrapper Tasks

1. `completed` Align `cmdproto` with the transparent-wrapper contract:
   replace `execute` with `execjson`, remove success envelopes, preserve app output and exit status, and finish the related runtime, schema, help, docs, and test updates.
2. `completed` Refactor Loopo's `cmdproto` integration to call direct service handlers instead of shelling back into the CLI, while preserving the existing human command behavior for `init`, `quest next`, `quest help`, `hook`, `doctor`, and `sim`.
3. `completed` Update Loopo's proto/runtime surface to use direct domain-shaped outputs, field-level JSON payload binding, and the refined `cmdproto execjson` machine examples with no `execute` alias.
4. `completed` Update Loopo docs, references, behavior specs, and verifiers to match the transparent-wrapper model, including retiring stale `quest help --json` expectations where required by the plan.
5. `in_progress` Run the required verification commands in both repos, fix any regressions, and land the resulting worktree branches cleanly.
