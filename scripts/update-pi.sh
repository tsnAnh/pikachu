#!/usr/bin/env bash
# Update Pi and model catalogs, then report pin drift without rewriting pins.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd -P)"
TARGET_AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
bold() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok() { printf '    \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1" >&2; }

if [ "${1:-}" = "--target" ]; then
  [ "$#" -ge 2 ] || { warn "--target requires a directory"; exit 1; }
  TARGET_AGENT="$2"; shift 2
fi
[ "$#" -eq 0 ] || { warn "Usage: $0 [--target <agent-dir>]"; exit 1; }
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
[ -n "$PI_BIN" ] || { warn "Pi executable not found"; exit 1; }
scripts/setup-pi.sh --target "$TARGET_AGENT"

bold "Updating Pi CLI"
"$PI_BIN" update --self
bold "Refreshing model catalogs"
PI_CODING_AGENT_DIR="$TARGET_AGENT" "$PI_BIN" update --models
bold "Checking pinned npm packages"
node - "$PWD/agent/settings.json" <<'NODE' | while IFS=$'\t' read -r name pinned; do
const settings=JSON.parse(require("node:fs").readFileSync(process.argv[2],"utf8"));
for(const entry of settings.packages??[]){
  const source=typeof entry==="string"?entry:entry.source;
  if(!source.startsWith("npm:"))continue;
  const spec=source.slice(4),split=spec.lastIndexOf("@");
  console.log(`${spec.slice(0,split)}\t${spec.slice(split+1)}`);
}
NODE
  latest="$(npm view "$name" version 2>/dev/null || true)"
  if [ -z "$latest" ]; then warn "$name@$pinned: registry lookup failed"
  elif [ "$latest" = "$pinned" ]; then ok "$name@$pinned"
  else warn "$name: pinned $pinned, latest $latest"; fi
done

bold "Checking pinned Git packages"
git_ref="$(node -e '
const s=require("./agent/settings.json");
const e=s.packages.map(x=>typeof x==="string"?x:x.source).find(x=>x.startsWith("git:github.com/emilkowalski/skills@"));
process.stdout.write(e?e.slice(e.lastIndexOf("@")+1):"");
')"
remote_ref="$(git ls-remote https://github.com/emilkowalski/skills.git HEAD 2>/dev/null | awk '{print $1}')"
if [ -n "$git_ref" ] && [ "$git_ref" = "$remote_ref" ]; then ok "emilkowalski/skills@$git_ref"
elif [ -n "$remote_ref" ]; then warn "emilkowalski/skills: pinned $git_ref, HEAD $remote_ref"
else warn "emilkowalski/skills: remote lookup failed"; fi
bold "Done"
ok "pins were not modified"
