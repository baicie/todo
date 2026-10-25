# RC2-D Evidence Index

Committed excerpts from the local QA runs for the RC2-D.1 code gate `b3756b7`. Full logs, app binaries and ignored artifacts remain under `artifacts/native-qa/<run-id>/`; paths in committed copies are replaced with `<repo>` / `<user>`.

| Run                     | Kind                                 | Source commit | Status     | Tests                       |
| ----------------------- | ------------------------------------ | ------------- | ---------- | --------------------------- |
| `rc2d-20261025T094545Z` | QA release exe smoke                 | `b3756b7`     | PARTIAL    | 7 PASS / 0 FAIL / 4 NOT_RUN |
| `rc2d-20261025T095210Z` | QA release exe fault run             | `b3756b7`     | PARTIAL    | 9 PASS / 0 FAIL / 2 NOT_RUN |
| `rc2d-20261025T075858Z` | 1k/10k/100k import benchmark (prior) | `749eb6c`     | BENCH_ONLY | 1 benchmark sample          |

The benchmark is retained because RC2-D.1 did not change import production behavior; it is not a new RC2-D.1 benchmark.

## Artifact identities

| Artifact                                                         | SHA-256                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| QA NSIS `Shishi QA RC2D_1.0.0-rc2d_x64-setup.exe`                | `8918968a13441063aaa833ddcf9b5a4edac11d2496a71425ffa859bea0551f43` |
| QA release exe `target/release/todo-native.exe`                  | `53228203b33dd06722a36d7d93470d8ba95919328843d619c408a177d0cf848a` |
| Installed QA exe `%LOCALAPPDATA%\Shishi QA RC2D\todo-native.exe` | `62887ddd738753a9da30d5de733755d84d74fb6765307e6a4a0876a51a283969` |

The documented `run-windows.ps1 -Build -Install -AllowPartial` flow built and installed the QA package, discovered the installed `todo-native.exe`, and verified native identity `app.shishi.todo.qa` with the QA credential service. The production data root `%APPDATA%\app.shishi.todo` was absent before/after every run; production credentials were not read or written.

## Fault evidence

`fault-20261025T091214Z/fault-evidence.jsonl` contains a real injected `switch_prepared_persisted` error in `PREPARED`, plus passed cleanup and credential points. The run-bound config names the same run; no token or credential value is present.

## Notification activation coverage

The frontend bridge has 16 Vitest tests covering multi-record startup drain, bounded drain, empty termination, Native failure termination, FIFO serialization, duplicate suppression, account mismatch, abort during dynamic imports, first/second listener registration and initial drain, idempotent cleanup, late events, and the 8-record queue cap. Native has `take_drains_rejected_activations_and_returns_first_valid`, proving invalid records are rejected and skipped before the next valid delivery.

## Explicitly NOT_RUN

Real Windows Toast action click, wrong-account notification rejection, cold-start activation, process-kill matrix beyond the existing `RESTART_REQUIRED` child-kill test, QA legacy notification-store fixture, macOS/Linux runtime tests, Android/iOS builds, and `PLATFORM_RELEASE_READY`.

`PARTIAL`/`BENCH_ONLY` is not a release PASS.
