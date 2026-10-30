# Standalone smoke probe for PR #206, with Brave and Firefox selectors.
# Uses .NET's UI Automation wrapper for the same ClassName lookup and
# ValuePattern.SetValue + Win32 SendInput sequence. This is not the Rust app:
# policy activation, scheduling, MSIX resources and other platforms aren't tested.
# Run in Windows PowerShell 5.1: powershell -NoProfile -MTA -File <this file>
[CmdletBinding()]
param([switch]$CompileOnly, [ValidateRange(10,300)][int]$TimeoutSeconds = 60,
    [ValidateSet('any','msedge','brave','chrome','firefox')][string]$Browser = 'any')
$ErrorActionPreference = 'Stop'
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
Add-Type -Path (Join-Path $framework 'WPF\UIAutomationClient.dll')
Add-Type -Path (Join-Path $framework 'WPF\UIAutomationTypes.dll')
$source = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public static class AddressBarProbe206 {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr w, StringBuilder b, int n);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr w, StringBuilder b, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr w, out uint p);
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
    [StructLayout(LayoutKind.Explicit)] struct UNION {
        [FieldOffset(0)] public KEY keyboard;
        [FieldOffset(0)] public MOUSE mouse;
    }
    [StructLayout(LayoutKind.Sequential)] struct KEY {
        public ushort vk, scan; public uint flags, time; public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)] struct MOUSE {
        public int x,y; public uint data,flags,time; public UIntPtr extra;
    }
    static string Title(IntPtr w) { var b=new StringBuilder(1024); GetWindowText(w,b,b.Capacity); return b.ToString(); }
    static string BrowserName(IntPtr w) {
        uint p; GetWindowThreadProcessId(w,out p);
        return Process.GetProcessById((int)p).ProcessName.ToLowerInvariant();
    }
    static bool Browser(IntPtr w, string requested) {
        var b=new StringBuilder(64); GetClassName(w,b,b.Capacity);
        if(b.ToString()!="Chrome_WidgetWin_1" && b.ToString()!="MozillaWindowClass") return false;
        var name=BrowserName(w);
        if(requested!="any" && name!=requested) return false;
        return name=="brave" || name=="chrome" || name=="msedge" || name=="firefox";
    }
    static AutomationElement Bar(IntPtr w) {
        uint p; GetWindowThreadProcessId(w,out p);
        var name=Process.GetProcessById((int)p).ProcessName.ToLowerInvariant();
        if(name=="firefox") {
            var toolbar=AutomationElement.FromHandle(w).FindFirst(TreeScope.Children,new AndCondition(
                new PropertyCondition(AutomationElement.AutomationIdProperty,"nav-bar"),
                new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.ToolBar)));
            if(toolbar==null) return null;
            return toolbar.FindFirst(TreeScope.Descendants,new AndCondition(
                new PropertyCondition(AutomationElement.AutomationIdProperty,"urlbar-input"),
                new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.ComboBox)));
        }
        var className=name=="brave" ? "BraveOmniboxViewViews" : "OmniboxViewViews";
        return AutomationElement.FromHandle(w).FindFirst(TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ClassNameProperty,className));
    }
    static ValuePattern Value(AutomationElement bar) { return (ValuePattern)bar.GetCurrentPattern(ValuePattern.Pattern); }
    static bool Example(string s) {
        s=s.Trim().TrimEnd('/');
        return s=="example.com" || s=="https://example.com" || s=="http://example.com";
    }
    static void Navigate(IntPtr w, AutomationElement bar, string url) {
        if(GetForegroundWindow()!=w)
            throw new Exception("Test window lost foreground before navigation; no input sent.");
        if(bar.Current.HasKeyboardFocus)
            throw new Exception("Test window is foreground, but address bar still has keyboard focus; no input sent.");
        bar.SetFocus(); Value(bar).SetValue(url);
        if(GetForegroundWindow()!=w || !bar.Current.HasKeyboardFocus)
            throw new Exception("Focus changed before Enter; Enter NOT sent. Test URL may remain in address bar.");
        var down=new INPUT(); down.type=1; down.data.keyboard.vk=13;
        var up=down; up.data.keyboard.flags=2;
        if(SendInput(2,new[]{down,up},Marshal.SizeOf(typeof(INPUT)))!=2)
            throw new Exception("SendInput failed: "+Marshal.GetLastWin32Error());
    }
    static void WaitTitle(IntPtr w,string expected,int seconds) {
        var end=DateTime.UtcNow.AddSeconds(seconds);
        while(DateTime.UtcNow<end) {
            // Observation only: a focus switch after Enter does not cancel a
            // navigation already sent. Never send additional input here.
            if(Title(w).Contains(expected)) return;
            Thread.Sleep(250);
        }
        throw new Exception("Navigation did not produce expected page title: "+expected);
    }
    static void Restore(IntPtr w, string token, string parked, int seconds) {
        var end=DateTime.UtcNow.AddSeconds(seconds);
        bool reported=false;
        while(DateTime.UtcNow<end) {
            // Mirror the watcher's ticks: background windows and an edited
            // address bar defer work, rather than failing on a single sample.
            if(GetForegroundWindow()==w) {
                var bar=Bar(w);
                if(bar!=null && !bar.Current.HasKeyboardFocus) {
                    if(!Title(w).Contains(token) || Value(bar).Current.Value!=parked)
                        throw new Exception("Test tab changed while waiting; restore cancelled without input.");
                    Navigate(w,bar,"https://example.com/");
                    return;
                }
            }
            if(!reported) {
                Console.WriteLine("Restore deferred: bring the test page forward and leave the address bar unfocused.");
                reported=true;
            }
            Thread.Sleep(1000);
        }
        throw new Exception("Restore timed out waiting for safe focus; no restore input sent.");
    }
    public static void Run(string blockUrl,string token,int seconds,string requested) {
        Console.WriteLine("Open https://example.com/ in a disposable Chrome, Edge, Brave or Firefox window.");
        Console.WriteLine("Click the page (not the address bar), keep it in front, and don't type during the test.");
        var end=DateTime.UtcNow.AddSeconds(seconds);
        IntPtr w=IntPtr.Zero; AutomationElement bar=null;
        while(DateTime.UtcNow<end) {
            var candidate=GetForegroundWindow();
            if(candidate!=IntPtr.Zero && Browser(candidate,requested) && Title(candidate).Contains("Example Domain")) {
                bar=Bar(candidate);
                if(bar==null) {
                    Console.WriteLine("FAIL: browser-specific omnibox class not found. Edit-control metadata (no values):");
                    var edits=AutomationElement.FromHandle(candidate).FindAll(TreeScope.Descendants,
                        new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Edit));
                    foreach(AutomationElement edit in edits)
                        Console.WriteLine("  Class="+edit.Current.ClassName+"; AutomationId="+edit.Current.AutomationId);
                    throw new Exception("Exact PR address-bar lookup failed; no input sent.");
                }
                if(!bar.Current.HasKeyboardFocus && Example(Value(bar).Current.Value)) { w=candidate; break; }
            }
            Thread.Sleep(500);
        }
        if(w==IntPtr.Zero) throw new Exception("Timed out waiting for foreground Example Domain page with address bar unfocused.");
        Console.WriteLine("Browser under test: "+BrowserName(w));
        Console.WriteLine("PASS: exact browser-specific omnibox lookup and ValuePattern read.");
        Navigate(w,bar,blockUrl);
        WaitTitle(w,token,10);
        Console.WriteLine("PASS: SetValue + SendInput navigated to a local file in a path with spaces.");
        var parked=Value(bar).Current.Value;
        var marker="u="; var pos=parked.IndexOf(marker,StringComparison.Ordinal);
        if(pos<0 || Uri.UnescapeDataString(parked.Substring(pos+marker.Length))!="https://example.com/")
            throw new Exception("Original URL did not survive in the displayed block-page query string.");
        Console.WriteLine("PASS: original URL is decodable from displayed u= query parameter.");
        Console.WriteLine("Restoring in five seconds. If the address bar still has focus, click the page.");
        Thread.Sleep(5000);
        Console.WriteLine("Before restore: foreground="+(GetForegroundWindow()==w)+"; addressBarFocused="+bar.Current.HasKeyboardFocus);
        Restore(w,token,parked,seconds);
        WaitTitle(w,"Example Domain",15);
        if(!Example(Value(bar).Current.Value)) throw new Exception("Restored page address differs from example.com.");
        Console.WriteLine("PASS: returned to Example Domain. Browser mechanism smoke test passed.");
    }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies @(
    (Join-Path $framework 'WPF\UIAutomationClient.dll'),
    (Join-Path $framework 'WPF\UIAutomationTypes.dll'),
    (Join-Path $framework 'WPF\WindowsBase.dll')
)
if ($CompileOnly) { Write-Output 'PASS: C# probe compiled; no browser interaction performed.'; exit 0 }
$testDir = Join-Path ([IO.Path]::GetTempPath()) ('DH PR206 probe ' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testDir | Out-Null
$testPage = Join-Path $testDir 'blocked.html'
$token = 'DH PR206 probe ' + [Guid]::NewGuid().ToString('N')
Set-Content -LiteralPath $testPage -Encoding UTF8 -Value "<!doctype html><title>$token</title><h1>Address-bar redirect worked</h1><p>This temporary test page will return to example.com. Click here if the address bar has focus.</p><div role='toolbar' id='nav-bar'><input role='combobox' id='urlbar-input' value='Page input: must not be used as the browser address bar'></div>"
$testUrl = ([Uri]$testPage).AbsoluteUri + '?u=' + [Uri]::EscapeDataString('https://example.com/')
$log = Join-Path $testDir 'result.txt'
Start-Transcript -LiteralPath $log | Out-Null
$failed = $false
try {
    Write-Host 'PR #206 mechanism probe; no policy or Blocker settings are changed.'
    [AddressBarProbe206]::Run($testUrl, $token, $TimeoutSeconds, $Browser)
} catch {
    $failed = $true
    Write-Host ('FAIL: ' + $_.Exception.GetBaseException().Message) -ForegroundColor Red
} finally {
    Write-Host "Results and temporary test page: $testDir"
    Write-Host 'This does not verify the Rust watcher, policy gating, schedules, or MSIX packaging.'
    Stop-Transcript | Out-Null
}
if ($failed) { exit 1 }

