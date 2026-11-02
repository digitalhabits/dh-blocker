# Desktop native enforcement: validation record

## Scope after the split

This layer removes desktop extension integration while retaining native browser
blocking, worker health and actionable macOS permission recovery. It contains no
website failure grace, warning acknowledgement, redirect-confirmation state
machine, countdown UI or browser termination executor. The dependent recovery
PR owns that machinery and its real-browser validation. App blocking retains its
existing independent grace and quit behaviour.

**Not release-approved.** Automated policy and UI checks do not establish native
browser reliability. In particular, a successful redirect command does not prove
that the browser reached the block page.

## Required browser and platform evidence

| Gate | Windows | macOS |
|---|---|---|
| Fresh install and legacy-settings upgrade preserve rules, schedules, pauses and challenges | Pending installed test | Pending installed test |
| Supported browsers redirect and restore exact original URLs | Pending runtime | Pending runtime |
| Private/multiple windows and typing/focus races | Pending runtime | Pending runtime |
| Required permission grant, denial, revocation and recovery | Elevated-browser access pending | Automation and Accessibility pending |
| Firefox accessibility warm-up | Pending runtime | Pending runtime |
| App restart/package update with pending restores | Pending signed install | Pending signed install |
| App/browser CPU, lock/display/session transitions | Pending measurement | Pending measurement |
| Packaging | Installed MSIX and certification pending | Signed installed build pending |

The dependent recovery PR additionally validates warning delivery, grace
cancellation, browser identity, repeated redirect failure and termination. These
are not acceptance criteria for the diagnostics-only implementation here.

iOS Screen Time and Android native plugin enforcement are unchanged by this
split. Native builds and physical-device enforcement still require their own
checks; an Android web bundle does not prove Accessibility blocking.

## Upgrade ownership boundary

Cleanup removes only app-owned native-host manifests, registration entries and
owned extension-installation hints, idempotently. It must not edit browser
profiles, uninstall user extensions or change organisation policy. Existing
extensions may retain standalone or cached behaviour; the app no longer controls
or updates them.

## Evidence provenance

The pre-split implementation had Windows Rust, Tier 2 and MSIX resource checks.
Those results apply to the pre-split source and are not a Windows pass for this
new revision. The current split is checked separately before publication.
Real-browser validation remains pending unless a result explicitly names the
browser, platform, revision and command. The manual checks are in
[section 10](../scripts/manual-test-checklist.md#10-native-website-diagnostics-and-recovery).

## Split verification on macOS

Against the split working tree based on `a3fce194`:

- Tier 0: 218 passed; Tier 1: 572 passed using cached Chromium 1243 because the
  current Playwright browser download was blocked by the network allowlist.
- `cargo test --lib --locked`: 131 passed, 2 ignored; default-feature Clippy
  with `-D warnings` and both Rust formatting graphs passed.
- ESLint: zero errors; desktop and Android Vite builds and Android bundle
  pruning passed. Native Windows, iOS and Android enforcement was not run.
- The actual revoked-permission fixture rendered a 1064-by-64 warning at an
  1100-by-900 viewport, with a visible recovery action; screenshot inspected.

These checks verify the split and recovery UI, not real-browser redirects.
