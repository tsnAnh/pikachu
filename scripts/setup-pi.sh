#!/usr/bin/env bash
# Validate this repository and deploy its allowlisted Pi configuration.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd -P)"
SOURCE_AGENT="$REPO_ROOT/agent"
TARGET_AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
bold() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok() { printf '    \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1" >&2; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) [ "$#" -ge 2 ] || die "--target requires a directory"; TARGET_AGENT="$2"; shift 2 ;;
    -h|--help) printf 'Usage: %s [--target <agent-dir>]\n' "$0"; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done
case "$TARGET_AGENT" in ""|"/"|"$HOME"|"${HOME}/") die "Refusing unsafe target: ${TARGET_AGENT:-<empty>}" ;; esac
for command in node npm rsync git python3 uv; do command -v "$command" >/dev/null 2>&1 || die "'$command' is required"; done
python3 -c 'import sys; raise SystemExit(sys.version_info < (3, 12))' || die "Python 3.12 or newer is required"
resolve_pi_bin() {
  if [ -n "${PI_CFG_REAL_PI:-}" ] && [ -x "$PI_CFG_REAL_PI" ]; then printf '%s\n' "$PI_CFG_REAL_PI"; return 0; fi
  local directory candidate old_ifs="$IFS"
  IFS=:
  for directory in $PATH; do
    [ -n "$directory" ] || directory="."
    candidate="$directory/pi"
    [ -x "$candidate" ] || continue
    if [ -e "$REPO_ROOT/scripts/pi-launcher.sh" ] && [ "$candidate" -ef "$REPO_ROOT/scripts/pi-launcher.sh" ]; then continue; fi
    IFS="$old_ifs"; printf '%s\n' "$candidate"; return 0
  done
  IFS="$old_ifs"; return 1
}
PI_BIN="$(resolve_pi_bin || true)"
[ -n "$PI_BIN" ] || die "'pi' is required"
NODE_VERSION="$(node --version | sed 's/^v//')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<19))process.exit(1)' ||
  die "node $NODE_VERSION is too old; Node >=22.19 is required"

bold "Optional Jev"
KEYCHAIN_SERVICE="pikachu.typesafe-api-key"
KEYCHAIN_ACCOUNT="${USER:-$(id -un)}"
if [ -n "${TYPESAFE_API_KEY:-}" ]; then
  ok "TYPESAFE_API_KEY is available from the environment"
elif command -v security >/dev/null 2>&1 &&
  STORED_TYPESAFE_KEY="$(security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)" &&
  [ -n "$STORED_TYPESAFE_KEY" ]; then
  export TYPESAFE_API_KEY="$STORED_TYPESAFE_KEY"
  unset STORED_TYPESAFE_KEY
  ok "TYPESAFE_API_KEY loaded from macOS Keychain"
elif [ "${PI_CFG_UPDATE_RUNNING:-0}" = "1" ] || [ ! -t 0 ]; then
  warn "Jev is not configured; Pi will use the active coding model for native compaction"
elif command -v security >/dev/null 2>&1; then
  printf '    Enable optional Jev decisions and compaction? [y/N]: '
  IFS= read -r ENABLE_JEV
  case "$ENABLE_JEV" in
    y|Y|yes|YES|Yes)
      printf '    Enter TYPESAFE_API_KEY (hidden, Enter to cancel): '
      IFS= read -r -s TYPESAFE_KEY_INPUT
      printf '\n'
      if [ -n "$TYPESAFE_KEY_INPUT" ]; then
        security add-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w "$TYPESAFE_KEY_INPUT" -U >/dev/null ||
          die "Failed to save TYPESAFE_API_KEY in macOS Keychain"
        export TYPESAFE_API_KEY="$TYPESAFE_KEY_INPUT"
        unset TYPESAFE_KEY_INPUT
        ok "TYPESAFE_API_KEY saved in macOS Keychain"
      else
        warn "Jev setup cancelled; Pi will use the active coding model for native compaction"
      fi
      ;;
    *)
      ok "Jev skipped; Pi will use the active coding model for native compaction"
      ;;
  esac
  unset ENABLE_JEV
else
  warn "Jev is optional and no supported secure credential store was found; using Pi's active coding model"
fi

bold "Validating repository configuration"
for file in settings.json jev.json zentui.json; do
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$SOURCE_AGENT/$file"
  ok "$file"
done
for file in models.json mcp.json; do
  if [ -f "$SOURCE_AGENT/$file" ]; then
    node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$SOURCE_AGENT/$file"
    ok "$file"
  fi
