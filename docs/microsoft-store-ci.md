# Microsoft Store CI submit

On tag pushes (`v*`) and optional manual Release builds, GitHub Actions builds
unsigned Store `.msix` packages and submits them to Partner Center with What’s
new text from [`changelog.md`](../changelog.md). Partner Center re-signs the
packages on ingest.

The submit job is independent of the S3 / GitHub Release job: a Partner Center
outage does not block macOS or direct Windows distribution.

## One-time Partner Center / Entra setup

App update APIs are supported for **free** Store products (Digital Habits: Blocker stays
free to download).

1. In [Partner Center](https://partner.microsoft.com/), ensure a Microsoft Entra
   tenant is associated with the account  
   (Account settings → Organizations / tenant association).
2. In [Entra admin center](https://entra.microsoft.com/), register an application
   (App registrations → New registration). Note the **Application (client) ID**
   and **Directory (tenant) ID**.
3. Under Certificates & secrets, create a **client secret** and copy the value
   immediately.
4. Back in Partner Center → Account settings → User management →
   **Microsoft Entra applications**, add that app and assign the **Manager**
   role.
5. Copy your **Seller ID** (Account settings → Identifiers). It is a
   **number** (digits only) — not the Publisher GUID, not `CN=…`, not the
   Store `9…` ID.
6. Copy the app’s **Store ID** (Apps and games → Digital Habits: Blocker → Product
   identity / Store listing URL segment, e.g. `9P…`).

## GitHub Actions secrets (`digitalhabits/dh-blocker`)

Add these repository secrets (separate from Trusted Signing `AZURE_CLIENT_*`
and from package identity `WINDOWS_IDENTITY_*`):

| Secret | Source |
| --- | --- |
| `AZURE_AD_TENANT_ID` | Entra Directory (tenant) ID |
| `AZURE_AD_APPLICATION_CLIENT_ID` | Entra Application (client) ID |
| `AZURE_AD_APPLICATION_SECRET` | Entra client secret value |
| `SELLER_ID` | Partner Center **Seller ID** (numeric, e.g. `1234567`) |
| `MS_STORE_PRODUCT_ID` | Store product ID (`9P…`) |

Existing Store **package identity** secrets (already used by `build:win-store`):

- `WINDOWS_IDENTITY_NAME`
- `WINDOWS_PUBLISHER`
- `WINDOWS_PUBLISHER_DISPLAY_NAME`

## Workflow behaviour

[`Release build`](../.github/workflows/release.yml):

- **Tag push `v*`:** always builds MSIX and submits to the Store (when the five
  secrets above are set).
- **Manual run:** checkbox `submit_microsoft_store` (default on). Submission
  only runs when that box is checked **or** `create_github_release` is checked
  (same gate as creating a Release); tag pushes always submit.

Flow inside [`scripts/submit-microsoft-store.ps1`](../scripts/submit-microsoft-store.ps1):

1. Bundle x64 + ARM64 `.msix` into one `.msixbundle` (`makeappx`).
2. Build What’s new from the changelog section
   ([`scripts/changelog-to-store-whats-new.js`](../scripts/changelog-to-store-whats-new.js)
   `--platform windows`) — see [`changelog-style.md`](../changelog-style.md).
   Includes untagged bullets plus `[desktop]` / `[windows]`; excludes
   **Internal** and other-platform tags; keeps lead-in text without markdown
   asterisks; wraps with the standard Hi folks / open-source / Cheers footer.
   Legacy `### BY PLATFORM` nesting is still supported for older entries.
3. `msstore publish <bundle.msixbundle> -id <productId> -nc` — upload only.
   (`publish` recreates the pending draft, so metadata must come *after* this.
   Pass the package **file** as the path; do not use `-i` with a file.)
4. `msstore submission get` → stamp `releaseNotes` (same What's new format as
   iOS) and listing `description` from
   [`store-listing/description.txt`](../store-listing/description.txt), and
   mark every existing package except the new bundle as `PendingDelete`
   (Partner Center best practice: drop superseded `.msix` / older bundles) →
   `msstore submission update`.
5. `msstore submission publish` — commit for certification. Live availability
   follows the app’s Partner Center publishing schedule after certification.

If What’s new / package cleanup fails after upload, the script still commits
and warns loudly (fix listings/packages in Partner Center if needed).

## Local dry-run (credentials)

On a machine with the [Microsoft Store Developer CLI](https://github.com/microsoft/msstore-cli):

```powershell
msstore reconfigure `
  --tenantId $env:AZURE_AD_TENANT_ID `
  --sellerId $env:SELLER_ID `
  --clientId $env:AZURE_AD_APPLICATION_CLIENT_ID `
  --clientSecret $env:AZURE_AD_APPLICATION_SECRET

msstore apps list
msstore submission get $env:MS_STORE_PRODUCT_ID
```

## Retry submit without rebuilding

If Partner Center submit fails but the GitHub Release already has `.msix`
assets, use Actions → **Microsoft store submission** → Run workflow with the release tag
(e.g. `v3.8.4`). That checks out current `main` (so script fixes apply),
downloads the Release packages, and re-runs submit — no macOS/Windows rebuild.

Workflow: [`.github/workflows/store-submit.yml`](../.github/workflows/store-submit.yml).

## Manual fallback

If the five submission secrets are missing, the Store job fails fast with a
clear message. You can still upload the Release’s `.msix` artifacts by hand in
Partner Center → Packages (same as before CI submit existed).
