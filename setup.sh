#!/usr/bin/env bash
set -euo pipefail

# Makes THIS checkout runnable: deps, ~/.gylab/gen-image/{config.json,state}. Never clones or pulls;
# the skill's setup.sh does that in skill mode and then execs this. Safe to re-run.

VALID_FORMATS="preserve webp png jpeg"

ASSUME_YES=0
OPT_STATE_DIR=""
OPT_OUTPUT_FORMAT=""
OPT_MAX_CONCURRENT=""
OPT_CODEX_TIMEOUT=""

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

Sets up this checkout and ~/.gylab/gen-image/ (config.json, state/). Clones nothing.

  -y, --yes                 non-interactive; take defaults, never prompt
      --state-dir <path>    config.json stateDir (default: ~/.gylab/gen-image/state)
      --output-format <f>   config.json output.format ($VALID_FORMATS)
      --max-concurrent <n>  config.json maxConcurrentRenders
      --codex-timeout <ms>  config.json codex.timeoutMs
  -h, --help                this text

The config flags only apply when config.json is written; an existing one is never touched.
GEN_IMAGE_CONFIG, if set, is the config path instead of ~/.gylab/gen-image/config.json.
EOF
}

need_value() { [ "$#" -ge 2 ] || die "$1 requires a value"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes)         ASSUME_YES=1; shift ;;
    --state-dir)      need_value "$@"; OPT_STATE_DIR="$2"; shift 2 ;;
    --output-format)  need_value "$@"; OPT_OUTPUT_FORMAT="$2"; shift 2 ;;
    --max-concurrent) need_value "$@"; OPT_MAX_CONCURRENT="$2"; shift 2 ;;
    --codex-timeout)  need_value "$@"; OPT_CODEX_TIMEOUT="$2"; shift 2 ;;
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
  case "$p" in /*) printf '%s' "$p" ;; *) printf '%s' "${PWD%/}/$p" ;; esac
}

NO_TTY_MSG="no terminal available for prompts; re-run with --yes (plus any --state-dir/--output-format/--max-concurrent/--codex-timeout overrides)"
# -r is not enough: without a controlling terminal /dev/tty exists and is readable by mode, but opening it fails.
if [ "$ASSUME_YES" -eq 0 ] && ! (: </dev/tty) 2>/dev/null; then die "$NO_TTY_MSG"; fi

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

DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
[ -f "$DIR/cli/render.ts" ] && [ -f "$DIR/package.json" ] && [ -f "$DIR/config.json.example" ] \
  || die "$DIR does not look like a gen-image checkout (missing cli/render.ts, package.json or config.json.example)"

# Must agree with gylabDir() in shared/config.ts.
GYLAB_DIR="$HOME/.gylab/gen-image"
DEF_STATE_DIR="~/.gylab/gen-image/state"

step "Checkout: $DIR"

# ---- preflight -----------------------------------------------------------

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
    confirm "Continue anyway?" n || die "aborted; run '$CODEX_HINT' then re-run setup.sh"
  fi
fi

# ---- dependencies --------------------------------------------------------

step "Installing dependencies (bun install)"
say "${C_DIM}sharp builds native binaries here; a failure below is usually a missing toolchain or an unsupported platform${C_OFF}"
(cd "$DIR" && bun install) || die "bun install failed in $DIR — see the error above (sharp is the usual culprit: https://sharp.pixelplumbing.com/install)"

# ---- config.json ---------------------------------------------------------

CONFIG_EXAMPLE="$DIR/config.json.example"
CONFIG_PATH="$(abspath "${GEN_IMAGE_CONFIG:-$GYLAB_DIR/config.json}")"

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

if [ -e "$CONFIG_PATH" ]; then
  say "existing config kept (untouched)"
  if [ -n "$OPT_STATE_DIR$OPT_OUTPUT_FORMAT$OPT_MAX_CONCURRENT$OPT_CODEX_TIMEOUT" ]; then
    warn "config overrides ignored: $CONFIG_PATH already exists (edit it, or delete it to regenerate)"
  fi
else
  DEF_FORMAT="$(cfg_get "$CONFIG_EXAMPLE" output.format)"
  DEF_CONCURRENT="$(cfg_get "$CONFIG_EXAMPLE" maxConcurrentRenders)"
  DEF_TIMEOUT="$(cfg_get "$CONFIG_EXAMPLE" codex.timeoutMs)"

  if [ "$ASSUME_YES" -eq 0 ]; then
    say "${C_DIM}press enter to accept each default${C_OFF}"
    OPT_STATE_DIR="$(ask 'State dir (logs, claims, render slots)' "${OPT_STATE_DIR:-$DEF_STATE_DIR}")"
    while :; do
      OPT_OUTPUT_FORMAT="$(ask "Output format ($VALID_FORMATS)" "${OPT_OUTPUT_FORMAT:-$DEF_FORMAT}")"
      case " $VALID_FORMATS " in *" $OPT_OUTPUT_FORMAT "*) break ;; *) warn "pick one of: $VALID_FORMATS"; OPT_OUTPUT_FORMAT="" ;; esac
    done
    while :; do
      OPT_MAX_CONCURRENT="$(ask 'Max concurrent renders' "${OPT_MAX_CONCURRENT:-$DEF_CONCURRENT}")"
      case "$OPT_MAX_CONCURRENT" in *[!0-9]*|""|0*) ;; *) break ;; esac
      warn "must be a positive integer"; OPT_MAX_CONCURRENT=""
    done
    while :; do
      OPT_CODEX_TIMEOUT="$(ask 'Codex timeout (ms)' "${OPT_CODEX_TIMEOUT:-$DEF_TIMEOUT}")"
      case "$OPT_CODEX_TIMEOUT" in *[!0-9]*|""|0*) ;; *) break ;; esac
      warn "must be a positive integer"; OPT_CODEX_TIMEOUT=""
    done
  fi

  # The default stays "" in the file so the runtime keeps deriving it from HOME. A relative path
  # is pinned now: the runtime would resolve it against whatever cwd a caller happens to have.
  case "$OPT_STATE_DIR" in
    ""|"$DEF_STATE_DIR"|"$GYLAB_DIR/state") OPT_STATE_DIR="" ;;
    "~"|"~/"*|/*) ;;
    *) OPT_STATE_DIR="$(abspath "$OPT_STATE_DIR")" ;;
  esac

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

# ---- state dir -----------------------------------------------------------

STATE_DIR="$(cfg_get "$CONFIG_PATH" stateDir)"
[ -n "$STATE_DIR" ] || STATE_DIR="$GYLAB_DIR/state"
STATE_DIR="$(abspath "$STATE_DIR")"
mkdir -p "$STATE_DIR"

# ---- done ----------------------------------------------------------------

step "Done"
cat <<EOF
Checkout   $DIR
Config     $CONFIG_PATH
State      $STATE_DIR
Logs       $STATE_DIR/logs/

Smoke test (renders nothing, uses no quota):

  bun $DIR/cli/render.ts --dry-run '{"images":[{"prompt":"a red circle","out_path":"/tmp/gen-image-smoke.png"}]}'

Expect one JSON line: {"kind":"plan",...}
EOF

if [ "$CODEX_READY" -eq 0 ]; then
  printf '\n%sBefore any real render:%s %s\n' "$C_YEL" "$C_OFF" "$CODEX_HINT"
fi
