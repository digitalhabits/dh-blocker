# Native browser recovery: validation record

Stacked on PR #214. This layer owns redirect confirmation, visible-warning
acknowledgement, the 60-second recovery grace, countdown UI and the dormant
browser-termination executor. Worker health and permission recovery remain in
the base. All production termination signals remain disabled.

## Release status

**Not release-approved.** Source removal and automated checks do not establish
native browser reliability. No OS failure signal may enable browser quitting
without actual browser validation. Unvalidated signals remain diagnostic-only.

The native website failure grace is **60 seconds**, separate from the independent
app-blocking grace. A warning must name the browser, explain the failure and
recovery action, and accurately state whether windows will close. Diagnostic-only
signals must not display a countdown promising a quit that cannot happen.

The countdown starts only after the warning is visible in the app and the
backend acknowledges that warning ID. A notification alone is not proof that
the user saw it; hidden/covered warnings do not arm termination. Redirect
verification settles for 500 ms and requires three positive same-URL reads
200 ms apart across two attempts bound to the browser instance, policy and
target. Apple Events reads have their existing eight-second timeout, giving
one verification an upper bound of 25.1 seconds. Unknown reads cancel evidence.
The dormant executor requests polite termination, waits up to ten seconds,
then requires new positive evidence and the same process identity before force
termination. None of its production OS signals is enabled for quitting.

## Required browser evidence

| Gate | Windows | macOS |
|---|---|---|
| Fresh install and stored extension-selection upgrade preserve rules/schedules/pauses/challenges | Pending runtime | Pending runtime |
| Supported browsers redirect and restore exact original URLs | Pending runtime | Pending runtime |
| Private and multiple windows, typing/focus races | Pending runtime | Pending runtime |
| Granted/denied/revoked/recovered required permission | Elevated-browser access tests pending | Automation and Accessibility tests pending |
| Firefox launch/accessibility warm-up and bounded nudges | Disabled accessibility tests pending | Actual warm-up gap measurement pending |
| Repeated verified redirect failure, allowed navigation cancels | Pending runtime | Pending runtime |
| Warning/grace recovery; expiry/pause; browser restart; multiple browsers | Pending runtime | Pending runtime |
| Hidden app and notifications denied: visible warning without unsafe focus/input | Pending runtime | Pending runtime |
| Polite quit, bounded force quit and stale process identity rejection | Pending runtime | Pending runtime |
| App restart/package update with pending restores | Pending signed install | Pending signed install |
| App + browser CPU: idle, active block, pending restore | Pending measurement | Pending measurement |
| Actual lock/display/session transitions | Pending runtime | Pending runtime |

Unknown/unreadable/edited URLs, isolated read errors, warm-up, focus races and
missing acknowledgements never become confirmed failure merely through elapsed
time. Missing worker/resource errors require browser-specific impact before they
could qualify for quitting. Revalidate the same browser instance, active policy
and unresolved failure at grace expiry and before force quit.

## Packaging and mobile gates

- Windows: repeat block-page resource hash checks, real installed-browser
  redirects, local certification and separately track Partner Center approval.
- macOS: signed installed build, Apple Events entitlement and Accessibility
  permission behavior. Removing SafariServices must not break signing/loading.
- iOS: retain Screen Time App Group, shared Swift policy and entitlements; build
  and run policy checks on a macOS host and physical-device runtime checks.
- Android: build and JVM/Robolectric tests plus physical-device Accessibility
  checks. A frontend Android bundle alone does not prove enforcement.

## Upgrade ownership boundary

Cleanup may remove only app-owned native-host manifests/registration entries and
owned extension installation hints, idempotently. It must not edit browser
profiles, uninstall user extensions or change organisation policy. No desktop
blocklist mirror or communication loop may remain. Test with old extensions left
installed: their independent rules or cached state may continue to act, and this
app no longer controls or updates them. Their actual standalone behavior remains
an explicit runtime test, not a compatibility promise.

## Historical pre-split execution record

The following evidence predates this split and does not establish runtime
validation of the current revision. That checkout was prepared on Windows. Locked pnpm dependencies installed.
Windows Rust stable is available. No macOS/iOS runtime or physical mobile device
has been verified in this implementation session. Results below do not satisfy
the pending runtime gates above.

- `cargo test --lib` (Windows, default features): **95 passed**, rerun outside
  filesystem virtualization. The first sandbox run had six existing persistence
  test failures; all six passed in the rerun.
- Windows default-feature `cargo clippy --lib --bins --tests -- -D warnings`:
  **passed**. macOS Clippy is not executable on this Windows host.
- Frontend: **218 Tier 0 tests and 572 Tier 1 tests passed**. Tier 0 required
  an unsandboxed rerun because filesystem virtualization hid Vitest's temporary
  transformed modules. Desktop and Android Vite bundles built, and the Android
  bundle pruning check passed. This does not validate Android enforcement.
