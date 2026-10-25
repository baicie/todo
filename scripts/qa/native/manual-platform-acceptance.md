# Windows real-notification manual acceptance

Automated QA evidence is not a substitute for real Toast interaction. Run this
checklist only on an interactive Windows desktop with the QA build installed.
The QA app uses `app.shishi.todo.qa`, `%APPDATA%\app.shishi.todo.qa` and
`app.shishi.todo.rc2d-qa.secure-token`; it must never touch the production
identifier, data root or credential service.

## Evidence requirements

For every scenario record:

- test ID and QA run ID;
- HEAD, app EXE SHA-256 and installer SHA-256 from `manifest.json`;
- Windows/WebView2 version and whether the app was running or stopped;
- account A/B identity and task state;
- expected result, observed result, and `PASS` / `FAIL` / `PARTIAL` / `NOT_RUN`;
- screenshot or screen recording path; for cold start, include the process
  start time and the task that opened.

Fill `manual-platform.json` in the run artifact. Do not change `NOT_RUN` to
`PASS` without real desktop evidence; do not paste tokens, emails in full, or
real user task content into committed evidence.

## Scenarios

### M1 — running-app-activation: Toast “打开任务” while app is running

1. Install the QA NSIS package and start the QA app.
2. Create a QA-only task with a reminder/test notification in the future.
3. Wait for the Windows Toast and click the **打开任务** action.
4. **Expected:** the QA app focuses and opens that task; no production data is touched.
5. Record the task ID/name in QA-only data and a screenshot.

### M2 — cold-start-activation: Cold start from a Toast action

1. Quit the QA app (verify the process is gone).
2. Trigger a QA-only reminder and wait for its Toast.
3. Click **打开任务** while the app is stopped.
4. **Expected:** the app starts and opens the target task after initialization; no
   production account/data is used.
5. Record process start, the opened task, and a screenshot.

### M3 — wrong-account-rejection

1. Create QA accounts A and B with distinct QA-only data.
2. Activate B, then produce a Toast for an A task.
3. Click **打开任务**.
4. **Expected:** no A task opens; the app remains on B; a rejection message is
   shown if the bridge is ready. The rejection bridge is bounded (8) and
   pop-on-read.
5. Record both account IDs in short form and the observed/no-toast behavior.

### M4 — switch-race-rejection: Account switch race

1. Start an A→B or B→A switch and click an A notification during the gate-closed
   window.
2. **Expected:** fail-closed; no wrong-account task opens. The rejection may be
   delivered after the bridge drains its bounded queue.
3. Record the switch phase and observed result.

### M5 — deleted-task-rejection: Deleted task

1. Schedule a QA reminder, then delete the QA task before the Toast.
2. Click **打开任务**.
3. **Expected:** no task opens; a rejection result is produced and delivered once
   after the listener is ready; no stale target is retained.

### M6 — pre-listener-multi-pending: Several activations before the WebView listener

1. Quit the QA app.
2. Produce 2–8 QA notification actions while the process/WebView is not ready
   (use the QA-only test notification helper or Action Center history).
3. Start/click the app.
4. **Expected:** queued activations are drained in FIFO order without another
   event; the bounded queue keeps at most 8; opening is not duplicated.

### M7 — pre-listener-multi-rejection: Rejections before listener registration

1. Quit the QA app.
2. Trigger 2+ invalid QA notifications (wrong account/deleted task) while stopped.
3. Start the app.
4. **Expected:** the bounded rejection queue is drained after listeners install;
   each retained result is shown once; no direct event replay duplicates a toast.
   If more than 8 rejections occurred, the oldest may be dropped by design.

### M8 — target-db-corrupt: Target account database damaged

1. In a QA-only account, corrupt or truncate the target `shishi.sqlite3` before
   the switch verification, or remove its write permission.
2. Trigger the account switch and restart the app.
3. **Expected:** fail-closed; the target must not become active; the source
   account is restored, journal moves to FAILED or is repaired, and no empty
   target database is created.
4. Record the exact corruption, observed active account, journal phase, and
   source/target file existence.

### M9 — kill-restart-notification: Forced process kill/restart

1. With QA data only, queue a notification action, then terminate the QA process
   with Task Manager/`Stop-Process -Force`.
2. Restart the QA app.
3. **Expected:** no wrong-account task opens; any in-memory activation/rejection
   queue is lost (at-most-once UX, fail-closed security); account/journal
   recovery follows the crash matrix in the RC2-D.3 report.
4. Record the process kill time and post-restart active account.

### M10 — duplicate-toast-click: Repeated click / duplicate activation

1. Click the same Toast action repeatedly and trigger the same activation event
   multiple times.
2. **Expected:** the task is opened at most once per activation; duplicate wake
   events do not produce duplicate toasts or navigation.
3. Record click count, observed open count and any duplicate toast.

## Exit criteria

- All executed scenarios have real observation evidence.
- Any scenario without real interaction remains `NOT_RUN`, even if automated
  unit/IPC/harness tests pass.
- `PLATFORM_RELEASE_READY` stays `NOT_READY` until M1–M10 have acceptable
  evidence and the crash matrix blockers are closed.
