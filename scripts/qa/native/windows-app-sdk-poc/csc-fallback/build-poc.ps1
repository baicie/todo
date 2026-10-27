param([string]$OutDir = "")
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$out = if ($OutDir) { $OutDir } else { Join-Path $here "build" }
New-Item -ItemType Directory -Force -Path $out | Out-Null
$runtime = Get-AppxPackage -Name "Microsoft.WindowsAppRuntime.1.8" |
  Where-Object Architecture -eq "X64" | Select-Object -First 1
if (-not $runtime) { Write-Output "POC_STATUS=BLOCKED_NO_RUNTIME"; exit 0 }
$p = $runtime.InstallLocation
$refs = @(
  (Join-Path $p "Microsoft.Windows.AppNotifications.winmd"),
  (Join-Path $p "Microsoft.Windows.AppNotifications.Builder.winmd"),
  (Join-Path $p "Microsoft.Windows.Foundation.winmd"),
  "C:\Program Files (x86)\Windows Kits\10\UnionMetadata\Facade\Windows.WinMD",
  "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Runtime.dll",
  "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Runtime.InteropServices.WindowsRuntime.dll"
)
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { Write-Output "POC_STATUS=BLOCKED_NO_CSC"; exit 0 }
$exe = Join-Path $out "AppNotificationPoc.exe"
$argsList = @("/nologo", "/target:exe", "/platform:x64", "/out:$exe")
foreach ($r in $refs) { $argsList += "/reference:$r" }
$argsList += (Join-Path $here "Program.cs")
& $csc @argsList 2>&1 | Out-String | Set-Content -LiteralPath (Join-Path $out "csc.log") -Encoding utf8
if (-not (Test-Path $exe)) { Write-Output "POC_STATUS=COMPILE_FAILED"; exit 1 }
$runOut = Join-Path $out "run.stdout.txt"
$runErr = Join-Path $out "run.stderr.txt"
cmd.exe /c "`"$exe`" 1> `"$runOut`" 2> `"$runErr`""
$exitCode = $LASTEXITCODE
Write-Output "POC_STATUS=COMPILED_RUN_EXIT_$exitCode"
Get-Content -LiteralPath $runOut -ErrorAction SilentlyContinue
