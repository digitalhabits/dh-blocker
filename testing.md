# Digital Habits: Blocker Testing Tiers

This document expands the `README.md` testing section with a deeper technical explanation of each tier, how to run it, what it validates, and what it does not validate.

Terminology in this file follows `README.md`:

- **Tier 0** = plain unit tests over pure `src/` helpers (vitest, no app shell)
- **Tier 1** = in-app logic tests
- **Tier 2** = in-app integration tests (desktop command-path + legacy hosts checks)
- **UI shots** = a screenshot harness, not a tier — it renders, it does not assert

There is **no Tier 3** anymore — the v1.x privileged helper daemon and its smoke-test scripts were removed in v2. The UI harness is deliberately named rather than numbered: it is cheaper than Tier 1 but higher-fidelity than Tier 2 about appearance, so it has no place on the cost ladder the numbers describe.

---

## Why we use tiers

Each tier answers a different quality question:

- **Tier 0**: Is an individual exported helper correct in isolation?
- **Tier 1**: Is our blocking logic correct as pure behavior?
- **Tier 2**: Do app → Tauri command paths, data persistence, and migration cleanup behave correctly?
- **UI shots**: Does the interface actually look right? Nothing else can answer this. Tier 0 runs in jsdom, which has no layout engine — `getBoundingClientRect()` returns zeros, so "does this label fit in this box" is unanswerable there by construction. Tier 1 loads the page but asserts only logic, and Tier 2 asserts the Rust-derived snapshot. A change to `styles.css` can be wrong in every visible way and still be green.

No single tier is sufficient on its own. **Website blocking enforcement** (macOS Automation redirects, Windows/Firefox native messaging) is validated primarily through the **manual checklist** — Tier 2 asserts the Rust-derived enforcement snapshot (`current_blocking`), which proves derivation is correct but not that a browser actually redirects.

Tier 0 and Tier 1 overlap in kind but not in reach. Tier 1 owns the
*composed* question — schedule windows, overlaps, allowlist resolution — and
runs the real runner inside a page. Tier 0 exists for the leaf functions that
composition is built out of, which previously had no home above Tier 2: things
like `normalizeUnlockMinutes` or
`isProtectedApp` are pure, are asserted in milliseconds, and do not need a
browser to be meaningful. When a case fits both, prefer Tier 1 — it is the
layer closer to observed behavior.

---

## Choosing regression coverage

