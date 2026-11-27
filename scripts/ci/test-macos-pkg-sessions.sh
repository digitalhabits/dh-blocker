#!/bin/bash
# Exercise the package hooks against temporary files and simulated macOS sessions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../macos-pkg/scripts" && pwd)"
FIXTURE_ROOT=$(mktemp -d)
trap 'rm -rf "$FIXTURE_ROOT"' EXIT
export FIXTURE_ROOT
export MOCK_LOG="$FIXTURE_ROOT/commands"
mkdir "$FIXTURE_ROOT/bin" "$FIXTURE_ROOT/Applications"

cat > "$FIXTURE_ROOT/bin/mock" <<'MOCK'
#!/bin/bash
set -eu
case "${0##*/}" in
    stat)
        case "$2" in
            %u) echo "$CONSOLE_UID" ;;
            %Su) echo console-user ;;
            *) exit 1 ;;
        esac
        ;;
    id)
        case "$*" in
            '-u root') echo 0 ;;
            '-u installer-admin') echo 599 ;;
            '-u console-user') echo "$CONSOLE_UID" ;;
            '-un 501') echo console-user ;;
            '-un 502') echo other-user ;;
            '-un 503') echo host-only-user ;;
            '-un 504') echo logged-out-user ;;
            *) exit 1 ;;
        esac
        ;;
    launchctl)
        case "$1" in
            print) [[ " $GUI_DOMAINS " == *" ${2#gui/} "* ]] ;;
            asuser)
                export BOOTSTRAP_UID="$2"
                shift 2
                "$@"
                ;;
            bootout) echo "bootout ${RUN_UID:-0} $*" >> "$MOCK_LOG" ;;
            *) exit 1 ;;
        esac
        ;;
    sudo)
        if [[ "$1" == "-n" && "$2" == "-H" && "$3" == "-u" ]]; then
            export RUN_UID="${4#\#}" HOME="$FIXTURE_ROOT/home-${4#\#}"
            shift 4
        else
            export RUN_UID="$2"
            shift 2
        fi
        "$@"
        ;;
    open)
        printf 'open %s %s %s %s\n' "${RUN_UID:-0}" "${BOOTSTRAP_UID:-none}" "${TMPDIR:-unset}" "$*" >> "$MOCK_LOG"
        ;;
    ps)
        if [ "$1" = "-axww" ]; then
            while IFS='|' read -r pid uid bundle _rest; do
                printf ' %s %s %s/Applications/%s\n' "$pid" "$uid" "$FIXTURE_ROOT" "$bundle"
            done < "$FIXTURE_ROOT/processes"
        else
            while IFS='|' read -r pid uid bundle args replacement; do
                if [ "$pid" = "$3" ]; then
                    if [ "$5" = 'args=' ]; then
                        printf '%s/Applications/%s %s\n' "$FIXTURE_ROOT" "$bundle" "$args"
                    else
                        printf '%s %s/Applications/%s\n' "$uid" "$FIXTURE_ROOT" "${replacement:-$bundle}"
                    fi
                    exit 0
                fi
            done < "$FIXTURE_ROOT/processes"
            exit 1
        fi
        ;;
    pgrep) exit 1 ;;
    sleep|dscl) exit 0 ;;
    pkill|kill|osascript) printf '%s %s\n' "${0##*/}" "$*" >> "$MOCK_LOG" ;;
    *) exit 1 ;;
esac
MOCK
chmod +x "$FIXTURE_ROOT/bin/mock"
for command in stat id launchctl sudo open ps pgrep sleep dscl pkill kill osascript; do
    ln -s mock "$FIXTURE_ROOT/bin/$command"
done

cat > "$FIXTURE_ROOT/bash-env" <<'MOCK'
kill() {
    "$FIXTURE_ROOT/bin/kill" "$@"
}
MOCK
export BASH_ENV="$FIXTURE_ROOT/bash-env"
export PATH="$FIXTURE_ROOT/bin:$PATH"