done
node - "$SOURCE_AGENT/settings.json" <<'NODE'
const settings=JSON.parse(require("node:fs").readFileSync(process.argv[2],"utf8"));
const errors=[];
for(const entry of settings.packages??[]){
  const source=typeof entry==="string"?entry:entry.source;
  if(source.startsWith("npm:")){
    if(source.slice(4).lastIndexOf("@")<=0)errors.push(`npm package is not exactly pinned: ${source}`);
  }else if(source.startsWith("git:")){
    if(source.slice(4).lastIndexOf("@")<=0)errors.push(`git package is not pinned to a ref: ${source}`);
  }else errors.push(`unsupported package source: ${source}`);
}
if(errors.length){console.error(errors.join("\n"));process.exit(1)}
NODE
ok "all package sources are pinned"
for pkg in "$SOURCE_AGENT"/extensions/*/package.json; do
  [ -e "$pkg" ] || continue
  [ -f "$(dirname "$pkg")/package-lock.json" ] || die "Missing lockfile for local extension: $pkg"
done
ok "local extension lockfiles"

mkdir -p "$TARGET_AGENT"
TARGET_AGENT="$(cd "$TARGET_AGENT" && pwd -P)"
SOURCE_AGENT_REAL="$(cd "$SOURCE_AGENT" && pwd -P)"
PI_ROOT="$(dirname "$TARGET_AGENT")"
BACKUP_ROOT="$PI_ROOT/backups/pi-cfg/$(date +%Y%m%d-%H%M%S)"
BACKUP_CREATED=0
backup_path() {
  local relative="$1"
  local source="$TARGET_AGENT/$relative"
  [ -e "$source" ] || return 0
  local destination="$BACKUP_ROOT/$relative"
  mkdir -p "$(dirname "$destination")"
  cp -pR "$source" "$destination" || die "Failed to back up $relative"
  BACKUP_CREATED=1
}
sync_file() {
  local relative="$1"
  local source="$SOURCE_AGENT/$relative"
  [ -f "$source" ] || return 0
  local destination="$TARGET_AGENT/$relative"
  if [ -f "$destination" ] && cmp -s "$source" "$destination"; then return 0; fi
  backup_path "$relative"
  mkdir -p "$(dirname "$destination")"
  cp -p "$source" "$destination" || die "Failed to sync $relative"
  ok "synced $relative"
}
sync_directory() {
  local relative="$1"
  local source="$SOURCE_AGENT/$relative"
  [ -d "$source" ] || return 0
  local destination="$TARGET_AGENT/$relative"
  if [ -d "$destination" ] &&
    diff -qr --exclude node_modules --exclude .venv --exclude .upstream --exclude .browser-use-upstream --exclude __pycache__ --exclude .DS_Store "$source" "$destination" >/dev/null 2>&1; then return 0; fi
  backup_path "$relative"; mkdir -p "$destination"
  rsync -a --delete --exclude node_modules --exclude .venv --exclude .upstream --exclude .browser-use-upstream --exclude __pycache__ --exclude '*.pyc' --exclude .DS_Store "$source/" "$destination/" ||
    die "Failed to sync $relative"
  ok "synced $relative"
}

if [ "$SOURCE_AGENT_REAL" != "$TARGET_AGENT" ]; then
  bold "Syncing repo-owned configuration"
  for file in settings.json models.json mcp.json jev.json zentui.json; do sync_file "$file"; done
  for extension in context.ts plan-mode.ts delegation-mode.ts jev-control jev-browser; do
    if [ -d "$SOURCE_AGENT/extensions/$extension" ]; then sync_directory "extensions/$extension"
    else sync_file "extensions/$extension"; fi
  done
  retired="extensions/pi-rtk-optimizer"
  if [ -e "$TARGET_AGENT/$retired" ]; then
    backup_path "$retired"; rm -rf "$TARGET_AGENT/$retired"; ok "retired $retired"
  fi
else
  ok "source is the live agent directory; no copy required"
fi
if [ "$BACKUP_CREATED" -eq 1 ]; then ok "backup: $BACKUP_ROOT"; fi

bold "Installing local extension dependencies"
for pkg in "$TARGET_AGENT"/extensions/*/package.json; do
  [ -e "$pkg" ] || continue; dir="$(dirname "$pkg")"
  (cd "$dir" && npm ci --omit=dev --no-audit --no-fund --silent); ok "$(basename "$dir")"
done

