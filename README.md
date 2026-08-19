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

1. **Prerequisite checks** — `pi`, `npm`, `cargo`, `jq` (and `brew`, if present)
2. **rtk** — token-reducing CLI proxy, via Homebrew
3. **CodeMapper (`cm`)** — built from [source](https://github.com/p1rallels/codemapper) via Cargo
4. **Local extension deps** — `npm install` inside each `agent/extensions/*/`
5. **Pi packages** — everything listed in `agent/settings.json`

> **Prerequisites:** [Homebrew](https://brew.sh), [Node.js](https://nodejs.org/),
> [Rust](https://rustup.rs), [jq](https://jqlang.github.io/jq/), and pi itself.

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
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5",
  "defaultThinkingLevel": "medium",
  "packages": [
    "npm:pi-hooks",
    "git:github.com/elpapi42/pi-fork"
  ]
}
```

Package sources: `npm:<name>[@version]` or `git:<repo>[@ref]`. Add one with
`pi install npm:foo` (which writes to this file directly) or by editing it and re-running the setup
script.

See the [full settings reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md).

---

## 📦 Packages

| Package | Source | What it does |
|---|---|---|
| **pi-hooks** | npm | Lifecycle hooks (checkpoint, lsp, permission, ralph-loop, repeat) |
| **pi-rtk-optimizer** | npm | RTK command rewriting + tool-output compaction |
| **pi-observational-memory** | npm | Tiered compaction with observations & reflections |
| **pi-mermaid** | npm | Mermaid diagrams rendered as ASCII in the TUI |
| **amp-themes** | npm | Amp-inspired theme, editor chrome, compact tool display |
| **pi-powerline-footer** | npm | Powerline-style status bar |
| **@tmustier/pi-usage-extension** | npm | Session usage / cost dashboard |
| **pi-minimal-subagent** | [elpapi42](https://github.com/elpapi42/pi-minimal-subagent) | Lightweight subagent delegation |
| **pi-fork** | [elpapi42](https://github.com/elpapi42/pi-fork) | Fork-based isolated subprocess execution |
| **pi-caveman** | [v2nic](https://github.com/v2nic/pi-caveman) | Ultra-compressed comms (~75% fewer output tokens) |

---

## 🧩 Local Extensions

Auto-discovered by pi from `agent/extensions/`:

| Extension | What it does |
|---|---|
| `ask-user-question.ts` | Structured multiple-choice / freeform questions the model can ask |
| `context.ts` | `/context` — colored grid of context usage by category, plus cache stats |
| `web-fetch/` | `web_fetch` tool — readable article extraction, PDF parsing, Jina fallback |

`web-fetch/` has npm dependencies; the setup script installs them. Pi does **not** install deps for
locally-discovered extensions on its own.

---

## 📁 Layout

```
~/.pi/                         ← this repo
├── README.md
├── OPTIMIZATIONS.md           # review notes & backlog
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
