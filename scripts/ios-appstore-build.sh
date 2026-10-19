#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
EXPORT_DIR="$ROOT_DIR/src-tauri/gen/apple"
ACTIVE="$EXPORT_DIR/ExportOptions.plist"
STORE="$EXPORT_DIR/ExportOptions.store.plist"

cleanup() {
  git -C "$ROOT_DIR" checkout -- "$ACTIVE" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

cp "$STORE" "$ACTIVE"

PATH="$ROOT_DIR/scripts:$PATH" \
APPLE_DEVELOPMENT_TEAM=JD647S9RT6 \
IPHONEOS_DEPLOYMENT_TARGET=16.0 \
node "$ROOT_DIR/scripts/run-tauri.js" ios build

mkdir -p "$ROOT_DIR/for-distribution"
cp "$ROOT_DIR/src-tauri/gen/apple/build/arm64/Digital Habits Blocker.ipa" "$ROOT_DIR/for-distribution/Digital Habits Blocker.ipa"

# Check the archive as well as the IPA, so a failure shows whether the entitlements
# were lost at build time or at export.
echo ""
archive_ok=0; ipa_ok=0
"$ROOT_DIR/scripts/check-ios-entitlements.sh" "$EXPORT_DIR/build/redd-block_iOS.xcarchive" || archive_ok=$?
"$ROOT_DIR/scripts/check-ios-entitlements.sh" "$ROOT_DIR/for-distribution/Digital Habits Blocker.ipa" || ipa_ok=$?
if [[ $archive_ok -ne 0 || $ipa_ok -ne 0 ]]; then
  echo "❌ The IPA is missing entitlements its extensions need; do not upload it." >&2
  exit 1
fi
echo ""
echo "✅ App Store IPA ready: for-distribution/Digital Habits Blocker.ipa"
echo "   Upload with Transporter or: xcrun altool --upload-app --type ios --file \"for-distribution/Digital Habits Blocker.ipa\" --apiKey \$APPLE_API_KEY_ID --apiIssuer \$APPLE_API_ISSUER"
