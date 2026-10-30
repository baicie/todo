. (Join-Path $PSScriptRoot "windows-toast-marker.ps1")

$failures = New-Object System.Collections.Generic.List[string]
function Assert-True([bool]$condition, [string]$name) {
  if ($condition) {
    Write-Output "PASS $name"
  } else {
    $failures.Add($name)
    Write-Output "FAIL $name"
  }
}

Assert-True (Test-QaMarkerText -Text "QA Toast run-123 body" -Marker "run-123") "ascii marker"
Assert-True (Test-QaMarkerText -Text "QA Toast 运行中 run-123" -Marker "run-123") "unicode surrounding text"
Assert-True (Test-QaMarkerText -Text "prefix run-123 suffix" -Marker "run-123") "substring marker"
Assert-True (-not (Test-QaMarkerText -Text "QA Toast other-run" -Marker "run-123")) "different run rejected"
Assert-True (-not (Test-QaMarkerText -Text "" -Marker "run-123")) "empty text rejected"
Assert-True (-not (Test-QaMarkerText -Text "run-123" -Marker "")) "empty marker rejected"
Assert-True (Test-QaMarkerText -Text "abc" -Marker "abc") "exact string"

if ($failures.Count -gt 0) {
  Write-Error "marker runtime tests failed: $($failures -join ', ')"
  exit 1
}
Write-Output "marker runtime tests: PASS"
