# Windows App SDK AppNotification POC

Official .NET 8 + Windows App SDK project (not naked csc/WinMD):

- `AppNotificationPoc/` — `Microsoft.WindowsAppSDK` 1.8.250907003,
  `net8.0-windows10.0.19041.0`, x64, `WindowsPackageType=None`.
- `build-poc.ps1` — build and run one variant.
- `build-matrix.ps1` — four deployment variants (framework/self-contained ×
  auto/explicit bootstrap), logs and `matrix.json`.
- `csc-fallback/` — previous csc/WinMD diagnostic retained as historical fallback only.

Current result:

| Variant                               | Build | Default    | Register    |
| ------------------------------------- | ----- | ---------- | ----------- |
| A framework + auto bootstrap          | PASS  | OK         | 0x80040154  |
| B framework + explicit bootstrap      | PASS  | OK         | 0x80040154  |
| C self-contained + explicit bootstrap | PASS  | OK         | 0x80040154  |
| D self-contained + no bootstrap       | PASS  | 0x80040154 | not reached |

Bootstrap + AUMID set (`app.shishi.todo.qa.poc`) still fails at
`Register()` with `REGDB_E_CLASSNOTREG`. This is not a deployment-mode-only
defect; the exact CLSID is not exposed by the managed exception. The POC remains
BLOCKED for OS activation and does not replace the production backend.
