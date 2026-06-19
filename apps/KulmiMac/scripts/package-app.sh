#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
CLANG_MODULE_CACHE_PATH="${TMPDIR:-/tmp}/kulmi-clang-cache" \
SWIFTPM_MODULECACHE_OVERRIDE="${TMPDIR:-/tmp}/kulmi-swift-cache" \
swift build -c release

APP="$ROOT/.build/Kulmi.app"
BIN="$ROOT/.build/release/KulmiMac"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Kulmi"
cp "$ROOT/Resources/Info.plist" "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
printf '%s\n' "$APP"