bold "Installing complete Jev Ultrafast checkout"
JEV_BROWSER_DIR="$TARGET_AGENT/extensions/jev-browser"
JEV_ULTRAFAST_REF="1231850a0bf1a0c0341fe408ef1668dbbfdfac46"
JEV_ULTRAFAST_DIR="$JEV_BROWSER_DIR/.upstream"
JEV_BROWSER_PYTHON="$JEV_ULTRAFAST_DIR/.venv/bin/python"
if [ -d "$JEV_BROWSER_DIR/.venv" ]; then rm -rf "$JEV_BROWSER_DIR/.venv"; ok "retired package-only Jev runtime"; fi
if [ ! -d "$JEV_ULTRAFAST_DIR/.git" ]; then
  rm -rf "$JEV_ULTRAFAST_DIR"
  git clone --no-checkout --filter=blob:none https://github.com/browser-use/jev-ultrafast.git "$JEV_ULTRAFAST_DIR" >/dev/null 2>&1 ||
    die "Failed to clone Jev Ultrafast"
fi
git -C "$JEV_ULTRAFAST_DIR" fetch --depth 1 origin "$JEV_ULTRAFAST_REF" >/dev/null 2>&1 ||
  die "Failed to fetch pinned Jev Ultrafast commit"
git -C "$JEV_ULTRAFAST_DIR" checkout --detach --force "$JEV_ULTRAFAST_REF" >/dev/null 2>&1 ||
  die "Failed to check out pinned Jev Ultrafast commit"
git -C "$JEV_ULTRAFAST_DIR" clean -fd >/dev/null 2>&1 || die "Failed to clean Jev Ultrafast checkout"
[ "$(git -C "$JEV_ULTRAFAST_DIR" rev-parse HEAD)" = "$JEV_ULTRAFAST_REF" ] || die "Jev Ultrafast checkout verification failed"
git -C "$JEV_ULTRAFAST_DIR" apply --unidiff-zero "$JEV_BROWSER_DIR/patches/navigation-settle.patch" ||
  die "Failed to apply Jev Ultrafast navigation-settle patch"
uv sync --frozen --no-dev --project "$JEV_ULTRAFAST_DIR" --quiet
"$JEV_BROWSER_PYTHON" -c 'import jev_ultrafast; import browser_harness' || die "Jev browser runtime import check failed"
ok "complete jev-ultrafast checkout @ $JEV_ULTRAFAST_REF"


bold "Installing complete Browser Use checkout"
BROWSER_USE_REF="d8110c5ff87ccba887aaa726cdb780f2f84bef8d"
BROWSER_USE_DIR="$JEV_BROWSER_DIR/.browser-use-upstream"
BROWSER_USE_PYTHON="$BROWSER_USE_DIR/.venv/bin/python"
if [ ! -d "$BROWSER_USE_DIR/.git" ]; then
  rm -rf "$BROWSER_USE_DIR"
  git clone --no-checkout --filter=blob:none https://github.com/browser-use/browser-use.git "$BROWSER_USE_DIR" >/dev/null 2>&1 ||
    die "Failed to clone Browser Use"
fi
git -C "$BROWSER_USE_DIR" fetch --depth 1 origin "$BROWSER_USE_REF" >/dev/null 2>&1 || die "Failed to fetch pinned Browser Use commit"
git -C "$BROWSER_USE_DIR" checkout --detach --force "$BROWSER_USE_REF" >/dev/null 2>&1 || die "Failed to check out pinned Browser Use commit"
git -C "$BROWSER_USE_DIR" clean -fd >/dev/null 2>&1 || die "Failed to clean Browser Use checkout"
[ "$(git -C "$BROWSER_USE_DIR" rev-parse HEAD)" = "$BROWSER_USE_REF" ] || die "Browser Use checkout verification failed"
cp "$JEV_BROWSER_DIR/browser-use.uv.lock" "$BROWSER_USE_DIR/uv.lock" || die "Failed to install reviewed Browser Use lockfile"
uv sync --frozen --no-dev --python 3.12 --project "$BROWSER_USE_DIR" --quiet
"$BROWSER_USE_PYTHON" -c 'from browser_use import Agent, BrowserSession; from browser_use.llm.base import BaseChatModel' || die "Browser Use runtime import check failed"
ok "complete browser-use checkout @ $BROWSER_USE_REF"
bold "Installing bundled CloakBrowser"
"$JEV_BROWSER_DIR/node_modules/.bin/cloakbrowser" install >/dev/null
ok "CloakBrowser binary"
BUNDLED_BROWSER_URL="http://127.0.0.1:9223"
DEFAULT_LIVE_AGENT="$HOME/.pi/agent"
if [ "$TARGET_AGENT" = "$DEFAULT_LIVE_AGENT" ]; then
  BROWSER_STATE_DIR="$HOME/.local/share/pikachu/jev-browser"
  BROWSER_LOG_DIR="$HOME/.cache/pikachu"
  LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.pikachu.jev-browser.plist"
  mkdir -p "$BROWSER_STATE_DIR" "$BROWSER_LOG_DIR" "$(dirname "$LAUNCH_AGENT")"
  chmod 700 "$BROWSER_STATE_DIR"
  node - "$LAUNCH_AGENT" "$(command -v node)" "$JEV_BROWSER_DIR/chromium-host.mjs" "$BROWSER_STATE_DIR" "$BROWSER_LOG_DIR" <<'NODE'
