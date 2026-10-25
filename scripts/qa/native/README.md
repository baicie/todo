# Native QA Harness (RC2-D)

Isolated Windows QA build for account lifecycle, credentials, reminders and fault recovery. This directory is not a release pipeline and never targets the production identifier or production Credential Manager service.

## Safety model

- QA Tauri identifier: `app.shishi.todo.qa`; data root `%APPDATA%\app.shishi.todo.qa`.
- QA credential service: `app.shishi.todo.rc2d-qa.secure-token`.
- Fault injection is compiled with `--features native-qa`, armed only by `--rc2d-fault-config <path>`. There is no WebView command or environment-variable switch.
- The QA binary refuses to run under a non-QA identifier.
- Cleaning `artifacts/native-qa/<run-id>/` or the QA app data root is allowed only for this QA identifier. Never delete `%APPDATA%\app.shishi.todo`.

## Build

From the repository root:

```powershell
pnpm dlx @tauri-apps/cli@2.12.4 build `
  --config src-tauri/tauri.qa.conf.json `
  --features native-qa `
  --bundles nsis
```

Run it from `apps/native`, or use:

```powershell
./scripts/qa/native/run-windows.ps1 -Build
```

The QA bundle is written under `apps/native/src-tauri/target/release/bundle/nsis/`.

## Run

Smoke run against the release executable:

```powershell
./scripts/qa/native/run-windows.ps1 -AppExe "apps/native/src-tauri/target/release/todo-native.exe"
```

Install the NSIS package first, then run the installed binary:

```powershell
./scripts/qa/native/run-windows.ps1 -Build -Install
```

Fault run:

```powershell
./scripts/qa/native/run-windows.ps1 `
  -AppExe "apps/native/src-tauri/target/release/todo-native.exe" `
  -FaultConfig "C:\path\to\fault-config.json"
```

Performance smoke (`PerfTasks` creates tasks through the real WebView IPC):

```powershell
./scripts/qa/native/run-windows.ps1 -AppExe "..." -PerfTasks 1000
```

## Output

`artifacts/native-qa/<run-id>/`:

- `manifest.json` — run status, app/installer SHA-256, QA/production data roots.
- `environment.json` — OS, CPU, memory, Rust/Node/pnpm/WebView2 versions.
- `provenance.json` — git HEAD/branch/status, package/native manifest, build log reference.
- `tests.json` — PASS / FAIL / NOT_RUN with no fabricated results.
- `timeline.json` — harness events.
- `performance.json` — measured samples (empty when no scenario ran).
- `logs/` — build, installer, app stdout/stderr, harness output.
- `screenshots/` — real WebView screenshots.
- `summary.md` — human-readable result.
- `fault-evidence.jsonl` — only when a QA fault config was armed.

## Current limits

- Real toast click routing and wrong-account notification rejection need two interactive desktop cloud accounts and visible toasts. They are left NOT_RUN unless a future fixture performs that flow on Windows.
- A Windows toast action can be reported only while the process's action listener is alive; cold-start activation from Action Center is not claimed as PASS.
- macOS/Linux/Android/iOS builds are compile/unit-test evidence only unless a real device/runner result is recorded.
