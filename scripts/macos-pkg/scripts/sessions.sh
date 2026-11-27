#!/bin/bash
# Shared by the two PackageKit hooks.
# shellcheck disable=SC2034

APP_PATH='/Applications/Digital Habits Blocker.app'
LEGACY_REDD_BLOCKER_APP_PATH='/Applications/ReDD Blocker.app'
LEGACY_REDD_BLOCK_APP_PATH='/Applications/ReDD Block.app'
FRISTED_APP_PATH='/Applications/Fristed.app'

# PackageKit runs the hooks from the same private component scripts directory.
RESTART_UIDS_FILE="$SCRIPT_DIR/restart-uids"

is_gui_user() {
    local uid="$1"
    [[ "$uid" =~ ^[0-9]+$ ]] && [ "$uid" -ge 500 ] &&
        /bin/launchctl print "gui/$uid" >/dev/null 2>&1
}

run_as_gui_user() {
    local uid="$1"
    shift
    # asuser selects the bootstrap session but leaves the process running as root.
    /bin/launchctl asuser "$uid" /usr/bin/sudo -n -H -u "#$uid" "$@"
}
