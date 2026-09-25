---
name: jev-use
description: Build or adapt a bounded computer-use loop where Cua Driver observes and acts, TypeSafe Jev selects only from application-owned candidate IDs, and the caller validates and verifies every action. Use for the jev-use recipe or similar Jev integrations; do not use it to add model logic or credentials to Cua Driver.
---

# jev-use

## Pi configuration

In this Pi profile, activate the `computer` specialist group with `jev_find_tools`.
Use Cua Driver tools to obtain a fresh semantic observation, build the complete
candidate actions locally, and send only their IDs and short descriptions to
`jev_choose_action`. Include `reobserve` and `abstain`. The Pi launcher loads
`TYPESAFE_API_KEY` from the existing Keychain entry into Pi's process environment;
never request, print, log, or pass the key to Cua Driver. The chooser returns an
ID without executing an action. Resolve it against the original candidate table,
check target freshness, execute at most one authorized Cua Driver action, then
reobserve and verify the postcondition. Follow `AGENTS.md` computer-use
authorization before any desktop observation or action.

Pi starts every session with `/cua-focus protect`: target an exact background
window and keep the user's active app, cursor, and clipboard untouched. If the
Driver requires foreground delivery or desktop-wide input, stop and explain the
blocker. Only the user can opt into focus changes with `/cua-focus allow` for
that Pi session; do not switch modes or use another tool to bypass protection.

For Chrome tasks, use `cua_repl_js` and the persistent browser objects. Create
inactive agent-owned tabs through `browser.tabs.new()` or
`cua.createBrowserTab()`. List user tabs without claiming them; claim only an
exact descriptor returned by the current `browser.user.openTabs()` call. Unmarked
agent tabs close at turn end. `cua_browser_group` and `cua_browser_page` remain
deprecated compatibility wrappers over the same lifecycle engine.

The runnable upstream example is pinned at
`https://github.com/trycua/cua/tree/ef13ca7b92355fd81523990ddc907f717ff9c35a/libs/cua-driver/examples/jev-use`.

Keep the decision layer above Cua Driver. Driver supplies observations and
executes actions; the application constructs complete candidates; TypeSafe Jev
returns one candidate ID. Never let Jev invent tool names, coordinates, refs,
targets, delivery modes, or other arguments.

Use the example at `libs/cua-driver/examples/jev-use/` as the runnable reference.
Keep TypeSafe request construction in the external Jev adapter rather than in
Driver or a Driver extension. The Python and TypeScript adapters must expose
equivalent mock and live behavior.
For a process boundary, use `cua.jev_choice_request_v1` on stdin and require
`cua.jev_choice_v1` on stdout. The request contains only a goal, capture ID,
compact regions, bounded history, and candidate IDs with descriptions; the
response contains only the selected ID, model identity, confidence, and
probabilities. Invoke the Python interpreter and absolute chooser path directly
without a shell.
Prefer browser DOM and semantic evidence. The optional visual adapter consumes
the public `cua.visual_regions_v1` result only when Driver advertises both
`parse_visual_regions` and the capture-bound `click.capture_id` input.
Use the checked-in fixtures for deterministic development; do not add a model,
extension artifact, or Driver implementation detail to the recipe.

## Decision loop

1. State the goal and obtain a fresh Cua Driver observation through one
   persistent CLI or MCP session.
2. Prefer an unambiguous fresh accessibility or browser DOM token.
3. If visual grounding is needed, discover `parse_visual_regions` through the
   current MCP tool inventory. Validate its versioned result, capture ID,
   screenshot reference and dimensions, coordinate mapping, unique region IDs,
   bounds, content, confidence, and ambiguity. Build a pixel action only with
   the exact capture ID in the same `click` call. Otherwise reobserve or abstain.
4. Construct a bounded candidate table. Each executable candidate contains the
   complete Driver tool and arguments. Include `reobserve` and `abstain` when
   evidence can be stale, incomplete, or ambiguous.
5. Send Jev only the goal, compact observation, recent history, and candidate
   IDs with descriptions. Include typed visual regions and their `capture_id`
   when the current observation has validated visual evidence; do not send
   extension internals or screenshot bytes.
6. Resolve the returned ID against the original immutable table. Reject an
   unknown, duplicate, malformed, denied, stale, or capture-mismatched choice,
   or a result below the caller's stated confidence policy.
7. Execute at most one Driver action. Use background delivery by default;
   foreground delivery is an explicit escalation subject to the active Driver
   contract and user authorization.
8. Reobserve and verify the postcondition before building another table.

## Freshness and visual evidence

- Treat Driver page refs, accessibility tokens, screenshot IDs, and visual
  region IDs as observation-local. Never reuse them after the UI changes.
- Require visual bounds and centers to remain inside the exact screenshot
  coordinate space and tied to the same target and snapshot.
- If semantic and visual evidence disagree, or multiple regions are plausible,
  offer `reobserve` and `abstain` without inventing a mutation.
- Never remove `capture_id` or retry an expired, stale, or mismatched capture as
  an unbound coordinate action.
- Use semantic evidence as authority when it is available. A visual label does
  not prove editability or interactivity.

## Credentials and proof

The deterministic mock path must work without `TYPESAFE_API_KEY`. For live Jev,
read the key from the process environment or a secure interactive prompt; never
put it in source, command arguments, logs, artifacts, or messages. Verify task
completion from an independent application postcondition rather than a model
answer, action response, or screenshot alone.
