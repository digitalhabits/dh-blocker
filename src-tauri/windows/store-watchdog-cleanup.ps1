# Old Store builds created a non-packaged Scheduled Task. The Store
# uninstaller cannot run cleanup for it, so retire it on upgraded launch.
param([switch]$DefineOnly)

function Test-LegacyStoreWatchdog($Task, [string]$TaskName, [string]$Wrapper, [string]$UserSid) {
    $actions = @($Task.Actions)
    if ($Task.TaskPath -ne '\' -or $Task.TaskName -ne $TaskName -or
        $Task.Principal.RunLevel -ne 'Limited' -or $actions.Count -ne 1) {
        return $false
    }
    $wrapperArgument = '"' + $Wrapper + '"'
    if ($actions[0].Execute -notin @('wscript.exe', (Join-Path ([Environment]::SystemDirectory) 'wscript.exe')) -or
        ![string]::Equals($actions[0].Arguments, $wrapperArgument, [StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }

    $principal = [string]$Task.Principal.UserId
    if (!$principal) { return $false }
    if ($principal -eq $UserSid) { return $true }
    try {
        $account = [Security.Principal.NTAccount]::new($principal)
        return $account.Translate([Security.Principal.SecurityIdentifier]).Value -eq $UserSid
    } catch [Security.Principal.IdentityNotMappedException] {
        return $false
    }
}

if ($DefineOnly) { return }

$ErrorActionPreference = 'Stop'
$local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if (!$local) { return }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($product in @('Digital Habits Blocker', 'ReDD Blocker', 'ReDD Block', 'Fristed', 'Rum')) {
    $taskName = "$product Watchdog"
    $wrapper = Join-Path $local "$product\watchdog\redd-block-watchdog.vbs"
    $task = Get-ScheduledTask -TaskPath '\' -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task -and (Test-LegacyStoreWatchdog $task $taskName $wrapper $sid)) {
        Unregister-ScheduledTask -InputObject $task -Confirm:$false
        Write-Output "Retired $taskName"
    }
}
