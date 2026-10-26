# RC2-D Evidence Index

Committed excerpts from the local QA runs for the RC2-D.6 code gate `22382e3`. Full logs, app binaries and ignored artifacts remain under `artifacts/native-qa/<run-id>/`; paths in committed copies are replaced with `<repo>` / `<user>`.

| Run                     | Kind                                 | Source commit | Status     | Tests                       |
| ----------------------- | ------------------------------------ | ------------- | ---------- | --------------------------- |
| `rc2d-20261026T055128Z` | QA release exe smoke                 | `22382e3`     | PARTIAL    | 7 PASS / 0 FAIL / 4 NOT_RUN |
| `rc2d-20261026T055353Z` | QA release exe fault run             | `22382e3`     | PARTIAL    | 9 PASS / 0 FAIL / 2 NOT_RUN |
| `rc2d-20261025T075858Z` | 1k/10k/100k import benchmark (prior) | `749eb6c`     | BENCH_ONLY | 1 benchmark sample          |

The benchmark is retained from an earlier code gate; RC2-D.5 changed QA/evidence tooling, not import production behavior.

## Artifact identities

| Artifact                                                         | SHA-256                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| QA NSIS `Shishi QA RC2D_1.0.0-rc2d_x64-setup.exe`                | `18a4804fd166c8c2b026aa1420cd4f8a52a41abe0cb20bb21191c728910ca7ce` |
| QA release exe `target/release/todo-native.exe`                  | `5b7cea327fe915b3036d93430bd02856efe8787eab23376a20d9db7904552424` |
| Installed QA exe `%LOCALAPPDATA%\Shishi QA RC2D\todo-native.exe` | `a9f8b19f2ed9da261783c06d528db31ff710948bd4546e0c6024b72a07d4d0f2` |

QA identifier `app.shishi.todo.qa`; QA credential service `app.shishi.todo.rc2d-qa.secure-token`. Production data root `%APPDATA%\app.shishi.todo` was absent before/after each run; production credentials were not read or written.

## Evidence validation

Both committed runs pass:

```text
node scripts/qa/native/verify-native-qa-evidence.mjs \
  --artifact-root <dir> --expected-head 22382e3827d512ea722efa9ef1a6f79e6cf111f0
# ok: true, evidenceVerified: true, windowsPlatformReady: false
```

`manual-platform.json` is schema v2; all 10 scenarios are `NOT_RUN`, so no PASS
without observed evidence. `sha256sums.txt` covers the committed archive
(manifest excluded to avoid a self-reference).

## Real Toast attempt

`rc2d-20261026T055128Z/platform-scenario.json` records an actual UIA attempt:
a QA task/reminder was created and scheduled with the runId marker,
`windows-toast-driver.ps1` searched for a real `打开任务` button in a notification
host for 25 seconds, found none, and recorded `NOT_RUN`.

`notification-platform.json` shows Windows itself recorded the toast for
`app.shishi.todo.qa` at the exact scheduled time. A read-only copy of
`wpndatabase.db` was inspected separately and contained the toast title, body and
`shishi.task.v1:default:<task>` action. Therefore scheduling/action
registration/show were accepted by the platform; the missing piece is on-screen
UIA visibility (banner/Action Center), not the Rust scheduling path. No
screenshot of the user's desktop was retained. The scenario was not promoted to
PASS; `platform-results.json` remains `windowsPlatformReady: false`.

## Credential restart

`rc2d-20261026T055128Z/credential-restart.json` records a real QA Credential
Manager write, process termination, fresh process start, read-back and removal:
`status: PASS`, `restartedRead: true`, QA namespace only. This is supplemental
evidence; it is not one of the 10 public Toast scenarios.

## Fault evidence

`fault-20261026T055353Z/fault-evidence.jsonl` contains a real injected
`switch_prepared_persisted` error in `PREPARED`, plus passed cleanup and
credential points. No token or credential value is present.

## Explicitly NOT_RUN

Real Toast action (UIA found no button), cold-start activation, wrong-account
Toast rejection, switch-race Toast, deleted-task Toast, pre-listener multi
queues, target-DB corruption via real Toast, kill/restart Toast, duplicate real
clicks, macOS/Linux runtime, Android/iOS build/runtime, and
`PLATFORM_RELEASE_READY`.

`PARTIAL`/`NOT_RUN` is not a release PASS.
