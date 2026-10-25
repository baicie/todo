# RC2-D.2 — Platform Acceptance & Notification Reliability Design

Baseline code: `b3756b7`; PR #5 Draft, unmerged. This design covers RC2-D.2 only:
reliable rejection delivery, switch crash-recovery coverage, real Windows
notification acceptance capability, and cross-platform gates.

## 1. Notification rejection delivery

### 1.1 Problem

Native rejects a notification target before/without opening a task (wrong
account, task deleted, gate busy, app not ready). The rejection currently exists
only as a one-shot `native-notification-rejected` event. If the action happens
before the WebView listener is installed, `show_window()` still opens the app,
but the rejection toast can be lost.

### 1.2 Contract

- **Security is fail-closed and unchanged**: Native validates account registry,
  active account, RuntimeGate lease and task existence before producing an
  `Activation`. Rejection never opens a task, switches account or relaxes those
  checks.
- **Rejection notice delivery is bounded, FIFO, pop-on-read**: Native retains at
  most 8 rejection results. The event is only a wake-up. A dedicated command
  delivers one result per read; repeated reads return `None` when empty.
- **Overflow**: when a ninth rejection arrives, the oldest pending rejection is
  dropped. The newest 8 are retained. This is a deliberate UX bound; security
  decisions are unaffected. No retry/ACK state is introduced.
- **No secrets**: only a stable `code` and a short, already-sanitized message are
  stored; no tokens, task titles, emails or file paths.
- **Single delivery path**: the rejected event callback wakes a frontend
  rejection-drain loop; it must not call `notify` directly. This avoids both
  event delivery and queue delivery producing duplicate toasts.
- **Ordering**: rejection queue is FIFO independent of the activation queue.
  Frontend drains activations and rejections with serialized, bounded cycles.
- **Startup**: listeners are registered before the first drain; queued results
  from before listener registration are delivered without another event.
- **Failure/abort**: a Native command failure stops the current cycle (no busy
  retry); AbortSignal/cleanup stops notification and prevents callbacks against
  a disposed component.

### 1.3 State and APIs

Native `NotificationActivationState` adds `rejections: Mutex<VecDeque<RejectedActivation>>`.

- `put_rejection(rejection)` — cap 8, drop oldest.
- `take_rejection() -> Option<RejectedActivation>` — FIFO pop.
- `#[tauri::command] native_take_notification_rejection() -> Option<RejectedActivation>`
  — product command, no extra filesystem/database access.

`RejectedActivation` remains serialized camelCase: `{ code, message }`.

Frontend bridge:

- Register both `EVENT_OPEN` and `EVENT_REJECTED` listeners.
- Initial drain: activation drain then rejection drain, each bounded at 8.
- Rejected event only requests a rejection drain.
- One serial drain chain per kind or one combined serial chain; no overlap.
- Duplicate wake events are coalesced.
- No duplicate toast: every rejection command takes one record; the event never
  directly notifies.
- Abort checks at every await boundary.

## 2. Switch crash/recovery matrix

| Phase / boundary                           | Test type                    | Expected recovery                                                       | Planned result                 |
| ------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| Before prepare persisted                   | fault error test             | no journal; source active                                               | PARTIAL (no process kill hook) |
| PREPARED persisted                         | child process + kill/restart | discard prepared; source active                                         | planned PASS                   |
| Source DB close around switch              | fault/unit                   | fail-closed; source/target state consistent                             | PARTIAL                        |
| RESTART_REQUIRED persisted                 | child process + kill/restart | recover target; finish idempotent                                       | existing PASS                  |
| VERIFYING_TARGET                           | fault/recovery test          | fail-closed; journal retained; retry works                              | existing PARTIAL               |
| Target DB invalid/corrupt                  | fail-closed test             | no active target; error/diagnostic                                      | planned test                   |
| Commit target before/after                 | fault tests                  | one active account; registry/journal consistent                         | PARTIAL                        |
| Rollback source                            | existing failure tests       | source remains active; no partial target                                | PARTIAL                        |
| Journal cleanup/retry                      | fault tests                  | idempotent retry; journal eventually removed                            | existing PASS                  |
| Process restart after each applicable kill | child process                | verify active account, registry, journal, DB, outbox, cursor, device ID | planned                        |

Constraint: the current public API has no process-kill hook inside every
transaction. Tests only claim process-level PASS where a child process is
actually killed and restarted; other boundaries are unit/fault tests or
`NOT_RUN`. No production hook is added to manufacture coverage.

Additional state checks: active account, registry, journal phase/removal,
SQLite integrity, business rows, outbox, cursor, device ID, credential namespace
and recovery diagnostics. `server_shadow`/`kv_state` have no safe public
test-only reader; they remain unasserted and are reported as such.

## 3. Windows real notification acceptance

The QA package uses identifier `app.shishi.todo.qa`, data root
`%APPDATA%\app.shishi.todo.qa`, and credential service
`app.shishi.todo.rc2d-qa.secure-token`.

Automated harness results are limited to build/install/boot/storage/fault
checks. Real Toast click, cold start from Action Center, two-account rejection
and gate races require an interactive desktop and are `NOT_RUN` unless actually
clicked.

A manual checklist will require for every scenario:

- test ID, run ID, app/installer SHA-256, HEAD;
- exact setup (account A/B, task state, app started/stopped);
- expected and observed result;
- screenshot or screen recording path;
- `PASS` only with real platform interaction evidence; otherwise `NOT_RUN` or
  `PARTIAL` with reason.

QA-only automated hooks must be behind `native-qa`, validate QA identity before
use, and must not be registered in production builds.

## 4. Platform gates

- Windows: QA NSIS build, installed EXE discovery, QA identity, local
  `-Build -Install -AllowPartial` harness.
- macOS/Linux: CI `cargo check --features native-qa` compile only; runtime
  notification tests are `NOT_RUN` without runners.
- Android/iOS: no Android SDK/NDK or Xcode/signing in this environment. Add
  build checks only if verified commands exist; otherwise `NOT_RUN` with exact
  prerequisites.
- CI must run on the final code SHA. `native-qa` is triggered by PR label
  `native-qa` before merge; `workflow_dispatch` is unavailable until merged.

## 5. Acceptance criteria

- Rust rejection queue tests: FIFO, once-only, capacity/overflow, multiple
  rejections, valid activation unaffected.
- Frontend tests: queued rejections before listener, empty termination, wake
  during drain, no duplicate toast, Native failure termination, abort/cleanup
  at every async boundary.
- Switch child-process tests for PREPARED and RESTART_REQUIRED with restart
  invariants; external SQLite lock test remains.
- Windows QA harness run with real installed EXE and bound hashes.
- Independent review finds no P0/P1/P2 in the changed slice.
- Final report separates `CODE_RC_READY`, `PLATFORM_RELEASE_READY`,
  `RELEASE_STATUS`; no merge/release.
