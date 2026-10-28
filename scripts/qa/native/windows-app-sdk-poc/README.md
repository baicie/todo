# Windows App SDK AppNotification POC

Official .NET 8 + Windows App SDK project (not naked csc/WinMD):

- `AppNotificationPoc/` — `Microsoft.WindowsAppSDK` 1.8.250907003,
  `net8.0-windows10.0.19041.0`, x64, `WindowsPackageType=None`.
- `build-poc.ps1` — build and run one variant.
- `build-matrix.ps1` — four deployment variants (framework/self-contained ×
  auto/explicit bootstrap), logs and `matrix.json`.
- `AppxManifest.xml` / `create-msix.ps1` — reproducible packaged/MSIX control
  build; no installation is performed.
- `create-aumid-shortcut.ps1` — QA-only Start Menu shortcut with AUMID and
  ToastActivatorCLSID controls.
- `csc-fallback/` — historical csc/WinMD diagnostic only.

Current results:

| Variant                         | Build | Default    | Register    |
| ------------------------------- | ----- | ---------- | ----------- |
| A framework + auto              | PASS  | OK         | 0x80040154  |
| B framework + explicit          | PASS  | OK         | 0x80040154  |
| C self-contained + explicit     | PASS  | OK         | 0x80040154  |
| D self-contained + no bootstrap | PASS  | 0x80040154 | not reached |

Direct `PushNotifications_RegisterFullTrustApplication` returns `0`; the
remaining failure is in `Register()`'s COM server registration path. An explicit
`CoInitializeEx(COINIT_APARTMENTTHREADED)` returns `0x80010106`
(`RPC_E_CHANGED_MODE`) because the .NET/WinRT thread is already MTA, so COM
apartment initialization is not the missing step. A Start
Menu shortcut with AUMID/ToastActivatorCLSID and a built MSIX control did not
produce a successful Register: MSIX installation requires developer/sideload
policy and a trusted signing root (no elevation in this session). The
packaged/MSIX control remains **BLOCKED**; no package was installed and the
temporary certificate/shortcut was removed.

This POC is not a production backend and does not provide a real activation PASS.
