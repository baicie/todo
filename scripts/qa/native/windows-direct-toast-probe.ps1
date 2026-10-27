param(
  [string]$OutFile = "",
  [string]$Identifier = "app.shishi.todo.qa"
)

$ErrorActionPreference = "Stop"
$result = [ordered]@{
  schemaVersion = 1
  checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  identifier = $Identifier
  interactive = [System.Environment]::UserInteractive
  beforeAddedTime = $null
  afterAddedTime = $null
  timestampAdvanced = $false
  bannerObservedByUia = $false
  status = "NOT_RUN"
  error = $null
}

try {
  if (-not $result.interactive) { throw "non-interactive Windows session" }
  $key = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings\$Identifier"
  if (Test-Path -LiteralPath $key) {
    $before = (Get-ItemProperty -LiteralPath $key).LastNotificationAddedTime
    if ($null -ne $before) { $result.beforeAddedTime = [DateTime]::FromFileTime([int64]$before).ToUniversalTime().ToString("o") }
  }

  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>Shishi QA direct probe</text><text>environment banner test</text></binding></visual></toast>')
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Identifier)
  $notifier.Show($toast)
  Start-Sleep -Seconds 2

  if (Test-Path -LiteralPath $key) {
    $after = (Get-ItemProperty -LiteralPath $key).LastNotificationAddedTime
    if ($null -ne $after) {
      $result.afterAddedTime = [DateTime]::FromFileTime([int64]$after).ToUniversalTime().ToString("o")
      $result.timestampAdvanced = $result.afterAddedTime -ne $result.beforeAddedTime
    }
  }
  # This probe intentionally does not screenshot the desktop. A true banner
  # assertion is the UIA driver's job; a null result here means the platform
  # accepted the toast but no safe banner observation was made.
  $result.status = if ($result.timestampAdvanced) { "ACCEPTED_BANNER_NOT_OBSERVED" } else { "NOT_ACCEPTED" }
} catch {
  $result.status = "NOT_RUN"
  $result.error = $_.Exception.Message
}

$json = $result | ConvertTo-Json -Depth 5
if ($OutFile) {
  $dir = Split-Path -Parent $OutFile
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}
$json
