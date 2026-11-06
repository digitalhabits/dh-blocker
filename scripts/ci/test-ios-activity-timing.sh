#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

swiftc \
  -module-cache-path "$temporary_dir/module-cache" \
  "$repo_root/tauri-plugin-screentime/ios/Sources/OneOffActivityTiming.swift" \
  "$repo_root/tauri-plugin-screentime/ios/Sources/ScheduleData.swift" \
  "$repo_root/test/ios/OneOffActivityTimingTests.swift" \
  -o "$temporary_dir/one-off-activity-timing-tests"
"$temporary_dir/one-off-activity-timing-tests"