- `pnpm lint`: **zero errors, 156 warnings**. Both Rust crate graphs pass
  `cargo fmt --all --check`; `git diff --check` passes.
- Windows Tier 2 full profile: **33 passed, zero failed or skipped**, with no
  captured app errors. The isolated system-test app accepted the EULA through
  its own path and started its clock. This checks real command/persistence and
  startup paths, not actual browser redirects or OS failure signals.
- UI fixtures cover Windows onboarding/settings, macOS missing/revoked grants,
  all-granted/no-browser skips, and diagnostic/countdown warnings. Screenshots
  were rendered and inspected; OS permission prompts remain a runtime gate.
  At a 1100-by-900 viewport, browser measurements gave a 502-by-83.5 missing
  permission action region, a 1064-by-68 revoked-permission banner and a
  1064-by-49 countdown banner. Windows Settings asserts the obsolete Setup
  action is invisible; all-granted/no-browser fixtures assert setup is hidden.
- Tier 2 investigation exposed an inherited issue in `src/render.js`: its
  duplicated one-shot expiry calculation treats a 23:00-to-00:00 segment as
  ending earlier on the creation day. The shared resolver correctly spans
  midnight. The code is unchanged from the base PR; product behavior is not
  changed here. Active-schedule/pause integration fixtures use recurring
  schedules to isolate their intended assertions. A separate fix must test
  one-shot expiry across midnight on all four platforms.
- `scripts/test-msix-resources.ps1`: **3 checks passed** (correct layout/hashes,
  missing source rejection, invalid mapping rejection). This is not an installed
  MSIX or Store certification test.
- Android debug APK attempt: **blocked by environment setup**. The repository
  wrapper could not find `npx.cmd`; direct `pnpm exec tauri android build --debug
  --apk --target aarch64` reached the CLI and failed Android prerequisites. SDK
  command-line setup/NDK and Android Rust targets are not ready on this host.
- Android JVM test attempt with Android Studio's JBR and the local SDK:
  **blocked before compilation** because generated `tauri.settings.gradle` is
  absent. `tauri android init` was not run: it would overwrite committed manual
  patches. No Kotlin or mobile runtime pass is claimed.
- iOS Screen Time source, generated Apple entitlements and Android plugin source
  had no changes at the time of the mobile-boundary audit. Their native builds
  and device behavior remain unverified here.

Ambiguous legacy external-extension hints without app provenance are left alone;
their filename or extension ID alone is not sufficient ownership evidence.

## Reproducible real-browser transport check

On macOS, close Brave yourself, then run from `src-tauri`:

```bash
NATIVE_BROWSER_VALIDATION=1 cargo test --lib --locked live_brave_redirect_and_restore -- --ignored --nocapture --test-threads=1
```

This opt-in test refuses to attach while Brave is already running. It creates a
fresh profile under this worktree's ignored `artifacts/native-browser-validation/`
directory, opens a reserved `.invalid` URL, uses the production Apple Events
reader/planner/navigation path, observes the actual block-page URL and then
observes restoration of the exact original query and fragment. It does not
change production app data, existing browser profiles, TCC grants or policies.
An OS Automation prompt may require manual consent; denial fails the test.
Cleanup terminates only the child it launched. Logs and a successful `result.json`
remain in that run's directory.

A pass covers Brave's Apple Events redirect/restore transport. It does **not**
validate the failure signals, warning acknowledgement, notification delivery,
grace cancellation, process identity or termination executor. Record those
separately in the matrix above on macOS and Windows before enabling any signal.
The production `signal_validated` gate remains false for every failure type.

## Split validation status

- The diagnostics-only base was verified separately; see `docs/pr3-validation.md`.
- On this macOS host, Brave and Firefox were already running. The opt-in live check
  refused to attach with `Brave is already running; close it yourself before isolated native-browser validation`. No test browser was launched or terminated.
- Windows live-browser tests, elevated-browser access and installed-package
  tests remain pending. No Windows runtime is available in this worktree.
- Keep this PR in draft until the required real-browser evidence is recorded.

## Current split checks on macOS

- Tier 0: 223 passed; Tier 1: 572 passed using cached Chromium 1243.
- `cargo test --lib --locked`: 142 passed, 3 ignored. The new opt-in browser
  test is one of the ignored cases in the ordinary suite.
- Default-feature Clippy with `-D warnings`, both Rust formatting graphs,
  ESLint (zero errors, 157 existing warnings), desktop/Android Vite builds and
  Android bundle pruning passed.
- The synthetic countdown fixture rendered and was inspected: 1064 by 49 at
  an 1100-by-900 viewport. This is UI evidence, not OS signal validation.
- Explicit invocation of the live test failed at the already-running-Brave
  guard before launching a browser. Redirect/restore and termination validation
  remain pending; no signal was enabled and no existing browser was closed.
