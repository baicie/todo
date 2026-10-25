# RC2-D Evidence Index

Committed excerpts from the local QA runs for the RC2-D.1 code gate `144d8a6`. Full logs, app binaries and ignored artifacts remain under `artifacts/native-qa/<run-id>/`; paths in committed copies are replaced with `<repo>` / `<user>`.

| Run                     | Kind                                 | Source commit | Status     | Tests                       |
| ----------------------- | ------------------------------------ | ------------- | ---------- | --------------------------- |
| `rc2d-20261025T093253Z` | QA release exe smoke                 | `144d8a6`     | PARTIAL    | 7 PASS / 0 FAIL / 4 NOT_RUN |
| `rc2d-20261025T093323Z` | QA release exe fault run             | `144d8a6`     | PARTIAL    | 9 PASS / 0 FAIL / 2 NOT_RUN |
| `rc2d-20261025T075858Z` | 1k/10k/100k import benchmark (prior) | `749eb6c`     | BENCH_ONLY | 1 benchmark sample          |

The benchmark is retained because RC2-D.1 did not change import production behavior; it is not a new RC2-D.1 benchmark.

## Artifact identities

| Artifact                                                         | SHA-256                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| QA NSIS `Shishi QA RC2D_1.0.0-rc2d_x64-setup.exe`                | `452c306d32b7870bc10ead9e4c2120359bd9e4236569b43ae2f6d3fccf70d7df` |
| QA release exe `target/release/todo-native.exe`                  | `c080edbc4149bef55d816bc83bac46f34868b3324ace894e00872026e881f480` |
| Installed QA exe `%LOCALAPPDATA%\Shishi QA RC2D\todo-native.exe` | `fdf446eec3875f8fb87654ba55d3aa1ebdde7a6ec857e6926073fe74445d1736` |

The documented `run-windows.ps1 -Build -Install -AllowPartial` flow built and installed the QA package, discovered the installed `todo-native.exe`, and verified native identity `app.shishi.todo.qa` with the QA credential service. The production data root `%APPDATA%\app.shishi.todo` was absent before/after every run; production credentials were not read or written.

## Fault evidence

`fault-20261025T091214Z/fault-evidence.jsonl` contains a real injected `switch_prepared_persisted` error in `PREPARED`, plus passed cleanup and credential points. The run-bound config names the same run; no token or credential value is present.

## Notification activation coverage

The frontend bridge has 16 Vitest tests covering multi-record startup drain, bounded drain, empty termination, Native failure termination, FIFO serialization, duplicate suppression, account mismatch, abort during dynamic imports, first/second listener registration and initial drain, idempotent cleanup, late events, and the 8-record queue cap. Native has `take_drains_rejected_activations_and_returns_first_valid`, proving invalid records are rejected and skipped before the next valid delivery.

## Explicitly NOT_RUN

Real Windows Toast action click, wrong-account notification rejection, cold-start activation, process-kill matrix beyond the existing `RESTART_REQUIRED` child-kill test, QA legacy notification-store fixture, macOS/Linux runtime tests, Android/iOS builds, and `PLATFORM_RELEASE_READY`.

`PARTIAL`/`BENCH_ONLY` is not a release PASS.
