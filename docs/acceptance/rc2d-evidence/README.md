# RC2-D Evidence Index

Committed excerpts of the local QA runs. Full logs, app binaries and ignored local artifacts remain under `artifacts/native-qa/<run-id>/`; paths in committed copies are replaced with `<repo>` / `<user>`.

| Run                     | Kind                          | Source commit | Status     | Tests                       |
| ----------------------- | ----------------------------- | ------------- | ---------- | --------------------------- |
| `rc2d-20261025T063603Z` | Installed QA app smoke        | `6a320b5`     | PARTIAL    | 8 PASS / 0 FAIL / 4 NOT_RUN |
| `rc2d-20261025T064120Z` | Installed/target QA fault run | `6a320b5`     | PARTIAL    | 9 PASS / 0 FAIL / 2 NOT_RUN |
| `rc2d-20261025T064225Z` | 1k/10k/100k import benchmark  | `6a320b5`     | BENCH_ONLY | 1 benchmark sample          |

## Artifact identities

| Artifact                                                         | SHA-256                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| QA NSIS `Shishi QA RC2D_1.0.0-rc2d_x64-setup.exe`                | `ba05487e6b1c342aac7c9499225eea42b3e31fdd12e742353c3d25342fa6895a` |
| QA release exe `target/release/todo-native.exe`                  | `82606d8c401757f8bde94473ffda5b3f23b3288fd507474fbd7a0c43672ee3da` |
| Installed QA exe `%LOCALAPPDATA%\Shishi QA RC2D\todo-native.exe` | `5c45e2c56a3230ad27c843c5db8976c5a3f1dbdaf67df03073eac1f4ff9b83c9` |

Identifier: `app.shishi.todo.qa`. Credential service: `app.shishi.todo.rc2d-qa.secure-token`. Production data root `%APPDATA%\app.shishi.todo` was absent before/after each run; production credentials were not read or written.

## Fault evidence

`fault-20261025T064120Z/fault-evidence.jsonl` contains a real injected `switch_prepared_persisted` error in `PREPARED`, plus passed cleanup and credential points. The run-bound config under the full local artifact names the same run and the exact point; no token or credential value is present.

## Benchmark (import only)

|    Size | Runs |       Min |       P50 |       P95 |       Max |
| ------: | ---: | --------: | --------: | --------: | --------: |
|   1,000 |    3 |    425 ms |    453 ms |  3,444 ms |  3,444 ms |
|  10,000 |    3 |  4,852 ms |  4,994 ms |  5,085 ms |  5,085 ms |
| 100,000 |    3 | 90,793 ms | 90,935 ms | 91,487 ms | 91,487 ms |

The first 1k run includes warm-up; P95 is conservative. This is WebView IPC import with replace semantics, not UI file selection, cloud outbox or startup.

## Explicitly NOT_RUN

Real Windows Toast action click, wrong-account notification rejection, cold-start activation, process-kill/restart fault matrix, real SqliteBusy external lock, QA legacy notification-store fixture, macOS/Linux Rust tests, Android/iOS builds, Windows QA harness in CI, and `PLATFORM_RELEASE_READY`.

`PARTIAL`/`BENCH_ONLY` is not a release PASS.
