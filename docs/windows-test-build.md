# Local Windows test builds (x64)

The SDK/compiler installed during Windows validation remain installed. The
workflow is now tracked in the repository; it needs no Partner Center identity.

On a fresh PC install Node matching `package.json`, pnpm, Rust stable MSVC, and
Visual Studio 2022 Build Tools with the **Desktop development with C++** workload
(including the Windows SDK). Ensure `node`, `pnpm`, and `cargo` are on PATH,
restart the terminal after installation, and run `pnpm install`.

The toolchain used in this session can be installed with:

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet --wait --norestart"
winget install --id Rustlang.Rustup --exact
winget install --id OpenJS.NodeJS.LTS --exact
rustup target add x86_64-pc-windows-msvc
rustup component add clippy rustfmt
```

Install the pnpm version recorded in `packageManager` in `package.json`.
The SDK must provide `makeappx.exe` and `signtool.exe` beneath
`C:\Program Files (x86)\Windows Kits\10\bin`; this session used SDK
10.0.26100.0. Build caches use the shared location resolved by
`scripts/build-env.js`, so subsequent builds can reuse compiled dependencies.

```powershell
pnpm build:win-test
pnpm build:win-test -Sign
# Run in an elevated PowerShell for certificate trust and installation:
pnpm build:win-test -Install
```

Each command builds a normal release binary for x64 and packages it as MSIX.
The launcher name follows `productName` in `src-tauri/tauri.conf.json`, with
` (Test)` appended, so future product renames retain the distinction. The
in-app window title is unchanged. The package identity remains
`DigitalHabits.Blocker.LocalTest`, signed with `CN=Digital Habits Local Test`;
production `.env` identities are ignored during test packaging/signing.

Outputs live under `for-distribution/x86_64-pc-windows-msvc/` with a
`Digital-Habits-Blocker-Test_` prefix. The fourth version component increments
past installed test packages and existing outputs without changing the source
version. Keep outputs if uninstalling, to preserve that revision history.
Do not run two packaging commands concurrently. Test packages omit the
package-managed startup task. Never upload these packages to Partner Center.

**The separate package identity does not isolate app data or enforcement.**
Use a separate Windows account/VM for clean tests. On your normal account,
back up `%APPDATA%\com.reddblock` and `%LOCALAPPDATA%\Digital Habits Blocker`
before testing; stop the production instance before launching Test. Native
messaging registration and settings are shared. After testing, stop Test,
restore your backup, and launch production to restore its registration. Do
not run both instances together. Installation alone does not launch the app.

For checks, consult `testing.md` and `scripts/manual-test-checklist.md`.
At minimum run lint, Tier 0, Tier 1, Windows `cargo test --lib`, and default
feature Clippy. An MSIX build proves packaging, not browser redirect/restore,
CPU/power behavior, clean-account operation, or Store certification. Validate
those separately on the installed package. This workflow does not enable
WebDriver or system-test release features and does not cover ARM64.
