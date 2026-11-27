# Bundled elevated cleanup for the v1.x → 2.0 migration on Windows.
#
# Loaded by Rust via include_str! and templated with:
#   {STAGED}  — temp file holding the cleaned hosts content
#   {LIVE_HASH} and {CLEANED_HASH} — SHA-256 of the original and edited bytes,
#                                   or 'missing' when no hosts file exists
#
# DO NOT add other template placeholders without updating
# run_elevated_windows in commands/migration.rs.
#
# Run via Start-Process -Verb RunAs (UAC prompt). EAP=Stop ensures
# any unhandled error aborts before destructive steps. Status marker
# is written ONLY at the very end.
#
# Notes on the EAP=Continue blocks: schtasks/taskkill/ipconfig write
# to stderr when the target doesn't exist (the common case on a
# clean machine). Under EAP=Stop those stderr lines become
# terminating NativeCommandError records and abort the whole
# script. Each best-effort native-command call is wrapped in an
# EAP=Continue scope; the explicit `throw`s after each step are the
# authoritative gates.

$ErrorActionPreference = 'Stop'
$staged = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{STAGED}'))
$systemDirectory = [Environment]::SystemDirectory
$hosts = 'C:\Windows\System32\drivers\etc\hosts'
$helperTask = 'ReDD Block Helper'
$programData = if ($env:PROGRAMDATA) { $env:PROGRAMDATA } else { 'C:\ProgramData' }
# helper-state.json may exist under any historical shared-storage folder name.
$helperStatePaths = @(
    (Join-Path $programData 'Digital Habits Blocker\helper-state.json'),
    (Join-Path $programData 'ReDD Blocker\helper-state.json'),
    (Join-Path $programData 'ReDD Block\helper-state.json'),
    (Join-Path $programData 'Fristed\helper-state.json')
)

function Confirm-HostsUnchanged {
    $changed = if ('{LIVE_HASH}' -eq 'missing') {
        Test-Path -LiteralPath $hosts
    } else {
        (Get-FileHash -LiteralPath $hosts).Hash -ne '{LIVE_HASH}'
    }
    if ($changed) {
        throw 'hosts changed while preparing migration; retry with the current file'
    }
}

function Test-LegacyTaskPresent {
    # Query the root tasks to distinguish a failed query from a missing task.
    return [bool](Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -eq $helperTask)
}

# 1. Verify the exact staged bytes before stopping the helper.
if ('{CLEANED_HASH}' -ne 'missing' -and (Get-FileHash -LiteralPath $staged).Hash -ne '{CLEANED_HASH}') {
    throw 'staged hosts do not match the prepared edit'
}

# 2. Disable the legacy task before stopping the helper so it cannot
#    relaunch and rewrite hosts. Poll until the process is gone.
$helperTaskPresent = Test-LegacyTaskPresent
& {
    $ErrorActionPreference = 'Continue'
    if ($helperTaskPresent) {
        & "$systemDirectory\schtasks.exe" /Change /TN $helperTask /Disable 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'could not disable legacy scheduled task' }
        & "$systemDirectory\schtasks.exe" /End /TN $helperTask 2>&1 | Out-Null
    }
    & "$systemDirectory\taskkill.exe" /IM 'redd-block-helper.exe' /T /F 2>&1 | Out-Null
}
for ($i = 0; $i -lt 10; $i++) {
    $running = Get-Process -Name 'redd-block-helper' -ErrorAction SilentlyContinue
    if (-not $running) { break }
    Start-Sleep -Seconds 1
}
if (Get-Process -Name 'redd-block-helper' -ErrorAction SilentlyContinue) {
    throw 'helper still running after taskkill'
}

# 3. Only replace hosts if it needs an edit. Prepare a sibling file
#    and check the live hash immediately before committing.
$tmp = $null
try {
    if ('{LIVE_HASH}' -ne '{CLEANED_HASH}') {
        $tmp = $hosts + '.redd-tmp.' + [System.IO.Path]::GetRandomFileName()
        [System.IO.File]::Copy($staged, $tmp)
        if ((Get-FileHash -LiteralPath $tmp).Hash -ne '{CLEANED_HASH}') {
            throw 'staged hosts do not match the prepared edit'
        }
    }
    Confirm-HostsUnchanged
    if ($tmp) {
        [System.IO.File]::Replace($tmp, $hosts, [NullString]::Value)
        if ((Get-FileHash -LiteralPath $hosts).Hash -ne '{CLEANED_HASH}') {
            throw 'post-write hosts do not match the prepared edit'
        }
        # ipconfig can write to stderr when the DNS Client is stopped.
        & {
            $ErrorActionPreference = 'Continue'
            & "$systemDirectory\ipconfig.exe" /flushdns 2>&1 | Out-Null
        }
    }
} finally {
    if ($tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}

# 4. retire legacy scheduled task + daemon-specific files only.
#    CRITICAL: do NOT recursively delete ProgramData product folders.
#    The new app no longer writes there, but each account still imports
#    its blocklist data (redd-block-data.json) out of shared storage on
#    first launch — see commands::data::import_shared_data_into_per_user.
& {
    $ErrorActionPreference = 'Continue'
    & "$systemDirectory\schtasks.exe" /Delete /TN $helperTask /F 2>&1 | Out-Null
}
foreach ($helperState in $helperStatePaths) {
    Remove-Item -LiteralPath $helperState -Force -ErrorAction SilentlyContinue
}

# 5. VERIFY removal.
if (Test-LegacyTaskPresent) { throw 'scheduled task still present' }
foreach ($helperState in $helperStatePaths) {
    if (Test-Path -LiteralPath $helperState) { throw "helper-state.json still present: $helperState" }
}

# 6. status marker — written only after every gate above passed.
if ('{LIVE_HASH}' -eq 'missing') { Confirm-HostsUnchanged }
exit 42
