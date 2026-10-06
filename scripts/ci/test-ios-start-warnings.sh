#!/usr/bin/env bash
# Compiles and runs the start-warning planner tests on the host, once per time zone:
# warnings follow the phone's wall clock, so clock changes and zones are part of the rules.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

swiftc \
  -module-cache-path "$temporary_dir/module-cache" \
  -o "$temporary_dir/start-warning-tests" \
  "$repository_root/tauri-plugin-screentime/ios/Sources/ScheduleData.swift" \
  "$repository_root/tauri-plugin-screentime/ios/Sources/StartWarnings.swift" \
  "$repository_root/test/ios/StartWarningPlannerTests.swift"

for zone in UTC America/New_York Europe/London Asia/Kolkata; do
  TZ="$zone" "$temporary_dir/start-warning-tests"
done
