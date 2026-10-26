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
  wpnService = $null
  settingsKeyPresent = $false
  lastNotificationAddedTime = $null
  periodicNotificationCount = $null
  error = $null
}

try {
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
