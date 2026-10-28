# RC2-D.10 Scope Decision — Windows notification actions disabled

Status: accepted for the current RC.

## Decision

Windows desktop notification action routing is **not a release capability** in
this RC. Production Windows builds show the reminder body but do not register or
expose the `打开任务` action. QA builds retain the experimental action path only
behind the `native-qa` feature.

The experimental Windows App SDK POC source and the direct-WinRT probe were
removed from the release branch. Their historical commits and reports remain:

- `docs/acceptance/v1.0-rc2d.10-windows-com-registration.md`
- `docs/acceptance/rc2d-evidence/`
- commit history before this scope decision

## Reasons

- `AppNotificationManager.Register()` remains `0x80040154` in all tested
  deployment modes.
- Direct `PushNotifications_RegisterFullTrustApplication` succeeds, but the
  Register COM server path still fails; no CLSID is exposed and no native
  debugger/ETW environment is available.
- The current Windows session does not expose a Toast banner even for direct
  WinRT Toast.
- Packaged/MSIX control builds but cannot be installed without developer/
  sideload policy and trusted test signing.
- Real QA cloud A/B accounts are unavailable.

## Consequences

- Windows notification actions are gated off in production builds. This avoids
  shipping a broken click path.
- Windows platform remains `NOT_READY`; official 10 scenarios remain `NOT_RUN`.
- The code-level activation gateway, Instance-ID dedup, ACK/cancel protocol and
  evidence tooling remain in the branch and are still testable in QA builds.
- Re-enabling requires a real packaged/MSIX or validated Windows App SDK
  registration POC plus interactive Windows activation evidence.
