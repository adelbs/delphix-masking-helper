#!/usr/bin/env bash
# Regenerates everything derived from the algorithm guide in docs/src/:
# the PDFs, and the GitHub Pages site.
#
# Usage:  ./docs/build.sh            # builds all languages
#         ./docs/build.sh pt-BR es   # PDFs for the given languages only
#
# The site is always rebuilt for all three languages — it is cheap, and a partial site
# would leave one language quoting an older version of the guide.
#
# Requires Google Chrome (headless) — the guides use fonts installed on macOS
# (Iowan Old Style, Seravek, Menlo), so PDFs are best regenerated on a Mac.

set -euo pipefail

DOCS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$DOCS_DIR/src"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [[ ! -x "$CHROME" ]]; then
  echo "error: Google Chrome not found at $CHROME" >&2
  echo "Install Chrome, or point \$CHROME at another Chromium build." >&2
  exit 1
fi

LANGS=("$@")
if [[ ${#LANGS[@]} -eq 0 ]]; then
  LANGS=(pt-BR en es)
fi

for lang in "${LANGS[@]}"; do
  src="$SRC_DIR/guide.$lang.html"
  out="$DOCS_DIR/delphix-algorithms-guide.$lang.pdf"

  if [[ ! -f "$src" ]]; then
    echo "error: no source for '$lang' (expected $src)" >&2
    exit 1
  fi

  echo "building $lang …"
  "$CHROME" \
    --headless --disable-gpu --no-sandbox \
    --print-to-pdf="$out" \
    --no-pdf-header-footer \
    --virtual-time-budget=12000 \
    "file://$src" 2>/dev/null

  printf '  → %s (%s)\n' "${out#"$DOCS_DIR/"}" "$(du -h "$out" | cut -f1 | tr -d ' ')"
done

echo
echo "building the GitHub Pages site …"
node "$DOCS_DIR/build-site.mjs"

echo "done."
