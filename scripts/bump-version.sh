#!/bin/bash
# Version bump script for Digital Habits Blocker
# Usage: ./scripts/bump-version.sh 0.4.3
#
# This script updates the version in all necessary files:
# - package.json
# - src-tauri/tauri.conf.json (single source of truth for builds) + tauri.system-test.conf.json
# - src-tauri/Cargo.toml + the app's entry in Cargo.lock
# - iOS project files (via scripts/sync-ios-version.mjs)

set -e

if [ -z "$1" ]; then
    echo "Usage: ./scripts/bump-version.sh <version>"
    echo "Example: ./scripts/bump-version.sh 0.4.3"
    exit 1
fi

NEW_VERSION="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "Bumping version to $NEW_VERSION..."
echo ""

# Update package.json
echo "  Updating package.json..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$PROJECT_ROOT/package.json"
else
    sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$PROJECT_ROOT/package.json"
fi

# Update tauri.conf.json and the system-test config (which carries its own version)
for CONF in tauri.conf.json tauri.system-test.conf.json; do
    echo "  Updating src-tauri/$CONF..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$PROJECT_ROOT/src-tauri/$CONF"
    else
        sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$PROJECT_ROOT/src-tauri/$CONF"
    fi
done

# Update src-tauri/Cargo.toml
echo "  Updating src-tauri/Cargo.toml..."
# Only the [package] section: `[dependencies.*]` tables below carry their own
# `version = ` lines and must not be touched.
if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "/^\[package\]/,/^\[/ s/^version = \"[^\"]*\"/version = \"$NEW_VERSION\"/" "$PROJECT_ROOT/src-tauri/Cargo.toml"
else
    sed -i "/^\[package\]/,/^\[/ s/^version = \"[^\"]*\"/version = \"$NEW_VERSION\"/" "$PROJECT_ROOT/src-tauri/Cargo.toml"
fi

# Update the app's own entry in Cargo.lock, which cargo would otherwise rewrite on the next build
echo "  Updating src-tauri/Cargo.lock..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "/^name = \"redd-block\"$/{n;s/^version = \"[^\"]*\"/version = \"$NEW_VERSION\"/;}" "$PROJECT_ROOT/src-tauri/Cargo.lock"
else
    sed -i "/^name = \"redd-block\"$/{n;s/^version = \"[^\"]*\"/version = \"$NEW_VERSION\"/;}" "$PROJECT_ROOT/src-tauri/Cargo.lock"
fi

# Update iOS project files (tauri.ios.conf.json, gen/apple project + Info.plists)
echo "  Updating iOS project files..."
node "$SCRIPT_DIR/sync-ios-version.mjs" --version "$NEW_VERSION"

echo ""
echo "✅ Version bumped to $NEW_VERSION in all files!"
echo ""
echo "Files updated:"
echo "  - package.json"
echo "  - src-tauri/tauri.conf.json + tauri.system-test.conf.json"
echo "  - src-tauri/Cargo.toml + Cargo.lock"
echo "  - src-tauri/tauri.ios.conf.json + src-tauri/gen/apple (version/build stamps)"
echo ""
echo "Note: Build scripts (build-mac.sh, build-win.ps1) read from"
echo "      tauri.conf.json automatically - no manual update needed."
