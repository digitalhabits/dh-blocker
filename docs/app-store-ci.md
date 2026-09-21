# App Store CI submit (iOS)

On tag pushes (`v*`) and optional manual Release builds, GitHub Actions builds
the App Store `.ipa` (Tauri iOS, automatic cloud signing) and submits it to
App Store Connect with What's new text from [`changelog.md`](../changelog.md),
then submits the version for review with automatic release after approval.

The submit job is independent of the S3 / GitHub Release / Microsoft Store
jobs: an App Store Connect outage does not block desktop distribution.

## What goes into iOS "What's new"

[`scripts/changelog-to-store-whats-new.js`](../scripts/changelog-to-store-whats-new.js)
is run with `--platform ios`. See [`changelog-style.md`](../changelog-style.md)
for how changelog entries are written.

It keeps:

- Bullets with **no** platform tag (apply everywhere), and
- Bullets tagged `[ios]`

from every non-empty user-facing section (**Branding**, **Focus Spaces &
Blocking**, **Performance**, **Fixes & Polish**, …). It drops:

- The entire **Internal** section
- Bullets tagged only for other platforms (`[desktop]`, `[macos]`,
  `[windows]`, `[android]`)
- Markdown emphasis (keeps the lead-in words: `- Title. Body`)
- Platform tags themselves

Legacy nested `### BY PLATFORM` → `#### iOS` sections are still understood for
older changelog entries.

Output shape:

```text
Hi folks,

This update comes with some design improvements and under-the-hood improvements.

Focus Spaces & Blocking
- …

Fixes & Polish
- …

Remember that the app is open source — keep your feedback and suggestions coming at https://github.com/ulyngs/digital-habits-blocker

Cheers,
Ulrik & all of us at Centre for Digital Habits
```

The “This update comes with…” line is copied from `changelog.md` (authors write
it and delete unused parts — see [`changelog-style.md`](../changelog-style.md)).
**Useful new features** only when something genuinely new ships; improvements
and fixes to existing behaviour are design / under-the-hood only. Section
headings are included; blank line between sections; no blank line after a
heading or between `Cheers,` and the signature. Capped at the App Store’s
4,000 character limit.

Other stores use the same script with different filters:

- `--platform windows` → untagged + `[desktop]` + `[windows]`
- `--platform macos` → untagged + `[desktop]` + `[macos]`
- `--platform android` → untagged + `[android]`

If a release has **no** iOS-facing bullets (desktop-only release), the
Publish (App Store) job logs a notice and skips submission instead of
shipping an identical build.

## One-time App Store Connect setup

