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
  [switch]$AllowPartial,
  [switch]$DiscoverOnly,
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
  $hash = Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop
  if ($null -eq $hash) { throw "SHA-256 failed for $Path" }
  $hash.Hash.ToLowerInvariant()
}

function Get-GitCommitFallback {
  try {
    $headPath = Join-Path $RepoRoot ".git\HEAD"
    if (-not (Test-Path -LiteralPath $headPath)) { return "unknown" }
    $head = (Get-Content -LiteralPath $headPath -Raw).Trim()
    if ($head -match '^ref:\s*(.+)$') {
      $ref = $Matches[1]
      $refPath = Join-Path $RepoRoot (".git\" + $ref.Replace('/', '\'))
      if (Test-Path -LiteralPath $refPath) { return (Get-Content -LiteralPath $refPath -Raw).Trim() }
      $packed = Join-Path $RepoRoot ".git\packed-refs"
      if (Test-Path -LiteralPath $packed) {
        $line = Get-Content -LiteralPath $packed | Where-Object { $_ -match (" " + [regex]::Escape($ref) + "$") } | Select-Object -First 1
        if ($line) { return ($line -split ' ')[0] }
      }
      return "unknown"
    }
    return $head
  } catch { return "unknown" }
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
      # PowerShell 5.1 turns native stderr into NativeCommandError; with
      # ErrorActionPreference=Stop this aborts a successful Tauri build on
      # progress output. Keep stderr as data and judge only the exit code.
      $previousErrorAction = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      try {
        & pnpm @buildArgs 2>&1 | Tee-Object -FilePath $buildLog -Append | Out-Host
        $buildExit = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousErrorAction
      }
      if ($buildExit -ne 0) { throw "QA build failed with exit code $buildExit" }
    }
  } finally {
    Pop-Location
  }

  # Auto-discovery only makes sense when an install is actually requested: the
  # bundle directory also holds Dev and Stable installers, and picking the
  # newest one would refuse a run that never needed an installer at all (for
  # example -DiscoverOnly). An explicitly passed -Installer is still validated
  # below, so a caller cannot slip a non-QA package past the gate.
  if ([string]::IsNullOrWhiteSpace($Installer) -and $Install) {
    $found = Get-ChildItem -LiteralPath (Join-Path $RepoRoot "apps\native\src-tauri\target\release\bundle\nsis") -Filter "*.exe" -ErrorAction SilentlyContinue |
      Where-Object { $_.VersionInfo.ProductName -eq "Shishi QA RC2D" } |
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
    # Cargo package name is todo-native, so both the release build and the
    # NSIS-installed app use todo-native.exe (ProductName remains Shishi QA
    # RC2D). Prefer the installed path when -Install was requested.
    $releaseExe = Join-Path $RepoRoot "apps\native\src-tauri\target\release\todo-native.exe"
    $installedExes = @(
      (Join-Path $env:LOCALAPPDATA "Shishi QA RC2D\todo-native.exe"),
      (Join-Path $env:LOCALAPPDATA "Programs\Shishi QA RC2D\todo-native.exe")
    )
    $candidates = if ($Install) {
      $installedExes + $releaseExe
    } else {
      @($releaseExe) + $installedExes
    }
    $AppExe = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  }
  if (-not $AppExe -or -not (Test-Path -LiteralPath $AppExe)) {
    throw "QA executable not found. Build with -Build or pass -AppExe."
  }

  $appProduct = (Get-Item -LiteralPath $AppExe).VersionInfo.ProductName
  if ($appProduct -ne "Shishi QA RC2D") {
    throw "refusing non-QA app ProductName=$appProduct; QA harness never runs against production"
  }
  if ($DiscoverOnly) {
    Write-Output "Discovered QA exe: $((Resolve-Path -LiteralPath $AppExe).Path)"
    Write-Output "ProductName: $appProduct"
    Write-Output "Next: native qa_build_identity must report identifier app.shishi.todo.qa"
    exit 0
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

  if (-not $env:QA_GIT_COMMIT) { $env:QA_GIT_COMMIT = Get-GitCommitFallback }
  $env:QA_GIT_BRANCH = if ($env:QA_GIT_BRANCH) { $env:QA_GIT_BRANCH } else { "unknown" }

  $env:QA_CDP_PORT = "$CdpPort"
  $env:QA_ARTIFACT_ROOT = $ArtifactRoot
  $env:QA_RUN_ID = $RunId
  $env:QA_APP_EXE = $AppExe
  $env:QA_APP_SHA256 = Get-Sha256 $AppExe
  $env:QA_INSTALLER = if ($Installer) { $Installer } else { "" }
  $env:QA_INSTALLER_SHA256 = if ($installerHash) { $installerHash } else { "" }
  $faultEvidenceSource = Join-Path $qaDataRoot ("evidence\fault-" + $RunId + ".jsonl")
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $faultEvidenceSource) | Out-Null
  Remove-Item -LiteralPath $faultEvidenceSource -Force -ErrorAction SilentlyContinue
  $env:QA_FAULT_EVIDENCE = $faultEvidenceSource
  $env:QA_FAULT_CONFIG = $FaultConfig
  $env:QA_PERF_TASKS = "$PerfTasks"
  $env:QA_BENCH_SIZES = $BenchSizes
  $env:QA_BENCH_RUNS = "$BenchRuns"
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"

  $arguments = @()
  if ($FaultConfig) {
    if (-not (Test-Path -LiteralPath $FaultConfig)) { throw "Fault config not found: $FaultConfig" }
    $sourceConfig = Get-Content -LiteralPath $FaultConfig -Raw | ConvertFrom-Json
    $sourceConfig.evidencePath = $faultEvidenceSource
    $runConfigPath = Join-Path $ArtifactRoot "qa-fault-config.json"
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($runConfigPath, ($sourceConfig | ConvertTo-Json -Depth 10), $utf8)
    $FaultConfig = $runConfigPath
    Remove-Item -LiteralPath $faultEvidenceSource -Force -ErrorAction SilentlyContinue
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
  if ((Test-Path -LiteralPath $faultEvidenceSource) -and -not (Test-Path -LiteralPath $faultEvidence)) {
    Copy-Item -LiteralPath $faultEvidenceSource -Destination $faultEvidence -Force
  }
  if ($harnessExit -ne 0) { throw "QA harness failed with exit code $harnessExit" }

  # Release redirected app log handles before hashing the artifact directory.
  if ($appPid -and -not $KeepRunning) {
    Get-Process -Id $appPid -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    $appPid = $null
  }

  $finished = (Get-Date).ToUniversalTime()
  $testsPath = Join-Path $ArtifactRoot "tests.json"
  $testStatus = "UNKNOWN"
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
      "timeline.json", "performance.json", "summary.md", "manual-platform.json",
      "logs/build.log", "logs/app.stdout.log", "logs/app.stderr.log", "logs/harness.log"
    )
  }
  $manualScenariosPath = Join-Path $PSScriptRoot "manual-scenarios.json"
  if (-not (Test-Path -LiteralPath $manualScenariosPath)) {
    throw "manual scenario inventory missing: $manualScenariosPath"
  }
  $manualScenarios = [System.IO.File]::ReadAllText(
    $manualScenariosPath,
    [System.Text.Encoding]::UTF8
  ) | ConvertFrom-Json
  $manual = [ordered]@{
    schemaVersion = 2
    runId = $RunId
    gitCommit = $manifest.gitCommit
    appExe = $AppExe
    appExeSha256 = $manifest.appExeSha256
    installer = $Installer
    installerSha256 = $installerHash
    environment = "see environment.json"
    note = "Fill observed results only after real desktop interaction; never mark a scenario PASS without evidence."
    scenarios = @($manualScenarios | ForEach-Object {
      [ordered]@{
        id = $_.id
        status = "NOT_RUN"
        expected = $_.expected
        observed = $null
        evidence = @()
        reason = $null
        runId = $RunId
        headSha = $manifest.gitCommit
        appExeSha256 = $manifest.appExeSha256
        installerSha256 = $installerHash
        startedAt = $started.ToString("o")
        finishedAt = $finished.ToString("o")
      }
    })
  }
  $manualEvidencePath = Join-Path $ArtifactRoot "manual-platform.json"
  # The validator needs the finalized manifest for run/HEAD/binary binding.
  Write-Json (Join-Path $ArtifactRoot "manifest.json") $manifest
  Write-Json $manualEvidencePath $manual
  & node (Join-Path $PSScriptRoot "check-manual-scenarios.mjs") `
    --artifact-root $ArtifactRoot --expected-head $manifest.gitCommit
  if ($LASTEXITCODE -ne 0) {
    throw "manual platform evidence does not match the canonical scenario inventory"
  }
  $platformResults = [ordered]@{
    schemaVersion = 1
    runId = $RunId
    headSha = $manifest.gitCommit
    appExeSha256 = $manifest.appExeSha256
    installerSha256 = $installerHash
    windowsPlatformReady = $false
    otherDesktopPlatformReady = $false
    mobilePlatformReady = $false
    platformReleaseReady = $false
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    scenarios = @($manual.scenarios | ForEach-Object {
      [ordered]@{ id = $_.id; status = $_.status }
    })
  }
  Write-Json (Join-Path $ArtifactRoot "platform-results.json") $platformResults
  & node (Join-Path $PSScriptRoot "finalize-native-qa-evidence.mjs") --artifact-root $ArtifactRoot
  if ($LASTEXITCODE -ne 0) { throw "native QA evidence finalization failed" }

  Write-Log (Join-Path $LogDir "launcher.log") "QA harness completed: $ArtifactRoot status=$testStatus"

  $sumLines = New-Object System.Collections.Generic.List[string]
  $sumFiles = Get-ChildItem -LiteralPath $ArtifactRoot -Recurse -File |
    Where-Object { $_.Name -notin @("sha256sums.txt", "manifest.json") } |
    Sort-Object FullName
  foreach ($file in $sumFiles) {
    $rel = $file.FullName.Substring($ArtifactRoot.Length + 1).Replace([string][char]92, '/')
    $hash = Get-Sha256 $file.FullName
    $sumLines.Add("$hash  $rel")
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines(
    (Join-Path $ArtifactRoot "sha256sums.txt"),
    $sumLines,
    $utf8NoBom
  )
  $manifest.files = @($manifest.files) + @(
    "platform-results.json", "evidence-index.json", "sha256sums.txt"
  )
  Write-Json (Join-Path $ArtifactRoot "manifest.json") $manifest
  if ($testStatus -notin @("PASS", "BENCH_ONLY") -and -not $AllowPartial) {
    Write-Log (Join-Path $LogDir "launcher.log") "PARTIAL/NOT_RUN evidence is not a successful gate; pass -AllowPartial only for investigative runs"
    exit 2
  }
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
