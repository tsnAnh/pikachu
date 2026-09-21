#!/usr/bin/env bash
# Install the repo-owned Pi preflight launcher ahead of the underlying Pi binary.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd -P)"
SOURCE="$REPO_ROOT/scripts/pi-launcher.sh"
BIN_DIR="${PI_LAUNCHER_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/pi"
BACKUP_ROOT="$HOME/.pi/backups/pi-cfg/$(date +%Y%m%d-%H%M%S)-$$/launcher"

ok() { printf '    \033[32m✓\033[0m %s\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ "$#" -eq 0 ] || die "Usage: $0"
case "$BIN_DIR" in ""|"/"|"$HOME") die "Refusing unsafe launcher directory: ${BIN_DIR:-<empty>}" ;; esac
[ -x "$SOURCE" ] || die "Launcher is not executable: $SOURCE"
mkdir -p "$BIN_DIR"

if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  if [ "$TARGET" -ef "$SOURCE" ]; then
    ok "Pi preflight launcher already installed: $TARGET"
    exit 0
  fi
  mkdir -p "$BACKUP_ROOT"
  cp -pP "$TARGET" "$BACKUP_ROOT/pi" || die "Failed to back up existing $TARGET"
  rm -f "$TARGET"
  ok "backed up previous launcher: $BACKUP_ROOT/pi"
fi

ln -s "$SOURCE" "$TARGET"
ok "installed Pi preflight launcher: $TARGET"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '    \033[33m!\033[0m Add %s to PATH before the existing Pi location.\n' "$BIN_DIR" >&2 ;;
esac