const fs = require("node:fs");
const [plist, node, script, state, logs] = process.argv.slice(2);
const esc = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.pikachu.jev-browser</string>
<key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(script)}</string></array>
<key>EnvironmentVariables</key><dict>
<key>JEV_BROWSER_STATE_DIR</key><string>${esc(state)}</string>
<key>JEV_BROWSER_CDP_PORT</key><string>9223</string>
</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${esc(logs)}/jev-browser.log</string>
<key>StandardErrorPath</key><string>${esc(logs)}/jev-browser-error.log</string>
</dict></plist>\n`;
fs.writeFileSync(plist, xml, { mode: 0o600 });
NODE
  launchctl bootout "gui/$(id -u)/com.pikachu.jev-browser" >/dev/null 2>&1 || true
  for _ in $(seq 1 50); do
    launchctl print "gui/$(id -u)/com.pikachu.jev-browser" >/dev/null 2>&1 || break
    sleep 0.1
  done
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT" >/dev/null
  for _ in $(seq 1 50); do curl -fsS "$BUNDLED_BROWSER_URL/json/version" >/dev/null 2>&1 && break; sleep 0.1; done
  curl -fsS "$BUNDLED_BROWSER_URL/json/version" >/dev/null 2>&1 || die "CloakBrowser did not expose CDP on port 9223"
  ok "persistent CloakBrowser"
else
  warn "Bundled Chromium LaunchAgent is installed only for the live ~/.pi/agent profile"
fi
if ! BU_NAME=pikachu-chromium BU_CDP_URL="$BUNDLED_BROWSER_URL" "$JEV_BROWSER_PYTHON" -c 'from browser_harness.admin import ensure_daemon; ensure_daemon()' >/dev/null 2>&1; then
  if [ "${PI_CFG_UPDATE_RUNNING:-0}" = "1" ] || [ "$TARGET_AGENT" != "$DEFAULT_LIVE_AGENT" ]; then
    warn "Bundled Chromium is installed but its Browser Harness daemon is not active"
  else
    die "Browser Harness could not connect to CloakBrowser at $BUNDLED_BROWSER_URL"
  fi
else
  ok "Browser Harness connected to CloakBrowser without Chrome permission prompts"
fi

bold "Materializing exact npm package set"
mkdir -p "$TARGET_AGENT/npm"
node - "$TARGET_AGENT/settings.json" "$TARGET_AGENT/npm/package.json" <<'NODE'
const fs = require("node:fs");
const settings = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const dependencies = {};
for (const entry of settings.packages ?? []) {
  const source = typeof entry === "string" ? entry : entry.source;
  if (!source.startsWith("npm:")) continue;
  const spec = source.slice(4);
  const split = spec.lastIndexOf("@");
  dependencies[spec.slice(0, split)] = spec.slice(split + 1);
}
fs.writeFileSync(
  process.argv[3],
  `${JSON.stringify({ name: "pi-extensions", private: true, dependencies }, null, 2)}\n`,
  { mode: 0o600 },
);
NODE
npm install --prefix "$TARGET_AGENT/npm" --legacy-peer-deps --no-audit --no-fund --silent
ok "exact npm dependency graph"

bold "Installing pinned Pi packages"
PI_CODING_AGENT_DIR="$TARGET_AGENT" "$PI_BIN" update --extensions
PI_CODING_AGENT_DIR="$TARGET_AGENT" "$PI_BIN" list

LIVE_AGENT="$HOME/.pi/agent"
if [ -d "$LIVE_AGENT" ]; then LIVE_AGENT="$(cd "$LIVE_AGENT" && pwd -P)"; fi
if [ "$TARGET_AGENT" = "$LIVE_AGENT" ]; then
  bold "Installing Pi startup preflight"
  scripts/install-pi-launcher.sh
fi
bold "Done"
ok "live config: $TARGET_AGENT"
