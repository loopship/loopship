1. `completed` Rework `loopo sim` into a guided flow-step command with `loopo sim "<request>" --flow swe --runtime codex` start and `loopo sim --repo <repo> --json @-` continuation.
2. `completed` Preserve explicit passthrough hook testing through `loopo sim hook` only, and hard-fail legacy `start`, `next`, `callback`, and `status` public modes with migration guidance.
3. `completed` Update cmdproto, runtime simulation/stepper verification, README, and architecture docs for the guided sim surface.
4. `completed` Run targeted runtime/cmdproto verification and full `bun run verify`.
