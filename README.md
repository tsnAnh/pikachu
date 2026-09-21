# pikachu

**Pikachu is a curated, reproducible configuration for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).**
It combines Jev context compaction, automatic model routing, lazy specialist tools, LSP and AST
code intelligence, subagent delegation, interactive planning, session todos, command safety, and
automatic updates in one focused Pi setup.

This repository is useful if you are searching for a practical **Pi configuration**, **Pi coding
agent plugins**, **Pi extensions**, **Jev compaction**, **AI coding agent workflow**, **LSP coding
agent**, **subagent orchestration**, or **automatic Pi updater**.

## What is included

| Capability | Implementation |
|---|---|
| Context compaction | `@alexlikevibe/pi-jev@0.2.1` with native Pi fallback |
| Model routing | Local TypeSafe-backed Jev controller for Luna and Sol tiers |
| Code intelligence | `pi-lens@4.2.1` for LSP, diagnostics, symbols, and AST search |
| Editing | `pi-hashline-edit-pro@4.3.5` for hash-anchored changes |
| Delegation | `pi-subagents@0.70.0` and `@weshipwork/pi-herdr@0.1.0` |
| Review | pi-subagents' maintained parallel-review workflow |
| Web access | `pi-web-access@0.30.0`, activated only when needed |
| User questions | `pi-ask-user@0.15.0`, active from session start |
| MCP integration | `pi-mcp-adapter@2.34.0` with lazy Trello and RevenueCat servers |
| Terminal UI | `pi-zentui@0.25.0` as the persistent footer and UI owner |
| Command safety | `cc-safety-net@2.4.4` with its standard protection profile |
| Simplification | `pi-simplify@0.2.3` for focused post-change cleanup |
| Design guidance | `emilkowalski/skills`, pinned and filtered to `apple-design` |
| Automatic updates | A `pi` launcher that updates Pi, models, config, and pinned extensions |

All executable packages are pinned to an exact npm version or Git commit in
[`agent/settings.json`](agent/settings.json).

The default profile uses the dark theme, `openai-codex/gpt-5.6-luna`, and low thinking. The model
picker includes OpenAI Codex models plus the keyless `titox/deepseek-v4-flash` definition from
[`agent/models.json`](agent/models.json). MCP endpoints are defined without credentials in
[`agent/mcp.json`](agent/mcp.json); OAuth credentials remain in Pi's credential storage.

## Workflow features

### Jev compaction

Jev keeps high-value messages verbatim instead of replacing the conversation with a generated
summary. It uses a 50% keep threshold and requires at least 15% estimated reduction. Missing
credentials, authentication failures, timeouts, cancellation, and inadequate reduction fall back
to Pi's native compaction.

```text
/compact
```

Non-secret settings are stored in [`agent/jev.json`](agent/jev.json). The TypeSafe API key is read
only from the environment and is never written to the repository or Pi session files.

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

A manual model selection disables routing for that session until `/jev-route auto` is used.
Low-confidence classifications, missing credentials, unavailable models, and request failures keep
the current model. TitoX remains available for manual selection.

### Lazy specialist tools

Core file and shell tools, hashline editing, todos, safety tooling, `ask_user`, and the selected
delegation tool start active. Web access, pi-lens tools, and MCP tools start hidden to keep the
model's tool surface small.

```text
jev_find_tools({ query: "search current documentation and inspect symbol references" })
/jev-tools status
/jev-tools reset
```

Tool activation is additive for the session. Jev validates deterministic local matches when a
TypeSafe key is available; otherwise keyword matching provides the fallback. Delegation tools are
managed separately and are never changed by the specialist router.

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

Clone the repository and deploy the configuration:

```bash
git clone git@github.com:tsnAnh/pikachu.git
cd pikachu
scripts/setup-pi.sh
```

Optionally export the TypeSafe credential from your shell or secret manager:

```bash
export TYPESAFE_API_KEY="..."
```

Without the key, Pi still starts normally. Jev-dependent decisions use deterministic or native Pi
fallbacks.

Setup validates JSON, package pins, Node and Pi availability, and local extension lockfiles before
deploying. It synchronizes only repository-owned files to `~/.pi/agent`, backs up replaced files,
and preserves unknown live extensions, skills, credentials, and externally managed Herdr or Orca
files.

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
├── settings.json                 # Pi settings and exact package pins
├── models.json                   # Additional model definitions
├── mcp.json                      # MCP server definitions, without credentials
├── jev.json                      # Non-secret Jev compaction settings
├── zentui.json                   # Persistent UI settings
└── extensions/
    ├── context.ts                # /context
    ├── plan-mode.ts              # /plan workflow and approval panel
    ├── delegation-mode.ts        # /delegate and /review
    └── jev-control/              # Routing, lazy tools, and session todos
scripts/
├── setup-pi.sh                   # Validate, back up, and deploy config
├── update-pi.sh                  # Update Pi/models and report package drift
├── pi-launcher.sh                # Pre-start automatic update wrapper
└── install-pi-launcher.sh        # Install the wrapper in ~/.local/bin
```

Provider credentials stay in ignored Pi files or operating-system credential storage. Do not
commit `agent/auth.json`, API keys, OAuth tokens, session history, or generated package directories.

## Search keywords

Pi coding agent configuration, Pi plugins, Pi extensions, Jev compaction, TypeSafe AI, AI coding
agent, coding assistant, LSP agent, AST search, subagents, multi-agent coding, agent delegation,
parallel code review, plan mode, context management, automatic model routing, terminal coding
agent, developer tools, and automatic Pi updates.
