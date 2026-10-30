# RC2-D.6 — Windows Notification Root Cause & Native QA Security Design

Baseline: code `41901d4`, docs `df2805a`. Plugin locked at
`tauri-plugin-notification 2.7.0` (Windows uses `notify-rust 4.18`).

## 1. Lifecycle and ownership

```
QA task/reminder
  -> DesktopTimerAdapter queue (in-process)
  -> timer due
  -> NotificationTargetV1 from reminder id `account:<account>:<task>`
  -> register ActionType (QA AUMID + action id)
  -> notify-rust Toast builder.show()
  -> Windows notification platform / WpnService
  -> on-screen Toast banner OR Action Center history
  -> UIA driver (only matching QA run marker)
  -> Windows action callback
  -> Native account/gate/task validation
  -> activation/rejection queue
  -> WebView listener drain
  -> task detail
```

The app config identifier is the Windows AUMID
(`app.shishi.todo.qa` for QA). Per plugin metadata, Windows notifications
"only work for installed apps"; the NSIS Start Menu shortcut is part of
registration. The target/release executable alone is not equivalent to the
installed app.

## 2. Root cause of "no Toast button"

Diagnostic evidence from the actual run:

- OS registry for `app.shishi.todo.qa` recorded
  `LastNotificationAddedTime` at the exact scheduled fire time
  (`2026-10-26T05:16:49Z` / later run).
- `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db` contained a
  `toast` row for handler `app.shishi.todo.qa` with the task title, body and
  action content `打开任务`.
- The QA UIA driver found no on-screen `打开任务` button in a top-level
  notification host within 25s.

Therefore scheduling, action registration and `show()` succeeded at the
Windows platform boundary. The failure is at presentation/UIA: the notification
was accepted into the platform (likely Action Center banner hidden/expired or
not exposed to UIA) and the previous driver only inspected top-level on-screen
Toast windows. A longer blind timeout is not a fix.

Plugin 2.7.0 explicitly documents that on Windows a click is only reported while
the toast is on screen, not after it moved to Action Center; the app must not
claim action-center/cold-start activation from this construction.

## 3. Pre-spawn QA executable verification (P1)

Shared `qa-executable.mjs` used by both Toast and credential E2E:

- regular file + realpath; reject symlink/junction escape;
- allowed QA roots only (repo QA release + `%LOCALAPPDATA%` QA install dirs);
- basename `todo-native.exe` (not sufficient alone);
- manifest SHA-256 equality and manifest `appExe` path equality;
- PE ProductName `Shishi QA RC2D`;
- manifest runId/HEAD and provenance HEAD equality;
- environment QA identifier and production root absent/isolated;
- after spawn, PID → executable path must equal the verified path;
- any failure returns before `spawn()`.

The checker never launches the executable. Tests cover hash, ProductName,
outside-root, junction escape, HEAD/provenance, production-root, path mismatch.

## 4. UIA ownership (P1)

A Toast is actionable only when:

1. the button is inside a notification host;
2. the same host exposes this run's unique `runId` marker in its accessible
   text/title/body;
3. exactly one candidate matches; otherwise `AMBIGUOUS_TARGET`/`NOT_RUN`.

The QA title/body include the runId. A generic `打开任务` button from another app
is never clicked. InvokePattern only; no coordinates. The driver returns PARTIAL
after invoke; the E2E runner must observe the expected task detail for PASS.

## 5. Evidence finalization (P2)

`finalize-native-qa-evidence.mjs` order:

1. write platform-results (fixed timestamp from manifest);
2. walk business files and write evidence-index (including itself in inventory);
3. walk all files again, hash every file except `manifest.json` and
   `sha256sums.txt` (explicit self-reference exclusions), write checksums;
4. write manifest.files last.

Atomic temp+rename writes. Re-running is deterministic. The verifier rejects
missing/unregistered files, duplicate paths, wrong hashes, traversal/symlink and
manual/platform status mismatch. Evidence integrity is not proof of a real UI
click.

## 6. Cold start / single instance

- Single-instance plugin forwards second-instance activation to the first
  process only while a process exists; it does not provide a Windows Toast
  cold-start action by itself.
- Plugin 2.7.0 reports actions only while the toast is on screen; Action Center
  after process exit is not a supported activation path in this code.
- Therefore `cold-start-activation` remains a product capability gap/NOT_RUN
  until a native activation entry (AUMID/shortcut + COM activation) or a plugin
  extension is designed and tested.
- No claim of cold-start support is made from a synthetic `handle_action` call.

## 7. Scenario classes / gates

- `running-app-activation`: real toast + UIA marker + task detail.
- `cold-start-activation`: requires OS activation; currently NOT_RUN.
- Wrong-account/switch/deleted/target-DB/kill/duplicate: real desktop combos
  NOT_RUN in this environment.
- M6/M7 require a QA listener barrier; not implemented/claimed.
- Windows gate requires all mandatory scenarios PASS with evidence; otherwise
  `WINDOWS_PLATFORM_READY=NOT_READY`.
- `CODE_RC_READY` may be true independently; mobile/other desktop gates remain
  separate.
