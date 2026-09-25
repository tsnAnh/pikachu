# pikachu

**Pikachu is a curated, reproducible configuration for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).**
It combines native Pi context compaction, automatic model routing, lazy specialist tools, LSP and AST
code intelligence, subagent delegation, interactive planning, session todos, command safety, and
automatic updates in one focused Pi setup.

This repository is useful if you are searching for a practical **Pi configuration**, **Pi coding
agent plugins**, **Pi extensions**, **context management**, **AI coding agent workflow**, **LSP coding
agent**, **subagent orchestration**, or **automatic Pi updater**.

## What is included

| Capability | Implementation |
|---|---|
| Context compaction | Native Pi compaction using the active coding-agent model |
| Model routing | Local TypeSafe-backed Jev controller for Luna and Sol tiers |
| Code intelligence | `pi-lens@4.2.1` for LSP, diagnostics, symbols, and AST search |
| Editing | `pi-hashline-edit-pro@4.3.5` for hash-anchored changes |
| Delegation | `pi-subagents@0.70.0` and `@weshipwork/pi-herdr@0.1.0` |
| Review | pi-subagents' maintained parallel-review workflow |
| Web research | `pi-web-access@0.30.0`, activated only when needed |
| Computer use | Cua Driver for desktop apps; agent-owned background Chrome tabs for browser use |
| Android automation | `jev-android-automator@0.1.0` as a lazy, checksum-verified MCP runtime |
| User questions | `pi-ask-user@0.15.0`, active from session start |
| MCP integration | `pi-mcp-adapter@2.34.0` with lazy Cua Driver, Trello, RevenueCat, and Android servers |
| Terminal UI | `pi-zentui@0.25.0` as the persistent footer and UI owner |
| Command safety | `cc-safety-net@2.4.4` with its standard protection profile |
| Simplification | `pi-simplify@0.2.3` for focused post-change cleanup |
| Test quality | `test-audit` skill for test authoring and focused audits |
| Design guidance | `emilkowalski/skills`, pinned and filtered to `apple-design` |
| Automatic updates | A `pi` launcher that updates Pi, models, config, and pinned extensions |

All npm and Git packages are pinned to an exact version or commit in
[`agent/settings.json`](agent/settings.json). The attached Android wheel is pinned separately by
version and SHA-256 in [`agent/android-automator.json`](agent/android-automator.json).

The default profile uses the dark theme, `openai-codex/gpt-5.6-luna`, and low thinking. The model
picker includes the configured OpenAI Codex models. MCP endpoints are defined without credentials in
[`agent/mcp.json`](agent/mcp.json); OAuth credentials remain in Pi's credential storage.

## Workflow features

### Native Pi compaction

Compaction is owned by Pi and uses the active coding-agent model. No Jev compaction hook or other
memory extension intercepts Pi's compaction lifecycle.

```text
/compact
```

The TypeSafe API key used by other optional Jev features is read only from the environment and is
never written to the repository or Pi session files.

### Automatic model routing

Jev classifies only the latest user request and chooses the smallest configured model tier likely
to complete it reliably.

| Work level | Model and thinking level |
|---|---|
| Easy | `openai-codex/gpt-5.6-luna`, low |
| Routine | `openai-codex/gpt-5.6-sol`, low |
| Demanding | `openai-codex/gpt-5.6-sol`, medium |
| Hard | `openai-codex/gpt-5.6-sol`, high |

```text
/jev-route auto
/jev-route off
/jev-route status
```

A manual model selection disables routing for that session until `/jev-route auto` is used and is
remembered automatically for the next new Pi session. Low-confidence classifications, missing
credentials, unavailable models, and request failures keep the current model.

### Lazy specialist tools

Core file and shell tools, hashline editing, todos, safety tooling, `ask_user`, and the selected
delegation tool start active. Web research, computer use, Android automation, pi-lens tools,
and general MCP tools start hidden to keep the model's tool surface small. Computer use and Android
automation are separate specialist groups, so activating either keeps web-search and unrelated
direct tools hidden. The shared `mcp` gateway remains available for first-run tool discovery.

```text
jev_find_tools({ query: "search current documentation and inspect symbol references" })
/jev-tools status
/jev-tools reset
```

Tool activation is additive for the session. An unambiguous local specialist match activates directly;
Jev narrows multiple matches when a TypeSafe key is available. Without the key, keyword matching
provides the fallback. Delegation tools are
managed separately and are never changed by the specialist router.


