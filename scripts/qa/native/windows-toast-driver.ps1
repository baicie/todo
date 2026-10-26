param(
  [ValidateSet("Probe", "Click")]
  [string]$Mode = "Probe",
  [string]$ArtifactRoot = "",
  [string]$OutFile = "",
  [string]$ReadyFile = "",
  [int]$TimeoutSeconds = 20,
  [string]$ExpectedText = "",
  [string]$RunMarker = ""
)

. (Join-Path $PSScriptRoot "windows-toast-marker.ps1")

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ExpectedText)) {
  # Code points avoid Windows PowerShell 5.1 decoding this UTF-8 file as ANSI.
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
  $json = $value | ConvertTo-Json -Depth 12
  if ($OutFile) {
    $dir = Split-Path -Parent $OutFile
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  }
  $json
}

function Get-Parent($element) {
  return [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($element)
}

function Get-Ancestors($element) {
  $list = New-Object System.Collections.Generic.List[object]
  $current = Get-Parent $element
  $depth = 0
  while ($null -ne $current -and $depth -lt 20) {
    $list.Add($current)
    if ($current -eq [System.Windows.Automation.AutomationElement]::RootElement) { break }
    $current = Get-Parent $current
    $depth += 1
  }
  return $list
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

function Test-MarkerInElement($element, [string]$marker) {
  try {
    return Test-QaMarkerText -Text "$($element.Current.Name)" -Marker $marker
  } catch {
    # A stale UIA element is skipped; the actual marker compatibility error is
    # not swallowed by Test-QaMarkerText.
    return $false
  }
}

function Get-CommonAncestor($left, $right) {
  $leftAncestors = @($left) + @(Get-Ancestors $left)
  $rightAncestors = @($right) + @(Get-Ancestors $right)
  foreach ($node in $leftAncestors) {
    foreach ($candidate in $rightAncestors) {
      try {
        if ($node.Equals($candidate)) { return $node }
      } catch {}
    }
  }
  return $null
}

function Find-ToastCard($window, $button, [string]$expected, [string]$marker) {
  $all = $window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $markerElements = New-Object System.Collections.Generic.List[object]
  foreach ($element in $all) {
    if (Test-MarkerInElement $element $marker) { $markerElements.Add($element) }
  }
  if ($markerElements.Count -eq 0) { return $null }

  $candidates = New-Object System.Collections.Generic.List[object]
  foreach ($markerElement in $markerElements) {
    $container = Get-CommonAncestor $button $markerElement
    if ($null -eq $container) { continue }
    if ($container -eq $window) { continue } # host-level match is not a card
    try {
      $buttons = $container.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::NameProperty,
          $expected
        ))
      )
      $actionButtons = @($buttons | Where-Object {
        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button
      })
      if ($actionButtons.Count -eq 1) {
        $candidates.Add([ordered]@{
          container = $container
          markerElement = $markerElement
          button = $button
        })
      }
    } catch {}
  }
  if ($candidates.Count -eq 1) { return $candidates[0] }
  if ($candidates.Count -gt 1) { return [ordered]@{ ambiguous = $true; count = $candidates.Count } }
  return $null
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
    $candidates = New-Object System.Collections.Generic.List[object]
    foreach ($window in $windows) {
      try {
        if (-not (Test-NotificationHost $window)) { continue }
        $buttons = $window.FindAll(
          [System.Windows.Automation.TreeScope]::Descendants,
          $nameCondition
        )
        foreach ($button in $buttons) {
          if ($button.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button) { continue }
          $card = Find-ToastCard $window $button $expected $marker
          if ($null -eq $card) { continue }
          if ($card.ambiguous) {
            return [ordered]@{ ambiguous = $true; count = $card.count }
          }
          $candidates.Add([ordered]@{
            element = $card.button
            window = $window
            container = $card.container
          })
        }
      } catch {
        continue
      }
    }
    if ($candidates.Count -gt 1) {
      return [ordered]@{ ambiguous = $true; count = $candidates.Count }
    }
    if ($candidates.Count -eq 1) { return $candidates[0] }
    Start-Sleep -Milliseconds 200
  }
  return $null
}

