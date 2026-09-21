#!/usr/bin/env bash
# Validate this repository and deploy its allowlisted Pi configuration.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd -P)"
SOURCE_AGENT="$REPO_ROOT/agent"
TARGET_AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
bold() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok() { printf '    \033[32m✓\033[0m %s\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) [ "$#" -ge 2 ] || die "--target requires a directory"; TARGET_AGENT="$2"; shift 2 ;;
    -h|--help) printf 'Usage: %s [--target <agent-dir>]\n' "$0"; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done
case "$TARGET_AGENT" in ""|"/"|"$HOME"|"${HOME}/") die "Refusing unsafe target: ${TARGET_AGENT:-<empty>}" ;; esac
for command in node npm rsync; do command -v "$command" >/dev/null 2>&1 || die "'$command' is required"; done
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
    diff -qr --exclude node_modules --exclude .DS_Store "$source" "$destination" >/dev/null 2>&1; then return 0; fi
  backup_path "$relative"; mkdir -p "$destination"
  rsync -a --delete --exclude node_modules --exclude .DS_Store "$source/" "$destination/" ||
    die "Failed to sync $relative"
  ok "synced $relative"
}

if [ "$SOURCE_AGENT_REAL" != "$TARGET_AGENT" ]; then
  bold "Syncing repo-owned configuration"
  for file in settings.json models.json mcp.json jev.json zentui.json; do sync_file "$file"; done
  for extension in context.ts plan-mode.ts delegation-mode.ts jev-control; do
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
