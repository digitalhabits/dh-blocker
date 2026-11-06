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

See [testing.md](testing.md) for test commands, coverage limits and visual checks,
and the [manual checklist](scripts/manual-test-checklist.md) for real browser enforcement.

## Version management

Use `./scripts/bump-version.sh <version>` to keep the app, system-test build,
Cargo lockfile and generated iOS version stamps in sync. The script owns the
list of files; do not maintain a second list here.

Published update metadata lives in [docs/latest-versions.json](docs/latest-versions.json).
For store submission, see [Microsoft Store CI](docs/microsoft-store-ci.md) and
[App Store CI](docs/app-store-ci.md).

## Data, migration and uninstall

See the architecture guide for [desktop data locations and migration](architecture.md#32-desktop-app-data-paths),
[uninstall behaviour](architecture.md#113-uninstall), and
[v1 migration](architecture.md#114-v1x-migration). The current architecture is
Part I; the later historical sections describe retired implementations.

Desktop data is per user. Old machine-wide files remain import sources for
other accounts, so do not delete them as obsolete installation debris. On macOS,
in-app uninstall removes autostart entries and native-messaging manifests;
user data is retained unless the user chooses deletion (`delete_user_data` in
`src-tauri/src/commands/uninstall.rs`).

## Building from Android Studio

You can open `src-tauri/gen/android/` in Android Studio to inspect, run, and build the generated project. Android Studio is still building the Tauri Android app: the Gradle project invokes the Tauri/Rust build steps and packages the shared frontend assets together with the native Android plugin. Two things are required for builds from Android Studio to work:

1. **Keep the Tauri CLI running** in a terminal while you build: `pnpm tauri android dev --open`. The Gradle Rust task calls back into this process to fetch its build options; without it the build fails with a "failed to read CLI options" panic.
2. **`node`/`pnpm` and `cargo` must be on Gradle's PATH.** Android Studio launched from the Dock doesn't inherit your shell PATH, so `buildSrc/.../BuildTask.kt` is patched to prepend the nvm, cargo, and Homebrew bin directories. Note that re-running `tauri android init` regenerates that file and drops the patch — alternatively, launch Android Studio from a terminal (`open -a "Android Studio"`), which inherits your shell PATH.

