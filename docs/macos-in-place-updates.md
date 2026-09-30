# macOS in-place updates

The macOS app updates itself in place: it downloads a signed archive of the new
`.app`, swaps the bundle and reopens. The `.pkg` remains the installer for new
users and the fallback for anything the in-place path cannot do.

## How an update runs

1. The update banner (`src/update-banner.js`) calls `download_and_run_update`
   with the version it read from `docs/latest-versions.json`.
2. `commands/app_update.rs` fetches
   `releases/download/v<version>/macos-update.json` and hands it to
   `tauri-plugin-updater`, which downloads the `.app.tar.gz`, verifies its
   minisign signature against `plugins.updater.pubkey`, and replaces the
   running bundle. The `.pkg` installs the bundle as root, so the first
   in-place update after a `.pkg` install is expected to ask for an
   administrator password (the plugin's fallback when it cannot move the
   bundle itself). The swapped-in bundle is owned by the user, so later
   updates should not ask.
3. The app spawns a small `sh` that waits for this process to exit, then calls
   `std::process::exit(0)`. The `sh` reopens the new bundle. This exit bypasses
   the quit guards on purpose (see the note at the top of `src-tauri/src/lib.rs`).
   Blocking stops for the second or two this takes, as it does during a `.pkg`
   install.

If any step fails, the running bundle is left as it was and the app falls back
to the `.pkg` and Installer.app, as it did before in-place updates existed. The
failures include no public key in the build, no manifest on the release, a bad
signature and a cancelled password prompt. A build run from outside an `.app`
(`pnpm dev`) never tries the in-place path.

`requireSignedVersion` is on, so the signature must name the same version as the
manifest. `scripts/stage-macos-updater.js` re-signs every archive with
`--app-version`, which records that version in the signature.

## What the `.pkg` still does that an in-place update does not

The `.pkg` scripts (`scripts/macos-pkg/scripts/`) clean up v1.x daemon and hosts
residue, remove legacy app bundles (`ReDD Blocker.app`, `Fristed.app`, …) and
scrub stale LaunchAgents. The app's own first-launch migration
(`commands/migration.rs`) covers the v1.x cleanup. The rest only matters when
moving from a pre-rename build, and those builds cannot update in place anyway.
They predate the updater, so they always install the `.pkg`.

## One-time setup

The committed key is minisign key ID `14BB729C5BF4A1E1` (the ID appears in the
first line of the base64-decoded `plugins.updater.pubkey`). The two repository
secrets below must hold its private half. Until they do, releases ship only the
`.pkg` and the app keeps using it. Nothing breaks in the meantime.

To set up from scratch, or to rotate the key:

1. Generate the key pair locally, and keep the private key out of the repo:

   ```bash
   pnpm tauri signer generate -w ~/.tauri/dh-blocker-updater.key
   ```

2. Commit the contents of `~/.tauri/dh-blocker-updater.key.pub` as
   `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
3. Add two repository secrets: `TAURI_SIGNING_PRIVATE_KEY` (the contents of
   the private key file) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Store the private key and password somewhere durable, such as the team
   password manager. If they are lost, installed apps can no longer verify
   new updates, and every user must install the next release from the `.pkg`.

`scripts/build-mac.sh` builds the update archive only when both the secret and
the committed public key are present. The release workflow attaches
`macos-update.json` and the archive to the GitHub Release only when they were
built.

The first release built with a public key still reaches existing users through
the `.pkg`, because their installed builds have no key. In-place updates start
from the release after that.

## Testing a release candidate by hand

In-place install cannot run in CI, which has no signed `/Applications` install
to replace. Before relying on it for a release:

1. Install the previous release from its `.pkg`.
2. Publish the candidate through the release workflow, so that its GitHub
   Release carries `macos-update.json` and the archive, and
   `docs/latest-versions.json` points at it.
3. Click the update banner. Expect an administrator password prompt, a short
   exit, the new version reopening, and the Automation and Accessibility
   grants still in place.
4. Update once more and confirm no password prompt appears, since the bundle
   is now user-owned.
