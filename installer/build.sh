#!/bin/bash
# Builds ReadAloudUrduVoiceInstaller.pkg from this directory's scripts/.
# Run this, then upload the resulting .pkg to the project's GitHub Release -
# see BUILD.md for the full path from here to a working "Download Urdu voice"
# button in the extension.
set -euo pipefail
cd "$(dirname "$0")"

OUT="ReadAloudUrduVoiceInstaller.pkg"

pkgbuild \
    --nopayload \
    --identifier com.readaloud.piperinstaller \
    --version 1.0 \
    --scripts pkgroot/scripts \
    "$OUT"

echo ""
echo "Built: $(pwd)/$OUT"
echo "This is UNSIGNED - macOS Gatekeeper will block a first open until the"
echo "user right-clicks it and chooses Open (see BUILD.md 'Unsigned installer'"
echo "for the exact wording to show users, and for how to sign it later)."
