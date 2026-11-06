# AGENTS.md

Guidance for coding agents (Claude Code, etc.) working in this repository.

This file is loaded on every task, so it holds only what you would get *wrong*
by exploring the repo: invariants, cross-file contracts, and the reasoning
behind decisions that look like bugs from inside a single file. If
`package.json`, a workflow file, or the code already tells you, it is not
repeated here — keep it that way when you edit this file.

## What this is

Digital Habits: Blocker is a cross-platform website/app blocker built as a
**single Tauri v2 app** (Rust backend + HTML/JS/CSS frontend) targeting macOS
11+, Windows 10+, and iOS 16+. One frontend codebase
(`src/`) drives all three platforms; enforcement differs completely per platform.
There is **no** privileged helper daemon and **no** hosts-file writing — the app
itself is the enforcement engine (v3 architecture).

**Blast radius.** Because one `src/` ships to three platforms with three unrelated
enforcement backends, the usual way a change goes wrong here is not a broken
build — it is working correctly on the platform you ran and silently changing
behavior on the other two. Before you call a change to `src/` done, say what
it does on the platforms you did not run, and say plainly which ones you could
not verify. "Tier 1 is green" is not the same claim as "iOS still blocks."

Android is maintained in [digitalhabits/dh-blocker-android](https://github.com/digitalhabits/dh-blocker-android); do not reintroduce its build or enforcement paths here.

## The product principle

The user of this app is adversarial to their own future self. They asked to be
blocked, and in a weak moment they will look for a way out — that is the entire
problem the product exists to solve. Friction is the feature, not a rough edge
to smooth.

Several parts of the codebase look like bugs until you apply this:

- The tray icon has no menu and there is no quit gesture anywhere. Both
  `RunEvent::ExitRequested` and, on macOS, an `applicationShouldTerminate:`
  hook unconditionally turn every exit route into a hide-window. A blocker the
  user can quit is a blocker the user can bypass. Do not add an escape hatch to
  either guard without a deliberate decision — `commands/uninstall.rs` calls
  `std::process::exit(0)` specifically to bypass both, and in-app uninstall
  (macOS) or the OS uninstaller (Windows) is the only intended way out.
- Override challenges (`src/override-challenge.js`) make unblocking
  deliberately effortful. Making them cheaper or skippable is a product
  regression, not an ergonomics win.
- The compliance enforcer force-quits non-compliant browsers, and is
  nonetheless **opt-in and default off** (`settings.enforcementEnabled`).
  Escalation is a choice the user makes, not one we make for them.

**The adversary is a distracted user, not a technical one.** Our users are
non-technical: the bypass we design against is the one reachable in a weak
moment through the app's own UI, not one that requires a devtools console, a
debugger, or a rebuild. That is why `window.__REDDBLOCK_INTERNALS__`
(`src/dev-internals.js`) ships unguarded in production even though it exposes
`saveData`, `acceptEula` and friends — a deliberate accepted cost, not an
oversight. Keep the bar there: adding to that object is fine, but anything that
lowers friction in a path a user can reach *without* opening a console is a
product regression. The `e2e-webdriver` / `system-test` hard stop in `lib.rs` is
the separate, stricter case — a network-reachable automation endpoint is a
bypass anyone could be walked through remotely, so it must never compile into a
release.

**Decide which way failures fall.** When enforcement cannot determine state — a
URL will not parse, a browser will not answer, a query fails — the code must
pick between blocking something it should not and allowing something it should
have blocked. Neither is automatically right, but the choice must be explicit,
and it must be written down where the next reader will see it. See the
[Samsung Internet regression](testing.md#choosing-regression-coverage)
for a failure that silently allowed blocked sites.

## Where the real documentation is

| Read this | Before you |
| --- | --- |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Set up a local build or package a release. |
| [architecture.md](architecture.md) | Touch any enforcement code. **Part I = v3 (current, start here).** Parts II/III are historical v2/v1 kept for migration context — do not reason about current behavior from them, they describe a daemon and a hosts file that no longer exist. |
| [docs/ios-testing.md](docs/ios-testing.md) | Run iOS Simulator or connected-device checks; distinguish automated cases from remaining physical-device coverage. |
| [testing.md](testing.md) | Add or debug a test. Has the full "What runs in CI" table with triggers and path filters. |

## Commands

`package.json` is the reference for what exists; only the traps are listed here.

- **Version bumps span app, system-test and generated iOS files** — use
  `./scripts/bump-version.sh <version>`; its implementation owns the file list.
  Hand-editing only the main config leaves inconsistent versions.
- **Use `cargo test --lib`**, not bare `cargo test` — the latter still tries to
  build a stale `test_watcher` example.
- Run `pnpm lint` from the repository root and `cargo fmt --all --check` in
  `src-tauri`; the latter also covers the Screen Time plugin.

### pnpm is the only supported package manager

Use pnpm so worktrees share a content-addressed dependency store instead of
copying dependencies. Keep only `pnpm-lock.yaml`: parallel lockfiles can silently
describe different dependency trees. The local `scripts/only-pnpm.js` guard
enforces the package-manager choice without fetching a guard from the registry.

The trap when converting a command: **pnpm does not strip `--`**. `npm run
tauri -- build` passes `build`; `pnpm run tauri -- build` passes `--` *and*
`build`, and the tauri CLI chokes on it. Write `pnpm tauri build` — pnpm
forwards trailing args, flags included, without the separator.

## Architecture essentials

### Single source of truth
Desktop website/app rules derive from one JSON file, `redd-block-data.json`,
stored **per user** on every platform (`~/Library/Application Support/com.reddblock/`
on macOS, `%APPDATA%\com.reddblock\` on Windows — path logic in
`src-tauri/src/commands/data.rs`). It used to be machine-wide, which on a
shared PC gave a whole family one blocklist and made writes fail for whoever
did not create the file; those locations are now import sources only, read once
per account. Do not reintroduce a machine-wide branch — two accounts resolving
to one file is the bug, not the feature. The frontend writes it via
`save_data`; every backend re-reads it. `native_host::derive_payload()` computes
effective website rules: blocklist domains always block; when any allowlist
source is active, policy is `allowed-union − blocked-union` (blocklist wins on
overlap). iOS uses its own App Group store, not this file.

### Windows browser selection contract

Digital Habits: Focus extension + native-messaging host (`native_host.rs`); the same binary runs as the host via `redd-block --native-host`. UI Automation on the foreground window (`src-tauri/src/uia_web_automation.rs`) is opt-in, except Chrome/Edge/Brave default to it when native-messaging policy is confirmed to block communication. Explicit saved choices win. Otherwise missing/invalid selections retain Extension, including upgrades. UI and backend must resolve this exception identically; policy read failures retain Extension.

### Allow-mode / allowlists
"Focus spaces" (allow only these, block everything else) exist on all platforms.
The desktop rule (blocklist wins on overlap; concurrent allowlists union) is
mirrored on iOS by **two deliberately-duplicated resolvers that must stay in
sync**: JS (`deriveIOSEffectiveWebsitePolicy` / `deriveIOSEffectiveAppPolicy` in
`src/allowlist-ios.js`) for pre-validation, Swift (`IOSPolicyResolver` in the shared
`ScheduleData.swift`) for enforcement. Changing one without the other produces a
UI that promises something enforcement will not do. See architecture.md §9.4
and §12.3. Preserve the iOS 50-item allow-mode limit in validation as well as
enforcement.

### Frontend module conventions (important, non-obvious)
`src/` is plain ES modules, no framework — and it relies on two conventions
nothing in the code will remind you of:

- Cross-module mutable state lives on the single `state` object in
  `src/state.js`, because module-level `let`s cannot be reassigned across ES
  imports.
- Module top level holds **declarations only**, never calls into other app
  modules. This is what keeps the hub↔feature import cycles safe: every
  cross-module call is a hoisted function invoked at runtime. A single top-level
  call into another module can turn a working cycle into an undefined-at-import
  crash.

- The focus-space editor (`src/focus-space-editor.js`) is **one DOM node,
  `#focus-space-editor`, moved between two hosts**: the create modal borrows it
  from the scheduler panel in `openBlocklistModal` and `closeBlocklistModal`
  returns it. The listeners in `focus-space-tags.js` and
  `focus-space-editor-fields.js` look up its ids globally, so never clone it or
  give either host its own copy —
  duplicate ids would silently bind the wrong form. `handleBlocklistSelect`
  repopulates it for the selected space, except when the id is unchanged
  (then only the lock state is resynced, so a pause or stop does not discard
  unsaved edits) or while the create modal has it.

The order-sensitive startup sequence is the `DOMContentLoaded` handler in
`src/app.js`. The `window.__REDDBLOCK_INTERNALS__` keys in `src/dev-internals.js`
are a contract with the in-app tests — renaming one breaks tests that will not
tell you why.

`src/tauri-api.js` is a compat layer. The frontend still calls legacy
`*_via_helper` command names that route through
`src-tauri/src/commands/helper_shim.rs` (mostly no-ops for website blocking; app
blocking forwards to `app_watcher`). This is dead naming, not a live daemon —
there is no `helper-daemon/` in the repo, so do not go looking for one.

### Startup gate

Enforcement startup hooks must wait for acceptance of the current EULA revision.
Preserve this ordering when changing startup or onboarding.

## Testing

Use [testing.md](testing.md) for commands, suite selection and CI coverage.
The limits and cross-platform contracts matter more than the suite names:

- Tier 2 asserts the Rust-derived `current_blocking` snapshot; it does not prove
  that a browser redirects. Use the [manual checklist](scripts/manual-test-checklist.md)
  for actual website enforcement.
- Logic tests do not render layout. Visually inspect UI changes using the
  screenshot harness described in [testing.md](testing.md).

### Match verification to risk

For enforcement changes and substantive bug fixes, add or update a regression
test and confirm it fails on the original code before applying the fix, where
practical. An existing failing test is sufficient.

Small, low-risk changes — such as copy edits, minor styling, documentation, and
behavior-preserving refactors — do not require a new test or a test-first
workflow. Run relevant existing checks and visually inspect UI changes. Add
coverage when it protects meaningful behavior; avoid tests that merely repeat
implementation details.

If automated reproduction is impractical, explain briefly and use the closest
reliable verification. Judge risk by behavioral impact, not diff size: a one-line
change to blocking, schedules, allowlists, persistence, or bypass prevention can
still need regression coverage.

See [testing.md](testing.md#choosing-regression-coverage) for test placement,
visual verification, and the failures behind this guidance.

### Interpreting green checks

Check the workflow paths and feature flags for the change being made; a green
PR can omit the relevant platform suite. Default-feature checks do not exercise
all feature-gated code. In particular, system-test data isolation needs
`cargo test --lib --features system-test --locked`, which Rust CI runs separately.
Clippy's platform jobs still use default features.

Run `cargo clippy --lib --bins --tests -- -D warnings` locally before pushing
Rust. ESLint rejects unused bindings, and the Rust crate currently allows deprecations.
Consult the lint configuration and workflows for the current exceptions rather
than extending them to silence a new problem.
