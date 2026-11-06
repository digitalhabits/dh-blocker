#!/usr/bin/env bash
# Compiles and runs the ScheduleBlockData time-rule tests on the host. ScheduleData.swift
# keeps its ManagedSettings code behind `#if os(iOS)`, so the shared model compiles
# here as plain Foundation.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

swiftc \
  -module-cache-path "$temporary_dir/module-cache" \
  -o "$temporary_dir/schedule-data-tests" \
  "$repository_root/src-tauri/gen/apple/Shared/ScheduleData.swift" \
  "$repository_root/test/ios/ScheduleDataTests.swift"

"$temporary_dir/schedule-data-tests"
