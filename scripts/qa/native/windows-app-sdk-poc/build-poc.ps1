param(
  [string]$Configuration = "Release",
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$project = Join-Path $here "AppNotificationPoc\AppNotificationPoc.csproj"
$result = [ordered]@{
  schemaVersion = 1
  checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  dotnet = $null
  project = $project
  appSdkVersion = "1.8.250907003"
  build = "NOT_RUN"
  run = "NOT_RUN"
  log = $null
  error = $null
}

$dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnetCommand) {
  $result.error = "dotnet SDK not on PATH; install .NET 8 SDK or use a GitHub Windows runner"
  if ($OutDir) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutDir "poc-build.json") -Encoding utf8
  }
  $result | ConvertTo-Json -Depth 4
  exit 0
}
$result.dotnet = $dotnetCommand.Source
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
$env:DOTNET_NOLOGO = "1"

try {
  & $dotnetCommand.Source restore $project --disable-parallel --nologo 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "dotnet restore failed" }
  $result.build = "PASS"
  & $dotnetCommand.Source build $project -c $Configuration -p:Platform=x64 --no-restore --nologo 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "dotnet build failed" }

  $bin = Join-Path $here "AppNotificationPoc\bin\x64\$Configuration\net8.0-windows10.0.19041.0\win-x64"
  $dll = Join-Path $bin "AppNotificationPoc.dll"
  if (-not (Test-Path -LiteralPath $dll)) { throw "POC assembly not found: $dll" }
  $beforeLog = Join-Path $bin "poc-log.txt"
  Remove-Item -LiteralPath $beforeLog -ErrorAction SilentlyContinue
  & $dotnetCommand.Source $dll 2>&1 | Out-Host
  $result.run = if (Test-Path -LiteralPath $beforeLog) { Get-Content -LiteralPath $beforeLog -Raw } else { "NO_LOG" }
  if ($OutDir) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    if (Test-Path -LiteralPath $beforeLog) { Copy-Item -LiteralPath $beforeLog (Join-Path $OutDir "poc-log.txt") -Force }
    Copy-Item -LiteralPath (Join-Path $bin "AppNotificationPoc.exe.err.txt") (Join-Path $OutDir "poc-stderr.txt") -Force -ErrorAction SilentlyContinue
  }
} catch {
  $result.error = $_.Exception.Message
  $result.build = if ($result.build -eq "PASS") { "PASS" } else { "FAIL" }
}

if ($OutDir) {
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutDir "poc-build.json") -Encoding utf8
}
$result | ConvertTo-Json -Depth 5
