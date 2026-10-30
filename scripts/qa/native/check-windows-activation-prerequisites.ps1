param(
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"
$result = [ordered]@{
  schemaVersion = 1
  checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  windowsCaption = $null
  windowsBuild = $null
  dotnetAvailable = $false
  cscAvailable = $false
  msbuildAvailable = $false
  windowsAppRuntimePackages = @()
  appNotificationWinRT = $false
  toastWinRT = $false
  qaShortcut = $false
  qaAumidSettings = $false
  status = "BLOCKED"
  blockers = @()
}

try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
  if ($os) {
    $result.windowsCaption = "$($os.Caption)"
    $result.windowsBuild = "$($os.BuildNumber)"
  }
  $result.dotnetAvailable = [bool](Get-Command dotnet -ErrorAction SilentlyContinue)
  $result.cscAvailable = Test-Path "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
  $result.msbuildAvailable = [bool](Get-Command msbuild -ErrorAction SilentlyContinue)
  $result.windowsAppRuntimePackages = @(
    Get-AppxPackage -Name "Microsoft.WindowsAppRuntime*" -ErrorAction SilentlyContinue |
      ForEach-Object { "$($_.Name) $($_.Version)" }
  )
  try {
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $result.toastWinRT = $true
  } catch {}
  try {
    [void][Microsoft.Windows.AppNotifications.AppNotificationManager, Microsoft.Windows.AppNotifications, ContentType = WindowsRuntime]
    $result.appNotificationWinRT = $true
  } catch {}
  $shortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Shishi QA RC2D.lnk"
  $result.qaShortcut = Test-Path -LiteralPath $shortcut
  $result.qaAumidSettings = Test-Path "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\app.shishi.todo.qa"
  if (-not $result.dotnetAvailable) {
    $result.blockers += "dotnet SDK is not installed; Windows App SDK C# projection/COM POC cannot be built"
  }
  if (-not $result.msbuildAvailable) {
    $result.blockers += "MSBuild is not installed"
  }
  if (-not $result.appNotificationWinRT) {
    $result.blockers += "AppNotification WinRT type is not projected/loadable in this PowerShell session"
  }
  if ($result.blockers.Count -eq 0) { $result.status = "PREREQUISITES_PRESENT" }
} catch {
  $result.blockers += $_.Exception.Message
}

$json = $result | ConvertTo-Json -Depth 6
if ($OutFile) {
  $dir = Split-Path -Parent $OutFile
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}
$json
