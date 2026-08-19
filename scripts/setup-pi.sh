#!/usr/bin/env bash
#
# Bootstrap the pi environment described by agent/settings.json.
# Safe to re-run — every step is idempotent. Pass --force to rebuild cm.
#
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
SETTINGS="$REPO_ROOT/agent/settings.json"
FORCE="${1:-}"

bold()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()    { printf '    \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '    \033[33m!\033[0m %s\n' "$1" >&2; }
die()   { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ -f "$SETTINGS" ] || die "Missing $SETTINGS — is this repo cloned to ~/.pi?"

# ── Prerequisites ────────────────────────────────────────────────────
bold "Checking prerequisites"
for cmd in pi npm cargo jq; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' is required but not installed."
  ok "$cmd"
done
if command -v brew >/dev/null 2>&1; then ok "brew"; else warn "Homebrew not found — rtk install will be skipped."; fi

# ── rtk ──────────────────────────────────────────────────────────────
bold "rtk (token-reducing CLI proxy)"
if command -v rtk >/dev/null 2>&1 && [ "$FORCE" != "--force" ]; then
  ok "already installed"
elif command -v brew >/dev/null 2>&1; then
  brew install rtk
else
  warn "skipped — install Homebrew, then: brew install rtk"
fi

# ── CodeMapper ───────────────────────────────────────────────────────
bold "CodeMapper (cm)"
if command -v cm >/dev/null 2>&1 && [ "$FORCE" != "--force" ]; then
  ok "already installed — re-run with --force to rebuild"
else
  cargo install --locked --git https://github.com/p1rallels/codemapper.git
fi

# ── Local extension dependencies ─────────────────────────────────────
# Pi runs `npm install` for packages it installs, but NOT for extensions
# auto-discovered under agent/extensions/. Their deps are ours to install.
bold "Local extension dependencies"
found_ext_deps=0
for pkg_json in agent/extensions/*/package.json; do
  [ -e "$pkg_json" ] || continue
  found_ext_deps=1
  dir="$(dirname "$pkg_json")"
  echo "    npm install → $dir"
  (cd "$dir" && npm install --omit=dev --no-audit --no-fund --silent)
  ok "$(basename "$dir")"
done
[ "$found_ext_deps" -eq 1 ] || ok "none to install"

# ── Pi packages ──────────────────────────────────────────────────────
bold "Pi packages"
while IFS= read -r pkg; do
  [ -n "$pkg" ] || continue
  echo "    pi install $pkg"
  pi install "$pkg"
done < <(jq -r '.packages[] | if type == "string" then . else .source end' "$SETTINGS")

bold "Done"
pi list
