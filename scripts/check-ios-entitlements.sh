#!/usr/bin/env bash
# Fails unless the iOS app and every extension it embeds are signed with Screen
# Time (Family Controls) access and the shared App Group. Without them the
# monitor extension cannot read schedules or change blocks, so blocks only switch
# on or off when the app is opened. 3.9.0 and 3.10.0 shipped like that from CI.
# Usage: scripts/check-ios-entitlements.sh <.ipa | .xcarchive | .app>
set -euo pipefail

APP_GROUP="group.com.reddblock"
target="${1:?usage: $0 <.ipa | .xcarchive | .app>}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

case "$target" in
  *.ipa)
    unzip -q "$target" -d "$work/ipa"
    app="$(find "$work/ipa/Payload" -maxdepth 1 -name '*.app' | head -1)" ;;
  *.xcarchive) app="$(find "$target/Products/Applications" -maxdepth 1 -name '*.app' | head -1)" ;;
  *.app) app="$target" ;;
  *) echo "Not an .ipa, .xcarchive or .app: $target" >&2; exit 2 ;;
esac
[[ -n "$app" && -d "$app" ]] || { echo "No .app found in $target" >&2; exit 2; }

echo "Signing entitlements in $(basename "$target"):"
failed=0
for bundle in "$app" "$app"/PlugIns/*.appex; do
  [[ -d "$bundle" ]] || continue
  plist="$work/entitlements.plist"
  codesign -d --entitlements - --xml "$bundle" > "$plist" 2>/dev/null || : > "$plist"
  family="$(/usr/libexec/PlistBuddy -c 'Print :com.apple.developer.family-controls' "$plist" 2>/dev/null || true)"
  groups="$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.application-groups' "$plist" 2>/dev/null || true)"
  missing=()
  [[ "$family" == "true" ]] || missing+=("Family Controls")
  grep -qx "[[:space:]]*$APP_GROUP" <<<"$groups" || missing+=("App Group $APP_GROUP")
  if [[ ${#missing[@]} -eq 0 ]]; then
    echo "  ok       $(basename "$bundle")"
  else
    echo "  MISSING  $(basename "$bundle"): $(IFS=,; echo "${missing[*]}" | sed 's/,/, /g')"
    failed=1
  fi
done
exit "$failed"
