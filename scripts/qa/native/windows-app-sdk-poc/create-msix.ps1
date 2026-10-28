param(
  [string]$OutDir = "",
  [string]$PublishDir = "",
  [string]$MakeAppx = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\makeappx.exe",
  [string]$Dotnet = ""
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$out = if ($OutDir) { $OutDir } else { Join-Path $here "msix-output" }
$publish = if ($PublishDir) { $PublishDir } else { Join-Path $out "publish" }
New-Item -ItemType Directory -Force -Path $out | Out-Null
$dotnetPath = if ($Dotnet) { $Dotnet } else { (Get-Command dotnet -ErrorAction SilentlyContinue).Source }
if (-not $dotnetPath) { throw "dotnet SDK not found; set -Dotnet or PATH" }
if (-not (Test-Path $MakeAppx)) { throw "MakeAppx not found: $MakeAppx" }
$project = Join-Path $here "AppNotificationPoc\AppNotificationPoc.csproj"
& $dotnetPath publish $project -c Release -r win-x64 --self-contained true -p:WindowsAppSDKSelfContained=true -p:PocNoBootstrap=false -o $publish --nologo
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }
$layout = Join-Path $out "layout"
Remove-Item $layout -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $layout,$layout\Assets | Out-Null
Copy-Item $publish\* $layout -Recurse -Force
Copy-Item (Join-Path $here "AppxManifest.xml") $layout -Force
Add-Type -AssemblyName System.Drawing
foreach ($spec in @(@(44,'Square44x44Logo.png'),@(50,'StoreLogo.png'),@(150,'Square150x150Logo.png'),@(310,'Wide310x150Logo.png'))) {
  $bmp = New-Object System.Drawing.Bitmap $spec[0],$spec[0]
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb(30,90,160))
  $bmp.Save((Join-Path $layout "Assets\$($spec[1])"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
$package = Join-Path $out "ShishiQaAppNotificationPoc.msix"
& $MakeAppx pack /d $layout /p $package /o
if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed" }
$result = [ordered]@{
  schemaVersion = 1
  builtAt = (Get-Date).ToUniversalTime().ToString("o")
  package = $package
  packageSha256 = (Get-FileHash $package -Algorithm SHA256).Hash
  note = "MSIX build only. Installation requires developer/sideload policy and trusted signing root; this script does not install."
}
$result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out "msix-summary.json") -Encoding utf8
$result | ConvertTo-Json
