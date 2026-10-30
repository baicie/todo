$ErrorActionPreference = "Stop"
if (-not [System.Environment]::UserInteractive) {
  Write-Output "UIA fixture tests: NOT_RUN (non-interactive Windows session)"
  exit 0
}
$here = $PSScriptRoot
$driver = Join-Path $here "windows-toast-driver.ps1"
$fixture = Join-Path $here "uia-fixture.ps1"
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("shishi-uia-fixture-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $root | Out-Null
$failures = New-Object System.Collections.Generic.List[string]

function Invoke-Case {
  param(
    [string]$Name,
    [string]$Mode,
    [string]$FixtureMarker,
    [string]$DriverMarker,
    [string]$ExpectedStatus,
    [bool]$ExpectClick,
    [bool]$ExpectScreenshot
  )
  $caseDir = Join-Path $root $Name
  New-Item -ItemType Directory -Force -Path $caseDir | Out-Null
  $click = Join-Path $caseDir "clicked.txt"
  $out = Join-Path $caseDir "driver.json"
  $fixtureProcess = Start-Process powershell.exe -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $fixture,
    "-Mode", $Mode, "-Marker", $FixtureMarker, "-ClickFile", $click,
    "-LifetimeSeconds", "20"
  ) -PassThru
  try {
    Start-Sleep -Milliseconds 1500
    & powershell.exe -NoProfile -File $driver -Mode Click -RunMarker $DriverMarker `
      -TimeoutSeconds 8 -ArtifactRoot $caseDir -OutFile $out | Out-Null
    $result = Get-Content -LiteralPath $out -Raw | ConvertFrom-Json
    $actualStatus = "$($result.status)"
    if ($actualStatus -ne $ExpectedStatus) {
      $failures.Add("$Name status expected $ExpectedStatus got $actualStatus ($($result.error))")
    }
    if ((Test-Path -LiteralPath $click) -ne $ExpectClick) {
      $failures.Add("$Name click expectation failed")
    }
    if ($ExpectScreenshot) {
      $shot = Join-Path $caseDir "screenshots\toast-driver.png"
      if (-not (Test-Path -LiteralPath $shot)) {
        $failures.Add("$Name missing screenshot")
      } else {
        Add-Type -AssemblyName System.Drawing
        $image = [System.Drawing.Image]::FromFile($shot)
        try {
          if ($image.Width -gt 1000 -or $image.Height -gt 900) {
            $failures.Add("$Name screenshot too large: $($image.Width)x$($image.Height)")
          }
        } finally {
          $image.Dispose()
        }
      }
    }
    Write-Output "CASE $Name status=$actualStatus clicked=$(Test-Path -LiteralPath $click)"
  } finally {
    Stop-Process -Id $fixtureProcess.Id -Force -ErrorAction SilentlyContinue
  }
}

try {
  Invoke-Case -Name "single-marker-card" -Mode "Single" -FixtureMarker "run-single" `
    -DriverMarker "run-single" -ExpectedStatus "PARTIAL" -ExpectClick $true -ExpectScreenshot $true
  Invoke-Case -Name "split-cards" -Mode "Split" -FixtureMarker "run-split" `
    -DriverMarker "run-split" -ExpectedStatus "NOT_RUN" -ExpectClick $false -ExpectScreenshot $false
  Invoke-Case -Name "duplicate-cards" -Mode "Duplicate" -FixtureMarker "run-duplicate" `
    -DriverMarker "run-duplicate" -ExpectedStatus "NOT_RUN" -ExpectClick $false -ExpectScreenshot $false
  Invoke-Case -Name "non-notification-host" -Mode "NonHost" -FixtureMarker "run-nonhost" `
    -DriverMarker "run-nonhost" -ExpectedStatus "NOT_RUN" -ExpectClick $false -ExpectScreenshot $false
  Invoke-Case -Name "marker-mismatch" -Mode "Single" -FixtureMarker "run-correct" `
    -DriverMarker "run-other" -ExpectedStatus "NOT_RUN" -ExpectClick $false -ExpectScreenshot $false

  if ($failures.Count -gt 0) {
    Write-Error ("UIA fixture tests failed:`n" + ($failures -join "`n"))
    exit 1
  }
  Write-Output "UIA fixture tests: PASS (5 cases)"
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
