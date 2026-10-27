param(
  [string]$OutDir = "",
  [string]$Dotnet = ""
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$project = Join-Path $here "AppNotificationPoc\AppNotificationPoc.csproj"
$dotnetPath = if ($Dotnet) { $Dotnet } else { (Get-Command dotnet -ErrorAction SilentlyContinue).Source }
if (-not $dotnetPath) { throw "dotnet SDK not found; set -Dotnet or PATH" }
$out = if ($OutDir) { $OutDir } else { Join-Path $here "matrix" }
New-Item -ItemType Directory -Force -Path $out | Out-Null
$variants = @(
  @{ name = "A-framework-auto"; self = "false"; noBootstrap = "true" },
  @{ name = "B-framework-explicit"; self = "false"; noBootstrap = "false" },
  @{ name = "C-selfcontained-explicit"; self = "true"; noBootstrap = "false" },
  @{ name = "D-selfcontained-auto"; self = "true"; noBootstrap = "true" }
)
$results = @()
foreach ($v in $variants) {
  $log = Join-Path $out ($v.name + ".build.log")
  & $dotnetPath build $project -c Release -p:Platform=x64 `
    "-p:WindowsAppSDKSelfContained=$($v.self)" "-p:PocNoBootstrap=$($v.noBootstrap)" `
    --nologo 2>&1 | Set-Content -LiteralPath $log -Encoding utf8
  $build = $LASTEXITCODE -eq 0
  $bin = Join-Path $here "AppNotificationPoc\bin\x64\Release\net8.0-windows10.0.19041.0\win-x64"
  $dll = Join-Path $bin "AppNotificationPoc.dll"
  $pocLog = Join-Path $bin "poc-log.txt"
  Remove-Item -LiteralPath $pocLog -ErrorAction SilentlyContinue
  $exitCode = $null
  if ($build -and (Test-Path $dll)) {
    & $dotnetPath $dll 1> (Join-Path $out ($v.name + ".run.out")) 2> (Join-Path $out ($v.name + ".run.err"))
    $exitCode = $LASTEXITCODE
  }
  $content = if (Test-Path $pocLog) { Get-Content -LiteralPath $pocLog -Raw } else { "NO_LOG" }
  if (Test-Path $pocLog) { Copy-Item $pocLog (Join-Path $out ($v.name + ".poc.log")) -Force }
  $results += [ordered]@{ name = $v.name; selfContained = $v.self; noBootstrap = $v.noBootstrap; build = $build; exitCode = $exitCode; log = $content }
}
$results | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $out "matrix.json") -Encoding utf8
$results | ConvertTo-Json -Depth 8
