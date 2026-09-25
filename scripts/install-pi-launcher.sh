#!/usr/bin/env bash
# Install the repo-owned Pi preflight launcher ahead of the underlying Pi binary.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd -P)"
SOURCE="$REPO_ROOT/scripts/pi-launcher.sh"
ANDROID_SOURCE="$REPO_ROOT/scripts/jev-android-mcp-launcher.sh"
BIN_DIR="${PI_LAUNCHER_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/pi"
ANDROID_TARGET="$BIN_DIR/pikachu-jev-android-mcp"
BACKUP_ROOT="$HOME/.pi/backups/pi-cfg/$(date +%Y%m%d-%H%M%S)-$$/launcher"

ok() { printf '    \033[32m✓\033[0m %s\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ "$#" -eq 0 ] || die "Usage: $0"
case "$BIN_DIR" in ""|"/"|"$HOME") die "Refusing unsafe launcher directory: ${BIN_DIR:-<empty>}" ;; esac
[ -x "$SOURCE" ] || die "Launcher is not executable: $SOURCE"
[ -x "$ANDROID_SOURCE" ] || die "Launcher is not executable: $ANDROID_SOURCE"
mkdir -p "$BIN_DIR"

if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  if [ "$TARGET" -ef "$SOURCE" ]; then
    ok "Pi preflight launcher already installed: $TARGET"
  else
    mkdir -p "$BACKUP_ROOT"
    cp -pP "$TARGET" "$BACKUP_ROOT/pi" || die "Failed to back up existing $TARGET"
    rm -f "$TARGET"
    ok "backed up previous launcher: $BACKUP_ROOT/pi"
    ln -s "$SOURCE" "$TARGET"
    ok "installed Pi preflight launcher: $TARGET"
  fi
else
  ln -s "$SOURCE" "$TARGET"
  ok "installed Pi preflight launcher: $TARGET"
fi

if [ -e "$ANDROID_TARGET" ] || [ -L "$ANDROID_TARGET" ]; then
  if [ "$ANDROID_TARGET" -ef "$ANDROID_SOURCE" ]; then
    ok "Jev Android MCP launcher already installed: $ANDROID_TARGET"
  else
    mkdir -p "$BACKUP_ROOT"
    cp -pP "$ANDROID_TARGET" "$BACKUP_ROOT/pikachu-jev-android-mcp" || die "Failed to back up existing $ANDROID_TARGET"
    rm -f "$ANDROID_TARGET"
    ln -s "$ANDROID_SOURCE" "$ANDROID_TARGET"
    ok "installed Jev Android MCP launcher: $ANDROID_TARGET"
  fi
else
  ln -s "$ANDROID_SOURCE" "$ANDROID_TARGET"
  ok "installed Jev Android MCP launcher: $ANDROID_TARGET"
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '    \033[33m!\033[0m Add %s to PATH before the existing Pi location.\n' "$BIN_DIR" >&2 ;;
esac
