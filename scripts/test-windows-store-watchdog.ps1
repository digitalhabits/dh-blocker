$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../src-tauri/windows/store-watchdog-cleanup.ps1" -DefineOnly

$taskName = 'Digital Habits Blocker Watchdog'
$local = Join-Path $env:USERPROFILE 'AppData\Local'
$wrapper = Join-Path $local 'Digital Habits Blocker\watchdog\redd-block-watchdog.vbs'
$arguments = '"' + $wrapper + '"'
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $currentUser.User.Value

function New-TaskFixture {
    @{
        TaskPath = '\'
        TaskName = $taskName
        Principal = @{ UserId = $sid; RunLevel = 'Limited' }
        Actions = @(@{ Execute = 'wscript.exe'; Arguments = $arguments })
    }
}

function Assert-Ownership($Task, [bool]$Expected, [string]$Scenario) {
    if ((Test-LegacyStoreWatchdog $Task $taskName $wrapper $sid) -ne $Expected) {
        throw "Unexpected task ownership for $Scenario"
    }
}

$task = New-TaskFixture
Assert-Ownership $task $true 'historical Store task'
$task.Principal.UserId = $currentUser.Name
Assert-Ownership $task $true 'account-name principal'

$task = New-TaskFixture
$task.Principal.UserId = if ($sid -eq 'S-1-5-18') { 'S-1-5-19' } else { 'S-1-5-18' }
Assert-Ownership $task $false 'another account'

$task = New-TaskFixture
$task.Principal.RunLevel = 'Highest'
Assert-Ownership $task $false 'elevated task'

$task = New-TaskFixture
$task.TaskPath = '\Other\'
Assert-Ownership $task $false 'same name in another task folder'
$task.TaskPath = '\'
$task.TaskName = 'Unrelated Watchdog'
Assert-Ownership $task $false 'unrelated task name'

$task = New-TaskFixture
$task.Actions[0].Arguments = '"' + (Join-Path $local 'Digital Habits Blocker\redd-block-watchdog.vbs') + '"'
Assert-Ownership $task $false 'direct-install wrapper'
$task.Actions[0].Arguments = $arguments + ' "another argument"'
Assert-Ownership $task $false 'additional arguments'
$task.Actions[0].Arguments = $arguments
$task.Actions[0].Execute = 'cmd.exe'
Assert-Ownership $task $false 'unrelated executable'

$task = New-TaskFixture
$task.Actions += @{ Execute = 'cmd.exe'; Arguments = '/c exit' }
Assert-Ownership $task $false 'additional action'