# Redirect machine-specific paths in copies so this never touches /Applications,
# user homes or Installer logs and can run without a GUI or elevated privileges.
new_transaction() {
    rm -rf "$FIXTURE_ROOT/transaction"
    mkdir "$FIXTURE_ROOT/transaction"
    for source in "$SCRIPT_DIR"/*; do
        sed -E \
            -e '/^exec > >/d' \
            -e "s|/var/log/redd-block-pkg-|$FIXTURE_ROOT/redd-block-pkg-|g" \
            -e "s|/Applications/|$FIXTURE_ROOT/Applications/|g" \
            -e "s|/Users/|$FIXTURE_ROOT/Users/|g" \
            -e "s@/(usr/)?(bin|sbin)/(stat|id|launchctl|sudo|open|ps|pgrep|pkill|kill)@$FIXTURE_ROOT/bin/\\3@g" \
            "$source" > "$FIXTURE_ROOT/transaction/${source##*/}"
    done
    : > "$MOCK_LOG"
    : > "$FIXTURE_ROOT/processes"
}

expect_exact() {
    local actual="$1" expected="$2"
    if [ "$actual" != "$expected" ]; then
        printf 'Expected commands:\n%s\nActual commands:\n%s\n' "$expected" "$actual" >&2
        exit 1
    fi
}

APP="$FIXTURE_ROOT/Applications/Digital Habits Blocker.app"
export USER=root SUDO_USER=installer-admin CONSOLE_UID=501 GUI_DOMAINS='501 502 503'
new_transaction
TMPDIR="$FIXTURE_ROOT/vanishing-pkg-temp" /bin/bash "$FIXTURE_ROOT/transaction/postinstall" >/dev/null
expect_exact "$(cat "$MOCK_LOG")" "open 501 501 unset $APP"

new_transaction
export CONSOLE_UID=0 GUI_DOMAINS=
/bin/bash "$FIXTURE_ROOT/transaction/preinstall" >/dev/null
/bin/bash "$FIXTURE_ROOT/transaction/postinstall" >/dev/null
expect_exact "$(cat "$MOCK_LOG")" ""

new_transaction
export USER=installer-admin CONSOLE_UID=501 GUI_DOMAINS=''
/bin/bash "$FIXTURE_ROOT/transaction/postinstall" >/dev/null
expect_exact "$(cat "$MOCK_LOG")" ""

new_transaction
export CONSOLE_UID=501 GUI_DOMAINS='501 502 503 504'
cat > "$FIXTURE_ROOT/processes" <<'PROCESSES'
101|501|Digital Habits Blocker.app/Contents/MacOS/redd-block|
102|502|ReDD Blocker.app/Contents/MacOS/redd-block|
103|503|Fristed.app/Contents/MacOS/redd-block|mindshield@example.com
104|504|ReDD Block.app/Contents/MacOS/ReDD Block|
105|501|Digital Habits Blocker.app/Contents/MacOS/redd-blocker|
106|502|Different Product.app/Contents/MacOS/redd-block|
107|502|ReDD Blocker.app/Contents/MacOS/redd-block||Different Product.app/Contents/MacOS/other
PROCESSES
mkdir -p "$APP" "$FIXTURE_ROOT/Applications/ReDD Blocker.app"
mkdir -p "$FIXTURE_ROOT/home-502/Library/LaunchAgents"
legacy_plist="$FIXTURE_ROOT/home-502/Library/LaunchAgents/Fristed.plist"
current_plist="$FIXTURE_ROOT/home-502/Library/LaunchAgents/com.reddblock.plist"
: > "$legacy_plist"
printf '%s\n' "$APP/Contents/MacOS/redd-block" > "$current_plist"

/bin/bash "$FIXTURE_ROOT/transaction/preinstall" >/dev/null
export GUI_DOMAINS='501 502 503' # User 504 logged out during installation.
/bin/bash "$FIXTURE_ROOT/transaction/postinstall" >/dev/null
expect_exact "$(cat "$MOCK_LOG")" "kill -TERM 101
kill -TERM 102
kill -TERM 103
kill -TERM 104
kill -KILL 101
kill -KILL 102
kill -KILL 103
kill -KILL 104
open 501 501 unset $APP
bootout 502 bootout gui/502 $legacy_plist
open 502 502 unset -g $APP"
[ ! -e "$legacy_plist" ]
[ -f "$current_plist" ]
[ ! -e "$FIXTURE_ROOT/Applications/ReDD Blocker.app" ]

echo 'macOS package session fixtures passed'
