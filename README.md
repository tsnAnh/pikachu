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
5. **Plan verifier** — syncs the pinned Python environment and probes configured score-token logprobs
6. **Pi packages** — `pi update --extensions`, which installs anything missing and updates the
   rest straight from `agent/settings.json`

> **Prerequisites:** [Homebrew](https://brew.sh), [Node.js](https://nodejs.org/),
> [Rust](https://rustup.rs), [Python](https://python.org/), [uv](https://docs.astral.sh/uv/), and pi itself.

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
  "defaultProvider": "opencode",
  "defaultModel": "deepseek-v4-flash-free",
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

**The default model still needs an OpenCode Zen API key.** `agent/settings.json` defaults to
`opencode` / `deepseek-v4-flash-free` ($0 in and out). "Free" means no charges, not no auth —
OpenCode's own docs say to sign in, add billing details and copy an API key, and that applies to the
`-free` models too. The official `opencode` CLI hides this behind a one-time login, which is why it
feels keyless. pi needs the key explicitly:

```
pi        # then: /login  →  OpenCode Zen
```

or export `OPENCODE_API_KEY`. Getting the key:

1. Sign in at <https://opencode.ai/auth> and copy the API key from your account.
   Billing details are only needed for the **paid** models — the `-free` ones work without a card.
2. `pi` → `/login` → **OpenCode Zen** → paste. Stored in `agent/auth.json` at `0600` (gitignored).
   Or `export OPENCODE_API_KEY=...` in your shell rc — `auth.json` takes priority over the env var.
3. Nothing else to change; `defaultProvider`/`defaultModel` are already set.

The key is the same one the `opencode` CLI uses, so if you have already connected Zen there, copy it
from the account page rather than generating a second one.

Note the free models are offered "for a limited time" while OpenCode collects feedback — this is not
a stable long-term default.

> **Known problem with this model.** Users report `deepseek-v4-flash-free` returning HTTP 429
> *"Rate limit exceeded"* on **every** direct OpenAI-compatible API call — with a valid bearer
> token, from multiple IPs — while the official OpenCode CLI works fine from the same network
> ([opencode#42074](https://github.com/anomalyco/opencode/issues/42074)). The backend appears to
> route TUI traffic differently from direct API clients. **pi is a direct API client**, so it falls
> in the affected category. If every turn 429s, that is this, not your key.
>
> Fallbacks: `opencode/deepseek-v4-flash` (paid, 1M context) or `openai-codex/gpt-5.6-sol`, which
> already works with your existing OAuth token.

Two more limits on the free model: its context window is **200k** (the paid `deepseek-v4-flash` is
1M), and it is **text-only** — image attachments and `read` on an image will not work. Ctrl+P
switches models mid-session.

**`emilkowalski/skills` is filtered to one skill.** The repo ships 11 skills; loading all of them
would put 11 descriptions in every system prompt. The entry uses
`"skills": ["skills/apple-design"]` so only that one loads. Drop the filter if you want the rest —
the animation ones (`animate`, `review-animations`, `improve-animations`) are the obvious next picks.

**`amp-themes` and `pi-hashline-edit-pro` both claim the `read` tool.** amp-themes'
`amp-tool-display.ts` re-registers *all* of pi's built-ins (`bash`, `edit`, `find`, `grep`, `ls`,
`read`, `write`) purely to override their render hooks — it inherits each real `ToolDefinition` and
swaps only `renderCall`/`renderResult`. Harmless on its own; fatal next to hashline, which registers
its own `read`. pi refuses to start:

```
Error: Failed to load extension ".../amp-themes/extensions/amp-tool-display.ts":
Tool "read" conflicts with .../pi-hashline-edit-pro/index.ts
```

Resolved with a filter — amp-themes keeps its theme, editor chrome and user-message rendering, and
gives up only Amp-style tool rendering:

```json
{ "source": "npm:amp-themes", "extensions": ["!extensions/amp-tool-display.ts"] }
```

If you would rather have Amp's tool rendering than hash-anchored editing, drop
`pi-hashline-edit-pro` instead and remove this filter.

**A globally-installed pi package silently shadows this repo's copy.** pi resolves a user-scope
`npm:` package to `agent/npm/node_modules/<name>` *only if it already exists there*; otherwise it
falls back to whatever `npm root -g` has and uses that (`getNpmInstallPath` → legacy global path).
So `npm i -g amp-themes` from months ago wins over the version this repo declares, and the config
you are reading is not the one running.

```bash
npm ls -g --depth 0        # see what is shadowing
npm rm -g amp-themes       # and any other pi-* listed there
```

`setup-pi.sh` warns about this before it installs anything, but it will not remove anything for
you — uninstalling from your global npm is your call, not a setup script's.

**`pi-powerline-footer` and `amp-themes` fight over keybindings.** Starting pi prints a cascade of
`[powerline-footer] Shortcut conflict ...` lines, each one displacing the next, ending with
`editorEnd: "super+shift+down" is already in use`. Non-fatal, but it means some of those shortcuts
are not where either package thinks. This is the §6 duplicate-UI problem in practice: pick one of
the two, or accept remapped keys.

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

## 🔎 grep is already ripgrep

Worth knowing before reaching for an rg extension: pi's built-in `grep` tool **is** ripgrep.
`core/tools/grep.ts` calls `ensureTool("rg")` and spawns the binary — there is no non-rg fallback, it
errors out if rg cannot be obtained. Likewise `find` is `fd`. pi prefers a system `rg`/`fd` if one is
on `PATH` and otherwise downloads them into `agent/bin/` (that is what the `fd` binary in there is;
`rg` appears on the first `grep` call).

So the tool is named `grep` and behaves like `rg`. Renaming it would only break the skills and
prompts that refer to `grep`. Separately, `pi-rtk-optimizer` rewrites shell commands through
`rtk rewrite`, which covers `grep` typed into `bash`.

---

## 🗂 Retired

- `agent/prompts/plan.md` and `agent/skills/plan/` — moved to `_to_delete/` on the machine. The
  prompt was a 7-line wrapper around the skill, and both were superseded by the decision to skip
  `pi-plan` (see `OPTIMIZATIONS.md` §12). `_to_delete/` is gitignored; delete it yourself when
  you are happy.

---

## 🧩 Local Extensions

Auto-discovered by pi from `agent/extensions/`:

| Extension | What it does |
|---|---|
| `context.ts` | `/context` — colored grid of context usage by category, plus cache stats |
| `plan-mode.ts` | `/plan [--n N] [task]` — read-only, multi-stance planning with repository gates, optional verifier ranking, and human selection. |

`web-fetch/` and `ask-user-question.ts` were removed once `pi-web-access` and `pi-ask-user` covered
the same ground as maintained packages.

---

## ✅ Verified planning

`/plan` keeps the existing `tool_call` read-only gate and delegates planning to distinct stance
agents. It always reports a suggested fan-out of 1, 3, or 5 from the task's visible complexity;
`--n` overrides the number without hiding the suggestion.

```text
/plan Fix the parser in `src/parser.ts`
/plan --n 5 Design the authentication migration
/plan --n 3                # the next ordinary prompt becomes the task
/plan-review <session-id>  # offline review of a tracked execution
```

Referenced paths, symbols, and repository commands are checked before scoring. The verifier then
filters on groundedness, ranks the survivors across six criteria, shows the top-two disagreement,
and asks the human to choose. It never auto-selects. Rankings and execution scores are custom
session entries, so they are visible in the TUI but absent from model context; only the chosen plan
is sent to the executor.

The planner model is configurable at `planVerify.plannerModel`. The verifier must serve the same
underlying model ID and expose real score-token logprobs—there is no model fallback. When
`verifierUrl` is local, Pi starts the bundled verifier on launch and reuses an existing listener.
Configure the direct OpenAI-compatible endpoint before starting Pi. The equivalent manual command
for diagnostics is:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8000/v1
export OPENAI_API_KEY=EMPTY
export LLM_VERIFIER_MODEL=gpt-5.6-sol
uv run --frozen --project scripts/verifier \
  uvicorn service:app --app-dir scripts/verifier --host 127.0.0.1 --port 8899
```

`GET http://127.0.0.1:8899/healthz` returns HTTP 503 unless the probe observes a usable A–T
logprob distribution. If the service is absent, refuses, dies mid-run, or reports a different
model, Pi remains usable and presents every repository-gated plan unranked with a degraded label.
Remote verifier URLs are never launched locally.

`pi-caveman` can remove plan specificity and observational-memory compaction can discard evidence;
the extension warns when either appears active. Candidate agents always start with fresh context.

---

## 📁 Layout

```
~/.pi/                         ← this repo
├── README.md
├── OPTIMIZATIONS.md           # review notes & backlog
├── web-search.json            # 🚫 never committed — pi-web-access provider keys
├── scripts/
│   ├── setup-pi.sh            # bootstrap (idempotent)
│   ├── verifier/               # FastAPI + SQLite llm-verifier service
│   └── update-pi.sh           # update everything to latest
└── agent/                     # pi's config dir (PI_CODING_AGENT_DIR)
    ├── settings.json          # ✅ tracked — the real config
    ├── AGENTS.md              # ✅ tracked — global instructions (optional)
    ├── agents/                # ✅ tracked — read-only planning stances
    ├── criteria/              # ✅ tracked — versioned verifier criteria
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
