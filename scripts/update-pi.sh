#!/usr/bin/env bash
#
# Update everything to latest: the pi CLI, all configured packages,
# model catalogs, rtk, CodeMapper, and local extension dependencies.
#
set -euo pipefail

cd "$(dirname "$0")/.."

bold() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1" >&2; }

command -v pi >/dev/null 2>&1 || { printf '\033[31m✗ pi is not installed\033[0m\n' >&2; exit 1; }

bold "pi CLI + packages"
# --all covers self + packages; it reads agent/settings.json without rewriting it,
# so object-form entries (the pi-hooks LSP filter) survive.
pi update --all

bold "Model catalogs"
pi update --models

bold "rtk"
if command -v brew >/dev/null 2>&1 && brew list rtk >/dev/null 2>&1; then
  brew upgrade rtk || ok "already latest"
else
  warn "rtk not installed via Homebrew — skipping"
fi

bold "CodeMapper (cm)"
if command -v cargo >/dev/null 2>&1; then
  cargo install --locked --force --git https://github.com/p1rallels/codemapper.git
else
  warn "cargo not found — skipping"
fi

bold "Local extension dependencies"
for pkg_json in agent/extensions/*/package.json; do
  [ -e "$pkg_json" ] || continue
  dir="$(dirname "$pkg_json")"
  echo "    npm update → $dir"
  (cd "$dir" && npm update --omit=dev --no-audit --no-fund --silent)
  ok "$(basename "$dir")"
done

bold "Done"
pi list
