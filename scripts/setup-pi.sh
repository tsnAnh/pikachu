#!/usr/bin/env bash
#
# Bootstrap the pi environment described by agent/settings.json.
# Safe to re-run — every step is idempotent. Pass --force to rebuild cm/rtk.
#
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
SETTINGS="$REPO_ROOT/agent/settings.json"
FORCE="${1:-}"

bold() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ -f "$SETTINGS" ] || die "Missing $SETTINGS"

# ── Prerequisites ────────────────────────────────────────────────────
bold "Checking prerequisites"
for cmd in pi npm cargo python3 uv; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' is required but not installed."
  ok "$cmd"
done
if command -v brew >/dev/null 2>&1; then ok "brew"; else warn "Homebrew not found — rtk install will be skipped."; fi

# pi-hashline-edit-pro declares engines.node >= 22.19.0. Fail here with a clear
# message rather than part-way through installing 16 packages.
NODE_FULL="$(node --version 2>/dev/null | tr -d 'v')"
NODE_MAJOR="${NODE_FULL%%.*}"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "Could not determine node version (got '${NODE_FULL:-nothing}')." ;;
esac
if [ "$NODE_MAJOR" -lt 22 ]; then
  die "node $NODE_FULL is too old — pi-hashline-edit-pro needs >= 22.19.0."
fi
ok "node $NODE_FULL"

# ── Is pi actually going to read our settings file? ──────────────────
# pi reads global settings from $PI_CODING_AGENT_DIR (default ~/.pi/agent).
# If this repo isn't cloned to ~/.pi, everything below would configure a
# different settings.json than the one in this repo — silently.
bold "Checking config location"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
if [ "$(cd "$REPO_ROOT/agent" 2>/dev/null && pwd -P)" = "$(cd "$PI_DIR" 2>/dev/null && pwd -P)" ]; then
  ok "pi reads $SETTINGS"
else
  warn "pi reads its global settings from: $PI_DIR"
  warn "but this repo's settings file is:   $SETTINGS"
  warn "Clone this repo to ~/.pi, or export PI_CODING_AGENT_DIR=$REPO_ROOT/agent"
  die  "Refusing to continue — packages would install against the wrong config."
fi

# ── Shadowed packages ────────────────────────────────────────────────
# pi resolves a user-scope npm package to agent/npm/node_modules/<name>, but
# ONLY if it already exists there. Otherwise it falls back to a globally
# npm-installed copy and uses that instead (getNpmInstallPath -> legacy global
# path). A stale `npm i -g <pi-package>` therefore silently shadows the version
# this repo declares, and the config you are reading is not the one running.
bold "Checking for globally-installed pi packages"
GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
shadowed=0
if [ -n "$GLOBAL_ROOT" ] && [ -d "$GLOBAL_ROOT" ]; then
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if [ -d "$GLOBAL_ROOT/$name" ] && [ ! -d "agent/npm/node_modules/$name" ]; then
      warn "$name is installed globally and will shadow this repo's copy"
      shadowed=$((shadowed + 1))
    fi
  done < <(node -e '
    const d = require("./agent/settings.json");
    for (const p of d.packages) {
      const s = typeof p === "string" ? p : p.source;
      if (s.startsWith("npm:")) console.log(s.slice(4).replace(/@[^@/]+$/, ""));
    }' 2>/dev/null)
fi
if [ "$shadowed" -gt 0 ]; then
  warn ""
  warn "Remove them so pi manages its own copies under agent/npm:"
  warn "  npm rm -g <name> ...    # then re-run this script"
  warn "Stale global copies are a real hazard: an old amp-themes bundles"
  warn "pi-tool-display, whose 'read' tool collides with pi-hashline-edit-pro"
  warn "and stops pi from starting at all."
else
  ok "none shadowing"
fi

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
# pi runs `npm install` for packages it installs, but NOT for extensions
# auto-discovered under agent/extensions/. Their deps are ours to install.
bold "Local extension dependencies"
found=0
for pkg_json in agent/extensions/*/package.json; do
  [ -e "$pkg_json" ] || continue
  found=1
  dir="$(dirname "$pkg_json")"
  echo "    npm install → $dir"
  (cd "$dir" && npm install --omit=dev --no-audit --no-fund --silent)
  ok "$(basename "$dir")"
done
[ "$found" -eq 1 ] || ok "none to install"

# ── Verified-plan service ────────────────────────────────────────────
bold "Verified-plan service"
uv sync --frozen --project "$REPO_ROOT/scripts/verifier" --quiet
ok "Python environment synced"
if [ -n "${OPENAI_BASE_URL:-}${DEEPSEEK_API_KEY:-}${VERTEX_API_KEY:-}" ]; then
  if uv run --frozen --project "$REPO_ROOT/scripts/verifier" python "$REPO_ROOT/scripts/verifier/service.py" --check >/dev/null; then
    ok "verifier model exposes score-token logprobs"
  else
    warn "verifier capability probe failed — /plan will present gate-passing plans unranked"
  fi
else
  warn "verifier endpoint is not configured — /plan will present gate-passing plans unranked"
fi

# ── Pi packages ──────────────────────────────────────────────────────
# `pi update --extensions` installs anything missing and updates the rest,
# reading agent/settings.json without rewriting it. Do NOT loop over
# `pi install` here: that rewrites settings.json and would flatten the
# object-form entries (e.g. the pi-hooks LSP filter) back into plain strings.
bold "Pi packages"
pi update --extensions

bold "Done"
pi list
