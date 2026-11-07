param([Parameter(Mandatory=$true)][int]$FixturePid, [Parameter(Mandatory=$true)][string]$WindowTitle)
$ErrorActionPreference = 'Stop'
if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne 'MTA') { throw 'UIAutomation probe requires an MTA thread' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class HostedProbeWindow {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $FixturePid)
$windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
$window = $null
foreach ($candidate in $windows) { if ($candidate.Current.Name -eq $WindowTitle) { $window = $candidate; break } }
if ($null -eq $window) { throw "No UIAutomation window for exact PID $FixturePid and title $WindowTitle" }
$nameCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Save marker')
# Legacy WinForms providers can expose a custom control type. The exact
# owned window/PID and unique label identify the control; a fresh persisted
# nonce, not the advertised type, proves the button handler actually ran.
$button = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCondition)
if ($null -eq $button) { throw 'Save marker button not exposed to UIAutomation' }
if ($button.Current.ProcessId -ne $FixturePid) { throw 'Accessibility control belongs to another process' }
$patterns = @($button.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
$pattern = $null
$focusError = $null
if ($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke()
    $method = 'UIAutomation InvokePattern'
} else {
    # Older WinForms accessibility providers may lack InvokePattern. Exercise
    # the visible button with real keyboard input, without sending BM_CLICK or
    # calling a fixture method. Verify the foreground PID before sending Space.
    [void][HostedProbeWindow]::SetForegroundWindow([IntPtr]$window.Current.NativeWindowHandle)
    try { $button.SetFocus() } catch { $focusError = $_.Exception.Message }
    Start-Sleep -Milliseconds 150
    [uint32]$foregroundPid = 0
    [void][HostedProbeWindow]::GetWindowThreadProcessId([HostedProbeWindow]::GetForegroundWindow(), [ref]$foregroundPid)
    if ($foregroundPid -ne $FixturePid) {
        throw "Native button focus unavailable for exact PID $FixturePid; foreground PID: $foregroundPid"
    }
    if ($null -ne $focusError) {
        # The owned fixture has exactly one tabbable control. Use actual
        # keyboard navigation when its legacy provider cannot SetFocus.
        # No fixture method, BM_CLICK, or saved-marker write is performed here.
        [System.Windows.Forms.SendKeys]::SendWait('{TAB}')
    }
    [void][HostedProbeWindow]::GetWindowThreadProcessId([HostedProbeWindow]::GetForegroundWindow(), [ref]$foregroundPid)
    if ($foregroundPid -ne $FixturePid) { throw 'Native button focus unavailable before Space' }
    [System.Windows.Forms.SendKeys]::SendWait(' ')
    $method = if ($null -eq $focusError) { 'UIAutomation SetFocus + native Space key' } else { 'UIAutomation window identity + native Tab/Space' }
}
@{ method = $method; apartment = [System.Threading.Thread]::CurrentThread.GetApartmentState().ToString(); pid = $FixturePid; title = $WindowTitle; patterns = $patterns; focusError = $focusError; controlType = $button.Current.ControlType.ProgrammaticName } | ConvertTo-Json -Compress
