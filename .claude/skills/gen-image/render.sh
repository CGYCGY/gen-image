#!/usr/bin/env bash
set -euo pipefail

# Runs the gen-image CLI from whichever checkout this skill drives. Resolution order is shared with
# setup.sh; keep the two in step.

is_checkout() { [ -f "$1/cli/render.ts" ] && [ -f "$1/package.json" ]; }

HERE="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
HERE="$(cd -P "$(dirname "$HERE")" && pwd -P)"
LINKED="$(cd -P "$HERE/../../.." 2>/dev/null && pwd -P || true)"

if [ -n "${GEN_IMAGE_DIR:-}" ]; then
  DIR="$GEN_IMAGE_DIR"
elif [ -n "$LINKED" ] && is_checkout "$LINKED"; then
  DIR="$LINKED"
else
  DIR="$HOME/.gylab/gen-image"
fi

# node_modules too: a clone whose setup never finished fails later with a far less useful error.
if ! is_checkout "$DIR" || [ ! -d "$DIR/node_modules" ] || ! command -v bun >/dev/null 2>&1; then
  printf 'gen-image runtime not set up (looked in %s); run: bash "%s/setup.sh" -y\n' "$DIR" "$HERE" >&2
  exit 1
fi

exec bun "$DIR/cli/render.ts" "$@"
