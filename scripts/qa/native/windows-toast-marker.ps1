# Shared marker matcher. Windows PowerShell 5.1 runs on .NET Framework, whose
# String.Contains overload does not accept StringComparison. Use IndexOf.
function Test-QaMarkerText {
  param(
    [string]$Text,
    [string]$Marker
  )
  if ([string]::IsNullOrEmpty($Text) -or [string]::IsNullOrEmpty($Marker)) {
    return $false
  }
  return ($Text.IndexOf($Marker, [System.StringComparison]::Ordinal) -ge 0)
}
