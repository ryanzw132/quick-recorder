#!/usr/bin/env bash
# Quick Recorder — one-time install of the macOS Finder tag native messaging host.
#
# What this does:
#   1. Verifies the `tag` CLI is installed (installs via Homebrew if missing).
#   2. Copies qr-tagger.py to ~/.quick-recorder/.
#   3. Writes the Chrome native messaging host manifest at
#      ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.quickrecorder.tagger.json
#      with allowed_origins set to your extension's ID.
#
# Usage:  ./install-native-host.sh <chrome-extension-id>
#
# Find your extension ID:
#   1. Open chrome://extensions
#   2. Toggle "Developer mode" (top-right)
#   3. Look under "Quick Recorder" for the ID line — copy it.

set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: this installer is macOS-only." >&2
  exit 1
fi

EXT_ID="${1:-}"
if [[ -z "$EXT_ID" ]]; then
  echo "Usage: $0 <chrome-extension-id>"
  echo
  echo "Get your extension ID from chrome://extensions (toggle Developer mode)."
  exit 1
fi

# Sanity-check the ID format (32 lowercase a-p chars). A wrong ID means Chrome
# refuses to launch the helper at runtime ("not allowed") with no clear error
# in the user's face — bail loudly here unless --force is passed.
FORCE=0
for arg in "$@"; do
  if [[ "$arg" == "--force" ]]; then FORCE=1; fi
done
if ! [[ "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
  if [[ "$FORCE" -ne 1 ]]; then
    echo "ERROR: '$EXT_ID' is not a valid Chrome extension ID." >&2
    echo "Expected 32 lowercase letters a-p (e.g. 'fjajhhaahdmgiefegoknbmafbbgkaimm')." >&2
    echo "Find the right ID at chrome://extensions (toggle Developer mode)." >&2
    echo "If you really want to install with this ID, re-run with --force." >&2
    exit 1
  fi
  echo "WARNING: '$EXT_ID' is not a typical extension ID. --force given, continuing."
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_PY="$SCRIPT_DIR/native-host/qr-tagger.py"

if [[ ! -f "$SOURCE_PY" ]]; then
  echo "ERROR: cannot find $SOURCE_PY" >&2
  echo "Run this script from the screen-recorder directory." >&2
  exit 1
fi

# 1. Ensure `tag` CLI is installed.
if ! command -v tag >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "→ Installing 'tag' CLI via Homebrew…"
    brew install tag
  else
    echo "ERROR: 'tag' CLI not found and Homebrew not installed." >&2
    echo "Install Homebrew (https://brew.sh) then re-run this script, or:" >&2
    echo "  brew install tag" >&2
    exit 1
  fi
else
  echo "✓ 'tag' CLI already installed at $(command -v tag)"
fi

# 2. Copy the helper to a stable location.
INSTALL_DIR="$HOME/.quick-recorder"
mkdir -p "$INSTALL_DIR"
DEST_PY="$INSTALL_DIR/qr-tagger.py"
cp "$SOURCE_PY" "$DEST_PY"
chmod +x "$DEST_PY"
echo "✓ Helper installed at $DEST_PY"

# 3. Write the native messaging host manifest.
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$MANIFEST_DIR"
MANIFEST="$MANIFEST_DIR/com.quickrecorder.tagger.json"

cat > "$MANIFEST" <<JSON
{
  "name": "com.quickrecorder.tagger",
  "description": "Apply macOS Finder tags to files downloaded by Quick Recorder",
  "path": "$DEST_PY",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON

echo "✓ Native host manifest written to $MANIFEST"
echo
echo "Done. Reload the Quick Recorder extension at chrome://extensions, then"
echo "stop a recording and click a tag in the post-record popup to test."
