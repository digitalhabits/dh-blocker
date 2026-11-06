# iOS testing

Run the automated website lifecycle on a connected iPad or iPhone. Unlock the device, get its explicit identifier from `xcrun devicectl list devices` and run:

```sh
node scripts/ios-test/run.mjs device-full --device "$DEVICE" --profile website
```

The signed external XCTest drives the installed Blocker and Safari. Approve Apple's **XCTest Enable UI Automation** prompt if it appears. The run uses the English Blocker and Safari labels and requires Screen Time to be authorised already.

| Gate | Evidence |
| --- | --- |
| Host | Tier 0/1, the four Foundation-only Swift suites, production frontend build, measured iPhone/iPad Chromium fixtures. Inspect the PNGs as well. |
| Simulator | An unsigned Tauri archive compiles the app and both Screen Time extensions. Installing it on explicit iPhone and iPad simulators checks real WKWebView layout. |
| Unsigned device compile | Compile the native app and extensions without signing or requiring an installed Simulator runtime. Used by PR CI; cannot be installed on the iPad. |
| Signed device build | Release app and extensions have the expected bundle IDs, valid Apple Development profiles, Family Controls and shared App Group entitlements. |
| Store export | App Store export, with entitlement checks on both archive and IPA. Run with the distribution identity and profiles. |
| Physical iPhone/iPad | Automated Safari restriction and expiry with a run-owned schedule. Separate checklist cases cover Screen Time authorisation, app shields and the picker. |

