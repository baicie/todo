# RC2-D Evidence Index

Committed excerpts from the local QA runs for the RC2-D.2 code gate `00e3dcd`. Full logs, app binaries and ignored artifacts remain under `artifacts/native-qa/<run-id>/`; paths in committed copies are replaced with `<repo>` / `<user>`.

| Run                     | Kind                                 | Source commit | Status     | Tests                       |
| ----------------------- | ------------------------------------ | ------------- | ---------- | --------------------------- |
| `rc2d-20261025T120025Z` | Installed QA app smoke               | `00e3dcd`     | PARTIAL    | 7 PASS / 0 FAIL / 4 NOT_RUN |
| `rc2d-20261025T120802Z` | QA release exe fault run             | `00e3dcd`     | PARTIAL    | 9 PASS / 0 FAIL / 2 NOT_RUN |
| `rc2d-20261025T075858Z` | 1k/10k/100k import benchmark (prior) | `749eb6c`     | BENCH_ONLY | 1 benchmark sample          |

The benchmark is retained from an earlier code gate; RC2-D.2 changed notification/bridge and test coverage, not import production behavior.

## Artifact identities

| Artifact                                                         | SHA-256                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| QA NSIS `Shishi QA RC2D_1.0.0-rc2d_x64-setup.exe`                | `ca425fce30d73bff2570420dbe636d3632c0cb0f5380057d79af1907c276879f` |
| QA release exe `target/release/todo-native.exe`                  | `cc3be4b592d466d1113acac845ab173eb76f30d5d63ea2914484a1fd7ca7a3d0` |
| Installed QA exe `%LOCALAPPDATA%\Shishi QA RC2D\todo-native.exe` | `28b5b093b0dd2fa788309d4a8fef8640293d597f62912aeff49a5044ba7b119b` |

The documented `run-windows.ps1 -Build -Install -AllowPartial` flow built and installed the QA package, discovered the installed `todo-native.exe`, and verified native identity `app.shishi.todo.qa` with the QA credential service. The production data root `%APPDATA%\app.shishi.todo` was absent before/after every run; production credentials were not read or written.

## Fault evidence

`fault-20261025T120802Z/fault-evidence.jsonl` contains a real injected `switch_prepared_persisted` error in `PREPARED`, plus passed cleanup and credential points. The run-bound config names the same run; no token or credential value is present.

## Notification activation/rejection coverage

The frontend bridge has 19 Vitest tests covering activation FIFO, bounded drain, empty termination, Native failure termination, dedupe, account mismatch, rejection queue FIFO, pre-listener rejection replay, event-only wake semantics, no duplicate toast, abort during imports/listener registration/initial drain, idempotent cleanup, and late events.

Native tests cover rejection FIFO/pop-once/capacity-8/newest retention and invalid activation skipping.

`manual-platform.json` starts every M1–M8 real-desktop scenario as `NOT_RUN`; no automated result is promoted to a Toast/cold-start PASS. The checklist is `scripts/qa/native/manual-platform-acceptance.md`.

## Explicitly NOT_RUN

Real Windows Toast action click, wrong-account notification rejection, cold-start activation, complete process-kill matrix beyond PREPARED/RESTART_REQUIRED, Android/iOS builds and runtime, macOS/Linux runtime, and `PLATFORM_RELEASE_READY`.

`PARTIAL`/`BENCH_ONLY` is not a release PASS.