### Computer use: Cua Driver and background Chrome tabs

[`trycua/cua`](https://github.com/trycua/cua) supplies Cua Driver for native desktop apps and exact Chrome binding. Install Cua Driver 0.28.2 or newer and grant Accessibility and Screen Recording. On macOS, start the app-owned daemon with existing-profile authorization and its agent cursor overlay: `open -n -g -a CuaDriver --args serve --grant existing-profile --cursor-reduced-motion auto`. Check readiness with `cua-driver status` and `cua-driver permissions status`.

The `cua-runtime` extension owns one long-lived Cua Driver MCP connection and lifecycle session per Pi turn. `cua_repl_js` runs persistent asynchronous JavaScript in a 64 MiB QuickJS isolate without Node, filesystem, process, module, socket, or network globals. The allowlisted host bridge exposes `cua`, `agent.browsers`, and `nodeRepl`; `cua_repl_reset` destroys guest state, revokes handles, ends the Driver session, and cleans tabs. Computer-use turns route to a Sol model. Browser research and ordinary URL retrieval remain with `pi-web-access`.

Pi protects the user's active desktop by default. Cua Driver input targets an exact window or tab with background delivery. The agent cursor stays hidden for background Chrome actions. If the user opens the controlled tab, its activation event shows the separate agent cursor and Pi continues working without moving the real pointer or activating another app. The runtime refuses desktop-wide input and app activation while protected. Shared clipboard writes and other consequential actions require action-time confirmation. If background delivery cannot complete a task, Pi returns the blocker. `/cua-focus allow` opts into focus-changing actions for the current Pi session; `/cua-focus protect` restores protection. New sessions start protected.

For Chrome tasks, `agent.browsers.get("chrome")` creates inactive agent-owned grouped tabs, lists user tabs without claiming them, and claims only an exact current identity. Accessibility refs and screenshot coordinates are observation-local. Semantic and locator actions run in the background; trusted controls that cannot run safely return a foreground-handoff requirement. `markDeliverable()` and `markHandoff()` preserve selected tabs, while unmarked tabs and claims close at turn end. Browser management records a bounded local before-state and undo audit. The extension requests `tabs`, `windows`, `tabGroups`, `bookmarks`, `nativeMessaging`, `storage`, and `debugger`; review its Chrome permission prompt. Page content remains untrusted data.

Chrome 150 and newer can reject `Browser.getWindowForTarget`, which prevents Cua Driver from proving its native-window-to-CDP binding. Pi detects those versions from the exact owned or claimed tab before setup and uses the installed extension's scoped debugger backend for that tab. The bridge still requires its v2 handshake plus a unique Chrome tab, group, window, native process, and native window match; Cua Driver continues to own the separate window-scoped agent cursor and native app automation. Ambiguous native windows fail closed. Older Chrome versions that use Driver binding also fail closed on existing-profile permission refusals.

After reviewing the extension files, run `scripts/setup-pi.sh`. In `chrome://extensions`, enable Developer mode and load or reload the unpacked directory printed by setup. Confirm extension ID `dlealeamoioddhcgkabjdfomigkjkmem` and version 2.0.1. Pi startup reports Driver version, permissions, cursor support, and Chrome bridge handshake in the terminal. If the handshake is absent, browser computer use fails with that one setup action and does not fall back to a user tab. The old `cua_browser_group` and `cua_browser_page` tools remain as deprecated wrappers for existing prompts.

The pinned [`jev-use` skill](https://github.com/trycua/cua/blob/ef13ca7b92355fd81523990ddc907f717ff9c35a/skills/jev-use/SKILL.md) guides a bounded observe, choose, act, verify loop. Pi's `jev_choose_action` tool sends a compact observation and candidate IDs with descriptions to TypeSafe Jev using the existing `TYPESAFE_API_KEY` loaded by the Pi launcher. Include `reobserve` and `abstain` in every candidate set. The tool rejects unknown IDs and low-confidence choices; it never executes a Cua Driver action. Pi must keep each complete action and its arguments outside the Jev request, check freshness before execution, and verify the result from a fresh app observation. Without a TypeSafe key, the tool abstains.

Computer actions can cause external side effects. Give the agent a narrow, verifiable goal and confirm consequential actions. Verify the resulting app state independently of the action response.

### Android automation

The `jev-android` MCP server exposes the attached `jev-android-automator@0.1.0` control plane as a
lazy Android specialist. Its direct tools cover emulator status and lifecycle, debug APK builds and
installation, app control, indexed observation and actions, bounded Logcat, checkpoints, and the
high-level `android_run_goal` loop. Use `jev_find_tools` with an Android request to activate only this
group; the server process and emulator remain stopped until an Android tool is called.

Setup reads [`agent/android-automator.json`](agent/android-automator.json), verifies the release wheel
against its recorded SHA-256, exports exact dependencies from the attached project's `uv.lock`, and
installs an isolated runtime under the live Pi profile. Override the source checkout without editing
the tracked manifest when necessary:

```bash
JEV_ANDROID_AUTOMATOR_SOURCE=/absolute/path/to/jev-android-automator scripts/setup-pi.sh
```

The current emulator backend requires Linux x86_64, Docker Engine, `/dev/kvm`, and ADB. macOS can
install and load the MCP integration, build the Python/Android components, and report unsupported
host status, but Docker Desktop cannot run this KVM emulator. Autonomous goals also require
`TYPESAFE_API_KEY`; there is no coding-model fallback for the automator's indexed decisions. Exact
field values are supplied by the active Pi model through `text_values`, and Pi must verify the final
snapshot before reporting completion.

### Interactive plan mode

```text
/plan <request>
```

The command enters read-only plan mode and submits the request immediately. While planning, Pi can
inspect the project but cannot edit files or execute mutating commands. When the plan is ready, a
scrollable Markdown panel presents three choices:

1. Implement the plan in the current context.
2. Clear context, then implement the plan.
3. Stay in plan mode and continue revising the plan.

The first two choices exit plan mode automatically. Manual controls remain available through
`/plan on`, `/plan off`, and `/plan status`.

### Session todos

The model-facing `todo` tool supports `list`, `add`, `update`, `complete`, `remove`, `next`, and
`review`. Todos have stable IDs, priorities, dependencies, status, details, and optional completion
evidence. Dependency validation and cycle detection are deterministic.

```text
/todos
```

Todo state follows the current Pi session branch. Jev may rank ready work or flag duplicates,
scope drift, and weak evidence, but it never silently deletes, rewrites, or completes an item.

### Delegation and parallel review

```text
/delegate auto
/delegate herdr
/delegate subagents
/delegate both
/delegate status
/review
```

`auto` uses Herdr when its tool and environment are available, otherwise it uses pi-subagents.
The selection changes only the `herdr` and `subagent` tools and is reconstructed when a session or
branch is reopened. `/review` selects subagents and starts the maintained parallel-review workflow.

Inside Herdr with `herdr` selected, the Pi rules require panes for independent parallel tasks and
persistent processes such as servers, watchers, and lengthy checks. Pi owns integration and
validation, while short sequential work stays in the current pane. Pi tracks panes it creates for
a task, collects their results, stops task-owned processes, and closes those panes when work ends.
It also closes them after a failure or cancellation when possible. Pi leaves its own pane,
user-created panes, and panes the user asked to keep alone. These are agent instructions, not a
runtime guard.

### Other commands

| Command | Purpose |
|---|---|
| `/context` | Show detailed context and token usage |
| `/zentui` | Configure the persistent terminal UI |
| `/cc-safety-net` | Inspect or manage command-safety behavior |

## Install

Requirements:

- Pi
- Node.js 22.19 or newer
- npm
- rsync
- Python 3.12 or newer
- `uv`
- Cua Driver 0.28.0 or newer; macOS requires the app-owned daemon and desktop permissions
- Linux x86_64, Docker Engine, `/dev/kvm`, and ADB to run the Android emulator

Clone the repository and deploy the configuration:

```bash
git clone git@github.com:tsnAnh/pikachu.git
cd pikachu
scripts/setup-pi.sh
```

Jev is optional for model routing, specialist validation, todo review, and Jev-backed automation.
It is not used for compaction. If `TYPESAFE_API_KEY` is not already available, interactive setup
first asks whether to enable these Jev features. Only an affirmative answer opens the hidden key prompt. On macOS, a
non-empty value is stored in Keychain under `pikachu.typesafe-api-key`; the preflight launcher
reads it into Pi's environment at startup. The key is never written to this repository, Pi
configuration, logs, or session files. Declining or cancelling leaves native Pi compaction and
deterministic specialist fallbacks available.

You can also provide the key from your shell or another secret manager before setup:

```bash
export TYPESAFE_API_KEY="..."
```

Without the key, Pi still starts normally. Jev-dependent decisions use deterministic fallbacks,
while native Pi compaction continues to use the active coding-agent model.

To disable Jev for one launch even when a key is configured:

```bash
JEVC_DISABLED=1 pi
```

To remove the macOS Keychain entry:

```bash
security delete-generic-password -a "$USER" -s "pikachu.typesafe-api-key"
```

Setup validates JSON, package pins, Node and Pi availability, and local extension lockfiles before
deploying. It synchronizes only repository-owned files to `~/.pi/agent`, backs up replaced files,
and preserves unknown live extensions, skills, credentials, and externally managed Herdr or Orca
files.

The [`jev-use` skill](agent/skills/jev-use/SKILL.md) and [`test-audit` skill](agent/skills/test-audit/SKILL.md) are synced from the repository. The latter's
source is [OpenClaw at commit `9b0a71e`](https://github.com/openclaw/openclaw/tree/9b0a71ed078587f8267a4d32d61070154bdf3904/.agents/skills/test-audit).
The [Pi global rules](agent/AGENTS.md) are based on this machine's Codex global `AGENTS.md`, with
Pi-specific delegation and pane cleanup rules. Setup syncs them to the live Pi profile; the
separate Codex global rules are unchanged.

To validate or deploy another Pi profile:

```bash
scripts/setup-pi.sh --target /absolute/path/to/agent
```

## Automatic Pi updates

For the standard live profile, setup installs a preflight launcher at `~/.local/bin/pi`. When that
directory appears before the package-managed Pi binary in `PATH`, running `pi` performs these steps
before the TUI starts:

1. Fast-forward this repository when its checkout is clean and has an upstream.
2. Validate and sync the allowlisted configuration.
3. Reconcile local dependencies and exact extension pins.
4. Update the Pi CLI and model catalogs.
5. Report newer plugin versions without silently rewriting reviewed pins.

Update failures are logged and fail open, so an unavailable Git host or npm registry does not
prevent Pi from starting with the current installation. A process lock prevents concurrent Pi
launches from running competing updates.
The launcher prints each preflight phase in the terminal; detailed command output stays in the
private update log. Progress goes to stderr so Pi's JSON and RPC stdout remain machine-readable.

```bash
pi --skip-update                         # skip once
PI_AUTO_UPDATE=0 pi                      # skip for this invocation
PI_AUTO_UPDATE_INTERVAL_SECONDS=21600 pi # update at most once every six hours
```

The update log is stored at `~/.cache/pi-cfg/update.log`. Manual updates use the same deployment
path:

```bash
scripts/update-pi.sh
```

Package upgrades remain reviewable: update the exact version in `agent/settings.json`, update any
affected lockfile, run validation, and commit the result.

## Repository layout

```text
agent/
├── AGENTS.md                     # Global Pi rules with Herdr orchestration policy
├── settings.json                 # Pi settings and exact package pins
├── models.json                   # Additional model definitions
├── mcp.json                      # MCP server definitions, without credentials
├── android-automator.json        # Pinned local Android automator release metadata
├── zentui.json                   # Persistent UI settings
├── skills/                      # Pinned jev-use and test-audit guidance
└── extensions/
    ├── context.ts                # /context
    ├── plan-mode.ts              # /plan workflow and approval panel
    ├── delegation-mode.ts        # /delegate and /review
    └── jev-control/              # Routing, session todos, and lazy specialist tools
scripts/
├── setup-pi.sh                   # Validate, back up, and deploy config
├── update-pi.sh                  # Update Pi/models and report package drift
├── pi-launcher.sh                # Pre-start automatic update wrapper
├── jev-android-mcp-launcher.sh    # Resolve and launch the managed Android MCP runtime
└── install-pi-launcher.sh        # Install the wrapper in ~/.local/bin
```

Provider credentials stay in ignored Pi files or operating-system credential storage. Do not
commit `agent/auth.json`, API keys, OAuth tokens, session history, or generated package directories.

## Search keywords

Pi coding agent configuration, Pi plugins, Pi extensions, native Pi compaction, TypeSafe AI, AI coding
agent, coding assistant, LSP agent, AST search, subagents, multi-agent coding, agent delegation,
parallel code review, plan mode, context management, automatic model routing, terminal coding
agent, developer tools, and automatic Pi updates.
