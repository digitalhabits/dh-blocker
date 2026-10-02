#!/usr/bin/env bash
# Compiles and runs the Foundation-only shared schedule-store tests on the host.
# The shared store itself imports ManagedSettings and so cannot run off-device;
# only the pure read-outcome source is compiled here.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

swiftc \
  -O \
  -o "$temporary_dir/schedule-store-tests" \
  "$repository_root/tauri-plugin-screentime/ios/Sources/ScheduleStoreRead.swift" \
  "$repository_root/test/ios/ScheduleStoreReadTests.swift"

"$temporary_dir/schedule-store-tests"
