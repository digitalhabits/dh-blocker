# Developer guide

For an introduction to the app and setup guidance, see the [README](README.md).
For implementation details, see [architecture.md](architecture.md); Part I describes the current architecture.

## Local Development

### Prerequisites

- [Node.js](https://nodejs.org/) (see `engines` in [package.json](package.json) for supported versions)
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- [Tauri CLI](https://tauri.app/start/prerequisites/)

**Windows additional requirements:**
- Visual Studio Build Tools with C++ workload

**iOS additional requirements:**
- Xcode 26.5+ (the iOS 26.5 SDK is needed for `ManagedSettingsStore.refresh`; older Xcodes fail to compile the Screen Time plugin)
- An Apple Developer account
- A physical iOS device (Screen Time APIs don't work in the simulator)

**Android additional requirements:**
- Android Studio with Android SDK, platform-tools, and NDK installed
- A configured emulator or physical Android device (`adb devices` should show it)
- Tauri Android prerequisites installed for the Rust targets used by your device/emulator

### Getting Started

```bash
# Clone the repository
git clone https://github.com/digitalhabits/dh-blocker.git
cd dh-blocker

# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Run on iOS device (opens Xcode, then press ⌘R to build)
pnpm dev:ios

# Run on Android emulator/device
pnpm dev:android
```

The app will open automatically. Hot-reloading is enabled for both frontend (Vite) and backend (Tauri).

On Android, enable ReDD Block in Android Settings -> Accessibility after the
first install.

### Building

```bash
# macOS: Universal binary (Intel + Apple Silicon) → .app
pnpm build:mac

# macOS: Wrap the .app into a signed/notarized .pkg installer
# (outputs Digital-Habits-Blocker-{version}.pkg)
pnpm build:mac-pkg

# macOS: Both in one go (.app + .pkg)
pnpm build:mac-all

# Windows: NSIS/MSI installers (x64 + ARM64) — direct download / S3
pnpm build:win

# Windows: Microsoft Store (MSIX for Partner Center upload; same pipeline as digital-habits-to-do)
pnpm build:win-store

# iOS: Build IPA for App Store upload (via Transporter)
pnpm build:ios

# Android: Build through Tauri/Gradle (release; unsigned)
pnpm build:android
```

For Android — required environment variables (`ANDROID_HOME`/`NDK_HOME`/`JAVA_HOME`,
not set by `pnpm install`), debug-APK builds, single-ABI targeting, and the
install/`adb logcat` loop — see [docs/android-build.md](docs/android-build.md).

For Store builds, set `WINDOWS_IDENTITY_NAME` and `WINDOWS_PUBLISHER` in `.env` (Partner Center → Product identity). Release tags submit the MSIX to Partner Center from CI (What’s new from `changelog.md` via `scripts/changelog-to-store-whats-new.js` — write entries per [`changelog-style.md`](changelog-style.md); see [docs/microsoft-store-ci.md](docs/microsoft-store-ci.md)). Manual upload still works from `for-distribution/<target>/`. Run `node scripts/generate-icons-from-svg.js` first if `assets/icons/1024x1024.png` is missing.

**Local sideload:** `build:win-store` MSIX files are unsigned (Partner Center signs on upload). Sign and install in an **elevated** PowerShell (cert goes in `LocalMachine\TrustedPeople`):

```powershell
pnpm sign:win-store-msix -MsixPath "for-distribution/aarch64-pc-windows-msvc/Digital-Habits-Blocker_3.1.5.0_arm64.msix" -Install
```

Also turn on **Settings → System → For developers → Developer Mode**. If `0x800B0109` persists, remove old packages first: `Get-AppxPackage *ReDDBlock* | Remove-AppxPackage`.

Built artifacts are copied to `for-distribution/` for upload or direct distribution.

### Testing

Testing is organized into automated tiers, a screenshot harness, and a manual checklist (see [testing.md](testing.md)):

**0. Unit Tests (vitest, instant)**

Pure helpers from `src/`, in isolation. No browser, no app.

```bash
pnpm test:tier0
```

**1. Unit Tests (in-app, instant)**

Tests blocking logic — time-based scenarios, overlaps, overrides, override-all state transitions, and challenge difficulty selection. No system modification.

```bash
pnpm dev                   # Start the app
# Press Cmd+Shift+T (Mac) or Ctrl+Shift+T (Windows)
# Or type in the dev console: runBlockingTests()
```

**2. Integration Tests (in-app, profile-based)**

Creates real blocks using safe `.invalid` domains and exercises app → Tauri command paths (save, pause/resume, scoped clear, app-blocking commands, migration hosts cleanup). Does **not** fully prove website blocking on v3 — use the manual checklist for Automation redirects and extension enforcement.

```bash
# In the dev console:
runIntegrationTests('core')   # default, faster critical checks
runIntegrationTests('full')   # core + expanded non-UI coverage
```

**3. UI Screenshots (headless browser, seconds)**

Renders app screens from fixture data and writes PNGs to `artifacts/ui/`. No Rust toolchain and no Tauri build — just Vite and a Chromium, so it runs on a laptop or in CI on Linux. Nothing else in the stack renders: jsdom has no layout engine, so a `styles.css` change can be wrong in every visible way and still be green.

```bash
pnpm ui:shoot                                    # every screen
pnpm ui:shoot --screen=week-crowded --measure    # one screen, with measured geometry
```

**4. Manual Checklist**

See `scripts/manual-test-checklist.md` for the full pre-release checklist. Key items: macOS Automation setup + enforcer (Safari/Chrome/Brave/Edge), Firefox/Windows extension install, hide-on-close + launch-at-login, v1.x migration cleanup, Screen Time (iOS).

## Project Structure

```
redd-block/
├── src/                          # Frontend (HTML/JS/CSS)
│   ├── index.html                # Main app layout
│   ├── app.js                    # App logic & UI
│   └── styles.css                # Styling
├── src-tauri/                    # Tauri backend (Rust)
│   ├── src/
│   │   ├── lib.rs                # App setup, tray, hide-on-close, autostart
│   │   ├── app_watcher.rs        # In-process app watcher (sysinfo poll + quit)
│   │   ├── enforcer.rs           # Compliance enforcer (Automation TCC on macOS Safari/Chromium; extension elsewhere)
│   │   ├── web_automation.rs     # macOS Automation tab blocking (Safari, Chrome, Brave, Edge)
│   │   ├── native_host.rs        # Headless native-messaging host (Windows / Firefox blocklist feed)
│   │   ├── native_host_install.rs # Registers native-messaging manifests (Windows; skipped on macOS)
│   │   ├── profile_scan.rs       # Reads browser profile files
│   │   └── commands/             # IPC commands (data, apps, migration, …)
│   ├── blocked/                  # Block page bundled for macOS Automation redirects
│   ├── entitlements.macos.plist  # macOS Automation (Apple Events) entitlement
│   ├── gen/apple/                # Generated Xcode project
│   ├── gen/android/              # Generated Android project (committed)
│   ├── tauri.conf.json           # Shared Tauri config
│   ├── tauri.android.conf.json   # Android-specific config
│   ├── tauri.ios.conf.json       # iOS-specific config
│   ├── tauri.macos.conf.json     # macOS-specific config
│   └── tauri.windows.conf.json   # Windows-specific config
├── tauri-plugin-screentime/      # iOS Screen Time plugin
│   ├── ios/Sources/              # Swift plugin (FamilyActivityPicker, ManagedSettings)
│   ├── src/                      # Rust bindings
│   └── permissions/              # Plugin permissions
├── tauri-plugin-android-blocker/ # Android AccessibilityService blocking plugin
│   ├── android/                  # Kotlin plugin + BlockerService + schedules
│   ├── src/                      # Rust bindings
│   └── permissions/              # Plugin permissions
├── browser-ext-migration/
│   ├── MIGRATION_PLAN.md         # Rollout plan + remaining-work checklist
│   ├── FUTURE_OPTIONS.md         # Parked localhost fallback + signed .pkg notes
├── scripts/                      # Build/signing (build-mac.sh, build-mac-pkg.sh, …)
├── docs/                         # GitHub Pages (version info, App Store privacy policy)
└── vite.config.js                # Vite dev server config
```

## Version Management

| Component | Version Location |
|-----------|------------------|
| **App** | `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/tauri.android.conf.json`, `src-tauri/Cargo.toml` |
| **Published versions** | `docs/latest-versions.json` (macOS, Windows, iOS, Android, plus `sha256.macosPkg` and `sizeBytes.macosPkg` for in-app macOS updates) |

Use `./scripts/bump-version.sh <version>` to update the app version in all files at once.

## Building from Android Studio

You can open `src-tauri/gen/android/` in Android Studio to inspect, run, and build the generated project. Android Studio is still building the Tauri Android app: the Gradle project invokes the Tauri/Rust build steps and packages the shared frontend assets together with the native Android plugin. Two things are required for builds from Android Studio to work:

1. **Keep the Tauri CLI running** in a terminal while you build: `pnpm tauri android dev --open`. The Gradle Rust task calls back into this process to fetch its build options; without it the build fails with a "failed to read CLI options" panic.
2. **`node`/`pnpm` and `cargo` must be on Gradle's PATH.** Android Studio launched from the Dock doesn't inherit your shell PATH, so `buildSrc/.../BuildTask.kt` is patched to prepend the nvm, cargo, and Homebrew bin directories. Note that re-running `tauri android init` regenerates that file and drops the patch — alternatively, launch Android Studio from a terminal (`open -a "Android Studio"`), which inherits your shell PATH.

