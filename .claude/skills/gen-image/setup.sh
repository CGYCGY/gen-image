#!/usr/bin/env bash
set -euo pipefail

# Finds or clones the checkout this skill drives, then hands over to that checkout's setup.sh.
# Safe to re-run: for the ~/.gylab/gen-image clone it is also the upgrade path.

GYLAB_DIR="$HOME/.gylab/gen-image"
REPO_URL="${GEN_IMAGE_REPO:-https://github.com/CGYCGY/gen-image.git}"
DIR=""
ASSUME_YES=0
PASS=()

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need_value() { [ "$#" -ge 2 ] || die "$1 requires a value"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)     need_value "$@"; DIR="$2"; shift 2 ;;
    --repo)    need_value "$@"; REPO_URL="$2"; shift 2 ;;
    -h|--help) cat <<EOF
Usage: setup.sh [--dir <path>] [--repo <url>] [checkout setup options]

  --dir <path>   checkout to set up (default: \$GEN_IMAGE_DIR, else the checkout this skill sits
                 in when linked from one, else $GYLAB_DIR, cloned and kept updated)
  --repo <url>   git URL for that clone (default: \$GEN_IMAGE_REPO, else the upstream GitHub URL)

Every other option (-y, --state-dir, --output-format, --max-concurrent, --codex-timeout) goes to
the checkout's own setup.sh; see its --help.
EOF
               exit 0 ;;
    -y|--yes)  ASSUME_YES=1; PASS+=("$1"); shift ;;
    *)         PASS+=("$1"); shift ;;
  esac
done

# Checked before cloning so a non-interactive run fails fast. Prompts read /dev/tty, which keeps
# `curl … | bash` interactive; -r alone passes even when there is no controlling terminal.
if [ "$ASSUME_YES" -eq 0 ] && ! (: </dev/tty) 2>/dev/null; then
  die "no terminal available for prompts; re-run with -y"
fi

is_checkout() { [ -f "$1/cli/render.ts" ] && [ -f "$1/package.json" ]; }

# Resolution order is shared with render.sh; keep the two in step.
HERE="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
HERE="$(cd -P "$(dirname "$HERE")" && pwd -P)"
LINKED="$(cd -P "$HERE/../../.." 2>/dev/null && pwd -P || true)"

# The ~/.gylab clone is the skill's own, so it is the one checkout this script may update. A
# checkout named by --dir or $GEN_IMAGE_DIR is the developer's, even when it is that same path.
OWNED=0
if [ -n "$DIR" ] || [ -n "${GEN_IMAGE_DIR:-}" ]; then
  DIR="${DIR:-$GEN_IMAGE_DIR}"
  case "$DIR" in "~/"*) DIR="$HOME/${DIR#\~/}" ;; /*) ;; *) DIR="${PWD%/}/$DIR" ;; esac
else
  if [ -n "$LINKED" ] && is_checkout "$LINKED"; then DIR="$LINKED"; else DIR="$GYLAB_DIR"; fi
  case "$DIR" in "$GYLAB_DIR"|"$(cd -P "$GYLAB_DIR" 2>/dev/null && pwd -P)") DIR="$GYLAB_DIR"; OWNED=1 ;; esac
fi

if [ "$DIR" = "$GYLAB_DIR" ] && ! is_checkout "$DIR"; then
  command -v git >/dev/null 2>&1 || die "git not found on PATH; install git or clone $REPO_URL to $DIR yourself"
  if [ ! -e "$DIR" ]; then
    git clone "$REPO_URL" "$DIR" || die "clone of $REPO_URL failed; check the URL (--repo) and your network"
  elif [ ! -d "$DIR/.git" ]; then
    # Developer mode leaves only config.json and state/ here; adopt them rather than fail, they are
    # the clone's gitignored root paths.
    for f in "$DIR"/* "$DIR"/.[!.]* "$DIR"/..?*; do
      [ -e "$f" ] || continue
      case "${f##*/}" in config.json|state) ;; *) die "$DIR holds files other than config.json and state/; move them and re-run" ;; esac
    done
    git -C "$DIR" init -q && git -C "$DIR" remote add origin "$REPO_URL" && git -C "$DIR" fetch -q origin \
      || die "fetch of $REPO_URL into $DIR failed; check the URL (--repo) and your network"
    BRANCH="$(git -C "$DIR" ls-remote --symref origin HEAD | sed -n 's|^ref: refs/heads/\([^[:space:]]*\).*|\1|p')"
    [ -n "$BRANCH" ] || die "cannot tell the default branch of $REPO_URL"
    git -C "$DIR" checkout -q -b "$BRANCH" --track "origin/$BRANCH" || die "checkout of $BRANCH in $DIR failed"
  fi
elif [ "$OWNED" -eq 1 ] && [ -d "$DIR/.git" ]; then
  if [ -n "$(git -C "$DIR" status --porcelain)" ]; then
    printf '!! local changes in %s; skipping update\n' "$DIR" >&2
  elif ! git -C "$DIR" symbolic-ref -q HEAD >/dev/null || ! git -C "$DIR" remote get-url origin >/dev/null 2>&1; then
    printf '!! %s is detached or has no origin; skipping update\n' "$DIR" >&2
  else
    git -C "$DIR" pull -q --ff-only || die "git pull --ff-only failed in $DIR; resolve it there and re-run"
  fi
fi

is_checkout "$DIR" || die "$DIR is not a gen-image checkout (no cli/render.ts or package.json)"
[ -f "$DIR/setup.sh" ] || die "$DIR has no setup.sh; it predates this skill, update it (git pull) and re-run"
exec bash "$DIR/setup.sh" ${PASS[@]+"${PASS[@]}"}
