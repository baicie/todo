# Windows App SDK AppNotificationManager POC

This is an isolated QA-only POC; it does not replace the production notification backend.

```powershell
powershell.exe -NoProfile -File scripts/qa/native/windows-app-sdk-poc/build-poc.ps1 -OutDir artifacts/app-sdk-poc
```

Current environment: compile succeeds with csc + installed Windows App Runtime 1.8 WinMD
projections; runtime fails because the unpackaged app has no Windows App SDK bootstrap
(`Microsoft.WindowsAppRuntime.Bootstrap.dll` unavailable) and the AppNotification WinRT
projection is not loadable without the .NET/App SDK projection runtime.

Current result: compilation succeeds; runtime exits with CLR code `-532462766`
(`0xE0434352`) before a managed exception can be captured. The Windows App SDK
bootstrap/projection runtime is not available, so this is a **BLOCKED POC**, not a
PASS. A real POC PASS requires the QA app to register/show a toast and receive its
activation event; synthetic callbacks are not accepted.
