#!/usr/bin/env bash
# Launch the managed Jev Android Automator MCP runtime for this Pi profile.
set -euo pipefail

case "${JEVC_DISABLED:-}" in
  1|true|TRUE|yes|YES) printf 'Jev is disabled for this Pi launch; Android automation is unavailable.\n' >&2; exit 1 ;;
esac

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
CONFIG="$AGENT_DIR/android-automator.json"
PYTHON="$AGENT_DIR/runtimes/jev-android-automator/.venv/bin/python"

[ -f "$CONFIG" ] || { printf 'Jev Android Automator config is missing: %s\n' "$CONFIG" >&2; exit 1; }
[ -x "$PYTHON" ] || { printf 'Jev Android Automator runtime is not installed; run Pikachu setup first.\n' >&2; exit 1; }

if [ -z "${JEV_ANDROID_AGENT_ID:-}" ]; then
  JEV_ANDROID_AGENT_ID="$(node -e '
const value=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));
if(typeof value.agentId!=="string"||!/^[a-z][a-z0-9-]{0,62}$/.test(value.agentId))process.exit(1);
process.stdout.write(value.agentId);
' "$CONFIG")"
  export JEV_ANDROID_AGENT_ID
fi

exec "$PYTHON" -m jev_android_automator.mcp_server
