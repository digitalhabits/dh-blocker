#!/bin/bash
# Bundled elevated cleanup for the v1.x → 2.0 migration on macOS.
#
# Loaded by Rust via `include_str!` and templated with:
#   {STAGED}  — temp file holding the cleaned hosts content
#   {LIVE_HASH} and {CLEANED_HASH} — SHA-256 of the original and edited bytes,
#                                   or 'missing' when no hosts file exists
#
# DO NOT add other template placeholders without updating
# run_elevated_macos in commands/migration.rs to substitute them.
#
# Run inside `osascript do shell script "..." with administrator
# privileges`. set -e ensures any failed gate aborts before any
# destructive step. Status marker is written ONLY at the very end.
#
# Numbered exit codes (so log surfaces *which* gate failed):
#   11  daemon still registered after bootout
#   12  live hosts changed after preparation
#   13  staged or post-write hosts do not match the prepared edit
#   14  daemon file still present after rm

set -e

hash_file() {
    digest=$(/usr/bin/shasum -a 256 < "$1") || return
    printf '%s\n' "${digest%% *}"
}

legacy_daemon_present() {
    launchctl print system/com.redd.block.helper >/dev/null 2>&1 ||
        launchctl print system/org.reddfocus.redd-block-helper >/dev/null 2>&1
}

check_hosts_unchanged() {
    if [ '{LIVE_HASH}' = 'missing' ]; then
        [ ! -e /etc/hosts ] && [ ! -L /etc/hosts ]
    else
        [ "$(hash_file /etc/hosts)" = '{LIVE_HASH}' ]
    fi
}

# 1. Verify the exact staged bytes before stopping the helper.
if [ '{CLEANED_HASH}' != 'missing' ]; then
    test "$(hash_file '{STAGED}')" = '{CLEANED_HASH}' || exit 13
fi

# 2. STOP the daemon FIRST so it can't race us by re-adding markers
#    to the hosts file. bootout returns immediately, so we poll
#    launchd's own registry until it confirms the service is gone
#    (10 s ceiling). We use launchctl as the authoritative signal —
#    pgrep against the process name is unreliable here because our
#    script's own command line literally contains the helper path
#    string.
launchctl bootout system/com.redd.block.helper 2>/dev/null || true
launchctl bootout system/org.reddfocus.redd-block-helper 2>/dev/null || true
launchctl unload /Library/LaunchDaemons/com.redd.block.helper.plist 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! legacy_daemon_present; then
        break
    fi
    sleep 1
done
# Final hard check + 1 s settle so any in-flight signal handlers in
# the daemon finish their last writes before we touch hosts.
if legacy_daemon_present; then
    echo "daemon still registered after bootout" >&2
    exit 11
fi
sleep 1

# 3. Only replace hosts if it needs an edit. Prepare a sibling file
#    and check the live hash immediately before committing.
TMP=''
trap 'if [ -n "$TMP" ]; then rm -f "$TMP"; fi' EXIT
if [ '{LIVE_HASH}' != '{CLEANED_HASH}' ]; then
    TMP=$(mktemp /etc/hosts.redd-tmp.XXXXXX)
    cp '{STAGED}' "$TMP"
    test "$(hash_file "$TMP")" = '{CLEANED_HASH}' || exit 13
    chown root:wheel "$TMP"
    chmod 644 "$TMP"
fi
if ! check_hosts_unchanged; then
    echo "hosts changed while preparing migration; retry with the current file" >&2
    exit 12
fi
if [ -n "$TMP" ]; then
    mv "$TMP" /etc/hosts
    TMP=''
    test "$(hash_file /etc/hosts)" = '{CLEANED_HASH}' || exit 13

    # Flush DNS so the cleaned hosts file takes effect immediately.
    dscacheutil -flushcache 2>/dev/null || true
    killall -HUP mDNSResponder 2>/dev/null || true
fi

# 4. ONLY NOW remove the daemon's persistent state. Hosts is clean,
#    daemon is stopped — safe to make the removal permanent.
#
#    CRITICAL: do NOT `rm -rf /var/lib/redd-block` blindly. The new
#    app no longer writes there, but it still imports the user's
#    blocklist data (redd-block-data.json) out of it into their own
#    per-user store — see commands/data.rs::import_shared_data_into_per_user.
#    Deleting it before every account on the machine has launched the
#    new build loses their blocklists. We only delete the
#    daemon-specific files and leave the data file + directory in place.
rm -f /Library/LaunchDaemons/com.redd.block.helper.plist
rm -f /Library/LaunchDaemons/org.reddfocus.redd-block-helper.plist
rm -f /Library/PrivilegedHelperTools/com.redd.block.helper
rm -f /var/lib/redd-block/helper-state.json
rm -f /tmp/redd-block-helper.sock

# 5. VERIFY removal — `rm -f` is silent if the file is held open or
#    on a read-only mount. We re-stat to be sure. Note: we don't
#    check /var/lib/redd-block itself; it intentionally stays.
for f in /Library/LaunchDaemons/com.redd.block.helper.plist \
         /Library/LaunchDaemons/org.reddfocus.redd-block-helper.plist \
         /Library/PrivilegedHelperTools/com.redd.block.helper \
         /var/lib/redd-block/helper-state.json; do
    if [ -e "$f" ]; then
        echo "failed to remove $f" >&2
        exit 14
    fi
done

# 6. Reset any stale Full Disk Access (TCC) entries for com.reddblock so
#    v2.0 registers cleanly under its current code-signature
#    requirement. TCC keys entries on the signature requirement, not
#    just bundle id, so a previous build (e.g. a beta signed with a
#    different identity) can shadow the new entry and prevent the app
#    from showing up in System Settings → Privacy & Security → Full
#    Disk Access. Harmless if no entry exists. Best-effort: failure
#    here must not abort migration, hence `|| true`.
tccutil reset SystemPolicyAllFiles com.reddblock 2>/dev/null || true

# 7. Status marker — written only if every gate above passed.
if [ '{LIVE_HASH}' = 'missing' ]; then
    check_hosts_unchanged || exit 12
fi
printf 'ok\n'
