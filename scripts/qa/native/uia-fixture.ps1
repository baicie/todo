param(
  [string]$Mode = "Single",
  [string]$Marker = "fixture-run-1",
  [string]$ClickFile = "",
  [string]$ReadyFile = "",
  [int]$LifetimeSeconds = 25
)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$actionText = -join @([char]0x6253, [char]0x5F00, [char]0x4EFB, [char]0x52A1)
$windowTitle = if ($Mode -eq "NonHost") { "QA Fixture" } else { "Notification QA Fixture" }
$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="$windowTitle" Width="600" Height="260" Topmost="True"
        WindowStartupLocation="Manual" Left="120" Top="120">
  <StackPanel Orientation="Horizontal" Margin="10">
    <GroupBox Header="Notification Card" Width="270" Height="180" Margin="0,0,10,0">
      <StackPanel Margin="10">
        <TextBlock Text="QA Toast $Marker" FontSize="16"/>
        <Button x:Name="ButtonA" Content="" Width="130" Height="36" Margin="0,16,0,0"/>
      </StackPanel>
    </GroupBox>
    <GroupBox x:Name="SecondCard" Header="Other Card" Width="270" Height="180" Visibility="Collapsed">
      <StackPanel Margin="10">
        <TextBlock x:Name="SecondMarker" Text="QA Toast other-run" FontSize="16"/>
        <Button x:Name="ButtonB" Content="" Width="130" Height="36" Margin="0,16,0,0"/>
      </StackPanel>
    </GroupBox>
  </StackPanel>
</Window>
"@
$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$window = [System.Windows.Markup.XamlReader]::Load($reader)
$buttonA = $window.FindName("ButtonA")
$buttonA.Content = $actionText
$secondCard = $window.FindName("SecondCard")
$buttonB = $window.FindName("ButtonB")
$buttonB.Content = $actionText

switch ($Mode) {
  "Split" {
    # Marker stays in the first card, action button in a different card.
    $secondCard.Visibility = "Visible"
    # Marker stays only in the first card; action is only in the second card.
    $window.FindName("SecondMarker").Text = "QA Toast other-run"
    $buttonA.Content = "Noop"
    $buttonA.IsEnabled = $false
  }
  "Duplicate" {
    $secondCard.Visibility = "Visible"
    $window.FindName("SecondMarker").Text = "QA Toast $Marker"
    $buttonB.Content = $actionText
  }
  default {
    $buttonB.IsEnabled = $false
  }
}

$clickHandler = {
  if ($ClickFile) {
    [System.IO.File]::WriteAllText($ClickFile, "clicked", (New-Object System.Text.UTF8Encoding($false)))
  }
  $window.Close()
}
$buttonA.Add_Click($clickHandler)
$buttonB.Add_Click($clickHandler)

$window.Show()
if ($ReadyFile) {
  $dir = Split-Path -Parent $ReadyFile
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($ReadyFile, "ready", (New-Object System.Text.UTF8Encoding($false)))
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds($LifetimeSeconds)
$timer.Add_Tick({
  $timer.Stop()
  $window.Close()
})
$timer.Start()
$window.Add_Closed({
  [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
})
[System.Windows.Threading.Dispatcher]::Run()
