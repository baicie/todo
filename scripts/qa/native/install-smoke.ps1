param(
  [string]$Installer = "",
  [string]$ExpectedCommit = "",
  [string]$CiAuthorization = "",
  [string]$OutFile = "artifacts/native-qa-install-smoke.json",
  [int]$InstallTimeoutSeconds = 300,
  [int]$LaunchSeconds = 20,
  # Runs every precondition (including the clean-runner check) and stops before
  # the installer. Used by the refusal tests so they can exercise a valid CI
  # context without installing anything.
  [switch]$PreflightOnly
)

# Non-interactive install / provenance / uninstall smoke for the QA NSIS.
#
# Scope: this runs on an EPHEMERAL hosted Windows runner. It proves the package
# installs to the QA install directory, that the installed EXE carries the QA
# ProductName/Version and the expected embedded commit, that Dev/Stable data
# roots are never created, and that a silent uninstall removes the install
# directory without touching them.
#
# It DOES install and uninstall software, so it must never run by accident on a
# developer's machine. Access is therefore denied by default and requires ALL of
# the following, checked before anything else happens:
#   - the exact authorization marker that native-qa.yml passes explicitly
#     (a present RUNNER_TEMP is NOT sufficient, and neither is any single env var);
#   - Windows;
#   - GITHUB_ACTIONS=true;
#   - RUNNER_ENVIRONMENT=github-hosted (a self-hosted runner is refused);
#   - the workflow ref names .github/workflows/native-qa.yml;
#   - a non-empty, existing RUNNER_TEMP.
# A missing, empty or wrong marker is BLOCKED and the installer is never started.
#
# It does NOT prove desktop behaviour: no human sees a toast, a banner or a
# click here, and this script never asserts them. Those stay NOT_RUN.
#
# Fail closed: if the runner is not clean (any Shishi install or any of the
# three data roots already exists), the result is BLOCKED rather than a PASS -
# a dirty runner cannot demonstrate isolation.

$ErrorActionPreference = 'Stop'

# The workflow passes this exact string. Kept here (not read from the
# environment) so a stray GITHUB_ACTIONS=true on a laptop cannot authorize a
# destructive run on its own.
$RequiredAuthorization = 'github-actions:native-qa:install-smoke'

