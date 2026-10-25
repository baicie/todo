# RC2-D Evidence Index

Committed excerpts from the local QA runs for the RC2-D.3 code gate `d348a8b`. Full logs, app binaries and ignored artifacts remain under `artifacts/native-qa/<run-id>/`; paths in committed copies are replaced with `<repo>` / `<user>`.

| Run                     | Kind                                 | Source commit | Status     | Tests                       |
| ----------------------- | ------------------------------------ | ------------- | ---------- | --------------------------- |
| `rc2d-20261025T140122Z` | Installed QA app smoke               | `d348a8b`     | PARTIAL    | 7 PASS / 0 FAIL / 4 NOT_RUN |
| `rc2d-20261025T140142Z` | QA release exe fault run             | `d348a8b`     | PARTIAL    | 9 PASS / 0 FAIL / 2 NOT_RUN |
| `rc2d-20261025T075858Z` | 1k/10k/100k import benchmark (prior) | `749eb6c`     | BENCH_ONLY | 1 benchmark sample          |

The benchmark is retained from an earlier code gate; RC2-D.3 changed notification validation/tests and crash coverage, not import production behavior.

## Artifact identities

| Artifact                                                         | SHA-256                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| QA NSIS `Shishi QA RC2D_1.0.0-rc2d_x64-setup.exe`                | `5b085004500e27e49cef85d878bcf4b57b207b2af1dec6aa2f53f4b8c467efe9` |
| QA release exe `target/release/todo-native.exe`                  | `c8f2e4bed3eb45838cb35ccdce64b01209a55417ff23045ea19b105136544797` |
| Installed QA exe `%LOCALAPPDATA%\Shishi QA RC2D\todo-native.exe` | `eee31fbdb215bc5a5891fcb10bcb661840b42c16a3f67b8b2581ec5f8fd30b74` |

The documented `run-windows.ps1 -Build -Install -AllowPartial` flow built and installed the QA package, discovered the installed `todo-native.exe`, and verified native identity `app.shishi.todo.qa` with the QA credential service. The production data root `%APPDATA%\app.shishi.todo` was absent before/after every run; production credentials were not read or written.

## Fault evidence

`fault-20261025T140142Z/fault-evidence.jsonl` contains a real injected `switch_prepared_persisted` error in `PREPARED`, plus passed cleanup and credential points. The run-bound config names the same run; no token or credential value is present.

## Notification activation/rejection coverage

The frontend bridge has 24 Vitest tests covering activation FIFO, bounded drain, empty termination, Native failure termination and retry, dedupe, account mismatch, rejection FIFO and 8/9 boundary, cross-queue independence, event-only wake semantics, no duplicate toast, abort during imports/listener registration/initial drain, idempotent cleanup, and late events.

Native has 11 notification tests covering rejection FIFO/pop-once/capacity-8/newest retention, invalid activation skipping, and serialized rejection results that contain no injected absolute paths, `UnsafePath`, registry parse errors or SQL text.

## Crash matrix evidence

`crates/native-accounts/tests/crash_faults.rs` spawns real child processes that install a QA-only terminating fault injector and exit at:
`SwitchPreparedPersisted`, `SwitchRestartRequiredPersisted`,
`SwitchVerifyingTargetPersisted`, `RegistryActiveBeforeUpdate`,
`RegistryActiveAfterUpdate`, and `SwitchJournalBeforeCleanup`.
`crates/native-accounts/tests/sigkill.rs` adds real child SIGKILL/restart coverage for `PREPARED` and `RESTART_REQUIRED`.
All size/outbox/shadow/kv/cursor/device/schema invariants are compared through `read_snapshot()`.

`manual-platform.json` starts every M1–M10 real-desktop scenario as `NOT_RUN`; no automated result is promoted to a Toast/cold-start PASS. The checklist is `scripts/qa/native/manual-platform-acceptance.md`.

## Explicitly NOT_RUN

Real Windows Toast action click, wrong-account notification rejection, cold-start activation, process-level coverage of boundaries without a deterministic hook, credential-token crash consistency, Android/iOS builds and runtime, macOS/Linux runtime, and `PLATFORM_RELEASE_READY`.

`PARTIAL`/`BENCH_ONLY` is not a release PASS.
