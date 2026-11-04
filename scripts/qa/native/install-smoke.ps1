param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [string]$OutFile = "artifacts/native-qa-install-smoke.json",
  [int]$InstallTimeoutSeconds = 300,
  [int]$LaunchSeconds = 20
)

# Non-interactive install / provenance / uninstall smoke for the QA NSIS.
#
# Scope: this runs on an EPHEMERAL hosted Windows runner. It proves the package
# installs to the QA install directory, that the installed EXE carries the QA
# ProductName/Version and the expected embedded commit, that Dev/Stable data
# roots are never created, and that a silent uninstall removes the install
# directory without touching them.
#
# It does NOT prove desktop behaviour: no human sees a toast, a banner or a
# click here, and this script never asserts them. Those stay NOT_RUN.
#
# Fail closed: if the runner is not clean (any Shishi install or any of the
# three data roots already exists), the result is BLOCKED rather than a PASS -
# a dirty runner cannot demonstrate isolation.

$ErrorActionPreference = 'Stop'

function Get-Sha256([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
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
  $qa = node (Join-Path $PSScriptRoot 'qa-identity.mjs')
  $identity = $qa | ConvertFrom-Json
  $productName = $identity.productName
  $productVersion = $identity.version
  $qaDataRoot = Join-Path $env:APPDATA $identity.identifier
  $stableRoot = Join-Path $env:APPDATA 'app.shishi.todo'
  $devRoot = Join-Path $env:APPDATA 'app.shishi.todo.dev'
  $installDir = Join-Path $env:LOCALAPPDATA $productName
  $result.installDir = $installDir

  if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw "installer not found: $Installer" }
  $result.installerSha256 = Get-Sha256 $Installer

  # ---- preconditions: the runner must be clean -----------------------------
  $existingInstalls = @(Get-ChildItem -LiteralPath $env:LOCALAPPDATA -Directory -Filter 'Shishi*' -ErrorAction SilentlyContinue)
  $result.dataRoots.before = [ordered]@{
    stable = (Test-Path -LiteralPath $stableRoot)
    dev = (Test-Path -LiteralPath $devRoot)
    qa = (Test-Path -LiteralPath $qaDataRoot)
    existingInstalls = @($existingInstalls | ForEach-Object { $_.Name })
  }
  $dirty = @()
  if ($result.dataRoots.before.stable) { $dirty += "stable data root exists: $stableRoot" }
  if ($result.dataRoots.before.dev) { $dirty += "dev data root exists: $devRoot" }
  if ($result.dataRoots.before.qa) { $dirty += "qa data root exists: $qaDataRoot" }
  if ($existingInstalls.Count -gt 0) { $dirty += "existing Shishi installs: $($existingInstalls.Name -join ', ')" }
  if (Test-Path -LiteralPath $installDir) { $dirty += "install dir exists: $installDir" }
  if ($dirty.Count -gt 0) {
    $result.status = 'BLOCKED'
    $result.error = 'runner is not clean: ' + ($dirty -join '; ')
    throw $result.error
  }
  $result.checks.cleanRunner = $true

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

if ($result.status -ne 'PASS') { exit 1 }
exit 0
