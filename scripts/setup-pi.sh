#!/usr/bin/env bash
# Validate this repository and deploy its allowlisted Pi configuration.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd -P)"
SOURCE_AGENT="$REPO_ROOT/agent"
TARGET_AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
bold() {
  printf '\n\033[1m==> %s\033[0m\n' "$1"
  if [ "${PI_CFG_PROGRESS_FD:-}" = "3" ] && [ "$1" != "Done" ]; then printf 'Pi preflight: %s\n' "$1" >&3; fi
}
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
command -v cua-driver >/dev/null 2>&1 || die "Cua Driver is required; install it from https://cua.ai/docs/how-to-guides/driver/install"
CUA_DRIVER_VERSION="$(cua-driver --version | awk '{print $2}')"
node -e 'const [major,minor,patch]=process.argv[1].split(".").map(Number);if(!Number.isInteger(major)||!Number.isInteger(minor)||!Number.isInteger(patch)||major<0||(major===0&&(minor<28||(minor===28&&patch<2))))process.exit(1)' "$CUA_DRIVER_VERSION" ||
  die "Cua Driver >=0.28.2 is required (found $CUA_DRIVER_VERSION)"
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
  warn "Jev is not configured; model routing and specialist judgments will use deterministic fallbacks"
elif command -v security >/dev/null 2>&1; then
  printf '    Enable optional Jev routing and specialist decisions? [y/N]: '
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
        warn "Jev setup cancelled; deterministic fallbacks remain available"
      fi
      ;;
    *)
      ok "Jev skipped; deterministic fallbacks remain available"
      ;;
  esac
  unset ENABLE_JEV
else
  warn "Jev is optional and no supported secure credential store was found; using Pi's active coding model"
fi

bold "Validating repository configuration"
for file in settings.json zentui.json android-automator.json; do
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$SOURCE_AGENT/$file"
  ok "$file"
done
for file in models.json mcp.json; do
  if [ -f "$SOURCE_AGENT/$file" ]; then
    node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))' "$SOURCE_AGENT/$file"
    ok "$file"
  fi
done
node - "$SOURCE_AGENT/android-automator.json" <<'NODE'
const value=JSON.parse(require("node:fs").readFileSync(process.argv[2],"utf8"));
const sha=/^[a-f0-9]{64}$/;
const agent=/^[a-z][a-z0-9-]{0,62}$/;
if(value.version!==1||typeof value.packageVersion!=="string"||!value.packageVersion||
  typeof value.wheelFile!=="string"||!/^jev_android_automator-[A-Za-z0-9_.-]+\.whl$/.test(value.wheelFile)||
  typeof value.wheelSha256!=="string"||!sha.test(value.wheelSha256)||
  typeof value.sourcePath!=="string"||!value.sourcePath||typeof value.agentId!=="string"||!agent.test(value.agentId)){
  console.error("android-automator.json is invalid");process.exit(1);
}
NODE
ok "Android automator release metadata"
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
    diff -qr --exclude node_modules --exclude .venv --exclude .upstream --exclude __pycache__ --exclude .DS_Store "$source" "$destination" >/dev/null 2>&1; then return 0; fi
  backup_path "$relative"; mkdir -p "$destination"
  rsync -a --delete --exclude node_modules --exclude .venv --exclude .upstream --exclude __pycache__ --exclude '*.pyc' --exclude .DS_Store "$source/" "$destination/" ||
    die "Failed to sync $relative"
  ok "synced $relative"
}

if [ "$SOURCE_AGENT_REAL" != "$TARGET_AGENT" ]; then
  bold "Syncing repo-owned configuration"
  for file in AGENTS.md settings.json models.json mcp.json zentui.json android-automator.json; do sync_file "$file"; done
  for extension in context.ts plan-mode.ts delegation-mode.ts jev-control cua-runtime; do
    if [ -d "$SOURCE_AGENT/extensions/$extension" ]; then sync_directory "extensions/$extension"
    else sync_file "extensions/$extension"; fi
  done
  sync_directory "browser-group"
  sync_directory "skills/test-audit"
  sync_directory "skills/jev-use"
  sync_directory "skills/gui-automation"
  for retired in extensions/pi-rtk-optimizer extensions/jev-browser jev.json; do
    if [ -e "$TARGET_AGENT/$retired" ]; then
      mkdir -p "$(dirname "$BACKUP_ROOT/$retired")"
      mv "$TARGET_AGENT/$retired" "$BACKUP_ROOT/$retired" || die "Failed to retire $retired"
      BACKUP_CREATED=1
      ok "retired $retired"
    fi
  done
  if [ "$TARGET_AGENT" = "$HOME/.pi/agent" ]; then
    old_agent="$HOME/Library/LaunchAgents/com.pikachu.jev-browser.plist"
    if [ -f "$old_agent" ]; then
      launchctl bootout "gui/$(id -u)/com.pikachu.jev-browser" >/dev/null 2>&1 || true
      mkdir -p "$BACKUP_ROOT/launch-agents"
      mv "$old_agent" "$BACKUP_ROOT/launch-agents/com.pikachu.jev-browser.plist"
      BACKUP_CREATED=1
      ok "retired CloakBrowser LaunchAgent"
    fi
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

