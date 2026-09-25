#!/usr/bin/env bash
# Register the local bridge for the user-installed Chrome browser-use extension.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd -P)"
TARGET_AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
EXTENSION_ID="dlealeamoioddhcgkabjdfomigkjkmem"
NATIVE_NAME="com.pikachu.browser_group"
NODE_BIN="$(command -v node)"
[ -n "$NODE_BIN" ] || { echo "Node.js is required" >&2; exit 1; }
HOST_SCRIPT="$TARGET_AGENT/browser-group/native-host.mjs"
[ -f "$HOST_SCRIPT" ] || { echo "Run scripts/setup-pi.sh first" >&2; exit 1; }
WRAPPER="$TARGET_AGENT/bin/pikachu-browser-group-host"
SOCKET_PATH="$TARGET_AGENT/browser-group.sock"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST="$MANIFEST_DIR/$NATIVE_NAME.json"
mkdir -p "$(dirname "$WRAPPER")" "$MANIFEST_DIR"
python3 - "$NODE_BIN" "$HOST_SCRIPT" "$SOCKET_PATH" "$WRAPPER" "$MANIFEST" "$NATIVE_NAME" "$EXTENSION_ID" <<'PY'
import json, os, shlex, sys
node, host, socket, wrapper, manifest, name, extension_id = sys.argv[1:]
script = f"#!/bin/sh\nPI_BROWSER_GROUP_SOCKET={shlex.quote(socket)} exec {shlex.quote(node)} {shlex.quote(host)}\n"
for path, content in (
    (wrapper, script),
    (manifest, json.dumps({"name": name, "description": "Agent-owned Pi browser tabs", "path": wrapper, "type": "stdio", "allowed_origins": [f"chrome-extension://{extension_id}/"]}, indent=2) + "\n"),
):
    if os.path.exists(path):
        with open(path, "rb") as old:
            if old.read() != content.encode():
                backup = path + ".before-pikachu-browser-group"
                if not os.path.exists(backup):
                    with open(backup, "wb") as saved: saved.write(open(path, "rb").read())
    temporary = path + ".tmp"
    with open(temporary, "w") as out: out.write(content)
    os.chmod(temporary, 0o700 if path == wrapper else 0o600)
    os.replace(temporary, path)
PY
printf 'Native messaging host installed: %s\n' "$MANIFEST"
printf 'Load unpacked extension in Chrome: %s\n' "$TARGET_AGENT/browser-group/extension"
printf 'Expected extension ID: %s\n' "$EXTENSION_ID"
EXPECTED_VERSION="$(node -p "require('$TARGET_AGENT/browser-group/extension/manifest.json').version")"
printf 'Expected extension version: %s\n' "$EXPECTED_VERSION"
