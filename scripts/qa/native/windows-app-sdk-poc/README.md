# Windows App SDK AppNotification POC

Official .NET 8 + Windows App SDK project (not naked csc/WinMD):

- `AppNotificationPoc/AppNotificationPoc.csproj` — `Microsoft.WindowsAppSDK` 1.8.250907003,
  `net8.0-windows10.0.19041.0`, x64, `WindowsPackageType=None`, explicit
  `MddBootstrapInitialize2`.
- `build-poc.ps1` — restore, build and run; writes build/run log.
- `csc-fallback/` — previous csc/WinMD diagnostic retained as historical fallback only;
  it is not the formal POC.

```powershell
powershell.exe -NoProfile -File scripts/qa/native/windows-app-sdk-poc/build-poc.ps1 -OutDir artifacts/app-sdk-poc
```

Observed in this session:

- official project **restore/build PASS**;
- `MddBootstrapInitialize2` returns `0`;
- `AppNotificationManager.Default` is constructed successfully;
- `manager.Register()` throws `COMException HRESULT 0x80040154
  (REGDB_E_CLASSNOTREG)`.

The failing call is now isolated to `Register()`, not bootstrap or projection
construction. The POC remains BLOCKED for OS activation.

This is a concrete registration/runtime blocker, not a fake pass. The app SDK
build is not a real OS activation PASS.
