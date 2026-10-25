# RC2-D Evidence Index

Committed excerpts of the local QA runs for review-fix HEAD `749eb6c`. Full logs, app binaries and ignored local artifacts remain under `artifacts/native-qa/<run-id>/`; paths in committed copies are replaced with `<repo>` / `<user>`.

| Run                     | Kind                          | Source commit | Status     | Tests                       |
| ----------------------- | ----------------------------- | ------------- | ---------- | --------------------------- |
| `rc2d-20261025T075344Z` | Installed QA app smoke        | `749eb6c`     | PARTIAL    | 8 PASS / 0 FAIL / 4 NOT_RUN |
| `rc2d-20261025T075811Z` | Installed/target QA fault run | `749eb6c`     | PARTIAL    | 9 PASS / 0 FAIL / 2 NOT_RUN |
| `rc2d-20261025T075858Z` | 1k/10k/100k import benchmark  | `749eb6c`     | BENCH_ONLY | 1 benchmark sample          |

## Artifact identities

| Artifact                                                         | SHA-256                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| QA NSIS `Shishi QA RC2D_1.0.0-rc2d_x64-setup.exe`                | `3bce130101fd78bc6cf6f54d898a52418d923b0e7c28019fb44962ec1ebb14b1` |
| QA release exe `target/release/todo-native.exe`                  | `1da44e3adac84f538aa43ee6a13120cbdeda9fe187a996c34a8790f9101e9bf3` |
| Installed QA exe `%LOCALAPPDATA%\Shishi QA RC2D\todo-native.exe` | `090aa3843a9994136d4bbf7c52d771f8587169db0fc282c2369477fa370b25c0` |

The documented `run-windows.ps1 -Build -Install -AllowPartial` flow built, installed, discovered the installed `todo-native.exe`, and verified native identity `app.shishi.todo.qa`. Identifier: `app.shishi.todo.qa`. Credential service: `app.shishi.todo.rc2d-qa.secure-token`. Production data root `%APPDATA%\app.shishi.todo` was absent before/after each run; production credentials were not read or written.

## Fault evidence

`fault-20261025T075811Z/fault-evidence.jsonl` contains a real injected `switch_prepared_persisted` error in `PREPARED`, plus passed cleanup and credential points. The run-bound config under the full local artifact names the same run and the exact point; no token or credential value is present.

## Benchmark (import only)

|    Size | Runs |       Min |       P50 |       P95 |       Max |
| ------: | ---: | --------: | --------: | --------: | --------: |
|   1,000 |    3 |    396 ms |    465 ms |  3,485 ms |  3,485 ms |
|  10,000 |    3 |  4,626 ms |  4,670 ms |  4,755 ms |  4,755 ms |
| 100,000 |    3 | 81,841 ms | 83,235 ms | 83,523 ms | 83,523 ms |

The first 1k run includes warm-up; P95 is conservative. This is WebView IPC import with replace semantics, not UI file selection, cloud outbox or startup. The earlier replace-only `SELECT EXISTS` short-circuit was reverted in this round; the sample improved versus the prior local run, but this is not treated as proof of a performance change.

## Review-fix coverage

- Duplicate import IDs are rejected before the transaction for lists, tasks, steps and day plans; cross-entity equal IDs remain allowed.
- Invalid import leaves local rows, outbox and sync state unchanged (regression tests).
- Notification activation is explicitly pop-on-read; the no-op ACK command/calls were removed.
- QA default executable discovery now resolves `todo-native.exe` from the release and installed directories; `-DiscoverOnly` verifies it without launching.

## Explicitly NOT_RUN

Real Windows Toast action click, wrong-account notification rejection, cold-start activation, process-kill/restart fault matrix, real SqliteBusy external lock, QA legacy notification-store fixture, macOS/Linux Rust tests, Android/iOS builds, Windows QA harness in CI, and `PLATFORM_RELEASE_READY`.

`PARTIAL`/`BENCH_ONLY` is not a release PASS.
