# Configuration audit

## Applied architecture

The configuration was redesigned after inspecting the current Pi 0.85.1 extension APIs, the
focused `@alexlikevibe/pi-jev` package, maintained package manifests, and
[Oh My Pi](https://github.com/can1357/oh-my-pi).

The resulting rule is one owner per concern:

| Concern | Owner |
|---|---|
| Context compaction | Focused pi-jev compaction |
| Model/tool/todo judgments | Local TypeSafe-backed Jev control |
| Persistent UI | pi-zentui |
| Code intelligence | pi-lens |
| Editing | pi-hashline-edit-pro |
| Delegation | Herdr or pi-subagents, selected per session |
| Review | pi-subagents' maintained parallel-review prompt |
| Web research | pi-web-access |
| Browser automation | Complete pinned Browser Use default with Pi model bridge; complete pinned Jev fallback |
| Safety | cc-safety-net standard policy |
| Context inspection | Local `/context` command |

## Removed overlap

- `pi-observational-memory` competed for `session_before_compact`.
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
- Browser Use is deployed as a complete checkout pinned to Git commit
  `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`; Jev Ultrafast is independently pinned to
  `1231850a0bf1a0c0341fe408ef1668dbbfdfac46`. Both use frozen upstream `uv.lock` files, and
  generated checkouts and virtual environments remain ignored.
- A tracked generic navigation-settle patch waits for a changed URL/title and a ready document after
  link clicks; setup reapplies it deterministically to the pinned checkout.
- Browser Use sends bounded messages, images, and schemas over JSONL to Pi's configured
  `openai-codex/gpt-5.6-sol` provider at low reasoning; structured responses are validated in
  TypeScript and again by Pydantic. Credentials are never exported to Python and Cloud is disabled.
  Jev operation/target choices receive only the TypeSafe key; its field text uses the same Pi model bridge.
- Normal automation uses a pinned CloakBrowser custom Chromium profile and never attaches to Chrome. Chrome
  session export is command-triggered, confirmation-gated, stored outside the repository with mode
  `0600`, and loaded only into the isolated automation profile.
- Both browser engines use bounded deadlines, one shared mutex, and no silent model or engine fallback.
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
