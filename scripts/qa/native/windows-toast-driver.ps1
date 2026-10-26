param(
  [ValidateSet("Probe", "Click")]
  [string]$Mode = "Probe",
  [string]$ArtifactRoot = "",
  [string]$OutFile = "",
  [int]$TimeoutSeconds = 20,
  [string]$ExpectedText = "",
  [string]$RunMarker = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ExpectedText)) {
  # Construct the Chinese action label from code points so Windows PowerShell
  # 5.1 does not decode this UTF-8 script as ANSI.
  $ExpectedText = -join @([char]0x6253, [char]0x5F00, [char]0x4EFB, [char]0x52A1)
}
$started = (Get-Date).ToUniversalTime()
$timeline = New-Object System.Collections.Generic.List[object]
function Add-Timeline([string]$name, $detail = $null) {
  $timeline.Add([ordered]@{
    at = (Get-Date).ToUniversalTime().ToString("o")
    name = $name
    detail = $detail
  })
}

function Write-Result($value) {
  $json = $value | ConvertTo-Json -Depth 10
  if ($OutFile) {
    $dir = Split-Path -Parent $OutFile
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  }
  $json
}

function Get-TopLevel([System.Windows.Automation.AutomationElement]$element) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $current = $element
  while ($null -ne $current) {
    $parent = $walker.GetParent($current)
    if ($null -eq $parent -or $parent -eq [System.Windows.Automation.AutomationElement]::RootElement) {
      return $current
    }
    $current = $parent
  }
  return $element
}

function Test-NotificationHost([System.Windows.Automation.AutomationElement]$window) {
  if ($null -eq $window) { return $false }
  $class = "$($window.Current.ClassName)"
  $name = "$($window.Current.Name)"
  $process = ""
  try { $process = (Get-Process -Id $window.Current.ProcessId -ErrorAction Stop).ProcessName } catch {}
  $hostMatch = $class -match "CoreWindow|Notification|Toast|Shell|Xaml" -or
    $name -match "Notification|Toast" -or
    $process -match "ShellExperienceHost|ShellHost|StartMenuExperienceHost"
  return [bool]$hostMatch
}

function Test-WindowMarker([System.Windows.Automation.AutomationElement]$window, [string]$marker) {
  if ([string]::IsNullOrWhiteSpace($marker)) { return $false }
  try {
    $all = $window.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($element in $all) {
      try {
        $name = "$($element.Current.Name)"
        if ($name.Contains($marker, [System.StringComparison]::Ordinal)) { return $true }
      } catch {}
    }
  } catch {}
  return $false
}

function Find-ToastButton([string]$expected, [string]$marker, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  $nameCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $expected
  )
  while ((Get-Date) -lt $deadline) {
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($window in $windows) {
      try {
        if (-not (Test-NotificationHost $window)) { continue }
        $buttons = $window.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          $nameCondition
        )
        foreach ($button in $buttons) {
          if ($button.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button) { continue }
          if (-not (Test-WindowMarker $window $marker)) { continue }
          return [ordered]@{ element = $button; window = $window }
        }
      } catch {
        continue
      }
    }
    Start-Sleep -Milliseconds 250
  }
  return $null
}

function Save-Screenshot([string]$path, $bounds) {
  try {
    Add-Type -AssemblyName System.Drawing
    if ($null -eq $bounds -or $bounds.Width -le 0 -or $bounds.Height -le 0) { return $false }
    $bitmap = New-Object System.Drawing.Bitmap ([int]$bounds.Width), ([int]$bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen([System.Drawing.Point]::new([int]$bounds.X, [int]$bounds.Y), [System.Drawing.Point]::Empty, $bounds.Size)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose()
    $bitmap.Dispose()
    return $true
  } catch {
    Add-Timeline "screenshot_failed" "$($_.Exception.Message)"
    return $false
  }
}

$result = [ordered]@{
  schemaVersion = 1
  mode = $Mode
  status = "NOT_RUN"
  startedAt = $started.ToString("o")
  finishedAt = $null
  expectedText = $ExpectedText
  desktopInteractive = [System.Environment]::UserInteractive
  wpnService = $null
  webView2 = $null
  findings = @()
  screenshot = $null
  error = $null
  timeline = $timeline
}

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Timeline "uia_loaded"

  $wpn = Get-Service WpnService -ErrorAction SilentlyContinue
  $result.wpnService = if ($wpn) { "$($wpn.Status)" } else { "missing" }
  $webview = Get-ChildItem "C:\Program Files (x86)\Microsoft\EdgeWebView\Application" -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+\.' } | Sort-Object Name -Descending | Select-Object -First 1
  $result.webView2 = if ($webview) { $webview.Name } else { "missing" }

  if (-not $result.desktopInteractive) {
    $result.error = "no interactive desktop session"
    throw $result.error
  }
  if ($result.wpnService -ne "Running") {
    $result.error = "Windows Push Notification Service is not Running"
    throw $result.error
  }

  if ([string]::IsNullOrWhiteSpace($RunMarker)) {
    $result.status = "FAIL"
    $result.error = "RunMarker is required to attribute a notification to this QA run"
    Add-Timeline "missing_run_marker"
    throw $result.error
  }
  $found = Find-ToastButton -expected $ExpectedText -marker $RunMarker -seconds $TimeoutSeconds
  if ($null -eq $found) {
    $result.status = "NOT_RUN"
    $result.error = "no real Toast button '$ExpectedText' with QA run marker '$RunMarker' found within $TimeoutSeconds s"
    Add-Timeline "toast_not_found_or_ambiguous"
  } else {
    $window = $found.window
    $button = $found.element
    $toastWindow = $window
    if ($ArtifactRoot) {
      $shot = Join-Path $ArtifactRoot "screenshots\toast-driver.png"
      if (Save-Screenshot $shot $window.Current.BoundingRectangle) {
        $result.screenshot = "screenshots/toast-driver.png"
      }
    }
    $result.findings += [ordered]@{
      windowName = "$($window.Current.Name)"
      windowClass = "$($window.Current.ClassName)"
      windowProcessId = $window.Current.ProcessId
      buttonName = "$($button.Current.Name)"
      buttonAutomationId = "$($button.Current.AutomationId)"
    }
    Add-Timeline "toast_found"
    if ($Mode -eq "Click") {
      $pattern = $null
      if ($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke()
        Add-Timeline "toast_invoked"
        # The caller must still prove the QA app opened the expected task and
        # that the click came from this run. A UIA invoke alone is not a PASS.
        $result.status = "PARTIAL"
      } else {
        $result.status = "FAIL"
        $result.error = "Toast button does not expose InvokePattern"
      }
    } else {
      $result.status = "PARTIAL"
    }
  }
} catch {
  $result.status = "FAIL"
  $result.error = $_.Exception.Message
  Add-Timeline "driver_error" $result.error
} finally {
  $result.finishedAt = (Get-Date).ToUniversalTime().ToString("o")
  Write-Result $result | Out-Host
}
