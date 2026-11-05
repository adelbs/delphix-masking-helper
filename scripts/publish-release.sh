#!/usr/bin/env bash
# Attaches the files of a release — the app archives, each preset's data, PDFs and package, and
# SHA256SUMS — to that release on GitHub, with the gh login of whoever runs it. Publishing is done
# by the maintainer, not by CI: what a release carries is uploaded by its author.
#
#   scripts/publish-release.sh vX.Y.Z
#
# The tag must be pushed and the release created first (gh release create vX.Y.Z --verify-tag …).
# The files are built by scripts/release-assets.mjs from the tag — not from this working tree — and
# checked against SHA256SUMS before anything is sent.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:-}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: $0 vMAJOR.MINOR.PATCH" >&2; exit 2; }
OUT="$ROOT/release-assets/$TAG"

command -v gh >/dev/null || { echo "gh is not installed: https://cli.github.com" >&2; exit 1; }
LOGIN=$(gh api user -q .login 2>/dev/null) || { echo "gh is not signed in: run gh auth login" >&2; exit 1; }

git -C "$ROOT" ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null \
  || { echo "$TAG is not on origin: push the tag first (git push origin $TAG)." >&2; exit 1; }
gh release view "$TAG" >/dev/null 2>&1 \
  || { echo "There is no release $TAG yet: create it first, e.g. gh release create $TAG --verify-tag --title $TAG --notes-file NOTES.md" >&2; exit 1; }

if [ ! -f "$OUT/SHA256SUMS" ]; then
  node "$ROOT/scripts/release-assets.mjs" --tag "$TAG"
fi
( cd "$OUT" && if command -v sha256sum >/dev/null; then sha256sum -c --quiet SHA256SUMS; else shasum -a 256 -c --quiet SHA256SUMS; fi ) \
  || { echo "The files in $OUT do not match their SHA256SUMS: rebuild them." >&2; exit 1; }

COUNT=$(ls "$OUT" | wc -l | tr -d ' ')
SIZE=$(du -sh "$OUT" | cut -f1)
echo
echo "  Release:  $TAG"
echo "  Files:    $COUNT ($SIZE) from $OUT"
echo "  As:       $LOGIN"
echo
read -r -p "  Upload them, replacing any already attached? [y/N] " answer
[[ "$answer" =~ ^[yYsS] ]] || { echo "  Nothing was sent."; exit 0; }

gh release upload "$TAG" "$OUT"/* --clobber
echo "  Done: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/$TAG"
