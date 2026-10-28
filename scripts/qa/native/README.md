# Native QA Harness (RC2-D)

Isolated Windows QA build for account lifecycle, credentials, reminders and fault recovery. This directory is not a release pipeline and never targets the production identifier or production Credential Manager service.

## Safety model

- QA Tauri identifier: `app.shishi.todo.qa`; data root `%APPDATA%\app.shishi.todo.qa`.
- QA credential service: `app.shishi.todo.rc2d-qa.secure-token`.
- Fault injection is compiled with `--features native-qa`, armed only by `--rc2d-fault-config <path>`. There is no WebView command or environment-variable switch.
- The QA binary refuses to run under a non-QA identifier.
- The launcher checks the executable ProductName, and the harness calls the
  native `qa_build_identity` command before any credential/task/import fixture.
  A production binary returns `isQa: false` and the harness aborts without
  touching credentials or data.
- Cleaning `artifacts/native-qa/<run-id>/` or the QA app data root is allowed only for this QA identifier. Never delete `%APPDATA%\app.shishi.todo`.

## Build

From `apps/native`:

```powershell
pnpm dlx @tauri-apps/cli@2.12.4 build `
  --config src-tauri/tauri.qa.conf.json `
  --features native-qa `
  --bundles nsis
```

Or from the repository root:

```powershell
./scripts/qa/native/run-windows.ps1 -Build
```

The QA bundle is written under `apps/native/src-tauri/target/release/bundle/nsis/`.

## Run

Smoke run against the release executable:

```powershell
./scripts/qa/native/run-windows.ps1 -AppExe "apps/native/src-tauri/target/release/todo-native.exe"
```

Build, install and run the installed binary. `-AllowPartial` is required for an
investigative evidence run because the two real-desktop notification checks are
explicit NOT_RUN; it does not turn them into PASS:

```powershell
./scripts/qa/native/run-windows.ps1 -Build -Install -AllowPartial
```

Verify the default executable discovery without launching the app:

```powershell
./scripts/qa/native/run-windows.ps1 -DiscoverOnly
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

Repeatable import benchmark (replace mode, three runs by default):

```powershell
./scripts/qa/native/run-windows.ps1 `
  -AppExe "..." `
  -BenchSizes "1000,10000,100000" `
  -BenchRuns 3
```

The benchmark writes `performance.json` with P50/P95 per size. It measures the
real WebView IPC import path, not cloud outbox upload or desktop startup.

## CI trigger

`.github/workflows/native-qa.yml` is added by an unmerged PR, so
`workflow_dispatch` is not available from the default branch yet. The supported
pre-merge entry point is adding the `native-qa` label to the PR. That label event
runs core fault-injection, Windows QA NSIS build + default EXE discovery, and
macOS/Linux compile checks; the summary job prints the separated results and
`Real Windows Toast/cold-start/two-account acceptance: NOT_RUN in CI`. Other PR
labels do not enter these jobs.

## Output

`artifacts/native-qa/<run-id>/`:

- `manifest.json` — run status, git commit/branch, app/installer SHA-256, QA/production data roots.
- `environment.json` — OS, CPU, memory, Rust/Node/pnpm/WebView2 versions.
- `provenance.json` — git HEAD/branch/status, package/native manifest, build log reference.
- `tests.json` — PASS / FAIL / NOT_RUN with no fabricated results.
- `timeline.json` — harness events.
- `performance.json` — measured samples (empty when no scenario ran).
- `logs/` — build, installer, app stdout/stderr, harness output.
- `screenshots/` — real WebView screenshots.
- `summary.md` — human-readable result.
- `fault-evidence.jsonl` — only when a QA fault config was armed.
- `manual-platform.json` — schema v2 evidence record; every scenario starts as
  `NOT_RUN`.
- `platform-results.json` — per-platform gate summary (initially NOT_READY).
- `evidence-index.json` / `sha256sums.txt` — archive file inventory and hashes.

## Real platform acceptance

`manual-platform-acceptance.md` contains the M1–M10 real Toast/cold-start/
wrong-account/rejection checklist and required evidence. The canonical IDs live
in `manual-scenarios.json`.

Tools:

- `windows-toast-driver.ps1 -Mode Probe|Click` — UI Automation driver that only
  accepts a button inside a verified notification host and invokes it; it never
  uses blind coordinates. A UIA invoke alone is `PARTIAL`, not PASS.
- `toast-e2e.mjs` — creates a QA task/reminder, invokes the driver and verifies
  the task detail actually opened. Only then may a scenario be PASS.
- `credential-restart-e2e.mjs` — QA keyring write, real process restart, read and
  remove; uses the QA credential service only.
- `finalize-native-qa-evidence.mjs` / `verify-native-qa-evidence.mjs` — rebuild
  checksums/index and verify schema, hashes, run/HEAD binding and evidence.
- `check-manual-scenarios.mjs --artifact-root ...` — PASS requires nonempty
  observation plus a real, hashed evidence file under the artifact root.

IPC/harness success is never promoted to real Toast PASS.

## Current limits

- Windows production builds gate notification actions off until the Windows
  App SDK registration/activation path is verified; QA builds retain the
  experimental path.
- Real toast click routing and wrong-account notification rejection remain NOT_RUN; the UIA driver and task/reminder fixture exist, but a real Toast was not observed in this environment.
- A Windows toast action can be reported only while the process's action listener is alive; cold-start activation from Action Center is not claimed as PASS.
- macOS/Linux/Android/iOS builds are compile/unit-test evidence only unless a real device/runner result is recorded.
