param([Parameter(Mandatory=$true)][int]$FixturePid)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Diagnostics;
public static class FixtureInspection {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder b, int n);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr t, int kind, IntPtr data, int size, out int needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    public static int Integrity(int pid) {
        using (var p = Process.GetProcessById(pid)) {
            IntPtr t; if (!OpenProcessToken(p.Handle, 8, out t)) throw new System.ComponentModel.Win32Exception();
            try { int n; GetTokenInformation(t, 25, IntPtr.Zero, 0, out n);
                IntPtr b = Marshal.AllocHGlobal(n);
                try { if (!GetTokenInformation(t, 25, b, n, out n)) throw new System.ComponentModel.Win32Exception();
                    IntPtr sid = Marshal.ReadIntPtr(b);
                    return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(Marshal.ReadByte(GetSidSubAuthorityCount(sid))-1)));
                } finally { Marshal.FreeHGlobal(b); }
            } finally { CloseHandle(t); }
        }
    }
    public static long[] Children(IntPtr h) { var r = new List<long>(); EnumChildWindows(h, delegate(IntPtr c, IntPtr l) { r.Add(c.ToInt64()); return true; }, IntPtr.Zero); return r.ToArray(); }
    public static string ClassName(IntPtr h) { var b = new StringBuilder(256); GetClassName(h,b,b.Capacity); return b.ToString(); }
}
'@
function Describe($element) {
    $c = $element.Current
    @{ name=$c.Name; automationId=$c.AutomationId; type=$c.ControlType.ProgrammaticName; class=$c.ClassName; framework=$c.FrameworkId; pid=$c.ProcessId; hwnd=$c.NativeWindowHandle; enabled=$c.IsEnabled; focusable=$c.IsKeyboardFocusable; patterns=@($element.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) }
}
$process = Get-Process -Id $FixturePid
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $FixturePid)
$ownedWindows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
$topLevel = @(foreach ($ownedWindow in $ownedWindows) { Describe $ownedWindow })
$window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
$tree = @((Describe $window))
$elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($element in $elements) { $tree += Describe $element }
$native = @(foreach ($h in [FixtureInspection]::Children($process.MainWindowHandle)) {
    [uint32]$owner = 0
    [void][FixtureInspection]::GetWindowThreadProcessId([IntPtr]$h, [ref]$owner)
    @{ hwnd=$h; pid=$owner; class=[FixtureInspection]::ClassName([IntPtr]$h); element=(Describe ([System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$h))) }
})
[uint32]$foregroundPid = 0
$foreground = [FixtureInspection]::GetForegroundWindow()
[void][FixtureInspection]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
@{ pid=$FixturePid; session=$process.SessionId; integrity=[FixtureInspection]::Integrity($FixturePid); clientPid=$PID; clientSession=(Get-Process -Id $PID).SessionId; clientIntegrity=[FixtureInspection]::Integrity($PID); foregroundHwnd=$foreground.ToInt64(); foregroundPid=$foregroundPid; topLevelWindows=$topLevel; tree=$tree; nativeChildren=$native } | ConvertTo-Json -Depth 8

