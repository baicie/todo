param(
  [string]$OutFile = "",
  [string]$Identifier = "app.shishi.todo.qa"
)

$ErrorActionPreference = "Stop"
$registryPath = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\$Identifier"
$result = [ordered]@{
  schemaVersion = 1
  identifier = $Identifier
  checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  desktopInteractive = [System.Environment]::UserInteractive
  sessionId = (Get-Process -Id $PID).SessionId
  windowsCaption = $null
  windowsVersion = $null
  windowsBuild = $null
  explorerRunning = $false
  startMenuShortcut = $false
  globalToastEnabled = $null
  wpnService = $null
  settingsKeyPresent = $false
  lastNotificationAddedTime = $null
  periodicNotificationCount = $null
  error = $null
}

try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
  if ($os) {
    $result.windowsCaption = "$($os.Caption)"
    $result.windowsVersion = "$($os.Version)"
    $result.windowsBuild = "$($os.BuildNumber)"
  }
  $result.explorerRunning = [bool](Get-Process explorer -ErrorAction SilentlyContinue)
  $shortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Shishi QA RC2D.lnk"
  $result.startMenuShortcut = Test-Path -LiteralPath $shortcut
  $globalPath = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings"
  if (Test-Path -LiteralPath $globalPath) {
    $global = Get-ItemProperty -LiteralPath $globalPath -ErrorAction SilentlyContinue
    if ($null -ne $global.NOC_GLOBAL_SETTING_TOASTS_ENABLED) {
      $result.globalToastEnabled = $global.NOC_GLOBAL_SETTING_TOASTS_ENABLED
    }
  }
  $service = Get-Service WpnService -ErrorAction SilentlyContinue
  $result.wpnService = if ($service) { "$($service.Status)" } else { "missing" }
  if (Test-Path -LiteralPath $registryPath) {
    $result.settingsKeyPresent = $true
    $props = Get-ItemProperty -LiteralPath $registryPath
    if ($null -ne $props.LastNotificationAddedTime) {
      try {
        $result.lastNotificationAddedTime = [DateTime]::FromFileTime([int64]$props.LastNotificationAddedTime).ToUniversalTime().ToString("o")
      } catch {
        $result.lastNotificationAddedTime = "$($props.LastNotificationAddedTime)"
      }
    }
    $result.periodicNotificationCount = $props.PeriodicNotificationCount
  }
} catch {
  $result.error = $_.Exception.Message
}

$json = $result | ConvertTo-Json -Depth 6
if ($OutFile) {
  $dir = Split-Path -Parent $OutFile
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}
$json
