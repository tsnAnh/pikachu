# ✨ pi-cfg

My personal **pi** agent configuration — packages, extensions, and bootstrap scripts to get a full
coding-agent environment running on any machine in minutes.

> **[pi](https://github.com/earendil-works/pi)** is an AI coding agent that lives in your terminal.

---

## 🚀 Quick Start

```bash
git clone git@github.com:tsnAnh/pi-cfg.git ~/.pi
~/.pi/scripts/setup-pi.sh
```

The setup script is idempotent — re-run it any time. It handles:

1. **Prerequisite checks** — `pi`, `npm`, `cargo` (and `brew`, if present), plus a guard that
   this repo really is pi's config dir
2. **rtk** — token-reducing CLI proxy, via Homebrew
3. **CodeMapper (`cm`)** — built from [source](https://github.com/p1rallels/codemapper) via Cargo
4. **Local extension deps** — `npm install` inside each `agent/extensions/*/`
5. **Pi packages** — `pi update --extensions`, which installs anything missing and updates the
   rest straight from `agent/settings.json`

> **Prerequisites:** [Homebrew](https://brew.sh), [Node.js](https://nodejs.org/),
> [Rust](https://rustup.rs), and pi itself.

> **Already have a `~/.pi`?** `agent/settings.json` is tracked by this repo now. Back up your
> existing one (`mv ~/.pi/agent/settings.json ~/.pi/agent/settings.json.bak`) before cloning, then
> merge anything you want to keep.

### Updating

```bash
~/.pi/scripts/update-pi.sh
```

Updates the pi CLI, every configured package, model catalogs, rtk, `cm`, and local extension deps.

---

## ⚙️ Config

**`agent/settings.json` is the config file pi actually reads.** Pi loads global settings from
`~/.pi/agent/settings.json` and per-project settings from `.pi/settings.json` — nothing else. Every
pi setting belongs in this file, not just packages:

```json
{
  "theme": "dark",
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-sol",
  "defaultThinkingLevel": "high",
  "packages": [
    "npm:pi-hooks",
    "git:github.com/elpapi42/pi-fork"
  ]
}
```

pi rewrites this file itself (it stores `lastChangelogVersion` here, and `/settings` writes to it),
so expect it to show up dirty in `git status` from time to time. That is the trade for having the
config actually version-controlled.

Package sources: `npm:<name>[@version]` or `git:<repo>[@ref]`. Add one by editing this file and re-running the setup script. Avoid `pi install` for packages
that use the object form — it rewrites entries as plain strings and would drop their filters.

See the [full settings reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md).

---

## 📦 Packages

Declared in [`agent/settings.json`](agent/settings.json).

### Agent capability

| Package | What it does |
|---|---|
| **pi-subagents** | Delegation + scripted multi-agent workflows. Subagents burn their own context window and return a summary — the largest token lever available. |
| **pi-web-access** | `web_search`, `fetch_content`, `source_check`, `get_search_content`. Pluggable providers, GitHub repo cloning, PDF/YouTube extraction. |
| **pi-lens** | LSP diagnostics, AST-grep search/replace, formatters, `module_report` / `read_symbol`. Also ships an MCP server. |
| **pi-hashline-edit-pro** | Hash-anchored `read` / `replace` / `undo_last_replace`. ⚠️ See *Behavior changes* below. |
| **pi-ask-user** | `ask_user` — searchable split-pane selection, multi-select, freeform input. |
| **@dietrichgebert/ponytail** | "Lazy senior dev" skills: `/ponytail`, `-audit`, `-debt`, `-gain`, `-review`. |
| **emilkowalski/skills** | Skills only, filtered to `apple-design` — Apple's fluid-motion and interface design principles translated to the web. |
| **pi-fork** | Fork-based isolated subprocess execution. |

### Context & tokens

| Package | What it does |
|---|---|
| **pi-rtk-optimizer** | RTK command rewriting + `bash`/`grep` output compaction. Config in `agent/extensions/pi-rtk-optimizer/config.json`. |
| **pi-observational-memory** | Tiered compaction with observations & reflections. |
| **pi-caveman** | Ultra-compressed output prose, opt-in per session via `/caveman`. |
| **pi-simplify** | `/simplify` — reviews recently changed code for clarity and maintainability. |

### Workflow & UI

| Package | What it does |
|---|---|
| **pi-hooks** | checkpoint, permission, ralph-loop, repeat, token-rate. Its `lsp` extension is **filtered out** — pi-lens owns LSP. |
| **pi-mermaid** | Mermaid diagrams as ASCII in the TUI. |
| **amp-themes** | Amp-inspired theme, editor chrome, compact tool display. |
| **pi-powerline-footer** | Powerline-style status bar. |
| **@tmustier/pi-usage-extension** | Session usage / cost dashboard. |

---

## ⚠️ Behavior changes to know about

**`pi-hashline-edit-pro` removes the built-in `edit` tool.** On `session_start` it calls
`setActiveTools(active.filter(t => t !== "edit"))` and registers its own `read`. Editing goes
through `replace` against 3-char line hashes; stale or ambiguous anchors are rejected rather than
fuzzy-matched. If edits start behaving unexpectedly, this is why — remove the package to get `edit`
back. Its own config lives in `~/.config/pi-hashline-edit-pro/`.

This interacts safely with `pi-rtk-optimizer`: rtk only compacts `bash`, `read` and `grep` output,
and `readCompaction.enabled` is `false` here, so hash anchors are passed through byte-exact.

**`pi-web-access` needs no key to start** — Exa MCP gives zero-config search — but more providers
(Brave, Tavily, Exa direct, Jina, …) need keys in `web-search.json`. That file lands in **this
repo's root** unless `PI_CODING_AGENT_DIR` is set, and it holds plaintext keys, so it's gitignored.
Don't force-add it.

**`emilkowalski/skills` is filtered to one skill.** The repo ships 11 skills; loading all of them
would put 11 descriptions in every system prompt. The entry uses
`"skills": ["skills/apple-design"]` so only that one loads. Drop the filter if you want the rest —
the animation ones (`animate`, `review-animations`, `improve-animations`) are the obvious next picks.

**`pi-rtk-optimizer` is behind on tested compatibility.** Its latest release (0.9.0) declares
`peerDependencies` of `^0.74 || ^0.75 || ^0.78 || ^0.79 || ^0.80` for pi, and pi is now 0.84.2. It
installs anyway — pi passes `--legacy-peer-deps` — but it has not been tested against this pi.
If tool output starts looking mangled, check `/rtk show` first.

**`pi-minimal-subagent` was removed.** It registered a tool literally named `subagent`, colliding
with `pi-subagents`, which is a superset of it.

**`pi-caveman` now comes from npm, not git.** There are two independent implementations of the same
idea — `npm:pi-caveman` (jonjonrankin) and `git:github.com/v2nic/pi-caveman` — and both register
`/caveman`. The npm one is what was already installed and working, and it updates through
`pi update`.

---

## 🧩 Local Extensions

Auto-discovered by pi from `agent/extensions/`:

| Extension | What it does |
|---|---|
| `context.ts` | `/context` — colored grid of context usage by category, plus cache stats |

`web-fetch/` and `ask-user-question.ts` were removed once `pi-web-access` and `pi-ask-user` covered
the same ground as maintained packages.

---

## 📁 Layout

```
~/.pi/                         ← this repo
├── README.md
├── OPTIMIZATIONS.md           # review notes & backlog
├── web-search.json            # 🚫 never committed — pi-web-access provider keys
├── scripts/
│   ├── setup-pi.sh            # bootstrap (idempotent)
│   └── update-pi.sh           # update everything to latest
└── agent/                     # pi's config dir (PI_CODING_AGENT_DIR)
    ├── settings.json          # ✅ tracked — the real config
    ├── AGENTS.md              # ✅ tracked — global instructions (optional)
    ├── extensions/            # ✅ tracked — local extensions
    ├── skills/                # ✅ tracked — local skills
    ├── prompts/               # ✅ tracked — prompt templates
    ├── themes/                # ✅ tracked — custom themes
    ├── auth.json              # 🚫 never committed — API keys & OAuth tokens
    ├── trust.json             # 🚫 ignored
    ├── sessions/              # 🚫 ignored
    ├── git/                   # 🚫 ignored — cloned git packages
    └── npm/                   # 🚫 ignored — installed npm packages
```

---

## 💡 Tips

| Need | Command |
|---|---|
| New machine | `git clone → ./scripts/setup-pi.sh` |
| Add a package | `pi install npm:foo`, then commit `agent/settings.json` |
| Update everything | `./scripts/update-pi.sh` |
| Toggle extensions/skills | `pi config` |
| Check installs | `pi list` |
| Verify `cm` | `cm stats .` |
| RTK savings this session | `/rtk stats` |

---

*Built with ❤️ for the pi community.*
