---
name: gui-automation
description: Use Pi's CUA runtime for visual interaction with macOS apps or Chrome when shell and APIs cannot complete the explicitly requested computer-use task.
---

# GUI automation with Pi CUA

This guidance adapts trycua/cua's `gui-automation` skill pinned at commit
`b207fc93de52522fe0e23b9c1fac3f34a2c85150` to Pi's background and confirmation
rules.

## Setup and posture

- Use `cua_repl_js`; start a clean runtime with exactly one entry call such as
  `cua.getState()`, `cua.getBrowser()`, `cua.createBrowserTab()`, or
  `cua.getApp()`.
- Keep `/cua-focus protect` active. Target an exact app window or exact claimed
  Chrome tab. CUA Driver's agent cursor may move; the real pointer and active app
  must remain unchanged.
- If a control needs foreground or desktop-wide trusted input, stop with the
  returned foreground-handoff requirement. Only the user may run
  `/cua-focus allow`.
- Consequential actions are confirmed at action time. Do not bundle approval
  with observation or reuse an approval for a different target.

## Workflow

1. Observe a fresh semantic state and screenshot when visual context matters.
2. Prefer accessibility actions, then locator actions, then capture-bound pixel
   actions.
3. Execute one action.
4. Reobserve and verify an independent postcondition. Refs, indices, and
   coordinates expire after navigation or a newer snapshot.
5. Mark a tab with `markDeliverable()` or `markHandoff()` only when it should
   survive turn cleanup.

## Browser lifecycle

Use `agent.browsers.list()` and `agent.browsers.get("chrome")`. Create inactive,
agent-owned tabs through `browser.tabs.new()` or `cua.createBrowserTab()`. Listing
user tabs does not claim them. Claim only a descriptor returned by the current
`browser.user.openTabs()` call. Unmarked agent tabs close at turn end; claims and
CUA sessions are revoked.

## Native apps

Use `cua.getApp(name)`, select one exact window, obtain fresh accessibility
state, and act with its current element token or snapshot index. Background
launch and background delivery are the defaults. Use deterministic verification
after each action.

## Upstream reference

Original skill:
`https://github.com/trycua/cua/blob/b207fc93de52522fe0e23b9c1fac3f34a2c85150/skills/gui-automation/SKILL.md`