function Get-ToastDiagnostics([string]$expected, [string]$marker) {
  $diag = [ordered]@{
    hostWindows = 0
    actionButtons = 0
    markerElements = 0
    topLevelWindows = 0
  }
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $diag.topLevelWindows = $windows.Count
  $nameCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $expected
  )
  foreach ($window in $windows) {
    try {
      if (-not (Test-NotificationHost $window)) { continue }
      $diag.hostWindows += 1
      $buttons = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
      $diag.actionButtons += $buttons.Count
      $all = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
      )
      foreach ($element in $all) {
        if (Test-MarkerInElement $element $marker) { $diag.markerElements += 1 }
      }
    } catch {}
  }
  return $diag
}

function Save-Screenshot([string]$path, $bounds) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    if ($null -eq $bounds -or $bounds.Width -le 0 -or $bounds.Height -le 0) { return $false }
    $width = [int]$bounds.Width
    $height = [int]$bounds.Height
    if ($width -gt 1000 -or $height -gt 900 -or ($width * $height) -gt 700000) {
      Add-Timeline "screenshot_rejected_large" "${width}x${height}"
      return $false
    }
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    if ($bounds.X -lt $screen.X -or $bounds.Y -lt $screen.Y -or
        ($bounds.X + $width) -gt ($screen.X + $screen.Width) -or
        ($bounds.Y + $height) -gt ($screen.Y + $screen.Height)) {
      Add-Timeline "screenshot_rejected_outside_screen"
      return $false
    }
    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen(
      [System.Drawing.Point]::new([int]$bounds.X, [int]$bounds.Y),
      [System.Drawing.Point]::Empty,
      [System.Drawing.Size]::new($width, $height)
    )
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
  schemaVersion = 2
  mode = $Mode
  status = "NOT_RUN"
  runMarker = $RunMarker
  startedAt = $started.ToString("o")
  driverReadyAt = $null
  notificationObservedAt = $null
  invokeAt = $null
  finishedAt = $null
  expectedText = $ExpectedText
  desktopInteractive = [System.Environment]::UserInteractive
  wpnService = $null
  webView2 = $null
  findings = @()
  screenshot = $null
  error = $null
  diagnostics = $null
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

  $result.driverReadyAt = (Get-Date).ToUniversalTime().ToString("o")
  Add-Timeline "driver_ready"
  if ($ReadyFile) {
    $readyDir = Split-Path -Parent $ReadyFile
    if ($readyDir) { New-Item -ItemType Directory -Force -Path $readyDir | Out-Null }
    [System.IO.File]::WriteAllText($ReadyFile, "ready", (New-Object System.Text.UTF8Encoding($false)))
  }

  $found = Find-ToastButton -expected $ExpectedText -marker $RunMarker -seconds $TimeoutSeconds
  if ($null -eq $found) {
    $result.status = "NOT_RUN"
    $result.error = "no unique Toast card with action '$ExpectedText' and marker '$RunMarker' within $TimeoutSeconds s"
    $result.diagnostics = Get-ToastDiagnostics $ExpectedText $RunMarker
    Add-Timeline "toast_not_found_or_ambiguous" $result.diagnostics
  } elseif ($found.ambiguous) {
    $result.status = "NOT_RUN"
    $result.error = "AMBIGUOUS_TARGET: $($found.count) Toast candidates matched marker '$RunMarker'"
    Add-Timeline "toast_ambiguous" "$($found.count)"
  } else {
    $window = $found.window
    $button = $found.element
    $container = $found.container
    $result.notificationObservedAt = (Get-Date).ToUniversalTime().ToString("o")
    $result.findings += [ordered]@{
      windowName = "$($window.Current.Name)"
      windowClass = "$($window.Current.ClassName)"
      windowProcessId = $window.Current.ProcessId
      containerName = "$($container.Current.Name)"
      containerClass = "$($container.Current.ClassName)"
      buttonName = "$($button.Current.Name)"
      buttonAutomationId = "$($button.Current.AutomationId)"
    }
    Add-Timeline "toast_card_found" "single marker-bound card"
    if ($ArtifactRoot) {
      $shot = Join-Path $ArtifactRoot "screenshots\toast-driver.png"
      if (Save-Screenshot $shot $container.Current.BoundingRectangle) {
        $result.screenshot = "screenshots/toast-driver.png"
      }
    }
    if ($Mode -eq "Click") {
      $pattern = $null
      if ($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $result.invokeAt = (Get-Date).ToUniversalTime().ToString("o")
        $pattern.Invoke()
        Add-Timeline "toast_invoked" "marker-bound card"
        # E2E runner must verify the task detail; UIA invoke alone is not PASS.
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
