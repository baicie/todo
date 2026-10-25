# RC2-D Evidence Index

Committed excerpts from the local QA runs for the RC2-D.4 code gate `deeb5a6`. Full logs, app binaries and ignored artifacts remain under `artifacts/native-qa/<run-id>/`; paths in committed copies are replaced with `<repo>` / `<user>`.

| Run                     | Kind                                 | Source commit | Status     | Tests                       |
| ----------------------- | ------------------------------------ | ------------- | ---------- | --------------------------- |
| `rc2d-20261025T153001Z` | QA release exe smoke                 | `deeb5a6`     | PARTIAL    | 7 PASS / 0 FAIL / 4 NOT_RUN |
| `rc2d-20261025T153019Z` | QA release exe fault run             | `deeb5a6`     | PARTIAL    | 9 PASS / 0 FAIL / 2 NOT_RUN |
| `rc2d-20261025T075858Z` | 1k/10k/100k import benchmark (prior) | `749eb6c`     | BENCH_ONLY | 1 benchmark sample          |

The benchmark is retained from an earlier code gate; RC2-D.4 changed crash tests/manual inventory, not import production behavior.

## Artifact identities

| Artifact                                                         | SHA-256                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| QA NSIS `Shishi QA RC2D_1.0.0-rc2d_x64-setup.exe`                | `18a4804fd166c8c2b026aa1420cd4f8a52a41abe0cb20bb21191c728910ca7ce` |
| QA release exe `target/release/todo-native.exe`                  | `5b7cea327fe915b3036d93430bd02856efe8787eab23376a20d9db7904552424` |
| Installed QA exe `%LOCALAPPDATA%\Shishi QA RC2D\todo-native.exe` | `a9f8b19f2ed9da261783c06d528db31ff710948bd4546e0c6024b72a07d4d0f2` |

The documented `run-windows.ps1 -Build -Install -AllowPartial` flow built and installed the QA package, discovered the installed `todo-native.exe`, and verified native identity `app.shishi.todo.qa` with the QA credential service. The production data root `%APPDATA%\app.shishi.todo` was absent before/after every run; production credentials were not read or written.

## Fault evidence

`fault-20261025T153019Z/fault-evidence.jsonl` contains a real injected `switch_prepared_persisted` error in `PREPARED`, plus passed cleanup and credential points. The run-bound config names the same run; no token or credential value is present.

## Notification activation/rejection coverage

The frontend bridge has 24 Vitest tests covering activation FIFO, bounded drain, empty termination, Native failure termination/retry, dedupe, account mismatch, rejection FIFO and 8/9 boundary, cross-queue independence, event-only wake semantics, no duplicate toast, abort during imports/listener registration/initial drain, idempotent cleanup, and late events.

Native has 11 notification tests covering rejection FIFO/pop-once/capacity-8/newest retention, invalid activation skipping, and serialized rejection results that contain no injected absolute paths, `UnsafePath`, registry parse errors or SQL text.

## Crash matrix evidence

`crates/native-accounts/tests/crash_faults.rs` spawns real child processes that install a QA-only terminating fault injector and exit at:
`SwitchPreparedPersisted`, `SwitchRestartRequiredPersisted`,
`SwitchFailedPersisted`, `SwitchVerifyingTargetPersisted`,
`RegistryActiveBeforeUpdate`, `RegistryActiveAfterUpdate`, and
`SwitchJournalBeforeCleanup`. It also covers rollback and a recovery interrupted
twice. `sigkill.rs` adds real child SIGKILL/restart coverage for `PREPARED` and
`RESTART_REQUIRED`.

Every recovery test compares full source/target `read_snapshot()` values (rows,
counts, outbox, shadow, kv, cursor, device, schema, account/API binding) and
checks journal phase, active account and repeated-recovery idempotence.

## Manual platform inventory

`scripts/qa/native/manual-scenarios.json` is the single source of truth for 10
unique scenarios. `check-manual-scenarios.mjs` verifies the checklist, harness
reference and generated `manual-platform.json` IDs match; the harness runs it
after writing every run's manifest.

`manual-platform.json` starts all 10 scenarios as `NOT_RUN`; no automated result
is promoted to a Toast/cold-start PASS. The checklist is
`scripts/qa/native/manual-platform-acceptance.md`.

## Explicitly NOT_RUN

Real Windows Toast action click, wrong-account notification rejection, cold-start activation, remaining crash boundaries without a deterministic hook, credential-token crash consistency, Android/iOS builds and runtime, macOS/Linux runtime, and `PLATFORM_RELEASE_READY`.

`PARTIAL`/`BENCH_ONLY` is not a release PASS.