function Get-Sha256([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  # .NET directly instead of Get-FileHash: that cmdlet lives in a module, and
  # under a host with an inherited PowerShell 7 PSModulePath the autoload can
  # fail with "Get-FileHash is not recognized" (observed on the Windows runner
  # when this script was invoked from Windows PowerShell 5.1 by the tests).
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $bytes = $sha.ComputeHash($stream)
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
  ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Get-EmbeddedCommit([string]$Path) {
  # Same byte-scan as run-windows.ps1: Latin-1 maps one byte to one character,
  # so the marker cannot be missed because of an encoding guess.
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $text = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
  $match = [regex]::Match($text, 'QA_BUILD_COMMIT:([0-9a-f]{40})')
  if ($match.Success) { return $match.Groups[1].Value }
  return $null
}

function Wait-Until([scriptblock]$Condition, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return [bool](& $Condition)
}

$result = [ordered]@{
  schemaVersion = 1
  status = 'FAIL'
  installer = $Installer
  installerSha256 = $null
  expectedCommit = $ExpectedCommit
  installDir = $null
  installedExe = $null
  installedExeSha256 = $null
  productName = $null
  productVersion = $null
  embeddedCommit = $null
  embeddedCommitSource = 'missing'
  installExitCode = $null
  uninstallExitCode = $null
  launch = 'NOT_RUN'
  launchDetail = $null
  checks = [ordered]@{}
  dataRoots = [ordered]@{}
  runner = [ordered]@{
    name = $env:RUNNER_NAME
    os = $env:RUNNER_OS
    temp = $env:RUNNER_TEMP
  }
  error = $null
}

try {
  # ---- execution authorization: deny by default ----------------------------
  # Everything in this block runs before the installer path is even hashed, let
  # alone started. Each failure sets BLOCKED (not FAIL) and names the reason.
  $result.checks.ciContext = $false
  if ([string]::IsNullOrWhiteSpace($CiAuthorization)) {
    $result.status = 'BLOCKED'
    throw "install-smoke requires the native-qa CI authorization marker; refusing to install on an unverified host"
  }
  if ($CiAuthorization -cne $RequiredAuthorization) {
    $result.status = 'BLOCKED'
    throw "install-smoke authorization marker is not the one native-qa.yml passes; refusing to install"
  }
  $result.checks.ciAuthorization = $true

  if ([System.Environment]::OSVersion.Platform.ToString() -ne 'Win32NT') {
    $result.status = 'BLOCKED'
    throw 'install-smoke only runs on Windows'
  }
  $result.checks.windowsPlatform = $true

  if ($env:GITHUB_ACTIONS -ne 'true') {
    $result.status = 'BLOCKED'
    throw 'install-smoke only runs under GitHub Actions (GITHUB_ACTIONS=true); a local host is refused'
  }
  $result.checks.githubActions = $true

  if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    $result.status = 'BLOCKED'
    throw "install-smoke requires a GitHub-hosted ephemeral runner (RUNNER_ENVIRONMENT=github-hosted); got '$($env:RUNNER_ENVIRONMENT)'"
  }
  $result.checks.githubHostedRunner = $true

  if ([string]::IsNullOrWhiteSpace($env:GITHUB_WORKFLOW_REF) -or $env:GITHUB_WORKFLOW_REF -notmatch '/\.github/workflows/native-qa\.yml@') {
    $result.status = 'BLOCKED'
    throw "install-smoke must be invoked by .github/workflows/native-qa.yml; got '$($env:GITHUB_WORKFLOW_REF)'"
  }
  $result.checks.nativeQaWorkflow = $true

  if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
    $result.status = 'BLOCKED'
    throw 'install-smoke requires an existing RUNNER_TEMP directory'
  }
  $result.checks.runnerTemp = $true
  $result.checks.ciContext = $true

  $qa = node (Join-Path $PSScriptRoot 'qa-identity.mjs')
  $identity = $qa | ConvertFrom-Json
  $productName = $identity.productName
  $productVersion = $identity.version
  $qaDataRoot = Join-Path $env:APPDATA $identity.identifier
  $stableRoot = Join-Path $env:APPDATA 'app.shishi.todo'
  $devRoot = Join-Path $env:APPDATA 'app.shishi.todo.dev'
  $installDir = Join-Path $env:LOCALAPPDATA $productName
  $result.installDir = $installDir

  if ([string]::IsNullOrWhiteSpace($Installer) -or -not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw "installer not found: $Installer" }
  $result.installerSha256 = Get-Sha256 $Installer
  if ([string]::IsNullOrWhiteSpace($ExpectedCommit) -or $ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') {
    throw "ExpectedCommit must be a 40-hex commit, got '$ExpectedCommit'"
  }

  # ---- preconditions: the runner must be clean -----------------------------
  # Check every location a Shishi install can occupy, not just the QA one:
  # per-user NSIS writes %LOCALAPPDATA%\<product> or %LOCALAPPDATA%\Programs\<product>,
  # and an uninstall entry proves an install even if its files were moved.
  $localRoots = @(
    (Join-Path $env:LOCALAPPDATA 'Shishi*'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Shishi*')
  )
  $existingInstalls = @(
    foreach ($pattern in $localRoots) {
      Get-ChildItem -Path $pattern -Directory -ErrorAction SilentlyContinue
    }
  )
  $uninstallKeys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $uninstallEntries = @(
    foreach ($key in $uninstallKeys) {
      Get-ItemProperty -Path $key -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like 'Shishi*' } |
        ForEach-Object { "$($_.DisplayName) $($_.DisplayVersion)" }
    }
  )
  $result.dataRoots.before = [ordered]@{
    stable = (Test-Path -LiteralPath $stableRoot)
    dev = (Test-Path -LiteralPath $devRoot)
    qa = (Test-Path -LiteralPath $qaDataRoot)
    existingInstalls = @($existingInstalls | ForEach-Object { $_.FullName })
    uninstallEntries = @($uninstallEntries)
    installDir = (Test-Path -LiteralPath $installDir)
  }
  $dirty = @()
  if ($result.dataRoots.before.stable) { $dirty += "stable data root exists: $stableRoot" }
  if ($result.dataRoots.before.dev) { $dirty += "dev data root exists: $devRoot" }
  if ($result.dataRoots.before.qa) { $dirty += "qa data root exists: $qaDataRoot" }
  if ($existingInstalls.Count -gt 0) { $dirty += "existing Shishi installs: $(@($existingInstalls | ForEach-Object { $_.FullName }) -join ', ')" }
  if ($uninstallEntries.Count -gt 0) { $dirty += "existing Shishi uninstall entries: $($uninstallEntries -join ', ')" }
  if ($result.dataRoots.before.installDir) { $dirty += "install dir exists: $installDir" }
  if ($dirty.Count -gt 0) {
    $result.status = 'BLOCKED'
    $result.error = 'runner is not clean: ' + ($dirty -join '; ')
    throw $result.error
  }
  $result.checks.cleanRunner = $true

  if ($PreflightOnly) {
    # Every precondition passed, nothing was installed. Used by the refusal
    # tests to exercise the authorized context without touching the host.
    $result.status = 'PREFLIGHT_ONLY'
    $result.checks.preflightOnly = $true
    return
  }

  # ---- install -------------------------------------------------------------
  $installerProcess = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru
  if (-not $installerProcess.WaitForExit($InstallTimeoutSeconds * 1000)) {
    try { $installerProcess.Kill() } catch {}
    throw "installer did not finish within $InstallTimeoutSeconds s"
  }
  $result.installExitCode = $installerProcess.ExitCode
  if ($installerProcess.ExitCode -ne 0) { throw "installer exited $($installerProcess.ExitCode)" }
  $result.checks.installExitZero = $true

  $installedExe = Join-Path $installDir 'todo-native.exe'
  $result.installedExe = $installedExe
  if (-not (Wait-Until { Test-Path -LiteralPath $installedExe -PathType Leaf } 60)) {
    throw "installed executable did not appear: $installedExe"
  }
  $result.checks.installedToQaDirectory = $true

  # ---- identity and provenance --------------------------------------------
  $info = (Get-Item -LiteralPath $installedExe).VersionInfo
  $result.productName = $info.ProductName
  $result.productVersion = $info.ProductVersion
  if ($info.ProductName -ne $productName) { throw "ProductName $($info.ProductName) != $productName" }
  $result.checks.productNameMatches = $true
  if ($info.ProductVersion -ne $productVersion) { throw "ProductVersion $($info.ProductVersion) != $productVersion" }
  $result.checks.productVersionMatches = $true

  $result.installedExeSha256 = Get-Sha256 $installedExe
  $embedded = Get-EmbeddedCommit $installedExe
  if ($embedded) {
    $result.embeddedCommit = $embedded
    $result.embeddedCommitSource = 'embedded'
  }
  if ($embedded -ne $ExpectedCommit.ToLowerInvariant()) {
    throw "embedded commit $embedded != expected $ExpectedCommit"
  }
  $result.checks.embeddedCommitMatches = $true

  # ---- Dev/Stable data roots must still not exist --------------------------
  $result.dataRoots.afterInstall = [ordered]@{
    stable = (Test-Path -LiteralPath $stableRoot)
    dev = (Test-Path -LiteralPath $devRoot)
    qa = (Test-Path -LiteralPath $qaDataRoot)
  }
  if ($result.dataRoots.afterInstall.stable) { throw 'stable data root was created by the QA install' }
  if ($result.dataRoots.afterInstall.dev) { throw 'dev data root was created by the QA install' }
  $result.checks.stableAndDevUntouched = $true

  # ---- launch smoke (best effort, never a desktop assertion) ---------------
  # A hosted runner has no interactive desktop. Starting the process is the
  # most this can do; if it cannot stay up, that is recorded as NOT_RUN with
  # the reason instead of being reported as a desktop pass.
  try {
    $appOut = Join-Path $env:RUNNER_TEMP 'qa-app.stdout.log'
    $appErr = Join-Path $env:RUNNER_TEMP 'qa-app.stderr.log'
    $app = Start-Process -FilePath $installedExe -PassThru -RedirectStandardOutput $appOut -RedirectStandardError $appErr
    Start-Sleep -Seconds $LaunchSeconds
    if ($app.HasExited) {
      $result.launch = 'NOT_RUN'
      $result.launchDetail = "process exited after $LaunchSeconds s with code $($app.ExitCode); a hosted runner has no interactive desktop"
    } else {
      $result.launch = 'STARTED'
      $result.launchDetail = "process alive after $LaunchSeconds s; desktop behaviour not observed"
      try { $app.Kill() } catch {}
    }
  } catch {
    $result.launch = 'NOT_RUN'
    $result.launchDetail = "could not start: $($_.Exception.Message)"
  }

  # ---- uninstall -----------------------------------------------------------
  $uninstaller = Join-Path $installDir 'uninstall.exe'
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw "uninstaller missing: $uninstaller" }
  $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru
  if (-not $uninstallProcess.WaitForExit($InstallTimeoutSeconds * 1000)) {
    try { $uninstallProcess.Kill() } catch {}
    throw "uninstaller did not finish within $InstallTimeoutSeconds s"
  }
  $result.uninstallExitCode = $uninstallProcess.ExitCode
  if ($uninstallProcess.ExitCode -ne 0) { throw "uninstaller exited $($uninstallProcess.ExitCode)" }
  if (-not (Wait-Until { -not (Test-Path -LiteralPath $installDir) } 60)) {
    throw "install directory still present after uninstall: $installDir"
  }
  $result.checks.uninstallRemovedInstallDir = $true

  # Uninstall must not remove another channel's data. The QA data root may
  # remain (that is correct: uninstall keeps user data), so it is recorded,
  # not asserted either way.
  $result.dataRoots.afterUninstall = [ordered]@{
    stable = (Test-Path -LiteralPath $stableRoot)
    dev = (Test-Path -LiteralPath $devRoot)
    qa = (Test-Path -LiteralPath $qaDataRoot)
  }
  if ($result.dataRoots.afterUninstall.stable) { throw 'stable data root exists after QA uninstall' }
  if ($result.dataRoots.afterUninstall.dev) { throw 'dev data root exists after QA uninstall' }
  $result.checks.stableAndDevStillUntouched = $true

  $result.status = 'PASS'
} catch {
  if ($result.status -ne 'BLOCKED') { $result.status = 'FAIL' }
  if (-not $result.error) { $result.error = $_.Exception.Message }
} finally {
  $dir = Split-Path -Parent $OutFile
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $result | ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath $OutFile -Encoding utf8
  Get-Content -LiteralPath $OutFile -Raw | Write-Output
}

if ($result.status -notin @('PASS', 'PREFLIGHT_ONLY')) { exit 1 }
exit 0
