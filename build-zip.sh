#!/bin/bash
# Build the Chrome Web Store submission ZIP.
# Run from the repo root: ./build-zip.sh

VERSION=$(node -e "console.log(require('./manifest.json').version)" 2>/dev/null || grep '"version"' manifest.json | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')
OUTFILE="perm-compare-v${VERSION}.zip"

zip -r "$OUTFILE" . \
  -x "*.git*" \
  -x ".gitignore" \
  -x ".DS_Store" \
  -x "*.zip" \
  -x "README.md" \
  -x "icons/README.md" \
  -x "build-zip.sh" \
  -x "store-assets/*" \
  -x "node_modules/*"

echo "Built: $OUTFILE"
unzip -l "$OUTFILE"
