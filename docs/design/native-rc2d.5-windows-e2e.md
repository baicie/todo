# RC2-D.5 — Windows Native E2E, Toast Interaction & Trusted Release Gate

Baseline: code `deeb5a6`, docs `363250b`. This design covers only RC2-D.5
platform acceptance, evidence integrity and QA automation. The existing
activation/rejection queue implementation is not rewritten.

## 1. Windows notification architecture

- Tauri notification plugin owns Windows registration and the action callback.
  The action id is the versioned compact token
  `shishi.task.v1:<account-id>:<task-id>`.
- Native `handle_action` parses the token, checks the account registry, active
  account, RuntimeGate lease and task existence, then appends to the in-memory
  activation queue (or rejection queue) and emits a wake-up event.
- The WebView bridge installs listeners before draining; pop-on-read queues are
  bounded at 8. The queue is in-memory: process exit loses pending items
  (at-most-once UX, fail-closed security).
- Real Windows Toast click is an OS interaction: a driver must click the actual
  Toast button. Calling `handle_action`, `native_take_*`, or emitting an event is
  `SIMULATED`, never `REAL_TOAST_PASS`.
- Cold start depends on the Windows shortcut/AUMID activation path. If the Tauri
  plugin only registers an in-process action listener, an app-stopped click may
  launch the executable without delivering the action. This must be probed, not
  assumed; missing cold-start delivery is a platform gap, not a JS bug.

## 2. Toast UI Automation driver

`windows-toast-driver.ps1` (PowerShell, interactive Windows only):

- requires `UserInteractive`, WpnService running, WebView2 presence and QA
  executable identity;
- loads .NET `UIAutomationClient`/`UIAutomationTypes`;
- enumerates top-level notification windows by class/name, then descendant
  buttons; only a button inside a verified notification window is actionable;
- locates the **打开任务** button by accessible name and invokes
  `InvokePattern`; never uses blind screen coordinates;
- records a JSON timeline, screenshots and failure classification;
- has per-step timeout, bounded retry, process cleanup and redacted logs;
- `-ProbeOnly` reports capability without clicking.

If no Toast window/button is found, result is `NOT_RUN` with a precise reason.
It is never promoted to PASS from IPC/harness success.

## 3. Fixture lifecycle

QA app only: identifier `app.shishi.todo.qa`, data root
`%APPDATA%\app.shishi.todo.qa`, credential service
`app.shishi.todo.rc2d-qa.secure-token`.

Fixture operations use existing product IPC where safe (`todo_storage`,
`native_create_account`, `schedule_reminder`, `cancel_reminder`,
`native_prepare_account_switch`, `native_abort_account_switch`) and QA-only
identity checks. New fixture commands, if any, are compiled only under
`native-qa`, validate the QA identifier/root and expose no arbitrary path,
token plaintext, production database access or notification bypass.

One run creates isolated A/B QA accounts and tasks; teardown removes only paths
recorded in the current run manifest. A process restart does not reuse another
run's data.

## 4. Scenario timing classes

The 10 canonical scenarios are classified by prerequisite:

| Scenario                     | Class                          | Prerequisite                                  |
| ---------------------------- | ------------------------------ | --------------------------------------------- |
| running-app-activation       | OS toast                       | app running, task/reminder, real button click |
| cold-start-activation        | OS toast + process activation  | app stopped, shortcut/AUMID, real click       |
| wrong-account-rejection      | OS toast + two QA accounts     | B active, A toast                             |
| switch-race-rejection        | OS toast + gate barrier        | switch in progress                            |
| deleted-task-rejection       | OS toast                       | delete after reminder                         |
| pre-listener-multi-pending   | native queue + webview barrier | app/native running, listener not installed    |
| pre-listener-multi-rejection | native queue + webview barrier | same                                          |
| target-db-corrupt            | filesystem + OS restart        | QA account DB corruption                      |
| kill-restart-notification    | process kill + OS toast        | app killed/restarted                          |
| duplicate-toast-click        | OS toast                       | repeated real clicks                          |

M6/M7 must use a QA initialization barrier: Native is running, queues can accept
events, WebView listener is deliberately absent. "App not running with in-memory
queue" is not a valid FIFO test; it proves at-most-once loss, not playback.

## 5. Evidence and trust model

Artifact root: `artifacts/native-qa/<run-id>/`.

Required files:

- `manifest.json` — runId, HEAD, app/installer hashes, timestamps, status.
- `environment.json`, `provenance.json`, `tests.json`, `timeline.json`,
  `manual-platform.json`, `platform-results.json`, `sha256sums.txt`,
  `evidence-index.json`, `logs/`, `screenshots/`, optional `videos/`.

`manual-platform.json` schema v2: each scenario has `id`, `status`, `expected`,
`observed`, `evidence[]`, `runId`, `headSha`, `appExeSha256`,
`installerSha256`, `startedAt`, `finishedAt`, `reason`.

Evidence object: `{ path, sha256, kind }`. Paths are relative to the artifact
root, must exist, must not escape via `..` or symlink, and SHA-256 must match.

PASS requires nonempty observed, at least one verified evidence file, matching
runId/HEAD/binary hashes and valid timestamps. NOT_RUN may have null observed
and evidence. FAIL/PARTIAL require a reason; any supplied evidence is verified.
Legacy artifacts without schema v2 are `UNVERIFIABLE_HISTORICAL_EVIDENCE`, never
retroactively PASS.

## 6. Platform gates

- `CODE_RC_READY`: Rust/TS tests, crash matrix, build and ordinary CI pass.
- `WINDOWS_PLATFORM_READY`: QA install/identity, evidence schema, all mandatory
  Windows real-Toast scenarios PASS, A/B isolation, credential/recovery scope.
- `OTHER_DESKTOP_PLATFORM_READY`: only after actual macOS/Linux runtime tests;
  compile checks alone do not qualify.
- `MOBILE_PLATFORM_READY`: only after mobile builds, install and runtime tests.
- `PLATFORM_RELEASE_READY`: all applicable platform gates, no P0/P1, evidence
  verifier PASS.

Any required FAIL/NOT_RUN or missing evidence keeps the relevant gate
`NOT_READY`. `RELEASE_STATUS` remains `DRAFT`/`NOT_RELEASED`.

## 7. Failure, timeout and cleanup

- Driver step timeout (default 30s), total scenario timeout, bounded retries
  (max 2) and explicit process cleanup.
- A stale/foreign process is never treated as the run's QA app; PID + start time
  - executable hash/identity are recorded.
- If automation cannot reach the desktop, mark NOT_RUN and preserve logs; do not
  substitute IPC simulation.
- Teardown removes only run-scoped QA artifacts; production root is checked
  before and after and must remain absent.