bold "Installing Jev Android Automator runtime"
ANDROID_CONFIG="$TARGET_AGENT/android-automator.json"
ANDROID_RUNTIME="$TARGET_AGENT/runtimes/jev-android-automator"
ANDROID_SOURCE_RAW="${JEV_ANDROID_AUTOMATOR_SOURCE:-$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.sourcePath)' "$ANDROID_CONFIG")}"
case "$ANDROID_SOURCE_RAW" in
  "~/"*) ANDROID_SOURCE="$HOME/${ANDROID_SOURCE_RAW#\~/}" ;;
  /*) ANDROID_SOURCE="$ANDROID_SOURCE_RAW" ;;
  *) die "android-automator.json sourcePath must be absolute or start with ~/" ;;
esac
ANDROID_WHEEL_FILE="$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.wheelFile)' "$ANDROID_CONFIG")"
ANDROID_WHEEL_SHA="$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.wheelSha256)' "$ANDROID_CONFIG")"
ANDROID_PACKAGE_VERSION="$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.packageVersion)' "$ANDROID_CONFIG")"
ANDROID_WHEEL="$ANDROID_SOURCE/dist/$ANDROID_WHEEL_FILE"
ANDROID_PYTHON="$ANDROID_RUNTIME/.venv/bin/python"
ANDROID_MARKER="$ANDROID_RUNTIME/.install-fingerprint"
if [ -f "$ANDROID_WHEEL" ] && [ -f "$ANDROID_SOURCE/uv.lock" ] && [ -f "$ANDROID_SOURCE/pyproject.toml" ]; then
  ACTUAL_ANDROID_SHA="$(node -e '
const fs=require("node:fs"),crypto=require("node:crypto");
process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
' "$ANDROID_WHEEL")"
  [ "$ACTUAL_ANDROID_SHA" = "$ANDROID_WHEEL_SHA" ] || die "Jev Android Automator wheel checksum does not match android-automator.json"
  ACTUAL_ANDROID_VERSION="$(node -e '
const text=require("node:fs").readFileSync(process.argv[1],"utf8");
const match=/^version\s*=\s*"([^"]+)"/m.exec(text);if(!match)process.exit(1);process.stdout.write(match[1]);
' "$ANDROID_SOURCE/pyproject.toml")"
  [ "$ACTUAL_ANDROID_VERSION" = "$ANDROID_PACKAGE_VERSION" ] || die "Jev Android Automator source version does not match android-automator.json"
  ANDROID_FINGERPRINT="$(node -e '
const fs=require("node:fs"),crypto=require("node:crypto"),hash=crypto.createHash("sha256");
for(const path of process.argv.slice(1))hash.update(fs.readFileSync(path));process.stdout.write(hash.digest("hex"));
' "$ANDROID_WHEEL" "$ANDROID_SOURCE/uv.lock")"
  INSTALLED_ANDROID_FINGERPRINT="$(sed -n '1p' "$ANDROID_MARKER" 2>/dev/null || true)"
  if [ "$INSTALLED_ANDROID_FINGERPRINT" != "$ANDROID_FINGERPRINT" ] ||
    ! "$ANDROID_PYTHON" -c 'import jev_android_automator' >/dev/null 2>&1; then
    mkdir -p "$(dirname "$ANDROID_RUNTIME")"
    ANDROID_TEMP="$(mktemp -d "${ANDROID_RUNTIME}.install.XXXXXX")"
    if ! (
      set -e
      uv export --frozen --no-dev --no-emit-project --project "$ANDROID_SOURCE" --output-file "$ANDROID_TEMP/requirements.txt" --quiet
      uv venv --python 3.12 "$ANDROID_TEMP/.venv" --quiet
      uv pip sync --python "$ANDROID_TEMP/.venv/bin/python" "$ANDROID_TEMP/requirements.txt" --quiet
      uv pip install --python "$ANDROID_TEMP/.venv/bin/python" --no-deps "$ANDROID_WHEEL" --quiet
      "$ANDROID_TEMP/.venv/bin/python" -c 'import jev_android_automator'
      rm -f "$ANDROID_TEMP/requirements.txt"
      printf '%s\n' "$ANDROID_FINGERPRINT" > "$ANDROID_TEMP/.install-fingerprint"
    ); then
      rm -rf "$ANDROID_TEMP"
      die "Failed to build the Jev Android Automator runtime"
    fi
    ANDROID_PREVIOUS="${ANDROID_RUNTIME}.previous.$$"
    if [ -d "$ANDROID_RUNTIME" ]; then mv "$ANDROID_RUNTIME" "$ANDROID_PREVIOUS"; fi
    if mv "$ANDROID_TEMP" "$ANDROID_RUNTIME"; then
      if [ -d "$ANDROID_PREVIOUS" ]; then rm -rf "$ANDROID_PREVIOUS"; fi
    else
      if [ -d "$ANDROID_PREVIOUS" ]; then mv "$ANDROID_PREVIOUS" "$ANDROID_RUNTIME"; fi
      die "Failed to activate the Jev Android Automator runtime"
    fi
  fi
  "$ANDROID_PYTHON" -c 'import importlib.metadata as m, jev_android_automator; assert m.version("jev-android-automator") == "'"$ANDROID_PACKAGE_VERSION"'"'
  ok "jev-android-automator@$ANDROID_PACKAGE_VERSION ($ANDROID_WHEEL_SHA)"
elif [ -x "$ANDROID_PYTHON" ] && "$ANDROID_PYTHON" -c 'import jev_android_automator' >/dev/null 2>&1; then
  warn "Jev Android Automator source is unavailable at $ANDROID_SOURCE; preserving the installed runtime"
else
  warn "Jev Android Automator source is unavailable at $ANDROID_SOURCE; Android tools will remain unavailable"
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
  bold "Installing Chrome CUA bridge"
  PI_CODING_AGENT_DIR="$TARGET_AGENT" scripts/install-browser-group.sh
  bold "Installing Pi startup preflight"
  scripts/install-pi-launcher.sh
fi
bold "Done"
ok "live config: $TARGET_AGENT"
