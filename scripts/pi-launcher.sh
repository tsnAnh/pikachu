#!/usr/bin/env bash
# Update the authoritative checkout and deployed Pi configuration before Pi starts.
set -uo pipefail

SCRIPT_PATH="$0"
while [ -L "$SCRIPT_PATH" ]; do
  LINK_TARGET="$(readlink "$SCRIPT_PATH")"
  case "$LINK_TARGET" in
    /*) SCRIPT_PATH="$LINK_TARGET" ;;
    *) SCRIPT_PATH="$(dirname "$SCRIPT_PATH")/$LINK_TARGET" ;;
  esac
done
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
LAUNCHER_SOURCE="$REPO_ROOT/scripts/pi-launcher.sh"
STATE_DIR="${PI_AUTO_UPDATE_STATE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/pi-cfg}"
LOCK_DIR="$STATE_DIR/update.lock"
STAMP_FILE="$STATE_DIR/last-success"
LOG_FILE="$STATE_DIR/update.log"
INTERVAL_SECONDS="${PI_AUTO_UPDATE_INTERVAL_SECONDS:-0}"

warn() { printf '\033[33mPi preflight: %s\033[0m\n' "$1" >&2; }

load_typesafe_key() {
  [ -z "${TYPESAFE_API_KEY:-}" ] || return 0
  command -v security >/dev/null 2>&1 || return 0
  local account stored_key
  account="${USER:-$(id -un)}"
  stored_key="$(security find-generic-password -a "$account" -s "pikachu.typesafe-api-key" -w 2>/dev/null || true)"
  [ -n "$stored_key" ] || return 0
  export TYPESAFE_API_KEY="$stored_key"
  unset stored_key
}

load_typesafe_key

resolve_real_pi() {
  local directory candidate
  local old_ifs="$IFS"
  IFS=:
  for directory in $PATH; do
    [ -n "$directory" ] || directory="."
    candidate="$directory/pi"
    [ -x "$candidate" ] || continue
    if [ -e "$LAUNCHER_SOURCE" ] && [ "$candidate" -ef "$LAUNCHER_SOURCE" ]; then
      continue
    fi
    IFS="$old_ifs"
    printf '%s\n' "$candidate"
    return 0
  done
  IFS="$old_ifs"
  return 1
}

REAL_PI="$(resolve_real_pi || true)"
if [ -z "$REAL_PI" ]; then
  warn "cannot find the underlying Pi executable; check PATH"
  exit 127
fi

FORWARDED_ARGS=()
SKIP_UPDATE="${PI_AUTO_UPDATE:-1}"
for argument in "$@"; do
  if [ "$argument" = "--skip-update" ]; then
    SKIP_UPDATE=0
  else
    FORWARDED_ARGS+=("$argument")
  fi
done

if [ "$SKIP_UPDATE" = "0" ] || [ "${PI_CFG_UPDATE_RUNNING:-0}" = "1" ]; then
  exec "$REAL_PI" "${FORWARDED_ARGS[@]}"
fi

case "$STATE_DIR" in
  ""|"/"|"$HOME"|"${HOME}/")
    warn "unsafe update-state directory; starting without the preflight"
    exec "$REAL_PI" "${FORWARDED_ARGS[@]}"
    ;;
esac

case "$INTERVAL_SECONDS" in
  ''|*[!0-9]*) warn "invalid PI_AUTO_UPDATE_INTERVAL_SECONDS; updating now"; INTERVAL_SECONDS=0 ;;
esac

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true

update_due=1
if [ "$INTERVAL_SECONDS" -gt 0 ] && [ -f "$STAMP_FILE" ]; then
  last_success="$(sed -n '1p' "$STAMP_FILE" 2>/dev/null || true)"
  case "$last_success" in
    ''|*[!0-9]*) ;;
    *)
      now="$(date +%s)"
      if [ $((now - last_success)) -lt "$INTERVAL_SECONDS" ]; then update_due=0; fi
      ;;
  esac
fi

if [ "$update_due" -eq 1 ]; then
  lock_acquired=0
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    lock_acquired=1
  else
    lock_pid="$(sed -n '1p' "$LOCK_DIR/pid" 2>/dev/null || true)"
    case "$lock_pid" in
      ''|*[!0-9]*) lock_pid='' ;;
    esac
    if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
      warn "another Pi update is running; starting with the current configuration"
    else
      rm -f "$LOCK_DIR/pid"
      rmdir "$LOCK_DIR" 2>/dev/null || true
      if mkdir "$LOCK_DIR" 2>/dev/null; then lock_acquired=1; fi
    fi
  fi

  if [ "$lock_acquired" -eq 1 ]; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    cleanup_lock() {
      rm -f "$LOCK_DIR/pid"
      rmdir "$LOCK_DIR" 2>/dev/null || true
    }
    trap cleanup_lock EXIT
    trap 'cleanup_lock; exit 129' HUP
    trap 'cleanup_lock; exit 130' INT
    trap 'cleanup_lock; exit 143' TERM

    : > "$LOG_FILE"
    chmod 600 "$LOG_FILE" 2>/dev/null || true
    printf 'Pi preflight: updating CLI, config, extensions, and models… '

    refresh_status=0
    if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal 2>/dev/null)" ]; then
        printf '%s\n' "Config checkout has local changes; skipped Git refresh." >> "$LOG_FILE"
      else
        upstream="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
        if [ -n "$upstream" ]; then
          remote="${upstream%%/*}"
          if ! git -C "$REPO_ROOT" fetch --quiet "$remote" >> "$LOG_FILE" 2>&1 ||
             ! git -C "$REPO_ROOT" merge --ff-only "$upstream" >> "$LOG_FILE" 2>&1; then
            refresh_status=1
          fi
        else
          printf '%s\n' "Config checkout has no upstream; skipped Git refresh." >> "$LOG_FILE"
        fi
      fi
    fi

    update_status=0
    PI_CFG_REAL_PI="$REAL_PI" PI_CFG_UPDATE_RUNNING=1 \
      "$REPO_ROOT/scripts/update-pi.sh" >> "$LOG_FILE" 2>&1 || update_status=$?

    if [ "$update_status" -eq 0 ]; then
      if [ "$refresh_status" -eq 0 ]; then date +%s > "$STAMP_FILE"; fi
      if [ "$refresh_status" -eq 0 ]; then
        printf '\033[32mdone\033[0m\n'
      else
        printf '\033[33mdone (config Git refresh failed)\033[0m\n'
        warn "details: $LOG_FILE"
      fi
    else
      printf '\033[33mfailed\033[0m\n'
      warn "using the current installation; details: $LOG_FILE"
    fi

    cleanup_lock
    trap - EXIT HUP INT TERM
  fi
fi

# A self-update can replace the executable, so resolve it again immediately before launch.
REAL_PI="$(resolve_real_pi || true)"
if [ -z "$REAL_PI" ]; then
  warn "the underlying Pi executable disappeared during update"
  exit 127
fi
exec "$REAL_PI" "${FORWARDED_ARGS[@]}"
