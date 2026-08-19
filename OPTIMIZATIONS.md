# pi-cfg optimization review

Audited against pi upstream docs (`earendil-works/pi`, `packages/coding-agent/docs/`) and the
package manager source.

**Status:** §1, §2 and §11 are **fixed** in this branch. §3–§10 remain as a backlog.
§12 is a shortlist of packages worth adding, §13 covers skills.

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

Worth knowing for later: pi **auto-installs missing packages from global settings on startup**
(`PackageManager.resolvePackageSources` → `installMissing`), so the `jq` loop is now belt-and-braces
rather than load-bearing. It's kept because it gives an explicit, greppable bootstrap and a real
exit code.

---

## 2. ✅ FIXED — `agent/extensions/web-fetch` couldn't load on a fresh machine

`web-fetch/index.ts` statically imports `@mozilla/readability`, `linkedom` and `turndown`. Pi runs
`npm install` only for packages *it* installs (`npm:` / `git:` sources) — **not** for extension
directories auto-discovered under `~/.pi/agent/extensions/`. There is no `node_modules` there and
nothing in `setup-pi.sh` creates one, so the extension throws on load.

**Applied:** `setup-pi.sh` now walks `agent/extensions/*/package.json` and runs
`npm install --omit=dev` in each; `update-pi.sh` runs `npm update` in the same places.

**Still worth doing:** either promote `web-fetch` to a real pi package (so pi installs its deps and
`pi update` maintains it), or replace it outright with `pi-web-access` — see §12. Pi has no built-in
web tool (built-ins are only `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`), so this
capability is load-bearing and shouldn't depend on a setup step nobody re-runs.

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

## 4. Zero model, thinking, or compaction tuning

None of pi's actual behavioral settings are configured. A reasonable `agent/settings.json`:

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

---

## 7. `pi-hooks` loads all five of its extensions

`pi-hooks` bundles `checkpoint`, `lsp`, `permission`, `ralph-loop`, and `repeat`. String form loads
everything; each registers tools and commands that cost system-prompt tokens on every request. Use
the object form to load only what you use:

```json
{
  "packages": [
    { "source": "npm:pi-hooks", "extensions": ["extensions/checkpoint.ts", "extensions/lsp.ts"] }
  ]
}
```

(Check the actual filenames with `pi config`, which also lets you toggle resources interactively.)

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

**Applied:** `set -euo pipefail`; the `jq | while read` subshell replaced with process substitution
so a failed `pi install` actually aborts; `rtk` and `cm` skipped when already present (`--force` to
rebuild); `cargo install --locked`; prereq checks extended to `pi` and `npm`; `brew` downgraded to a
warning so the script runs on Linux. Shellcheck-clean at `-S warning`. A companion
`scripts/update-pi.sh` covers "update everything to latest".

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

## 12. Packages worth adding

The pi package ecosystem has grown a lot (120+ on npm under `keywords:pi-package`). Ranked by what
this specific config is missing. Note that **`pi-powerline-footer`, already installed here, is by
`nicobailon`** — the first three below are by the same author, so they're a known quantity.

### Strong fits

| Package | Why it fits here |
|---|---|
| **`pi-web-access`** (0.24.0) | Web search + URL fetch + GitHub repo cloning + PDF extraction + YouTube, with pluggable providers (Brave, Tavily, Exa, Firecrawl, Jina, …). This is a **superset of the local `web-fetch/` extension** and it's a maintained package, so its deps install themselves and `pi update` maintains it. Adopting it retires ~650 lines of local TypeScript and the §2 class of bug permanently. |
| **`pi-subagents`** (0.51.0) | Single-agent delegation + scripted multi-agent workflows. The **single biggest token lever available** — a subagent burns its own context window and returns a summary, so exploration never lands in the parent transcript. Much richer than the `pi-minimal-subagent` currently installed; consider it a replacement, not an addition. (`@gotgenes/pi-subagents` 19.3.2 is a more API-focused alternative other extensions build on.) |
| **`pi-mcp-adapter`** (2.26.1) or **`pi-mcp-extension`** (1.5.0) | Pi ships with **no MCP support at all** — deliberately. If you use any MCP servers elsewhere (GitHub, Notion, Postgres, Playwright…), one of these is the only way to reach them from pi. |
| **`cc-safety-net`** (2.0.7) | Blocks destructive commands and reads of secret files. Given `agent/auth.json` sits inside this very repo tree, a guard against the agent reading or committing it is cheap insurance. |