Use [the physical-device checklist §14.0–14.4](../scripts/manual-test-checklist.md#14-ios-specific-physical-device-only) as the case definitions. The quick change gate for shared layout is host plus Simulator. For native registration, run the corresponding physical cases. For a signing or packaging change, add the Store export gate.

## Setup and build

From this worktree on macOS, with the Node version from `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
node --test scripts/ios-test/*.test.mjs
node scripts/ios-test/run.mjs host
```

On an Intel Mac use `x86_64-apple-ios` for Simulator. Use full Xcode and the release workflow's Xcode version where available. Set `DEVELOPER_DIR` to override it. The runner records the Xcode and SDK in use, including any deviation and the scoped SwiftPM native-build workaround for Xcode 27. Xcode services, Keychain and the local browser server may require a terminal outside a restrictive sandbox.

```sh
xcrun devicectl list devices
node scripts/ios-test/run.mjs preflight --device "$DEVICE"
node scripts/ios-test/run.mjs build --device "$DEVICE"
node scripts/ios-test/run.mjs build --mode simulator
node scripts/ios-test/run.mjs build --mode unsigned-device
node scripts/ios-test/run.mjs build --mode store
```

`DEVICE` must be the explicit UDID or CoreDevice identifier. Pair and trust the device, enable Developer Mode and unlock it. The same Apple Development identity must have profiles for the app, monitor and shield, with Family Controls, the shared group and the selected UDID. Open Xcode to provision profiles if preflight reports a missing target. A physical build uses Release and verifies the signed archive before any installation. The Store lane requires separate distribution profiles and verifies the archive and exported IPA. The build commands write local artefacts only.

Every command prints its report path under ignored `artifacts/ios-test/`. The report records source SHA and the dirty-source hash, tool versions, build configuration, executable hashes and embedded profile expiry where applicable. Preserve the report directory with its logs and screenshots. It can contain private device identifiers and images. A failed command or a pending required observation exits non-zero.

## Simulator layout

Build with `--mode simulator`, then select an explicit iPhone or iPad UUID from `xcrun simctl list devices`. Use the app directory from the corresponding build report:

Tauri requires a Simulator runtime matching the selected Xcode SDK. Preflight reports a missing runtime before building; an unsigned device build remains available for compilation-only checks. Simulator failures caused by missing runtimes are not evidence of an app regression.

```sh
xcrun simctl boot "$SIMULATOR"
xcrun simctl bootstatus "$SIMULATOR" -b
xcrun simctl install "$SIMULATOR" "$SIMULATOR_APP"
xcrun simctl launch "$SIMULATOR" com.reddblock
xcrun simctl io "$SIMULATOR" screenshot "$SCREENSHOT"
```

Walk through the UI that the simulator exposes and inspect portrait/landscape, the focus-space controls and the editor where available. Record any Screen Time onboarding gate that prevents reaching a screen. Simulator WKWebView evidence covers only the screens reached. The Chromium profile renders fixtures with a mocked backend to cover more screens and measures horizontal overflow.

## Physical smoke

Default to the installed build. Its source identity is unverified when there is no build receipt.

```sh
node scripts/ios-test/run.mjs device-smoke --device "$DEVICE"
```

For an explicitly authorised in-place upgrade, first collect the current app version, focus-space rules/settings and one already restricted and one allowed Safari page. Record whether an app-data backup was possible. Pass the exact device build report and baseline observation. If installation fails, preserve the existing app and report the blocker.

```sh
node scripts/ios-test/run.mjs device-smoke --device "$DEVICE" \
  --build "$BUILD_REPORT" --baseline "$BASELINE_NOTE"
```

Inspect the launch capture. Record the rule/control comparison as `upgrade-continuity` and background, manual swipe-away and relaunch as `relaunch`. Continuity and new registration are separate cases. CoreDevice inventory checks version, build number, developer signing flag and install location at the start and end of each interaction. It cannot re-hash an installed App Store bundle. If iOS replaces the app during the run, start again with an updated baseline.

Every assisted case uses the same recording command. Include a screenshot, video or contemporaneous observation log. Record the observation, expected result and relevant timestamps in the note:

```sh
node scripts/ios-test/run.mjs device-smoke --device "$DEVICE" --report "$RUN_REPORT" \
  --case relaunch --status PASS --note "$OBSERVATION" --evidence "$EVIDENCE"
```

Use `FAIL` for an observed incorrect result, `BLOCKED` for an unavailable prerequisite and `NOT_RUN` for a skipped case. `NOT_APPLICABLE` is assigned by the runner for OS-gated cases. A physical report with required cases left open stays non-green. A full run uses the same recording command with `device-full`. Use `--capture` with the report to take a screenshot at an assisted step.

## Automated fresh website registration

The website profile builds and installs its separately signed driver. It runs against the existing Blocker installation by default. Add `--build "$BUILD_REPORT"` for an explicitly authorised same-ID update from a verified device build. A run with an existing install reports its app source revision as unverified. Upgrade continuity is a separate case.

On the first run, Xcode may need to provision the driver's app ID. With an authenticated Xcode account for the project team, add `--provision-driver` to allow Xcode to obtain the test runner profile. The website check does the following:

1. Open `example.org` and `example.com` in Safari via CoreDevice. XCTest verifies the visible host and loaded page. If either is already blocked or fails to load, stop before creating a fixture.
2. Create a uniquely named block-mode focus space for only `example.org`. Set a 20-minute window already in progress, limited to today. Verify the times and date before saving.
3. Verify Safari shows the system restriction for the target, while the control still loads.
4. Keep Safari in the foreground through the real schedule boundary. Verify both sites load after expiry.
5. Return to Blocker, switch off the run-owned Flexible schedule outside its blocking window, and delete only the exact named fixture. Save the XCTest result and its screenshots in the report directory.

After an interruption, leave any test fixture to expire and rerun cleanup against the original report:

```sh
node scripts/ios-test/run.mjs device-full --device "$DEVICE" --report "$RUN_REPORT" --recover
```

Recovery closes a matching unsaved draft or removes the expired, named fixture. It keeps the original test verdict. Open the `.xcresult` to inspect failures and observations. Other physical scenarios retain their own checklist case status.

## Remaining physical cases

- **§14.0 `14.0-picker`**. Use an owned block-mode fixture and a harmless app outside Always Allowed. Verify native picker edits preserve the enforced selection floor, and observe the app shield and subsequent return.
- **§14.1 `14.1-allowlist`**. Use the dedicated-device lane for the allowlist, overlap, Stop all and legacy-data matrix.
- **§14.2 `14.2-availability` / `14.2-token-refresh`**. On older iOS verify startup and a genuine schedule transition. Use a dedicated iOS/iPadOS 26.5+ device for token refresh and corruption/reselection.
- **§14.3 `14.3-pause-resume` / `14.3-long-failure`**. Use a run-owned fixture, complete the real challenge, observe pause, automatic reblock while Blocker is backgrounded, and Resume now. Repeat timed manual and schedule variants from the checklist. Use the dedicated lane for next-day, midnight, sleep-window and registration-failure cases.
- **§14.4 `14.4-schedule-boundaries` / `14.4-notifications` / `14.4-persistence`**. Use a future run-owned schedule with a window of at least 15 minutes. Verify both enforcement boundaries in Safari while Blocker is closed and record expected and actual times. Use the dedicated lane for notification permissions and timing, overlapping cases, reboot and time zone.

Keep dedicated-device observations alongside the checklist and identify the OS, artifact and case. Never uninstall, clear data, revoke permissions, change the clock/time zone, use Stop all or weaken an existing rule on a personal device. Keep profile expiry in view when leaving a development build installed. If returning to the Store build, use a supported same-ID update path and verify rule continuity before making any device changes.

## External UI driver probe

The separate `scripts/ios-test/driver` XCUITest project has a read-only accessibility probe for an already installed Blocker and foreground Safari. It is independent of the generated Tauri project. First install the Simulator app as above, then run:

```sh
xcodebuild -project scripts/ios-test/driver/Driver.xcodeproj -scheme Driver \
  -destination "platform=iOS Simulator,id=$SIMULATOR" \
  -derivedDataPath artifacts/ios-test/driver-build \
  -resultBundlePath "$DRIVER_RESULTS" -parallel-testing-enabled NO \
  -only-testing:Driver/Driver/testReadWebViewAndCaptureSafari test
```

Use a fresh `.xcresult` path. For a physical experiment, select `platform=iOS,id=$DEVICE` and supply `DEVELOPMENT_TEAM=JD647S9RT6` with a provisioned driver identity. The runner app needs separate signing. Inspect the attachments in Xcode. This probe checks accessibility and capture only. The automated website lifecycle uses a separate test in the same project.