Follow [AGENTS.md's verification policy](AGENTS.md#match-verification-to-risk):
match effort to behavioral risk. Small, low-risk changes do not require new
tests or a test-first workflow; run relevant existing checks and visually inspect
UI changes. For enforcement changes and substantive bug fixes, prefer a
regression test that demonstrably fails on the original code. If the test was
written after the fix, running it against the original code can still establish
that it detects the regression.

Regression coverage is especially valuable for enforcement, where the
characteristic failure mode is silence rather than an error:

- A browser-specific URL-bar quirk makes extraction return nothing. The browser
  stays in the supported map, blocking just stops working for it, and nothing
  logs an error — that is how Samsung Internet's invisible `U+200E` prefix went
  unnoticed.
- `web_automation::tests::file_url_encodes_spaces` asserted the pre-rename
  product name and could never pass. Nothing ran it, so nobody found out until
  `cargo test --lib` was wired into CI.

When adding or updating coverage, put it where CI will actually run it,
matching the layer you changed:

| What you changed | Where the test goes |
| --- | --- |
| A single pure helper in `src/` — boundaries, malformed input | `test/tier0/` (Tier 0) |
| Blocking/schedule/allowlist logic in `src/` | `src/blocking-tests.js` (Tier 1) |
| Desktop enforcement semantics — derivation, URL decisions, payloads | `#[cfg(test)]` in the Rust module |
| Command paths, persistence round-trips | `src/integration-tests.js` (Tier 2) |
| Appearance or layout regressions | reuse or add a screen in `test/ui/screens.js`, then `pnpm ui:shoot --screen=<name> --measure` and **look at it** |

Prefer the highest row that can hold the case — except that a case about
*composed* behavior belongs in Tier 1 even when its pieces are individually
Tier 0-able. Use `scripts/manual-test-checklist.md` for behavior that needs
real-system verification, such as a browser redirecting or an app being quit.
If automated reproduction is impractical, briefly explain why and record the
closest reliable verification.

**A test that names a CSS class is not a test that the UI works.** jsdom has no
layout engine, so Tier 0 cannot measure a box —
`getBoundingClientRect()` returns zeros there. Asserting that a bar gained a
`.compact` class proves the class was added, not that the result is legible, and
it stays green if the matching rule is deleted from `styles.css`. For substantive layout fixes, check *geometry* (`pnpm ui:shoot --measure`
reports what a real browser measured) and look at the screenshot. Neither half
substitutes for the other. Minor styling and copy edits need visual inspection,
but do not require a new screenshot fixture or geometry assertion when existing
screens or a direct UI check suffice.

---

## Quick run guide

- **Tier 0**: `pnpm test:tier0` (that script wraps `vitest run`, so for watch
  mode while iterating use `pnpm vitest --config vitest.config.mjs`)
- **Tier 1**
  - Start app in dev mode: `pnpm dev`
  - Trigger tests: `Cmd+Shift+T` (macOS) or `Ctrl+Shift+T` (Windows)
  - Or console: `runBlockingTests()`
  - Headless: `pnpm test:tier1`
- **Tier 2**
  - In app dev console (default fast profile): `runIntegrationTests('core')`
  - In app dev console (expanded profile): `runIntegrationTests('full')`
- **UI shots**: `pnpm ui:shoot` (all screens) or `pnpm ui:shoot --screen=week-crowded --measure`
- **Rust**: `cd src-tauri && cargo test --lib`
- **Windows address-bar smoke probe**: in Windows PowerShell, run
  `powershell -NoProfile -MTA -File scripts/test-windows-address-bar.ps1 -Browser firefox`
  (also accepts `chrome`, `msedge`, or `brave`), then foreground a disposable
  `https://example.com/` window and click the page. The probe uses the same
  UIA selectors via .NET and verifies redirect to a temporary local file and
  restore. Its page includes lookalike Firefox IDs to exercise toolbar scoping.
  This does **not** run the Rust watcher or prove policy/schedule/MSIX behavior.

---

## What runs in CI

Pull requests to `main` gate every suite; commit and release coverage is
summarized below:

| Workflow | Job | Runs | Trigger |
| --- | --- | --- | --- |
| `ci.yml` | Frontend bundle | `vite:build` | every PR, every push to `main` |
| `ci.yml` | Tier 0 unit tests | `pnpm test:tier0` — vitest over `test/tier0/**` | every PR, every push to `main` |
| `ci.yml` | Tier 1 logic tests | `pnpm test:tier1` — `runBlockingTests()` in headless Chromium | every PR, every push to `main` |
| `ci.yml` | iOS one-off activity timing | Foundation-only Swift host tests on macOS: `scripts/ci/test-ios-activity-timing.sh`, `test-ios-schedule-registration.sh`, `test-ios-schedule-data.sh`, and `test-ios-start-warnings.sh` (run in four time zones) | every PR, every push to `main` |
| `release.yml` | Checks (lint + Tier 1) | `pnpm lint`, `pnpm test:tier1` — gates all four build jobs | every release run |
| `release.yml` | macOS (.pkg) | `cargo test --lib` before signing | every release run |
| `rust-ci.yml` | Rust unit tests | `cargo test --lib` on `macos-latest` | `src-tauri/**` changes, on PRs and `main` |
| `rust-ci.yml` | Clippy (desktop) | `cargo clippy --lib --bins --tests --locked -- -D warnings` on `macos-latest` **and** `windows-latest` | `src-tauri/**` changes, on PRs and `main` |
| `e2e-ci.yml` | Tier 2 (macOS + Windows) | `runIntegrationTests('full')` against a real built app over WebDriver | Tier 2 sources, `e2e/**`, `vite.config.js`, on PRs and `main` |

Notes on the non-obvious choices:

- **`ci.yml`, `rust-ci.yml` and `e2e-ci.yml` also run on pushes to `main`.**
  PR checks run against the merge preview, not the commit that ends up on
  `main`, and there is no merge queue — two independently-green PRs can land a
  broken `main`. The push trigger is also the only coverage for commits that
  never went through a PR (direct pushes, admin merges, `release.yml`'s own
  `latest-versions.json` commit). The path filters are duplicated between the
  `pull_request:` and `push:` blocks because GitHub Actions does not support
  YAML anchors; keep each pair in sync. `cancel-in-progress` is scoped to PR
  runs so each `main` commit keeps its own verdict.
- **A release runs its own checks.** `release.yml` is triggered by a `v*` tag
  push or a manual dispatch, neither of which is a PR, so nothing else verifies
  the tagged commit before it becomes a signed installer submitted to the App
  Store and Partner Center. Its `checks` job repeats lint + Tier 1 on `ubuntu`
  and every build job `needs:` it; `cargo test --lib` rides along in the macOS
  build job, which already has the Rust toolchain and a warm cache, and runs
  before any signing certificate is imported.

- **Rust runs on macOS, not Linux.** `web_automation.rs`, `window_inventory.rs`
  and `workspace_events.rs` are `#[cfg(target_os = "macos")]`, and the
  `cfg(not(ios))` modules depend on macOS/Windows-only crates, so the
  lib does not compile on a Linux runner at all. The full Windows backend
  suite runs in the Windows desktop clippy job with `cargo test --lib --locked`,
  including method policy, shared block-page decisions, and IPC registration.
  The job also runs `pnpm vite:build`
  first — `tauri_build::build()` refuses to run when the configured
  `frontendDist` (`../dist`) is missing.
**Tier 2 runs in CI** (`e2e-ci.yml`) against a real built app, because it drives
the actual Tauri command layer and cannot run on a bare page like Tier 1. See
"Tier 2 under WebDriver" below. Running it by hand from the dev console still
works and is unchanged.

---

## Tier 0: Unit Tests

### Purpose

Tier 0 asserts individual exported helpers from `src/` directly, with no app
shell, no built bundle and no Tauri layer. It is where a leaf function's edge
cases belong — boundary values, malformed input, "exact match, not substring".

### Entry points and structure

- Cases: `test/tier0/**/*.test.js`
- Config: `vitest.config.mjs` (kept separate from `vite.config.js`, which
  carries the index.html rewriting plugins
  that mean nothing when the entry point is a test file)
- Run: `pnpm test:tier0`

### What it covers today

| File | Module under test |
| --- | --- |
| `blocklist-utils.test.js` | protected apps/domains, always-on detection, iOS Screen Time selection normalization, legacy quick-start cleanup, focus-space colours |
| `schedule-engine.test.js` | repeat classification, one-off enforcement windows, pause state, weekday indexing |
| `time-inputs.test.js` | end-time field parsing |
| `unlock-duration.test.js` | the temporary unlock menu (0 = Never … 1440), fallback to the 24 h default, what a confirmed stop does to a block or schedule in memory |

### Notes on the environment

- `environment: 'jsdom'`. Most of these modules are leaf-ish, but several
  import siblings that touch `document` at import time; jsdom means a Tier 0
  test never has to hand-roll a DOM just to get an import to resolve.
- Tests that mutate the shared `state` object must restore it (`try`/`finally`);
  vitest runs a file's tests in one module registry, so a leaked `state.appData`
  is visible to every later case in that file.

### What differentiates Tier 0

- Fastest feedback in the repo — the whole suite is well under two seconds,
  versus a Vite dev server for Tier 1 and a full app build for Tier 2.
- Proves nothing about composition or about anything reaching the Tauri layer.
  A passing Tier 0 suite and broken blocking are entirely compatible.

---

## Tier 1: In-App Logic Tests

### Purpose

Tier 1 validates logic and state-composition rules without Tauri side effects or system file mutation.

### Entry points and structure

- Runner and categories: `src/blocking-tests.js`
- Pure helper/test functions: `src/test-utils.js`
- Loaded in dev UI via script tags: `src/index.html`
- Keyboard shortcut wiring: `src/app.js` (`Cmd/Ctrl + Shift + T`)

### What it actually tests

`src/blocking-tests.js` currently covers logical categories such as:

- time-window behavior (active/future/expired),
- schedule/day/time activation (including cross-midnight),
- overlap/union semantics,
- shared-domain edge cases,
- override and override-all state transitions,
- challenge difficulty selection (including max-difficulty effective count),
- blocklist duplication (data shape, naming, override copy, schedule copy),
- protected app/domain guards,
- iOS allowlist effective-policy resolvers (Category 14, **T55–T62**).

The Category 14 tests are **logic tests, not behavior tests**: they exercise
the pure JS functions that decide what iOS Screen Time enforcement should do
(`specific-block` vs `all-except`, blocklist-wins subtraction, Apple's
50-exception cap, category-token exclusion) — constraints with no desktop
equivalent. They run in the normal desktop dev build; no iOS build, simulator,
or device is involved. Desktop's own allowlist composition rules live in Rust
and are covered by `cargo test` (see **Rust unit tests** below).

It uses mock `appData` and pure functions from `src/test-utils.js` including:

- `getBlockedDomains(...)`
- `hasAnyActiveBlocks(...)`
- `findHardestChallengeAtTime(...)`
- `simulateOverrideAll(...)`

### What differentiates Tier 1

- Very fast and deterministic.
- Excellent for regression in business logic.
- Minimal environment dependency.

### Important limitations

- Does not prove real Automation redirects (macOS) or extension blocking (Windows/Firefox).
- Does not prove app-watcher quit behavior (manual checklist covers that).
- App watcher behavior is mostly marked as manual/placeholder in this tier.

---

## Tier 2: In-App Integration Tests

### Purpose

Tier 2 validates real side effects through the same app pathways users hit:

- frontend state updates,
- Tauri command calls (`save_data`, legacy `*_via_helper` shims, `clean_hosts_file`, app-blocking commands),
- pause/resume flag propagation,
- diagnostics contract.

It does **not** run a separate helper daemon. `check_helper_status()` always reports the app itself as ready via `helper_shim.rs`.

### Entry points and structure

- Integration suite: `src/integration-tests.js`
- Exposed runner: `window.runIntegrationTests(profile)`
- Uses internals exported by app runtime:
  - `window.__REDDBLOCK_INTERNALS__` from `src/app.js`

Core internal handles used:

- `appData`
- `saveData`
- `updateHostsFile` (legacy name — does not write hosts in v3)
- `tauriAPI`
- `render`

### Current profile model

- `runIntegrationTests('core')` — fast critical checks for regular local use.
- `runIntegrationTests('full')` — `core` plus expanded non-UI coverage.

Default behavior with invalid/missing profile falls back to `core`.

### Tier 2 exact test IDs and profile coverage

### Testing Group A: One-off and schedule mechanics
- **A1**: Enforcement derivation path (start → enforced, stop → cleared)
- **A2**: One-off start/end timing
- **A3**: Schedule active-now path
- **A4**: Future schedule path (**full only**)
- **A5**: Pause/resume one-off state path (**full only**)
- **A6**: Pause/resume one-off enforcement path
- **A7**: Pause natural-expiry one-off smoke (**full only**)
- **A8**: Pause/resume schedule active path (**full only**)
- **A9**: Pause natural-expiry schedule smoke (**full only**)
- **A10**: Pause inactive schedule suppression path (**full only**)
- **A11**: Data file owns enforcement — the legacy `set_blocks_via_helper` shim is ack-only and must not affect derived enforcement (**full only**)

Expected outcome for A2–A10, A11:
- blocking and schedule state transitions succeed through save + shim command paths
- pause/resume transitions update flags and sync without errors
- short timer-smoke checks confirm automatic pause expiry clears pause flags

### Testing Group B: Multi-block overlap correctness
- **B1**: Shared-domain overlap
- **B2**: One-off + schedule same blocklist (**full only**)

### Testing Group C: Clear and override semantics
- **C1**: Scoped clear by blocklist ID (shim ack + frontend clear path)
- **C2**: Clear-all manual blocks (**full only**)
- **C3**: Max difficulty blocklist start/clear path (**full only**)

### Testing Group E: Legacy-command and diagnostics invariants
- **E1**: Clean hosts command path (v1 migration cleanup — succeeds and is idempotent; v3 never writes hosts)
- **E2**: Diagnostics contract (v3 shim: always-ready helper status, `app_version` + `backend` label)

### Testing Group F: App-block command-path checks (non-visual)
- **F1**: Set blocked apps command path (**full only**)
- **F2**: Protected app payload path (**full only**)

### Testing Group G: Blocklist management
- **G1**: Duplicate blocklist then start/clear path (**full only**)

### Testing Group H: Allowlist mode (desktop websites channel)
- **H1**: Single allowlist enforcement state
- **H2**: Concurrent allowlists union (**full only**)
- **H3**: Allowlist + blocklist overlap (**full only**)
- **H4**: Pause/resume allowlist enforcement path (**full only**)

Group H creates, starts, pauses, and clears real allow-mode focus spaces
through the same save + sync path users hit (visible in the UI as the suite
runs). Each H test runs isolated (state reset before and after, same
mechanism as A4/A5/A7–A11), so leftover blocks from earlier failing tests
cannot skew its assertions. It asserts the Rust-derived enforcement snapshot via
`get_system_diagnostics` → `current_blocking` (`allowed_domains`,
per-block `mode`, flat blocked list) — the modern allowlist-aware read-back,
not the legacy hosts payload. Per-URL block/allow decisions and
blocklist-wins subtraction are decision-time logic covered by Rust unit tests
and Tier 1 Category 14. Group H is deliberately **websites-only**: automating
allow-mode app enforcement would enroll the tester's real open apps for quit —
that surface is manual checklist section 15.

## Tier 2 profile composition

- `core`: `A1`, `A2`, `A3`, `A6`, `B1`, `C1`, `E1`, `E2`, `H1`
- `full`: `core` + `A4`, `A5`, `A7`, `A8`, `A9`, `A10`, `A11`, `B2`, `C2`, `C3`, `F1`, `F2`, `G1`, `H2`, `H3`, `H4`

## Suite behavior

1. Setup snapshots the current `appData` so the suite can restore the user's state when it finishes.
2. Tests run sequentially by selected profile.
3. Some full-only pause/schedule cases use per-test reset/setup-cleanup boundaries.
4. Teardown restores the saved snapshot, saves it, and re-syncs via legacy shim commands.
5. When profile is `full` and at least one test fails, output includes a bottom **Group failure summary** for groups `A`–`H`.

### What differentiates Tier 2

- Real Tauri command flow from UI-side code.
- Catches persistence and shim regressions missed by Tier 1.

### Important limitations

- All groups now assert the Rust-derived enforcement snapshot (`get_system_diagnostics` → `current_blocking`), not the removed v1 hosts payload. This proves derivation and command paths, **not** browser-visible redirects.
- The legacy `*_via_helper` clear/set commands are acknowledgment-only shims on v3; the real clear path is the frontend mutating app data and saving. The rewritten C/B tests exercise both (shim ack + real path); A11 pins that shim payloads alone never affect enforcement.
- Some checks are command-path assertions, not UI-visible assertions.
- Not a substitute for manual Automation TCC flows, extension install, or enforcer grace UX.
- **Tech debt:** renaming `updateHostsFile()` (legacy name; it drives v3 sync).

---

## Tier 2 under WebDriver (experimental)

Tier 2 can also be driven from outside the app by attaching a WebDriver session
to the built app's webview:

```
pnpm build:e2e-app      # app built with the test runners kept in the bundle
pnpm test:tier2         # drives runIntegrationTests('full') and fails on any failure
```

Three things make this work, and all three are easy to trip over:

- **The app must be built in `e2e` Vite mode.** Normal builds strip
  `test-utils.js` / `blocking-tests.js` / `integration-tests.js` from the
  bundle, so `runIntegrationTests` would not exist in the webview.
  `src-tauri/tauri.e2e.conf.json` swaps `beforeBuildCommand` to
  `pnpm vite:build:e2e`, which keeps the `<script>` tags *and* emits the
  three classic scripts into the output root (Vite never bundles them).
- **`e2e/specs/tier2.e2e.js` is a driver, not a test.** All the assertions stay
  in `src/integration-tests.js` so the suite remains runnable by hand from the
  dev console. The spec only waits for the harness, starts the run, polls, and
  fails on any failed case — the same contract `run-tier1-headless.mjs` has
  with Tier 1.
- **Both platforms use the embedded WebDriver server.** The app serves
  WebDriver itself via the `e2e-webdriver` Cargo feature, so there is no
  external driver to install. Windows originally used `external`
  (`tauri-driver` + msedgedriver), which is the path Tauri's CI guide
  documents, but it never established a session on a runner — `POST /session`
  timed out at 180 s, twice, with the suite never starting. The embedded server
  was already green on macOS, so both jobs share it.

**`e2e-webdriver` must never ship.** It compiles an HTTP automation server into
the binary, and in a released blocker that is a remote-control bypass of every
block the app enforces. It is an explicit opt-in feature rather than the
crate's documented `#[cfg(debug_assertions)]` gate, which would open the port
on every `pnpm dev` session. `lib.rs` additionally carries a
`compile_error!` that fails the build if the feature is ever combined with a
release profile, so the mistake is impossible rather than merely unlikely.

Tier 2 mutates real state, which is why it stays manual locally and runs on a
disposable runner VM in CI. Its test domains are all `.invalid` by
construction.

---

## UI screenshot harness

`pnpm ui:shoot` renders app screens from fixture data in headless Chromium and
writes PNGs to `artifacts/ui/` (gitignored). Driver: `scripts/ui/shoot.mjs`;
screens: `test/ui/screens.js`; fixtures: `test/ui/fixtures.js`.

It needs **no Rust toolchain, no Tauri build and no signing** — just the Vite dev
server and a Chromium. That is the whole point: it runs in seconds on a laptop,
and identically on Linux in a container or CI, so a styling change can be looked
at without building the app.

```bash
pnpm ui:shoot                                    # every screen
pnpm ui:shoot --screen=week-crowded              # one screen
pnpm ui:shoot --screen=week-crowded --measure    # also print measured geometry
```

First run on a fresh machine needs the browser once: `npx playwright install
chromium`. If you are on an image that ships its own Chromium (a dev container),
point at it with `UI_SHOOT_CHROMIUM=/path/to/chrome` instead.

### How it boots the app without a backend

The app does not start without a Tauri runtime: `app.js` awaits `loadData()`,
which is an uncaught `invoke('load_data')`, so a missing transport aborts the
whole `DOMContentLoaded` handler before anything renders. Rather than adding a
no-backend code path to `src/`, the driver fakes the transport at the browser
boundary via `page.addInitScript`, so nothing test-only ships.

The stub is deliberately tiny, and unknown commands resolve `null` rather than
throwing — that is what stops it needing an entry per command as the backend
grows. **If a screen ever needs more than a canned constant there, leave that
screen out of the harness** rather than growing the stub into a second
implementation of the backend.

Fixtures are then seeded through `window.__REDDBLOCK_INTERNALS__` (the same
`appData` / `render` / `acceptEula` contract Tier 2 uses).

### What it does not do

There are **no committed reference images and no pixel diffing**. Cross-machine
font rendering makes those flaky unless the container image is pinned, and the
maintenance tax lands on every PR. This harness takes pictures; a human or an
agent decides whether they look right.

It is therefore **not a gate** and does not run in CI today. If a gate is wanted
later, the thing to assert is *generic invariants* that hold on every screen — no
text clipped by its container, no horizontal overflow, interactive targets ≥ 24px,
contrast ≥ 4.5:1 — not per-screen expectations, which age badly and go flaky.

### Adding a screen

Add an entry to `test/ui/screens.js`; do not edit the driver. Always set
`platform` — `detectPlatform()` has no Linux branch and falls through to
Windows, so an unstamped screenshot taken on Linux silently claims to be a
Windows one. Stamping it is also how mobile-only problems become visible:
hover-dependent affordances such as native `title` tooltips do not exist on iOS
devices, and only show up as missing when the page is rendered as those.

---

## Rust unit tests

Desktop enforcement semantics live in Rust and carry their own unit tests,
run outside the app:

```
cd src-tauri && cargo test --lib
```

(Use `--lib`; bare `cargo test` currently fails compiling a stale
`test_watcher` example binary.)

Coverage relevant to blocking behavior:

- `web_automation.rs` — URL block/allow decisions, including the **desktop
  allowlist semantics**: allowlist blocks non-allowed hosts, allowlist-only
  sessions count as active web enforcement, concurrent allowlists union,
  blocklist precedence on overlap, and block-page metadata attribution
  (blocklist hit wins; else earliest-started allowlist).
- `native_host.rs` — extension payload derivation (`derive_payload`),
  including allowlist domains staying out of the legacy flat blocklist.
- `profile_scan.rs`, `window_inventory.rs`, `commands/diagnostics.rs`,
  `commands/migration.rs` — supporting surfaces.

Run these before merging changes to `web_automation.rs`, `native_host.rs`,
`app_watcher.rs`, or `enforcer.rs`. CI also runs them on every PR that touches
`src-tauri/**` (`rust-ci.yml`), so a red job there means one of these failed.

---

## Tier Comparison

- **Tier 0 (unit)**: narrow but exhaustive per helper, fastest feedback, proves nothing about composition — and it runs in jsdom, which has no layout engine, so never a claim about appearance.
- **Tier 1 (logic)**: high breadth of logic permutations, zero system mutation.
- **Tier 2 (integration)**: moderate breadth, Tauri command paths with the `current_blocking` enforcement snapshot as read-back.
- **Rust unit tests**: enforcement decision logic (URL matching, allowlist composition, payload derivation).
- **UI shots**: appearance and layout geometry, from fixtures, in a real browser. Renders; does not assert.
- **Manual checklist**: required for website enforcement, permissions, enforcer behaviour, and visual UX on real devices.

Recommended stance:

- Run Tier 0 and Tier 1 during feature work.
- Visually inspect UI changes, using relevant `pnpm ui:shoot` screens or a direct UI check. For substantive layout fixes, also check measured geometry; see [Choosing regression coverage](#choosing-regression-coverage).
- Run Tier 2 for data/sync/shim regressions; do not treat passing Tier 2 as proof of website blocking.
- Before every release, run the relevant automated system/device tests and complete the remaining applicable manual checklist cases.

---

## iOS and testing tiers

See [the repeatable iOS testing protocol](docs/ios-testing.md) for build, Simulator and connected-device commands and evidence.

iOS enforcement uses the Screen Time plugin (`tauri-plugin-screentime`).

- **Tier 1 (logic):** Runs in the app; safe on iOS. Same blocking/schedule/override logic applies. **Category 14 (T55–T62)** covers the iOS allowlist effective-policy resolvers — run it on the desktop dev build; the resolvers are shared JS and encode iOS-only constraints (Apple's 50-exception cap, `specific-block` vs `all-except`, category-token exclusion).
- **Tier 2 (integration):** Desktop-oriented; helper-dependent paths always see the shim as “ready” but do not exercise Screen Time. Use the connected-device runner for its automated iOS cases and the physical-device checklist for remaining coverage.
- **Connected-device enforcement:** the `website` profile creates a temporary date-limited rule through the app UI, verifies Safari blocking and the allowed control, observes natural expiry with Blocker backgrounded, and removes its own fixture. It uses external XCTest and CoreDevice, requires no manual test-data entry, and records assertions and evidence. Device unlock, signing and Apple's UI Automation approval can require initial user action. This profile has been verified on an iPad; physical iPhone verification remains outstanding.
- **Remaining device coverage:** authorisation, native picker/app shielding, allowlist combinations, pause/resume and long-duration or recovery scenarios remain separate checklist cases in this version of the runner. A passing website profile does not imply these passed. FamilyControls authorisation and shields do not work meaningfully in the simulator, so Simulator UI checks cannot replace device cases. See `architecture.md` §12.3 for device-validation findings and known carve-outs.

For release, run the automated physical-device profile and complete the remaining applicable cases in **section 14. iOS-Specific**, including the **14.1 iOS allowlist matrix**. Record device/OS and any cases not run; iPad evidence does not establish iPhone-specific layout or interaction coverage.

---

## Typical contributor workflow

1. Run Tier 1 during active feature work for fast feedback.
2. Run Tier 2 before merging changes that touch save/sync/shim/app-blocking command paths (Group H when touching allowlist derivation or sync).
3. Run `cargo test --lib` before merging changes to Rust enforcement code.
4. Run the connected-device iOS profile for its automated website lifecycle. Complete remaining website, permission, enforcer and release checks using the manual checklist — section 15 for desktop allowlist, section 14/14.1 for iOS.

---

## Common troubleshooting

- **Windows Rust tests exit with `0xc0000139` before running any tests:**
  - The dialog plugin imports `TaskDialogIndirect`, which requires a Common
    Controls v6 manifest. Tauri embeds its manifest only in binary targets;
    `src-tauri/build.rs` supplies one for the library test executable too.
  - Keep the binary-specific `/MANIFEST:NO` override: the app already has
    Tauri's resource manifest, and generating another produces `CVT1100`.
- **Tier 1 not running:**
  - confirm `src/index.html` includes `test-utils.js` and `blocking-tests.js`.
  - confirm shortcut handler in `src/app.js` is active in current build.
- **Tier 2 failing with "current_blocking missing from system diagnostics":**
  - confirm the `get_system_diagnostics` command is registered and `tauriAPI.getSystemDiagnostics` exists in `src/app.js`.
- **Tier 2 failing at setup/teardown:**
  - confirm `window.__REDDBLOCK_INTERNALS__` exports are present from `src/app.js`.

### Windows MSIX resource staging

Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-msix-resources.ps1`.
This needs no compiler, Windows SDK or Store credentials. It exercises the same
staging script as `build-msix.ps1`, checks all three real block-page assets and
hashes in a path containing spaces, and rejects missing sources and incorrect
runtime mappings. Windows Rust CI runs it, including on `scripts/*msix*.ps1`
changes. This does not prove that installed browsers can read `WindowsApps`;
use the packaged-install checks in `scripts/manual-test-checklist.md`.
