---
"herdr-woof": minor
---

**Breaking:** `woof run start` is the one way to run a workflow. The Herdr
plugin and `/woof:run` only wrap it. Removed:

- `woof run build-review`: use `woof run start --workflow build-review --host foreground --project <repo>`.
  It prints the same human view and result line and uses the same exit codes.
  `--project` is the input's repository, which `run build-review` inferred.
- The Herdr plugin `start` action (`woof herdr start`) and the
  `.woof/start.json` convention: start runs with `woof run start` or `/woof:run`.
  The `status`, `cancel`, `watch` and `doctor` actions remain, and
  `woof herdr <action> --help` now prints the usage.
- `woof agent start`: it started an agent outside any workflow run.
- `woof attempt open` and `woof run show`: no workflow path used them. The
  scheduler opens attempts in-process with the SDK's `openAttempt`, and
  `woof status` or the SDK's `readSnapshot` shows a run. Both SDK functions
  are unchanged.

`woof submit`, `run cancel`, `run host`, the inspection commands and every SDK
export are unchanged. No public SDK export existed only for a removed command.
