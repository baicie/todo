# ADR: Windows native notification activation for RC2-D.8

## Status

Proposed / partially implemented. No production Windows notification backend
replacement in this round.

## Context

Current Windows path:

```
Reminder domain
  -> DesktopTimerAdapter (in-process)
  -> tauri-plugin-notification 2.7.0
  -> notify-rust 4.18
  -> Windows ToastNotificationManager / WpnService
```

The QA installed app has AUMID `app.shishi.todo.qa`, Start Menu shortcut and a
platform notification record. `tauri-plugin-notification` 2.7.0 documents that
Windows action callbacks are reported only while the Toast is on screen; it does
not provide Action Center or process-exit COM activation.

## Findings

- Notification platform accepts the QA toast and stores the action arguments
  (`shishi.task.v1:<account>:<task>`), but UIA exposes no on-screen card in this
  environment.
- `AppNotificationManager` is the right Windows App SDK API for unpackaged Win32
  activation and NotificationCenter clicks.
- The Windows App Runtime packages are installed, but this environment has no
  .NET SDK/MSBuild and the AppNotification WinRT projection is not loadable from
  Windows PowerShell 5.1.
- `check-windows-activation-prerequisites.ps1` records these facts read-only;
  no user notification setting is modified.

## Options

| Option                                                       | Benefit                                                                    | Cost/risk                                                                                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A. Windows App SDK `AppNotificationManager` + COM activation | Official unpackaged Win32 path; NotificationCenter and cold start possible | Needs .NET SDK/Windows App SDK build, COM/CLSID registration, AUMID/installer migration, single-instance routing, rollback/upgrade tests |
| B. Custom COM Toast activator around notify-rust             | Could preserve current builder                                             | Highest maintenance; manual COM registration and activation arguments/security are high risk                                             |
| C. Scope v1 to on-screen banner only                         | No backend replacement                                                     | Does not meet NotificationCenter/cold-start product requirement                                                                          |

## Decision

1. Do not replace the production Windows notification backend without a working
   POC and real OS activation evidence.
2. Deliver the provider-independent Native Activation Gateway and listener
   ready/ACK barrier now (account fence, task validation, in-flight ACK,
   bounded recovery, duplicate suppression).
3. Build the App SDK POC as a separate follow-up after installing .NET SDK /
   Windows App SDK build prerequisites; it must not share production AUMID/data.
4. Keep `cold-start-activation` and NotificationCenter scenarios NOT_RUN until
   real OS activation is observed and validated through the gateway.

## POC acceptance contract (next slice)

- QA-only AUMID and QA data root.
- `Register()` / `Unregister()` ownership and cleanup on install/upgrade/uninstall.
- Notification arguments contain only `NotificationTargetV1`; Native validates
  account, task and runtime gate before delivery.
- Running, NotificationCenter and cold-start are assessed independently.
- Single-instance forwarding must not bypass the gateway.
- Evidence must include OS notification identity, activation callback, Native
  validation, listener ACK and WebView task detail.
