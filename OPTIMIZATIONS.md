# Configuration audit

## Applied architecture

The configuration was redesigned after inspecting the current Pi 0.85.1 extension APIs,
maintained package manifests, and
[Oh My Pi](https://github.com/can1357/oh-my-pi).

The resulting rule is one owner per concern:

| Concern | Owner |
|---|---|
| Context compaction | Native Pi compaction with the active coding-agent model |
| Model/tool/todo judgments | Local TypeSafe-backed Jev control |
| Persistent UI | pi-zentui |
| Code intelligence | pi-lens |
| Editing | pi-hashline-edit-pro |
| Delegation | Herdr or pi-subagents, selected per session |
| Review | pi-subagents' maintained parallel-review prompt |
| Web research | pi-web-access |
| Computer use | Cua Driver for desktop apps and browsers through lazy Pi MCP tools |
| Safety | cc-safety-net standard policy |
| Context inspection | Local `/context` command |

## Removed overlap

- `pi-observational-memory` competed for `session_before_compact`.
- `@alexlikevibe/pi-jev` was removed so no extension intercepts Pi's compaction lifecycle.
- `pi-rtk-optimizer` truncated evidence before compaction and did not declare compatibility with
  the installed Pi release.
- `amp-themes` and `pi-powerline-footer` duplicated UI ownership and conflicted on shortcuts.
- `pi-hooks` bundled unrelated checkpoint, permission, loop, and token behaviors.
- Ponytail, Unlazy, Caveman, goal, usage, Mermaid, and pi-fork added workflow or display surface
  without a distinct required responsibility.
- Setup no longer installs or upgrades RTK or CodeMapper. Existing binaries are left alone.

## Oh My Pi findings

OMP's context pruning, provider-native compaction, debugger, persistent eval runtimes, and Agent Hub
are integrated into its forked runtime. Reconstructing them through a plugin pile would be fragile.
The portable ideas retained here are:

- specialist tools hidden until needed;
- explicit model roles;
- session-scoped structured todos;
- a first-class parallel review command;
- hashline edits and LSP-aware navigation.

OMP itself and the unrelated open-catalog `oh-my-pi` skill are not installed.

## Reproducibility and security

- Every npm package is pinned to an exact version and the external design skill to a commit SHA.
- `TYPESAFE_API_KEY` is environment-only.
- Cua Driver 0.28.0 or newer is a required host dependency. Pi's MCP adapter starts `cua-driver mcp`
  lazily and groups its direct tools under computer use. The pinned `jev-use` skill and local
  `jev_choose_action` tool keep TypeSafe decisions above Driver and restrict Jev to candidate IDs.
  The old Browser Use extension and its CloakBrowser LaunchAgent are retired by setup after backup.
- Cua Driver owns desktop permissions and action authorization. Its default `standard` mode allows
  desktop input, while attaching to an existing logged-in Chromium profile requires a separate grant.
- Pi's focus guard defaults to exact-window background input and blocks foreground, desktop-wide,
  app-activation, and clipboard-write actions. A user can opt into focus changes for one session with
  `/cua-focus allow`; new sessions reset to protected mode.
- Web research remains a separate tool group. Android emulator automation keeps its dedicated MCP
  runtime because it controls a guest device rather than the host desktop.
- Plain custom session entries hold todo/routing/tool/delegation state and are not sent to the LLM.
- Deployment copies only repo-owned files, backs up replacements, and preserves unknown live data.
- `agent/auth.json`, session history, installed packages, and runtime credential stores remain
  ignored.

## Upgrade policy

`scripts/update-pi.sh` may update Pi and model catalogs, but it reports rather than applies
package drift. Package bumps require a reviewed settings/lockfile change followed by typechecking,
unit tests, a temporary-target setup run, and a Pi startup smoke test.

`scripts/pi-launcher.sh` is installed ahead of Pi in `PATH` for the live profile. It performs that
update workflow before startup, fast-forwards only a clean authoritative checkout, serializes
concurrent updates, and starts the current installation when an update service is unavailable.
