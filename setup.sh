#!/usr/bin/env bash
set -euo pipefail

# gen-image installer. Safe to re-run: that is also the upgrade path.

DEFAULT_REPO_URL="https://github.com/CGYCGY/gen-image.git"
DEFAULT_DIR="$HOME/.gen-image"
SKILL_NAME="gen-image"
VALID_FORMATS="preserve webp png jpeg"

ASSUME_YES=0
DIR=""
REPO_URL="${GEN_IMAGE_REPO:-$DEFAULT_REPO_URL}"
OPT_STATE_DIR=""
OPT_OUTPUT_FORMAT=""
OPT_MAX_CONCURRENT=""
OPT_CODEX_TIMEOUT=""
PROJECT_DIR=""
INSTALL_SKILL=1

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BOLD=$'\033[1m'; C_RED=$'\033[31m'; C_YEL=$'\033[33m'; C_GRN=$'\033[32m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_BOLD=""; C_RED=""; C_YEL=""; C_GRN=""; C_DIM=""; C_OFF=""
fi

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$C_GRN" "$C_OFF" "$C_BOLD" "$*" "$C_OFF"; }
warn() { printf '%s!!%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: setup.sh [options]

  -y, --yes                 non-interactive; take defaults, never prompt
      --dir <path>          checkout location (default: \$GEN_IMAGE_DIR, else $DEFAULT_DIR)
      --repo <url>          git URL to clone when the checkout is missing
                            (default: \$GEN_IMAGE_REPO, else $DEFAULT_REPO_URL)
      --state-dir <path>    config.json stateDir
      --output-format <f>   config.json output.format ($VALID_FORMATS)
      --max-concurrent <n>  config.json maxConcurrentRenders
      --codex-timeout <ms>  config.json codex.timeoutMs
      --project <path>      install the skill into <path>/.claude/skills/$SKILL_NAME/
                            instead of ~/.claude/skills/$SKILL_NAME/
      --no-skill            do not install the skill
  -h, --help                this text
EOF
}

need_value() { [ "$#" -ge 2 ] || die "$1 requires a value"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes)         ASSUME_YES=1; shift ;;
    --dir)            need_value "$@"; DIR="$2"; shift 2 ;;
    --repo)           need_value "$@"; REPO_URL="$2"; shift 2 ;;
    --state-dir)      need_value "$@"; OPT_STATE_DIR="$2"; shift 2 ;;
    --output-format)  need_value "$@"; OPT_OUTPUT_FORMAT="$2"; shift 2 ;;
    --max-concurrent) need_value "$@"; OPT_MAX_CONCURRENT="$2"; shift 2 ;;
    --codex-timeout)  need_value "$@"; OPT_CODEX_TIMEOUT="$2"; shift 2 ;;
    --project)        need_value "$@"; PROJECT_DIR="$2"; shift 2 ;;
    --no-skill)       INSTALL_SKILL=0; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                usage >&2; die "unknown argument: $1" ;;
  esac
done

expand_tilde() {
  case "$1" in
    "~")   printf '%s' "$HOME" ;;
    "~/"*) printf '%s' "$HOME/${1#\~/}" ;;
    *)     printf '%s' "$1" ;;
  esac
}