### Worth evaluating

| Package | Note |
|---|---|
| **`pi-hashline-edit-pro`** (2.6.1) / **`pi-readseek`** (0.9.13) | Hash-anchored read/edit — every line gets a stable 3-char hash, stale anchors are *rejected* rather than fuzzy-matched. Failed edits are a quiet but large token cost (model re-reads the file, retries, re-reads again). Worth a trial if you see edit churn. |
| **`pi-background-tasks`** (2.4.2) | Durable background shell tasks + read-only delegated agents. Long builds/test suites stop blocking the turn. |
| **`pi-lens`** (4.0.1) | Real-time LSP/lint/typecheck feedback. Overlaps `pi-hooks`'s `lsp` — pick one. |
| **`@narumitw/pi-plan-mode`** (0.49.3) | Codex-style read-only `/plan` mode. This is roughly the useful half of what superpowers' `writing-plans` gave you, without the skill sprawl. |
| **`pi-zentui`** (0.20.1) | Starship-inspired statusline + OpenCode-style TUI. A single coherent alternative to `amp-themes` + `pi-powerline-footer` fighting over the same chrome (§6). |
| **`pi-ask-user`** (0.14.0) | Split-pane searchable ask-user tool — the maintained version of the local `ask-user-question.ts`. |

### Probably skip

- **`context-mode`** — "saves 98% of your context window" is marketing, and it's an MCP plugin, so it'd need the MCP adapter to even load.
- **`bigpowers`** / **`superpowers-zh`** — superpowers derivatives. You just removed superpowers.
- **`@hypabolic/pi-hypa`** — rewrites noisy shell commands out of context; that's what `pi-rtk-optimizer` already does. Don't stack two.

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

1. **Subagents for exploration** (§12). "Find every caller of X and tell me which ones need
   updating" costs 40k tokens in the main context and ~1k as a delegated summary. Nothing else on
   this list is in the same order of magnitude.

2. **Protect the prompt cache.** A cache hit is roughly a 10× cost reduction on the prefix. Anything
   that mutates earlier context — compaction, memory rewrites, injected notices — invalidates it.
   With four context-mutating extensions stacked (§5), this is the most likely place this config is
   quietly losing money. Turn on `showCacheMissNotices: true`, export `PI_CACHE_RETENTION=long`, and
   watch for churn.

3. **`cm` instead of grep + read.** `cm query`/`callers`/`trace` return a symbol and its edges;
   grep returns hits you then have to `read` files to interpret. But **it only helps if the model
   knows to use it** — see §3. Right now it doesn't.

4. **Right-size thinking.** `defaultThinkingLevel` plus per-level `thinkingBudgets` (§4). Reasoning
   tokens are billed and often invisible; `medium` with a 10k budget is a very different bill from
   `high` with 32k, for the same answer on routine work.

5. **Model cycling.** `enabledModels` + Ctrl+P. Routine edits on a cheap model, hard reasoning on a
   strong one, switched per-turn without leaving the session.

6. **Tool-output compaction** (`pi-rtk-optimizer`). Real but bounded, and it's the one already
   installed. Measure it with `/rtk stats` before tuning `truncate.maxChars`.

7. **Trim the loaded surface.** Every extension's tools and commands are described in the system
   prompt on *every* request. `pi-hooks` alone contributes five extensions (§7). `pi config` shows
   what's actually loaded; `defaultTools` can drop built-ins you never use.

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