1. In [App Store Connect](https://appstoreconnect.apple.com/) → Users and
   Access → **Integrations** → App Store Connect API → Team Keys, click **+**
   and create a key with the **Admin** role (required for cloud signing from
   CI; App Manager is not enough for creating provisioning profiles).
2. Note the **Issuer ID** (shown above the keys table) and the new key's
   **Key ID**.
3. Download the `AuthKey_<KEYID>.p8` private key (one-time download).
4. Base64-encode it for the GitHub secret:
   `base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy`

Both macOS jobs pin Xcode with `xcode-select` before building: the Screen
Time plugin calls `ManagedSettingsStore.refresh`, which only exists from the
iOS 26.5 SDK, so an older default Xcode on the runner would fail to compile.
Bump the path in the workflow when moving to a newer Xcode.

The same key authenticates both the build signing (Tauri passes it to
`xcodebuild -allowProvisioningUpdates`) and the fastlane submission.

The app record (com.reddblock), its Screen Time / Family Controls
entitlements, and the extension bundle IDs (com.reddblock.monitor,
com.reddblock.shieldconfiguration) already exist from manual releases —
nothing to change there.

## GitHub Actions secrets (`ulyngs/digital-habits-blocker`)

| Secret | Source |
| --- | --- |
| `APP_STORE_CONNECT_API_KEY_ID` | API key's Key ID |
| `APP_STORE_CONNECT_API_ISSUER_ID` | Issuer ID |
| `APP_STORE_CONNECT_API_KEY_P8` | base64 of the `AuthKey_*.p8` file |

These are separate from the existing macOS notarization secrets
(`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, …).

## Version and build numbers

The iOS Xcode project under `src-tauri/gen/apple` is committed and not
regenerated on build, so version stamps there go stale.
[`scripts/sync-ios-version.mjs`](../scripts/sync-ios-version.mjs) stamps the
`package.json` version (and a build number, default = version) into
`tauri.ios.conf.json`, `project.yml`, the `.pbxproj`, and the three
Info.plists. It runs:

- locally from `scripts/bump-version.sh` (commit the resulting changes), and
- in CI before every iOS build (so the IPA always matches the release tag).

App Store Connect requires a unique (version, build) pair per upload. If an
upload succeeded but you must upload a **new binary** for the same version,
re-run Release build with the `ios_build_number` input set (e.g. `3.8.5.1`).

## Workflow behaviour

[`Release build`](../.github/workflows/release.yml):

- **Tag push `v*`:** builds the IPA and submits to App Store Connect (when
  the three secrets above are set).
- **Manual run:** checkbox `submit_app_store` (default on) gates the submit
  job; the `build-ios` job always runs and its IPA is attached to the GitHub
  Release alongside the desktop installers.

Flow inside [`fastlane/Fastfile`](../fastlane/Fastfile) (`submit_app_store` lane):

1. Authenticate with the App Store Connect API key.
2. **Fail-fast preflight:** if any iOS version is already waiting for review,
   in review, or blocked by unresolved review issues, the lane exits before
   uploading. It does **not** auto-withdraw — fix App Store Connect manually,
   then re-run. (Prevents superseding an in-review version and attaching the
   wrong build, which happened when shipping over a still-queued release.)
3. `deliver`: upload the IPA, create/edit the App Store version matching
   `package.json`, set description, What's new, and promotional text on the
   primary locale (`en-GB` — English U.K., the app's primary language; not
   deliver's `"default"` key and not `en-US`) from
   [`store-listing/`](../store-listing/) + the generated What's new file,
   wait for the build to finish processing, and submit for review with
   `automatic_release: true` (goes live automatically after approval) and
   export compliance pre-answered (`ITSAppUsesNonExemptEncryption` is false
   in the Info.plist).

Listing copy (description + promotional text) is versioned in
[`store-listing/`](../store-listing/) so auto-submit does not keep shipping
stale App Store Connect text.

## Retry submit without rebuilding

If the App Store submit fails but the GitHub Release already has the `.ipa`
asset, use Actions → **App Store submission** → Run workflow with the release
tag (e.g. `v3.8.5`). That checks out current `main` (so script fixes apply),
downloads the Release IPA, and re-runs submit — no rebuild.

Two modes:

- **Upload failed** (binary never reached App Store Connect): run with
  defaults; the Release IPA is uploaded and submitted.
- **Upload succeeded, submission failed** (binary already processed): check
  `skip_binary_upload`; the existing build is attached and submitted. Leave
  `build_number` blank to use the latest build for that version.

Workflow: [`.github/workflows/app-store-submit.yml`](../.github/workflows/app-store-submit.yml).

## Local dry-run

```bash
VERSION="$(node -p "require('./package.json').version")"

# Preview the iOS What's new for the current package.json version:
node scripts/changelog-to-store-whats-new.js "$VERSION" --platform ios

# Stamp iOS versions after a bump (bump-version.sh already does this):
node scripts/sync-ios-version.mjs

# Full manual submit from a Mac with fastlane installed.
# Fill in Key ID, Issuer ID, and the path to your downloaded AuthKey_*.p8:
export APP_STORE_CONNECT_API_KEY_ID="<Key ID from App Store Connect>"
export APP_STORE_CONNECT_API_ISSUER_ID="<Issuer ID from App Store Connect>"
export APP_STORE_CONNECT_API_KEY_P8="$(base64 -i /path/to/AuthKey_<KEYID>.p8)"
pnpm build:ios
node scripts/changelog-to-store-whats-new.js "$VERSION" --platform ios --out whats_new_ios.txt
fastlane ios submit_app_store "version:${VERSION}" "ipa:for-distribution/Digital Habits Blocker.ipa" notes:whats_new_ios.txt
```

## Manual fallback

If the three secrets are missing, the App Store jobs fail fast with a clear
message. You can still build locally (`pnpm build:ios`) and upload with
Transporter, then fill in What's new by hand in App Store Connect — same as
before CI submit existed.
