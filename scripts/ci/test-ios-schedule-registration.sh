#!/usr/bin/env bash
# Compiles and runs the Foundation-only schedule-registration tests on the host.
# The plugin itself imports DeviceActivity and cannot run off-device, so only the
# pure decision source is compiled here.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

swiftc \
  -o "$temporary_dir/schedule-registration-tests" \
  "$repository_root/tauri-plugin-screentime/ios/Sources/ScheduleRegistration.swift" \
  "$repository_root/test/ios/ScheduleRegistrationTests.swift"

"$temporary_dir/schedule-registration-tests"
