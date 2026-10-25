param(
  [string]$RunId = "",
  [string]$AppExe = "",
  [string]$Installer = "",
  [int]$CdpPort = 9345,
  [switch]$Build,
  [switch]$Install,
  [string]$FaultConfig = "",
  [int]$PerfTasks = 0,
  [string]$BenchSizes = "",
  [int]$BenchRuns = 3,
  [switch]$KeepRunning
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$Timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
if ([string]::IsNullOrWhiteSpace($RunId)) { $RunId = "rc2d-$Timestamp" }
if ($RunId -match '[^A-Za-z0-9._-]' -or $RunId.Contains('..')) { throw "RunId contains unsafe characters: $RunId" }

$ArtifactRoot = Join-Path $RepoRoot "artifacts\native-qa\$RunId"
$LogDir = Join-Path $ArtifactRoot "logs"
$ScreenshotDir = Join-Path $ArtifactRoot "screenshots"
New-Item -ItemType Directory -Force -Path $ArtifactRoot, $LogDir, $ScreenshotDir | Out-Null

function Write-Json([string]$Path, $Value) {
  $Value | ConvertTo-Json -Depth 12 | Set-Content -Path $Path -Encoding utf8
}

function Write-Log([string]$Path, [string]$Text) {
  $Text | Tee-Object -FilePath $Path -Append | Out-Host
}

function Get-Sha256([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return $null }
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$started = (Get-Date).ToUniversalTime()
$buildLog = Join-Path $LogDir "build.log"
$appOut = Join-Path $LogDir "app.stdout.log"
$appErr = Join-Path $LogDir "app.stderr.log"
$faultEvidence = Join-Path $ArtifactRoot "fault-evidence.jsonl"
$appPid = $null
$installerHash = $null

try {
  Push-Location (Join-Path $RepoRoot "apps\native")
  try {
    if ($Build) {
      $buildArgs = @(
        "dlx", "@tauri-apps/cli@2.12.4", "build",
        "--config", "src-tauri/tauri.qa.conf.json",
        "--features", "native-qa",
        "--bundles", "nsis"
      )
      Write-Log $buildLog "pnpm $($buildArgs -join ' ')"
      & pnpm @buildArgs 2>&1 | Tee-Object -FilePath $buildLog -Append | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "QA build failed with exit code $LASTEXITCODE" }
    }
  } finally {
    Pop-Location
  }

  if ([string]::IsNullOrWhiteSpace($Installer)) {
    $found = Get-ChildItem -LiteralPath (Join-Path $RepoRoot "apps\native\src-tauri\target\release\bundle\nsis") -Filter "*.exe" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($found) { $Installer = $found.FullName }
  }
  if ($Installer -and (Test-Path -LiteralPath $Installer)) {
    $installerProduct = (Get-Item -LiteralPath $Installer).VersionInfo.ProductName
    if ($installerProduct -ne "Shishi QA RC2D") {
      throw "refusing non-QA installer ProductName=$installerProduct"
    }
    $installerHash = Get-Sha256 $Installer
  }

  if ($Install) {
    if (-not $Installer) { throw "-Install requires an NSIS installer path" }
    $installLog = Join-Path $LogDir "install.log"
    Write-Log $installLog "installing $Installer"
    $installerProcess = Start-Process -FilePath $Installer -ArgumentList "/S" -PassThru -Wait
    Write-Log $installLog "installer exit code: $($installerProcess.ExitCode)"
    if ($installerProcess.ExitCode -ne 0) { throw "QA installer failed: $($installerProcess.ExitCode)" }
  }

  if ([string]::IsNullOrWhiteSpace($AppExe)) {
    $candidates = @(
      (Join-Path $RepoRoot "apps\native\src-tauri\target\release\Shishi QA RC2D.exe"),
      (Join-Path $env:LOCALAPPDATA "Shishi QA RC2D\Shishi QA RC2D.exe"),
      (Join-Path $env:LOCALAPPDATA "Programs\Shishi QA RC2D\Shishi QA RC2D.exe")
    )
    $AppExe = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  }
  if (-not $AppExe -or -not (Test-Path -LiteralPath $AppExe)) {
    throw "QA executable not found. Build with -Build or pass -AppExe."
  }

  $appProduct = (Get-Item -LiteralPath $AppExe).VersionInfo.ProductName
  if ($appProduct -ne "Shishi QA RC2D") {
    throw "refusing non-QA app ProductName=$appProduct; QA harness never runs against production"
  }
  $qaDataRoot = Join-Path $env:APPDATA "app.shishi.todo.qa"
  $productionDataRoot = Join-Path $env:APPDATA "app.shishi.todo"
  $environment = [ordered]@{
    runId = $RunId
    capturedAt = (Get-Date).ToUniversalTime().ToString("o")
    os = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture)
    cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1 Name, NumberOfCores, NumberOfLogicalProcessors)
    memoryBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
    rust = (& rustc --version 2>&1 | Out-String).Trim()
    cargo = (& cargo --version 2>&1 | Out-String).Trim()
    node = (& node --version 2>&1 | Out-String).Trim()
    pnpm = (& pnpm --version 2>&1 | Out-String).Trim()
    tauriCli = (& pnpm dlx @tauri-apps/cli@2.12.4 --version 2>&1 | Select-Object -Last 1 | Out-String).Trim()
    webview2 = (Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue).pv
    qaIdentifier = "app.shishi.todo.qa"
    qaDataRoot = $qaDataRoot
    productionDataRoot = $productionDataRoot
    productionDataRootPresent = (Test-Path -LiteralPath $productionDataRoot)
    qaDataRootPresentBefore = (Test-Path -LiteralPath $qaDataRoot)
    appExe = $AppExe
    appExeSha256 = Get-Sha256 $AppExe
    installer = $Installer
    installerSha256 = $installerHash
    cdpPort = $CdpPort
    faultConfig = $FaultConfig
    build = [bool]$Build
    install = [bool]$Install
  }
  Write-Json (Join-Path $ArtifactRoot "environment.json") $environment
  Write-Log (Join-Path $LogDir "launcher.log") "environment captured"

  $env:QA_GIT_COMMIT = if ($env:QA_GIT_COMMIT) { $env:QA_GIT_COMMIT } else { "unknown" }
  $env:QA_GIT_BRANCH = if ($env:QA_GIT_BRANCH) { $env:QA_GIT_BRANCH } else { "unknown" }

  $env:QA_CDP_PORT = "$CdpPort"
  $env:QA_ARTIFACT_ROOT = $ArtifactRoot
  $env:QA_RUN_ID = $RunId
  $env:QA_APP_EXE = $AppExe
  $env:QA_APP_SHA256 = Get-Sha256 $AppExe
  $env:QA_INSTALLER = if ($Installer) { $Installer } else { "" }
  $env:QA_INSTALLER_SHA256 = if ($installerHash) { $installerHash } else { "" }
  $env:QA_FAULT_EVIDENCE = $faultEvidence
  $env:QA_FAULT_CONFIG = $FaultConfig
  $env:QA_PERF_TASKS = "$PerfTasks"
  $env:QA_BENCH_SIZES = $BenchSizes
  $env:QA_BENCH_RUNS = "$BenchRuns"
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"

  $arguments = @()
  if ($FaultConfig) {
    if (-not (Test-Path -LiteralPath $FaultConfig)) { throw "Fault config not found: $FaultConfig" }
    $sourceConfig = Get-Content -LiteralPath $FaultConfig -Raw | ConvertFrom-Json
    $sourceConfig.evidencePath = $faultEvidence
    $runConfigPath = Join-Path $ArtifactRoot "qa-fault-config.json"
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($runConfigPath, ($sourceConfig | ConvertTo-Json -Depth 10), $utf8)
    $FaultConfig = $runConfigPath
    Remove-Item -LiteralPath $faultEvidence -Force -ErrorAction SilentlyContinue
    $arguments = @("--rc2d-fault-config", "`"$runConfigPath`"")
    $env:QA_FAULT_CONFIG = $runConfigPath
  }
  $appExeAbsolute = (Resolve-Path -LiteralPath $AppExe).Path
  $AppExe = $appExeAbsolute
  Write-Log (Join-Path $LogDir "launcher.log") "launching $appExeAbsolute"
  $startArgs = @{
    FilePath = $appExeAbsolute
    WorkingDirectory = $RepoRoot
    PassThru = $true
    RedirectStandardOutput = $appOut
    RedirectStandardError = $appErr
  }
  if ($arguments.Count -gt 0) { $startArgs.ArgumentList = $arguments }
  $process = Start-Process @startArgs
  $appPid = $process.Id
  Write-Log (Join-Path $LogDir "launcher.log") "started QA app pid=$appPid exe=$AppExe"

  $harnessLog = Join-Path $LogDir "harness.log"
  if ([string]::IsNullOrWhiteSpace($BenchSizes)) {
    & node (Join-Path $PSScriptRoot "harness.mjs") 2>&1 | Tee-Object -FilePath $harnessLog | Out-Host
  } else {
    & node (Join-Path $PSScriptRoot "bench.mjs") 2>&1 | Tee-Object -FilePath $harnessLog | Out-Host
  }
  $harnessExit = $LASTEXITCODE
  if ($harnessExit -ne 0) { throw "QA harness failed with exit code $harnessExit" }

  $finished = (Get-Date).ToUniversalTime()
  $testsPath = Join-Path $ArtifactRoot "tests.json"
  $testStatus = "PASS"
  if (Test-Path -LiteralPath $testsPath) {
    $testStatus = (Get-Content -LiteralPath $testsPath -Raw | ConvertFrom-Json).status
  }
  $manifest = [ordered]@{
    runId = $RunId
    startedAt = $started.ToString("o")
    finishedAt = $finished.ToString("o")
    appExe = $AppExe
    appExeSha256 = Get-Sha256 $AppExe
    installer = $Installer
    installerSha256 = $installerHash
    faultConfig = $FaultConfig
    faultEvidencePresent = (Test-Path -LiteralPath $faultEvidence)
    gitCommit = if ($env:QA_GIT_COMMIT) { $env:QA_GIT_COMMIT } else { "unknown" }
    gitBranch = if ($env:QA_GIT_BRANCH) { $env:QA_GIT_BRANCH } else { "unknown" }
    qaDataRoot = $qaDataRoot
    productionDataRootPresentAfter = (Test-Path -LiteralPath $productionDataRoot)
    status = $testStatus
    files = @(
      "environment.json", "provenance.json", "manifest.json", "tests.json",
      "timeline.json", "performance.json", "summary.md",
      "logs/build.log", "logs/app.stdout.log", "logs/app.stderr.log", "logs/harness.log"
    )
  }
  Write-Json (Join-Path $ArtifactRoot "manifest.json") $manifest
  Write-Log (Join-Path $LogDir "launcher.log") "QA harness completed: $ArtifactRoot"
} catch {
  $failure = [ordered]@{
    runId = $RunId
    startedAt = $started.ToString("o")
    finishedAt = (Get-Date).ToUniversalTime().ToString("o")
    status = "FAIL"
    error = $_.Exception.Message
    appExe = $AppExe
    installer = $Installer
  }
  Write-Json (Join-Path $ArtifactRoot "manifest.json") $failure
  Write-Log (Join-Path $LogDir "launcher.log") "QA run failed: $($_.Exception.Message)"
  throw
} finally {
  if ($appPid -and -not $KeepRunning) {
    Get-Process -Id $appPid -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
}
