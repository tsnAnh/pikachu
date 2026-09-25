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
progress() { printf 'Pi preflight: %s\n' "$1" >&2; }

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

check_cua_runtime() {
  progress "Checking CUA Driver and Chrome bridge"
  if ! command -v cua-driver >/dev/null 2>&1; then warn "CUA unavailable: install Cua Driver 0.28.2 or newer"; return 0; fi
  local version permissions tools bridge_socket manifest version_ok
  version="$(cua-driver --version 2>/dev/null | awk '{print $2}')"
  version_ok="$(node -e 'const [a,b,p]=process.argv[1].split(".").map(Number);process.stdout.write(a>0||b>28||(b===28&&p>=2)?"yes":"no")' "$version" 2>/dev/null || printf no)"
  if [ "$version_ok" != "yes" ]; then warn "CUA unavailable: Cua Driver >=0.28.2 is required (found ${version:-unknown})"; return 0; fi
  if ! cua-driver status >/dev/null 2>&1; then warn "CUA unavailable: start the CuaDriver app daemon"; return 0; fi
  permissions="$(cua-driver permissions status --json 2>/dev/null || true)"
  if ! printf '%s' "$permissions" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);process.exit(v.accessibility&&v.screen_recording?0:1)}catch{process.exit(1)}})' ; then
    warn "CUA unavailable: grant Accessibility and Screen Recording to CuaDriver"; return 0
  fi
  tools="$(cua-driver list-tools 2>/dev/null || true)"
  if ! printf '%s' "$tools" | grep -q 'set_agent_cursor_enabled'; then warn "CUA unavailable: this Driver build lacks the agent cursor overlay"; return 0; fi
  bridge_socket="$HOME/.pi/agent/browser-group.sock"
  manifest="$HOME/.pi/agent/browser-group/extension/manifest.json"
  if [ ! -f "$manifest" ]; then warn "CUA browser unavailable: run scripts/setup-pi.sh"; return 0; fi
  if [ ! -S "$bridge_socket" ] || ! node "$HOME/.pi/agent/browser-group/check-bridge.mjs" >/dev/null 2>&1; then warn "CUA browser unavailable: reload Pikachu Browser Use from ~/.pi/agent/browser-group/extension in Chrome; the expected handshake is not active"; return 0; fi
  progress "CUA ready: Driver $version, permissions, cursor overlay, and Chrome bridge"
}

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
  check_cua_runtime
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
    exec 3>&2
    progress "Checking configuration checkout"

    refresh_status=0
    if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal 2>/dev/null)" ]; then
        printf '%s\n' "Config checkout has local changes; skipped Git refresh." >> "$LOG_FILE"
        progress "Local config changes found; skipping Git refresh"
      else
        upstream="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
        if [ -n "$upstream" ]; then
          remote="${upstream%%/*}"
          progress "Fetching config updates"
          if ! git -C "$REPO_ROOT" fetch --quiet "$remote" >> "$LOG_FILE" 2>&1; then
            refresh_status=1
          else
            progress "Applying config fast-forward"
            if ! git -C "$REPO_ROOT" merge --ff-only "$upstream" >> "$LOG_FILE" 2>&1; then refresh_status=1; fi
          fi
        else
          printf '%s\n' "Config checkout has no upstream; skipped Git refresh." >> "$LOG_FILE"
          progress "No config upstream; skipping Git refresh"
        fi
      fi
    else
      progress "Git checkout unavailable; using local config"
    fi

    update_status=0
    PI_CFG_REAL_PI="$REAL_PI" PI_CFG_UPDATE_RUNNING=1 PI_CFG_PROGRESS_FD=3 \
      "$REPO_ROOT/scripts/update-pi.sh" >> "$LOG_FILE" 2>&1 || update_status=$?

    if [ "$update_status" -eq 0 ]; then
      if [ "$refresh_status" -eq 0 ]; then date +%s > "$STAMP_FILE"; fi
      if [ "$refresh_status" -eq 0 ]; then
        progress "Ready"
      else
        progress "Ready with existing config (Git refresh failed)"
        warn "details: $LOG_FILE"
      fi
    else
      progress "Update failed; starting the current installation"
      warn "using the current installation; details: $LOG_FILE"
    fi

    exec 3>&-
    cleanup_lock
    trap - EXIT HUP INT TERM
  fi
fi

check_cua_runtime

# A self-update can replace the executable, so resolve it again immediately before launch.
REAL_PI="$(resolve_real_pi || true)"
if [ -z "$REAL_PI" ]; then
  warn "the underlying Pi executable disappeared during update"
  exit 127
fi
exec "$REAL_PI" "${FORWARDED_ARGS[@]}"
