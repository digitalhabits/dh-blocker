#!/bin/bash
# Build the macOS desktop app bundle (.app). Output is
# `for-distribution/Digital Habits Blocker.app`. For a shippable installer, run
# `scripts/build-mac-pkg.sh --release` next (or `pnpm build:mac-all`
# for both in one go).

set -euo pipefail

# Source environment variables for signing/notarization if present.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Support the older APPLE_PASSWORD name by mapping it to the variable
# the notarize hook actually reads.
if [ -n "${APPLE_PASSWORD:-}" ] && [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
  export APPLE_APP_SPECIFIC_PASSWORD="${APPLE_PASSWORD}"
fi

# Tauri v2 expects CI to be "true"/"false", not "1"/"0".
TAURI_CI="${CI:-}"
if [ "$TAURI_CI" = "1" ]; then
  TAURI_CI="true"
elif [ "$TAURI_CI" = "0" ]; then
  TAURI_CI="false"
fi

PROJECT_ROOT="$(pwd)"
BUILD_TARGET="${BUILD_MAC_TARGET:-universal-apple-darwin}"

CONFIG_ARGS=()
if [ -n "${APPLE_SIGNING_IDENTITY_OVERRIDE:-}" ]; then
  echo "Using signing identity override: ${APPLE_SIGNING_IDENTITY_OVERRIDE}"
  CONFIG_ARGS=(
    --config
    "{\"bundle\":{\"macOS\":{\"signingIdentity\":\"${APPLE_SIGNING_IDENTITY_OVERRIDE}\"}}}"
  )
fi

# In-place updates (tauri-plugin-updater, see src-tauri/src/commands/app_update.rs)
# need a minisign-signed .app.tar.gz next to the .pkg. Build it only when both
# halves of the key are present: the private key in the environment and the
# public key committed in tauri.conf.json (the CLI decodes the latter when it
# signs). Otherwise the build still produces the .app and the .pkg, and the app
# falls back to the .pkg. Setup: docs/macos-in-place-updates.md.
UPDATER_PUBKEY="$(node -p "require('./src-tauri/tauri.conf.json').plugins?.updater?.pubkey ?? ''")"
BUILD_UPDATER=false
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -n "$UPDATER_PUBKEY" ]; then
  BUILD_UPDATER=true
elif [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "WARNING: TAURI_SIGNING_PRIVATE_KEY is set but plugins.updater.pubkey is empty; skipping the in-place update archive."
fi
if [ "$BUILD_UPDATER" = true ]; then
  echo "Building the in-place update archive"
  CONFIG_ARGS+=(--config '{"bundle":{"createUpdaterArtifacts":true}}')
  # Tauri copies resource modes as it finds them, and an in-place update runs
  # none of the .pkg's permission fixes. Safari loads the block page as the
  # user, so these must be world-readable; git does not record 600 vs 644.
  chmod 644 src-tauri/blocked/*
fi

CARGO_TARGET_DIR="$(node -e 'process.stdout.write(require("./scripts/build-env").getCargoTargetDir(process.env))')"
export CARGO_TARGET_DIR
TARGET_DIR="${CARGO_TARGET_DIR}/${BUILD_TARGET}/release/bundle"

echo "Building Digital Habits Blocker for macOS (${BUILD_TARGET})..."
# `--bundles app` tells Tauri to produce only the .app, skipping its
# own .dmg target. We distribute via scripts/build-mac-pkg.sh, which
# wraps the .app in a signed .pkg with migration pre/post-install scripts.
CI="${TAURI_CI:-false}" \
pnpm tauri build --bundles app --target "${BUILD_TARGET}" ${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"}

APP_SOURCE="${TARGET_DIR}/macos/Digital Habits Blocker.app"

mkdir -p for-distribution

if [ -d "$APP_SOURCE" ]; then
  rm -rf "for-distribution/Digital Habits Blocker.app"
  cp -R "$APP_SOURCE" "for-distribution/Digital Habits Blocker.app"
fi

if [ "$BUILD_UPDATER" = true ]; then
  node scripts/stage-macos-updater.js \
    --bundle-dir "${TARGET_DIR}/macos" \
    --target "${BUILD_TARGET}" \
    --out for-distribution
fi

echo ""
echo "Build complete."
if [ -d "for-distribution/Digital Habits Blocker.app" ]; then
  echo "  App: for-distribution/Digital Habits Blocker.app"
fi
echo "  (Run scripts/build-mac-pkg.sh --release for a shippable .pkg.)"
