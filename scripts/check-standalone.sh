#!/usr/bin/env bash
#
# Assert this plugin stays standalone: it must not read bb-spotify's data,
# secrets, or package.
#
# WHY A SCRIPT RATHER THAN AN INLINE GREP
#
# The source documents at length WHY it no longer depends on bb-spotify. A bare
# `grep bb-spotify src/` therefore matches all of that prose and fails on the
# plugin's own comments. So comments are stripped first, and only real code is
# scanned.
#
# Same script runs locally and in CI, so a contributor finds the problem before
# pushing rather than from a red check.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d src ]; then
  echo "error: expected to run from the repo root (no src/ directory found)" >&2
  exit 1
fi

# Strip line comments before scanning. This is deliberately crude (it does not
# try to understand strings containing `//`) because the failure mode of a
# missed comment is a false PASS on prose, not a false FAIL on real code.
strip_comments() {
  sed -e 's://.*::' "$@"
}

# A `plugin_settings` lookup, the bb-spotify secrets directory, or an import of
# a bb-spotify package. These are the three ways a runtime dependency would
# reappear.
PATTERN='plugin_settings|plugins/spotify|from *["'"'"'][^"'"'"']*bb-spotify'

found=0
for file in src/*.ts; do
  [ -e "$file" ] || continue
  while IFS= read -r line; do
    printf '%s: %s\n' "$file" "$line"
    found=1
  done < <(strip_comments "$file" | grep -nE "$PATTERN" || true)
done

if [ "$found" -ne 0 ]; then
  echo "::error::found a runtime dependency on bb-spotify; this plugin must stay standalone" >&2
  echo "" >&2
  echo "This plugin owns its own Spotify credentials and must not read another" >&2
  echo "plugin's settings, secrets, or package." >&2
  exit 1
fi

echo "ok: no bb-spotify runtime dependency"
