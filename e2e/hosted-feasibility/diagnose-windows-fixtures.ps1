# Explicit local entry point: compiles/starts only disposable fixtures, never Blocker.
param([switch]$ManagedBaseline, [switch]$StressHeartbeat)
$ErrorActionPreference = 'Stop'
$root = Join-Path (Resolve-Path "$PSScriptRoot/../..").Path ('artifacts/hosted-feasibility/local-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $root)
function Run-Adapter([string]$Program, [string[]]$Arguments, [string]$Log) {
    $quoted = @($Arguments | ForEach-Object { '"' + $_ + '"' })
    $adapter = Start-Process -FilePath $Program -ArgumentList $quoted -WindowStyle Hidden -PassThru -RedirectStandardOutput ($Log + '.stdout') -RedirectStandardError ($Log + '.stderr')
    $null = $adapter.Handle
    try {
        if (!$adapter.WaitForExit(12000)) { throw 'Adapter exceeded 12-second deadline' }
        $adapter.WaitForExit()
        return $adapter.ExitCode
    } finally { if (!$adapter.HasExited) { $adapter.Kill(); $adapter.WaitForExit(5000) | Out-Null } }
}
& "$PSScriptRoot/fixtures/build-native-uia.ps1" -OutputDirectory $root
$children = @()
$results = @()
try {
    foreach ($role in @('Target', 'Control')) {
        $name = 'DHProbe' + $role + '_' + [guid]::NewGuid().ToString('N')
        $directory = Join-Path $root $name
        [void](New-Item -ItemType Directory -Path $directory)
        $binary = Join-Path $directory ($name + '.exe')
        & "$env:WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo /target:winexe "/out:$binary" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll (Join-Path $PSScriptRoot 'fixtures\Probe.cs')
        if ($LASTEXITCODE -ne 0) { throw 'Fixture compilation failed' }
        Copy-Item "$PSScriptRoot/fixtures/Probe.exe.config" ($binary + '.config')
        # Visible windows are the subject of this explicit GUI diagnostic.
        $child = Start-Process -FilePath $binary -ArgumentList @(('"' + $directory + '"'), $name) -WindowStyle Normal -PassThru
        $children += $child
        $deadline = (Get-Date).AddSeconds(15)
        while (!(Test-Path "$directory/ready")) { if ($child.HasExited -or (Get-Date) -gt $deadline) { throw 'Fixture readiness failed' }; Start-Sleep -Milliseconds 100 }
    }
    foreach ($child in $children) {
        $directory = Split-Path $child.Path
        if ($StressHeartbeat) {
            # Hold a writer open across timer ticks to reproduce the reader side
            # of the hosted file-sharing race deterministically.
            $locked = [IO.File]::Open("$directory/request", [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { Start-Sleep -Milliseconds 650 } finally { $locked.Dispose() }
            $deadline = (Get-Date).AddSeconds(10)
            while ((Get-Date) -lt $deadline -and !$child.HasExited) {
                try { [IO.File]::WriteAllText("$directory/request", [guid]::NewGuid().ToString()) }
                catch [IO.IOException] { $_ | Out-String | Add-Content "$directory/stress-write-errors.txt" }
                Start-Sleep -Milliseconds 1
            }
            if ($child.HasExited) { throw "Fixture exited during file-sharing stress; see $directory/fixture-error.txt" }
        }
        $status = Run-Adapter powershell.exe @('-NoProfile', '-MTA', '-File', "$PSScriptRoot/fixtures/inspect-window.ps1", '-FixturePid', $child.Id) "$directory/inspection"
        if ($status -ne 0) { throw 'Inspection failed; see retained logs' }
        # A live timer alone must not save a marker; wrong identity must not invoke.
        $nonce = [guid]::NewGuid().ToString()
        [IO.File]::WriteAllText("$directory/request", $nonce)
        Start-Sleep -Milliseconds 500
        if ([IO.File]::ReadAllText("$directory/response") -ne $nonce -or (Test-Path "$directory/saved-marker")) { throw 'Independent heartbeat/GUI oracle failed' }
        $status = Run-Adapter "$root/native-uia.exe" @($child.Id, 'wrong-title') "$directory/wrong-title"
        if ($status -eq 0 -or (Test-Path "$directory/saved-marker")) { throw 'Wrong identity was not rejected' }
        foreach ($round in 1..3) {
            $nonce = [guid]::NewGuid().ToString()
            [IO.File]::WriteAllText("$directory/request", $nonce)
            if ($ManagedBaseline) {
                $status = Run-Adapter powershell.exe @('-NoProfile', '-MTA', '-File', "$PSScriptRoot/fixtures/invoke-button.ps1", '-FixturePid', $child.Id, '-WindowTitle', $child.ProcessName) "$directory/activation-$round"
            } else {
                $status = Run-Adapter "$root/native-uia.exe" @($child.Id, $child.ProcessName) "$directory/activation-$round"
            }
            Start-Sleep -Milliseconds 500
            $passed = $status -eq 0 -and (Test-Path "$directory/saved-marker") -and [IO.File]::ReadAllText("$directory/saved-marker") -eq $nonce -and [IO.File]::ReadAllText("$directory/gui-response") -eq $nonce
            $results += @{ pid=$child.Id; round=$round; nonce=$nonce; passed=$passed; adapterExit=$status }
        }
    }
} finally {
    # Only Process objects returned by this run's Start-Process; no name matching.
    $clean = $true
    foreach ($child in $children) { if (!$child.HasExited) { $child.Kill(); if (!$child.WaitForExit(5000)) { $clean = $false } } }
    @{ managedBaseline=[bool]$ManagedBaseline; results=$results; cleanup=$clean } | ConvertTo-Json -Depth 5 | Set-Content "$root/results.json"
    Write-Output $root
}
if (!$clean -or @($results | Where-Object { !$_.passed }).Count -or $results.Count -ne 6) { exit 1 }

