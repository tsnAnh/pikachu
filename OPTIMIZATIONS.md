# pi-cfg optimization review

Audited against pi upstream docs (`earendil-works/pi`, `packages/coding-agent/docs/`) and the
package manager source.

**Status:** §1, §2, §6 (partly), §7, §9, §11 and §12 are **applied**. §3–§5, §8, §10 remain as a
backlog. §13 covers skills, §14 ranks token optimizations.

---

## 1. ✅ FIXED — the root `settings.json` was never read by pi

Pi only reads settings from two places:

| File | Scope |
|---|---|
| `~/.pi/agent/settings.json` | global |
| `.pi/settings.json` | per-project |

`~/.pi/settings.json` (this repo's root file) is **not** a config location. It works today only
because `setup-pi.sh` `jq`-loops it into `pi install`, and `pi install` then writes the real
`~/.pi/agent/settings.json`.

Two consequences:

- **Any non-package setting put in the root file is silently ignored.** `defaultModel`,
  `defaultThinkingLevel`, `theme`, `compaction`, `retry`, `thinkingBudgets`, `skills`, `enabledModels` —
  none of it would take effect.
- **The file that actually matters is gitignored.** `.gitignore` has `agent/*`, so the real
  `agent/settings.json` — the thing worth version-controlling — never lands in the repo. What gets
  reproduced on a new machine is the package list and nothing else.

**Applied:** `settings.json` → `agent/settings.json`, tracked; `.gitignore` restructured to
ignore-all-then-re-include, with explicit hard denials for `auth.json`, `trust.json`, `sessions/`,
`git/` and `npm/` that survive someone loosening a negation later. `setup-pi.sh` now reads the new
path.

> `agent/auth.json` holds provider API keys and OAuth tokens at `0600`, and it lives *inside this
> repo tree* once cloned to `~/.pi`. Never un-ignore it.

Note for the migration: if the machine already has a `~/.pi/agent/settings.json`, git will refuse
to check out over it. Move it aside first, then merge anything worth keeping.

The `jq` loop is gone entirely. `setup-pi.sh` now calls `pi update --extensions`, which reads
`agent/settings.json`, clones/installs anything missing (`updateGit` clones when the target dir is
absent; `shouldUpdateNpmSource` returns true when nothing is installed) and updates the rest —
without rewriting the settings file. That last part matters now that §7 uses an object-form entry:
looping over `pi install` would have rewritten `{ "source": "npm:pi-hooks", "extensions": [...] }`
back to the plain string `"npm:pi-hooks"` and silently dropped the LSP filter on the first run.

The script also now refuses to run when `agent/` isn't the directory pi actually reads
(`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) — the same class of mistake as the original bug,
caught at the door rather than discovered months later.

---

## 2. ✅ FIXED — `agent/extensions/web-fetch` couldn't load on a fresh machine

`web-fetch/index.ts` statically imports `@mozilla/readability`, `linkedom` and `turndown`. Pi runs
`npm install` only for packages *it* installs (`npm:` / `git:` sources) — **not** for extension
directories auto-discovered under `~/.pi/agent/extensions/`. There is no `node_modules` there and
nothing in `setup-pi.sh` creates one, so the extension throws on load.

**Applied:** `setup-pi.sh` now walks `agent/extensions/*/package.json` and runs
`npm install --omit=dev` in each; `update-pi.sh` runs `npm update` in the same places.

**Resolved for good:** `web-fetch/` was replaced by `pi-web-access` (§12), so this capability no
longer depends on a setup step nobody re-runs. The dependency-install loop stays in the script for
any future local extension.

---

## 3. No global `AGENTS.md` — the highest-leverage file in a pi config

`~/.pi/agent/AGENTS.md` is concatenated into the context of *every* session, in every project.
The repo doesn't have one. That's the single biggest gap.

It matters most for the tools this repo installs but never mentions: setup builds **`rtk`** and
**`cm` (CodeMapper)**, but nothing tells the model they exist. `cm` in particular has no extension —
the agent will never call `cm query` / `cm callers` / `cm trace` unless told to, so the Rust
indexer that replaced `pi-codemapper` is currently dead weight.

Suggested `agent/AGENTS.md`:

```markdown
# Global instructions

## Code search
Prefer `cm` (CodeMapper) over grep for symbol-level questions:
- `cm query <symbol>` — find a definition
- `cm callers <symbol>` / `cm callees <symbol>` — call graph
- `cm trace <symbol>` — execution path
- `cm diff` / `cm since <ref>` — what changed
Fall back to `grep`/`find` for plain text.

## Shell
`rtk` is installed and wraps common commands to cut output size. Don't fight the rewriter.

## Style
- Ask before large refactors; small diffs over rewrites.
- No comments that restate the code.
- Match surrounding style; don't reformat untouched lines.
```

Keep it short — it's in every request. Project-level `AGENTS.md` layers on top.

---

## 4. ⚠️ PARTLY FIXED — model settings existed, but only on the Mac

This turned out to be worse than "not configured". The machine's live
`~/.pi/agent/settings.json` *did* carry real tuning — `theme: dark`,
`defaultProvider: openai-codex`, `defaultModel: gpt-5.6-sol`, `defaultThinkingLevel: high` — and a
package (`pi-simplify`) that the repo had never heard of. None of it was in git, because the repo
tracked a file pi never reads (§1). A fresh machine would have reproduced none of it.

**Applied:** those four settings and `pi-simplify` are now in `agent/settings.json`, and the default
has since moved to `opencode` / `deepseek-v4-flash-free` — free tier, 200k context, text-only,
reasoning-capable. Note this needs an OpenCode Zen credential that `auth.json` does not yet have.

`enabledModels` is deliberately still unset: it *scopes* the session rather than just populating the
Ctrl+P list, so setting it would lock the model picker down to whatever patterns it names. With a
free model as the default you want the escape hatch wide open, not narrowed. Compaction and retry
are also still unset — the rest of this section stands:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5",
  "defaultThinkingLevel": "medium",
  "enabledModels": ["claude-*", "gpt-5*", "gemini-*"],
  "thinkingBudgets": { "minimal": 1024, "low": 4096, "medium": 10240, "high": 32768 },
  "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 },
  "retry": { "enabled": true, "maxRetries": 3, "provider": { "timeoutMs": 3600000, "maxRetries": 0 } },
  "showCacheMissNotices": true,
  "quietStartup": true,
  "externalEditor": "code --wait",
  "steeringMode": "one-at-a-time",
  "packages": [ "..." ]
}
```

Notes:

- `enabledModels` powers Ctrl+P model cycling — with `pi-caveman` and heavy compaction in play,
  fast switching between a cheap and a strong model is where the real savings are.
- `showCacheMissNotices: true` surfaces prompt-cache misses. Given this config stacks four
  context-mutating extensions (§7), you want to see when one of them is busting the cache.
- Keep `retry.provider.maxRetries` at `0` — the docs warn that SDK-level retries swallow
  out-of-quota errors and can hang the agent until the provider resets.
- Export `PI_CACHE_RETENTION=long` in your shell for extended prompt caching where the provider
  supports it.

---

## 5. Four overlapping layers of context compression

Currently stacked:

| Layer | What it does |
|---|---|
| pi built-in compaction | summarizes old turns |
| `pi-observational-memory` | *replaces* compaction with tiered observations/reflections |
| `pi-rtk-optimizer` `outputCompaction` | truncates tool output at 12 000 chars, filters build/test/git output |
| `pi-caveman` | strips filler from model prose |

These aren't complementary — they compete. The specific risk: rtk truncates a tool result
**before** observational-memory ever sees it, so the memory layer records a summary of a summary.
And two of them hook compaction, so whichever registers last wins silently.

**Suggested:** pick observational-memory as the compaction owner, and treat rtk as *transport*
compression only. Also reconsider `truncate.maxChars: 12000` — that's high enough that it rarely
fires on the outputs that matter and low enough to decapitate a long test run. Measure first:
`/rtk stats` reports actual savings per tool.

`pi-caveman` is opt-in per session (`/caveman`), so it's harmless sitting installed.

---

## 6. Duplicate UI and duplicate dashboards

- **`amp-themes` + `pi-powerline-footer`** — amp-themes ships "theme, editor chrome, and compact
  tool display"; powerline-footer ships a status bar. Both draw footer/chrome. Verify one isn't
  overwriting the other; drop whichever loses.
- **`agent/extensions/context.ts` + `@tmustier/pi-usage-extension`** — both are context/usage/cost
  dashboards. 536 lines of local TypeScript to maintain against a package that does the same job.
  Keep one. (If `context.ts`'s per-tool token grid is the reason to keep it, drop the npm package.)
- ✅ The other two local extensions are gone: `web-fetch/` → `pi-web-access`,
  `ask-user-question.ts` → `pi-ask-user`.

---

## 7. ✅ FIXED — `pi-hooks` loaded all of its extensions

`pi-hooks` bundles seven extensions: `checkpoint`, `lsp`, `lsp-tool`, `permission`, `ralph-loop`,
`repeat`, `token-rate`. String form loads all of them.

**Applied:** switched to object form excluding the LSP pair, since `pi-lens` now owns LSP and
running two LSP layers means two sets of language servers for the same project:

```json
{ "source": "npm:pi-hooks", "extensions": ["!lsp/*.ts"] }
```

`applyPatterns` in pi's package manager treats a filter list with no positive includes as
"everything, minus the exclusions", so this loads the other five. Verified against the package's
actual manifest paths.

`pi config` toggles these interactively if you want to trim further.

---

## 8. Nothing is pinned

Every entry is a floating ref:

```json
"npm:pi-hooks", "git:github.com/elpapi42/pi-fork", "git:github.com/v2nic/pi-caveman"
```

Two problems for a repo whose whole purpose is "reproduce my environment on a new machine":

- **Drift.** Pinned specs (`npm:pkg@1.2.3`, `git:host/user/repo@v1`) are skipped by
  `pi update --extensions`; unpinned ones move under you. Today's clone and next month's clone give
  different environments.
- **Supply chain.** Upstream's own warning: *"Pi packages run with full system access. Extensions
  execute arbitrary code."* Four of these are personal GitHub accounts. An unpinned git ref means
  whatever is on that branch at clone time runs with your permissions.

**Fix:** pin everything, bump deliberately with `pi install npm:pkg@<newver>` /
`pi install git:host/user/repo@<ref>`.

---

## 9. ✅ MOSTLY FIXED — `setup-pi.sh` hardening

**Applied:** `set -euo pipefail`; the `jq | while read` loop over `pi install` replaced outright
with `pi update --extensions` (see §1 — it installs missing packages *and* leaves settings.json
alone); a guard that aborts when `agent/` isn't pi's real config dir; `rtk` and `cm` skipped when
already present (`--force` to rebuild); `cargo install --locked`; prereq checks extended to `pi` and
`npm`, with `jq` no longer needed at all; `brew` downgraded to a warning so the script runs on
Linux. Shellcheck-clean at `-S warning`. A companion `scripts/update-pi.sh` covers "update
everything to latest".

**Not done:** pinning the `cm` build to a tag/rev — the repo publishes no tags, so this needs a
commit SHA choice you should make deliberately.

Original findings:

- The `jq -r '.packages[]' | while read` loop runs in a **subshell** — with plain `set -e` a failing
  `pi install` neither aborts nor is noticed. `pipefail` plus a `while ... done < <(...)` process
  substitution fixes it. (Moot if you adopt §1 and drop the loop.)
- `cargo install --git <url>` is unpinned and rebuilds from scratch on every run. Add `--locked` and
  a `--tag`/`--rev`, and skip when present:
  ```bash
  command -v cm >/dev/null || cargo install --locked --git https://github.com/p1rallels/codemapper.git --tag <tag>
  ```
- `brew install rtk` on every run — guard with `command -v rtk >/dev/null ||`.
- Prereq check covers `brew cargo jq` but not **`pi`** (the script's main verb) or **`npm`** (needed
  for §2, and claimed as a prerequisite in the README).
- Nothing is idempotent — re-running is a full reinstall. Cheap guards make the script safe to run
  after every `git pull`.
- Consider a `pi update --all` path so "update everything" isn't "reinstall everything".

---

## 10. Local extensions import the deprecated package scope

`ask-user-question.ts`, `context.ts` and `web-fetch/index.ts` import `@mariozechner/pi-coding-agent`,
`@mariozechner/pi-tui`, `@mariozechner/pi-ai`. Upstream renamed to `@earendil-works/*`. The extension
loader still aliases the old names (`core/extensions/loader.ts`), so nothing breaks *today* — but
it's a deprecation path, and it means editor type resolution points at packages npm no longer
publishes. Rename the imports.

---

## 11. ✅ FIXED — README drift

All fixed in the README rewrite:

- Listed `pi-codemapper` as installed; it was removed in `ac92204`.
- Omitted `@tmustier/pi-usage-extension`, added in `5cb4ebf`.
- The layout diagram showed top-level `git/` and `npm/`; pi puts those under `agent/git/` and
  `agent/npm/`, so the old `.gitignore` entries were guarding directories that never exist.
- Documented `jq` as a prerequisite, and the local extensions now have a section of their own.

---

## 12. ✅ APPLIED — packages added

Six packages added, one removed. Verified before install: manifests read, tool names extracted, and
the whole set checked for collisions against pi's built-ins (`read`, `bash`, `edit`, `write`,
`grep`, `find`, `ls`) and against each other.

| Added | Version | Registers |
|---|---|---|
| `pi-web-access` | 0.24.0 | `web_search`, `fetch_content`, `source_check`, `get_search_content` |
| `pi-subagents` | 0.51.0 | `subagent`, `subagent_wait`, `agent`, `contact_supervisor`, `structured_output`, watchdog tools |
| `pi-hashline-edit-pro` | 2.6.1 | `read` (override), `replace`, `undo_last_replace` |
| `pi-lens` | 4.0.1 | `analyze`, `lsp_diagnostics`, `lsp_navigation`, `ast_grep_search`/`_replace`, `module_report`, `read_symbol` |
| `pi-ask-user` | 0.14.0 | `ask_user` |
| `@dietrichgebert/ponytail` | 4.9.0 | no tools — 6 skills (`ponytail`, `-audit`, `-debt`, `-gain`, `-help`, `-review`) |

> Note the scope: the pi package is `@dietrichgebert/ponytail`. The unscoped `ponytail` on npm is an
> unrelated site-maintenance tool.

### What had to be resolved

**`pi-minimal-subagent` removed — hard collision.** It registers a tool named exactly `subagent`,
and so does `pi-subagents`. Two extensions claiming one tool name is not a preference question.
`pi-subagents` is a strict superset (scripted multi-agent workflows, supervisor contact, watchdog),
so it wins.

**`pi-hooks` filtered to drop its LSP pair** — see §7.

**`pi-hashline-edit-pro` removes the built-in `edit` tool.** Not a collision, an intentional
override: `session_start` calls `setActiveTools(active.filter(t => t !== "edit"))`. Worth
re-checking after a week of use — if edits feel worse rather than better, this is the package to
pull. Its state lives in `~/.config/pi-hashline-edit-pro/`, outside this repo.

**`pi-web-access` config leaks into the repo root.** `getWebSearchConfigDir()` returns
`PI_CODING_AGENT_DIR` if set, else `~/.pi` — *not* `~/.pi/agent`. With this repo cloned to `~/.pi`,
`web-search.json` lands in the tracked root, and it holds plaintext provider API keys
(`openaiApiKey`, `braveApiKey`, `exaApiKey`, …). Added to `.gitignore`. Setting
`PI_CODING_AGENT_DIR=~/.pi/agent` in your shell also moves it under the already-ignored `agent/`.

### Version compatibility (checked against pi 0.84.2)

| Package | Declared peer range | Verdict |
|---|---|---|
| `pi-rtk-optimizer` 0.9.0 | `^0.74 \|\| ^0.75 \|\| ^0.78 \|\| ^0.79 \|\| ^0.80` | ⚠️ Outside range. Installs (pi uses `--legacy-peer-deps`) but untested against 0.84. |
| `pi-powerline-footer` 0.15.1 | `>=0.81.0 <0.85.0` | ✅ Fits, but the upper bound means 0.85 will need a bump. |
| `pi-hashline-edit-pro` 2.6.1 | `engines.node >= 22.19.0` | ✅ Guarded — `setup-pi.sh` now aborts early on older node. |
| `pi-mermaid` 0.3.0 | peers on `@mariozechner/*` | ✅ Works via the loader alias, but see §10. |
| `pi-simplify` 0.2.3 | `@sinclair/typebox ^0.34.0` | ✅ pi migrated to `typebox` 1.x but still aliases the legacy root package. |
| Everything else | `*` | ✅ |

### The collision the audit missed

`amp-themes` + `pi-hashline-edit-pro` → `Tool "read" conflicts`, pi refuses to start.

It surfaced twice, from two different copies of amp-themes, and my pre-install scan missed both.

**First hit:** a stale *globally* npm-installed amp-themes that bundles `pi-tool-display`, which
registers `read`. My scan walked each package's own source and **skipped `node_modules`**, so a tool
registered by a bundled dependency was invisible — even though pi's packaging docs explicitly
describe `bundledDependencies` + `node_modules/` paths as a supported layout.

**Second hit, after removing the global copy:** amp-themes 0.4.1's *own*
`extensions/amp-tool-display.ts` registers `read` too. It re-registers every built-in
(`bash`, `edit`, `find`, `grep`, `ls`, `read`, `write`) to override render hooks only. My regex
looked for a literal `name: "..."` within 600 chars of `registerTool(`; these calls spread a
`create<Tool>ToolDefinition(cwd)` result, so the name is never a literal. The scan reported 7 tools
across 15 packages — implausibly few, and I did not treat that as the red flag it was.

Lessons:

1. Scan bundled dependencies, not just a package's own tree.
2. A tool name can be inherited rather than written literally. Static regex under-reports; treat a
   suspiciously low count as a failed scan, not a clean one.
3. The package you audit may not be the package that loads (§ below).

Resolved by filtering: `{ "source": "npm:amp-themes", "extensions": ["!extensions/amp-tool-display.ts"] }`.

### Globally-installed packages shadow this repo

`getNpmInstallPath` returns the managed `agent/npm` path only when it already exists; otherwise it
falls back to `npm root -g`. Any `npm i -g <pi-package>` therefore overrides what
`agent/settings.json` declares, silently and permanently, since pi then never installs its own copy.

On this machine that meant `amp-themes`, `pi-hooks`, `pi-rtk-optimizer`, `pi-observational-memory`,
`pi-mermaid`, `pi-powerline-footer` and `@tmustier/pi-usage-extension` were all resolving to global
copies — none of them appear in `agent/npm/package.json`. `setup-pi.sh` now detects and warns.

This is the same failure shape as §1: the file you are editing is not the thing that runs.

### Keybinding collisions, observed

`pi-powerline-footer` + `amp-themes` produce a displacement cascade at startup — `jumpChatBottom`
takes `ctrl+shift+g` → pushed to `super+up`, which displaces `scrollChatUp` → `super+down`, which
displaces `scrollChatDown`, and so on until `editorEnd` has nowhere to go. Non-fatal, but several
shortcuts end up somewhere neither package intended. Concrete evidence for §6: these two overlap
enough that keeping both costs more than it gives.

### Interactions worth watching

- **hashline vs rtk.** rtk compacts only `bash`, `read` and `grep` output. Hashline's tool is also
  named `read`, so rtk's read path *does* see it — but `readCompaction.enabled` is `false` in
  `config.json`, and `compactReadText` returns the text untouched in that case, before any
  truncation. Anchors survive byte-exact. rtk even has a `looksLikeAnchoredReadOutput` branch, so
  the two were built with each other in mind. **Don't turn on `readCompaction` without re-testing.**
- **hashline `read` vs pi-lens `read_symbol`.** Two different read-substitutes, no name collision,
  but the model now has three ways to read a file. Watch whether it picks sensibly.
- **`pi-lens` manifest quirk.** Its `package.json` declares `"skills": ["../../skills"]`, a path
  that escapes the package root. Probably resolves to nothing; harmless, but if its skills don't
  appear, that's why.
- **System-prompt growth.** These six add roughly 20 tool descriptions. That is a real per-request
  cost paid on every turn — the payoff has to come from subagents and fewer failed edits. If it
  doesn't, `pi config` is where you trim.

### Still on the table

- **`pi-mcp-adapter`** (2.26.1) or **`pi-mcp-extension`** (1.5.0) — pi ships with no MCP support at
  all. `pi-lens` now brings its own MCP *server*, but not a client. If you use MCP servers
  elsewhere, this is still the only bridge. (Note: pi's author skipped MCP deliberately.)
- **`cc-safety-net`** (2.0.7) — blocks destructive commands and secret-file reads. `agent/auth.json`
  and `web-search.json` both sit inside this repo tree, which is exactly the case it guards.
- **`pi-background-tasks`** (2.4.2) — long builds and test suites stop blocking the turn.
- **`pi-zentui`** (0.20.1) — one coherent TUI instead of `amp-themes` + `pi-powerline-footer`
  competing for the same chrome (§6).

### Rejected: `pi-plan`

`pi-plan@0.1.1` (read-only plan mode, `/plan` + Ctrl+Alt+P) was evaluated and **not added**.

It manages plan mode by calling `pi.setActiveTools()` with two hardcoded absolute lists:

```ts
const PLAN_MODE_TOOLS   = ["read", "bash", "grep", "find", "ls"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
```

`setActiveTools` *replaces* the active set. So leaving plan mode — via the toggle, or by picking
"Execute the plan" — pins the session to four tools. Everything else is dropped for the rest of that
session: the built-in `grep`, `find` and `ls`, plus every extension tool this config exists to
provide (`subagent`, `subagent_wait`, `web_search`, `fetch_content`, `source_check`, `ask_user`,
`replace`, `undo_last_replace`, all of pi-lens, `fork`). And `edit` comes *back*, which
pi-hashline-edit-pro removes on purpose.

That list was written when pi shipped roughly those tools and no others. It is not extension-aware,
and the package targets `@mariozechner/pi-*` `^0.70.2` — the pre-rename scope, 14 minor versions
behind 0.84.2.

The local `plan` skill covered the same need without gutting the toolset, so neither was kept: the
skill and its `/plan` prompt wrapper were retired at the same time (see below).

### Probably skip

- **`context-mode`** — "saves 98% of your context window" is marketing, and it's an MCP plugin, so
  it needs an adapter to load at all.
- **Any extension that calls `setActiveTools()` with an absolute list.** In a config this
  extension-heavy, that is a footgun by construction — the author cannot know what else you loaded.
  Grep for it before installing.
- **`bigpowers`** / **`superpowers-zh`** — superpowers derivatives. You just removed superpowers.
- **`@hypabolic/pi-hypa`** — rewrites noisy shell commands out of context, which is what
  `pi-rtk-optimizer` already does. Don't stack two.

---

## 13. Skills

Removing superpowers left `agent/skills/` empty. Pi discovers skills from `~/.pi/agent/skills/`,
`~/.agents/skills/`, package `skills/` dirs, and any path in the `skills` settings array.

**Free win — reuse skills you already have.** Pi reads other harnesses' skill directories directly:

```json
{
  "skills": ["~/.claude/skills", "~/.codex/skills"]
}
```

That alone may be all the skill config you need.

**Applied:** `emilkowalski/skills` added as a filtered git package —
`{ "source": "git:github.com/emilkowalski/skills", "skills": ["skills/apple-design"] }`. The repo
ships 11 skills; the filter loads one. Verified against pi's own matcher: for `SKILL.md` files
`matchesAnyPattern` also tests the parent directory, so `skills/apple-design` resolves to exactly
`skills/apple-design/SKILL.md` and excludes the other ten.

Preferred over vendoring the file into `agent/skills/` because `pi update` keeps it current and it
stays attributed upstream. The trade: no tags on that repo, so it tracks the default branch — see §8.

**Write your own, sparingly.** Skills are progressive disclosure: only the *description* sits in
every system prompt, the body loads on demand. That makes the description the expensive part — 30
skills is 30 descriptions in every request, forever. The reason superpowers was worth removing is
the same reason a hand-rolled replacement should stay small. Good candidates for this setup:

- **`codemapper`** — when and how to use `cm` (see §3; a skill is the alternative to putting it in `AGENTS.md`)
- **`rtk`** — what rtk rewrites and when to bypass it
- One skill per recurring project-specific workflow, in that project's `.pi/skills/` rather than globally

Set `"enableSkillCommands": true` (the default) so each is also reachable as `/skill:<name>`.

---

## 14. Token optimizations, ranked by actual leverage

Ordered by how much they save, not how easy they are.

1. **Subagents for exploration** — ✅ `pi-subagents` installed. "Find every caller of X and tell me
   which ones need updating" costs 40k tokens in the main context and ~1k as a delegated summary.
   Nothing else on this list is in the same order of magnitude. This only pays off if you actually
   reach for it, so it belongs in `AGENTS.md` (§3).

2. **Protect the prompt cache.** A cache hit is roughly a 10× cost reduction on the prefix. Anything
   that mutates earlier context — compaction, memory rewrites, injected notices — invalidates it.
   With four context-mutating extensions stacked (§5), this is the most likely place this config is
   quietly losing money. Turn on `showCacheMissNotices: true`, export `PI_CACHE_RETENTION=long`, and
   watch for churn.

3. **Structural search instead of grep + read.** `cm query`/`callers`/`trace`, and now
   `pi-lens`'s `ast_grep_search` / `module_report` / `read_symbol`, return a symbol and its edges;
   grep returns hits you then have to `read` files to interpret. But **it only helps if the model
   knows to reach for it** — see §3. Right now it doesn't.

4. **Right-size thinking.** `defaultThinkingLevel` plus per-level `thinkingBudgets` (§4). Reasoning
   tokens are billed and often invisible; `medium` with a 10k budget is a very different bill from
   `high` with 32k, for the same answer on routine work.

5. **Model cycling.** `enabledModels` + Ctrl+P. Routine edits on a cheap model, hard reasoning on a
   strong one, switched per-turn without leaving the session.

6. **Tool-output compaction** (`pi-rtk-optimizer`). Real but bounded, and it's the one already
   installed. Measure it with `/rtk stats` before tuning `truncate.maxChars`.

7. **Trim the loaded surface.** Every extension's tools and commands are described in the system
   prompt on *every* request — and §12 just added ~20 descriptions. This now cuts both ways: the new
   packages have to earn that overhead. `pi config` shows what's actually loaded; `defaultTools` can
   drop built-ins you never use.

8. **`pi-caveman`.** Cuts output prose, which is the cheapest half of the bill. Nice to have, not a
   strategy — and it's opt-in per session anyway.

---

## Suggested order

1. ~~§1 `agent/settings.json` as source of truth~~ ✅
2. ~~§2 web-fetch deps~~ ✅
3. **§3 `AGENTS.md`** — biggest remaining per-session payoff, and it's what makes `cm` real
4. **§12** — `pi-web-access` (retires the local extension) and `pi-subagents` (the token lever)
5. §4 model/thinking/compaction settings, then §5–§7 with `/rtk stats` and `pi config` as evidence
6. §8 pinning + §10 import scope — hygiene, do them when touching those files anyway