abspath() {
  local p; p="$(expand_tilde "$1")"
  case "$p" in /*) printf '%s' "$p" ;; *) printf '%s' "$PWD/$p" ;; esac
}

NO_TTY_MSG="no terminal available for prompts; re-run with --yes (plus any --state-dir/--output-format/--max-concurrent/--codex-timeout overrides)"
if [ "$ASSUME_YES" -eq 0 ] && [ ! -r /dev/tty ]; then die "$NO_TTY_MSG"; fi

# Prompts read /dev/tty so `curl … | bash` still reaches the user's keyboard.
ask() { # ask <prompt> <default>
  local answer
  printf '%s%s%s [%s]: ' "$C_BOLD" "$1" "$C_OFF" "$2" >/dev/tty
  IFS= read -r answer </dev/tty || die "$NO_TTY_MSG"
  printf '%s' "${answer:-$2}"
}

confirm() { # confirm <prompt> <y|n default>; true = proceed
  local answer def="$2"
  [ "$ASSUME_YES" -eq 1 ] && return 0
  local hint="[y/N]"; [ "$def" = y ] && hint="[Y/n]"
  printf '%s%s%s %s ' "$C_BOLD" "$1" "$C_OFF" "$hint" >/dev/tty
  IFS= read -r answer </dev/tty || die "$NO_TTY_MSG"
  answer="${answer:-$def}"
  case "$answer" in [yY]*) return 0 ;; *) return 1 ;; esac
}

is_repo_root() { [ -f "$1/cli/render.ts" ] && [ -f "$1/config.json.example" ] && [ -f "$1/package.json" ]; }

# ---- 1. locate or obtain the checkout ------------------------------------

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

if [ -n "$DIR" ]; then
  DIR="$(abspath "$DIR")"
elif [ -n "${GEN_IMAGE_DIR:-}" ]; then
  DIR="$(abspath "$GEN_IMAGE_DIR")"
elif is_repo_root "$SCRIPT_DIR"; then
  DIR="$SCRIPT_DIR"
else
  DIR="$DEFAULT_DIR"
fi

step "Checkout: $DIR"

if [ ! -e "$DIR" ]; then
  command -v git >/dev/null 2>&1 || die "git not found on PATH; install git or clone $REPO_URL to $DIR yourself"
  say "cloning $REPO_URL"
  git clone "$REPO_URL" "$DIR" || die "clone failed; check the URL (override with --repo) and your network/SSH access"
elif [ ! -d "$DIR" ]; then
  die "$DIR exists but is not a directory"
elif [ -d "$DIR/.git" ] && command -v git >/dev/null 2>&1; then
  # git replaces files by inode, so the running copy of this script survives an update in place.
  if [ -n "$(git -C "$DIR" status --porcelain)" ]; then
    warn "local changes in $DIR — skipping update"
  elif ! git -C "$DIR" symbolic-ref -q HEAD >/dev/null; then
    warn "detached HEAD in $DIR — skipping update"
  elif ! git -C "$DIR" remote get-url origin >/dev/null 2>&1; then
    warn "no origin remote in $DIR — skipping update"
  else
    say "updating (git pull --ff-only)"
    git -C "$DIR" pull --ff-only \
      || die "git pull --ff-only failed in $DIR; resolve it there (or 'git reset --hard origin/main' to discard) and re-run"
  fi
else
  is_repo_root "$DIR" || die "$DIR exists but is not a gen-image checkout; pick another --dir or remove it"
  warn "$DIR is not a git checkout — skipping update"
fi

is_repo_root "$DIR" || die "$DIR does not look like a gen-image checkout (missing cli/render.ts, config.json.example or package.json)"

# ---- 2. preflight --------------------------------------------------------

step "Preflight"

command -v bun >/dev/null 2>&1 \
  || die "bun not found on PATH. Install it: curl -fsSL https://bun.sh/install | bash   (docs: https://bun.sh/docs/installation)"
say "bun      $(bun --version)"

CODEX_READY=1
CODEX_HINT=""
if ! command -v codex >/dev/null 2>&1; then
  CODEX_READY=0
  CODEX_HINT="npm i -g @openai/codex, then codex login"
  warn "codex CLI not found on PATH — gen-image renders through it and cannot work without it"
elif CODEX_STATUS="$(codex login status 2>/dev/null | head -n 1)"; then
  say "codex    ${CODEX_STATUS:-logged in}"
else
  CODEX_READY=0
  CODEX_HINT="codex login"
  warn "codex is installed but not logged in"
fi

if [ "$CODEX_READY" -eq 0 ]; then
  # Only the user can complete this; the container mounts an already-authenticated CODEX_HOME instead.
  printf '%s   run this yourself, setup cannot: %s%s\n' "$C_YEL" "$CODEX_HINT" "$C_OFF" >&2
  if [ "$ASSUME_YES" -eq 0 ]; then
    confirm "Continue setup anyway?" n || die "aborted; run '$CODEX_HINT' then re-run setup.sh"
  fi
fi

# ---- 3. dependencies -----------------------------------------------------

step "Installing dependencies (bun install)"
say "${C_DIM}sharp builds native binaries here; a failure below is usually a missing toolchain or an unsupported platform${C_OFF}"
(cd "$DIR" && bun install) || die "bun install failed in $DIR — see the error above (sharp is the usual culprit: https://sharp.pixelplumbing.com/install)"

# ---- 4. config.json ------------------------------------------------------

CONFIG_EXAMPLE="$DIR/config.json.example"
CONFIG_PATH="$(abspath "${GEN_IMAGE_CONFIG:-$DIR/config.json}")"

step "Config: $CONFIG_PATH"

cfg_get() { # cfg_get <file> <dotted.key>
  # process.stdout.write, not console.log: bun colorizes inspected values (e.g. numbers) whenever
  # EITHER std stream is a TTY, and the escapes would end up inside the value.
  GI_FILE="$1" GI_KEY="$2" bun -e '
    const text = await Bun.file(process.env.GI_FILE).text();
    let cur;
    try { cur = JSON.parse(text) } catch (e) { console.error(e.message); process.exit(1) }
    for (const k of process.env.GI_KEY.split(".")) cur = cur?.[k];
    process.stdout.write(String(cur ?? ""));
  ' || die "cannot parse $1 as JSON"
}

validate_format() {
  case " $VALID_FORMATS " in *" $1 "*) ;; *) die "--output-format must be one of: $VALID_FORMATS (got '$1')" ;; esac
}
validate_posint() { # validate_posint <value> <flag>
  case "$1" in ''|*[!0-9]*) die "$2 must be a positive integer (got '$1')" ;; esac
  [ "$1" -gt 0 ] || die "$2 must be a positive integer (got '$1')"
}

[ -z "$OPT_OUTPUT_FORMAT" ]  || validate_format "$OPT_OUTPUT_FORMAT"
[ -z "$OPT_MAX_CONCURRENT" ] || validate_posint "$OPT_MAX_CONCURRENT" --max-concurrent
[ -z "$OPT_CODEX_TIMEOUT" ]  || validate_posint "$OPT_CODEX_TIMEOUT" --codex-timeout

WRITE_CONFIG=1
if [ -e "$CONFIG_PATH" ]; then
  if [ "$ASSUME_YES" -eq 1 ]; then
    WRITE_CONFIG=0
    say "existing config kept (untouched)"
    if [ -n "$OPT_STATE_DIR$OPT_OUTPUT_FORMAT$OPT_MAX_CONCURRENT$OPT_CODEX_TIMEOUT" ]; then
      warn "config overrides ignored: $CONFIG_PATH already exists (delete it to regenerate)"
    fi
  elif ! confirm "$CONFIG_PATH exists. Replace it?" n; then
    WRITE_CONFIG=0
    say "existing config kept"
  fi
fi

if [ "$WRITE_CONFIG" -eq 1 ]; then
  [ -f "$CONFIG_EXAMPLE" ] || die "missing $CONFIG_EXAMPLE — the checkout is incomplete"

  DEF_STATE_DIR="$(cfg_get "$CONFIG_EXAMPLE" stateDir)"
  DEF_FORMAT="$(cfg_get "$CONFIG_EXAMPLE" output.format)"
  DEF_CONCURRENT="$(cfg_get "$CONFIG_EXAMPLE" maxConcurrentRenders)"
  DEF_TIMEOUT="$(cfg_get "$CONFIG_EXAMPLE" codex.timeoutMs)"
  [ -n "$DEF_STATE_DIR" ] || DEF_STATE_DIR="$DIR/state"

  if [ "$ASSUME_YES" -eq 0 ]; then
    say "${C_DIM}press enter to accept each default${C_OFF}"
    OPT_STATE_DIR="$(ask 'State dir (logs, claims, render slots)' "${OPT_STATE_DIR:-$DEF_STATE_DIR}")"
    while :; do
      OPT_OUTPUT_FORMAT="$(ask "Output format ($VALID_FORMATS)" "${OPT_OUTPUT_FORMAT:-$DEF_FORMAT}")"
      case " $VALID_FORMATS " in *" $OPT_OUTPUT_FORMAT "*) break ;; *) warn "pick one of: $VALID_FORMATS" ;; esac
    done
    while :; do
      OPT_MAX_CONCURRENT="$(ask 'Max concurrent renders' "${OPT_MAX_CONCURRENT:-$DEF_CONCURRENT}")"
      case "$OPT_MAX_CONCURRENT" in ''|*[!0-9]*) warn "must be a positive integer" ;; *) [ "$OPT_MAX_CONCURRENT" -gt 0 ] && break || warn "must be a positive integer" ;; esac
    done
    while :; do
      OPT_CODEX_TIMEOUT="$(ask 'Codex timeout (ms)' "${OPT_CODEX_TIMEOUT:-$DEF_TIMEOUT}")"
      case "$OPT_CODEX_TIMEOUT" in ''|*[!0-9]*) warn "must be a positive integer" ;; *) [ "$OPT_CODEX_TIMEOUT" -gt 0 ] && break || warn "must be a positive integer" ;; esac
    done
  fi

  mkdir -p "$(dirname "$CONFIG_PATH")"
  # Temp file must sit beside the target so the mv is an atomic same-filesystem rename:
  # a half-written config.json would be read as a config error by every later run.
  CONFIG_TMP="$CONFIG_PATH.tmp.$$"
  trap 'rm -f "$CONFIG_TMP"' EXIT
  GI_SRC="$CONFIG_EXAMPLE" GI_OUT="$CONFIG_TMP" \
  GI_STATE_DIR="$OPT_STATE_DIR" GI_FORMAT="$OPT_OUTPUT_FORMAT" \
  GI_CONCURRENT="$OPT_MAX_CONCURRENT" GI_TIMEOUT="$OPT_CODEX_TIMEOUT" bun -e '
    const env = process.env;
    const cfg = JSON.parse(await Bun.file(env.GI_SRC).text());
    if (env.GI_STATE_DIR)  cfg.stateDir = env.GI_STATE_DIR;
    if (env.GI_CONCURRENT) cfg.maxConcurrentRenders = Number(env.GI_CONCURRENT);
    if (env.GI_FORMAT)  { cfg.output ??= {}; cfg.output.format = env.GI_FORMAT }
    if (env.GI_TIMEOUT) { cfg.codex  ??= {}; cfg.codex.timeoutMs = Number(env.GI_TIMEOUT) }
    await Bun.write(env.GI_OUT, JSON.stringify(cfg, null, 2) + "\n");
  ' || die "could not build config from $CONFIG_EXAMPLE"
  mv -f "$CONFIG_TMP" "$CONFIG_PATH"
  trap - EXIT
  say "wrote $CONFIG_PATH"
fi

STATE_DIR="$(cfg_get "$CONFIG_PATH" stateDir)"
[ -n "$STATE_DIR" ] || STATE_DIR="$DIR/state"
STATE_DIR="$(expand_tilde "$STATE_DIR")"

# ---- 5. skill ------------------------------------------------------------

SKILL_DEST=""
if [ "$INSTALL_SKILL" -eq 1 ]; then
  SKILL_SRC="$DIR/SKILL.md"
  if [ -n "$PROJECT_DIR" ]; then
    PROJECT_DIR="$(abspath "$PROJECT_DIR")"
    [ -d "$PROJECT_DIR" ] || die "--project path does not exist: $PROJECT_DIR"
    SKILL_ROOT="$PROJECT_DIR/.claude/skills/$SKILL_NAME"
  else
    SKILL_ROOT="$HOME/.claude/skills/$SKILL_NAME"
  fi
  SKILL_DEST="$SKILL_ROOT/SKILL.md"

  step "Skill: $SKILL_DEST"
  [ -f "$SKILL_SRC" ] || die "missing $SKILL_SRC — the checkout is incomplete (use --no-skill to skip)"

  # A symlinked destination is the pre-revamp layout pointing into an old checkout; writing
  # through it would edit that checkout instead of installing here.
  for link in "$SKILL_ROOT" "$SKILL_DEST"; do
    if [ -L "$link" ]; then
      warn "$link is a symlink -> $(readlink "$link")"
      confirm "Replace it with a real file?" n || die "left the symlink in place; remove it yourself or re-run with --no-skill"
      rm -f "$link"
    fi
  done

  mkdir -p "$SKILL_ROOT"
  if [ -e "$SKILL_DEST" ] && [ "$ASSUME_YES" -eq 0 ]; then
    confirm "$SKILL_DEST exists. Overwrite?" y || die "skill not installed; re-run with --no-skill to skip this step"
  fi
  cp -f "$SKILL_SRC" "$SKILL_DEST"
  say "installed"
fi

# ---- 6. done -------------------------------------------------------------

step "Done"
cat <<EOF
Checkout   $DIR
Config     $CONFIG_PATH
State      $STATE_DIR
Logs       $STATE_DIR/logs/
${SKILL_DEST:+Skill      $SKILL_DEST}

Smoke test (renders nothing, uses no quota):

  bun $DIR/cli/render.ts --dry-run '{"images":[{"prompt":"a red circle","out_path":"/tmp/gen-image-smoke.png"}]}'

Expect one JSON line: {"kind":"plan",...}
EOF

if [ "$CODEX_READY" -eq 0 ]; then
  printf '\n%sBefore any real render:%s %s\n' "$C_YEL" "$C_OFF" "$CODEX_HINT"
fi
