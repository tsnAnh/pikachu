/**
 * plan-mode — read-only exploration, without touching the active tool set.
 *
 * Written to replace `pi-plan`, which implements the same idea by calling
 * `pi.setActiveTools()` with two hardcoded absolute lists:
 *
 *     PLAN_MODE_TOOLS   = ["read", "bash", "grep", "find", "ls"]
 *     NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"]
 *
 * `setActiveTools` REPLACES the active set, so leaving plan mode pins the
 * session to whatever that list happens to name. Adding `grep`/`find`/`ls` to
 * it is not enough: an absolute list can never account for tools contributed by
 * other packages, so `subagent`, `web_search`, `fetch_content`, `ask_user`,
 * `replace`, pi-lens's tools and `fork` all vanish on the way out — and `edit`
 * comes back even when pi-hashline-edit-pro deliberately removed it.
 *
 * This version never mutates the tool set. It gates calls at `tool_call`
 * instead, so nothing to snapshot, nothing to restore, and tools added by
 * future packages are covered automatically: anything not on the read-only
 * allowlist is blocked while plan mode is on.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Tools that only observe. Everything else is blocked in plan mode.
 *
 * An allowlist rather than a denylist on purpose: a new package's write tool
 * should be blocked by default, not silently permitted until someone notices.
 */
const READ_ONLY_TOOLS = new Set([
  // pi built-ins (grep is ripgrep, find is fd — both read-only)
  "read",
  "grep",
  "find",
  "ls",
  // pi-hashline-edit-pro — its read override, not its mutations
  "offset",
  // pi-lens
  "analyze",
  "lsp_diagnostics",
  "lsp_navigation",
  "ast_grep_search",
  "module_report",
  "read_symbol",
  // pi-web-access
  "web_search",
  "fetch_content",
  "source_check",
  "get_search_content",
  // pi-ask-user
  "ask_user",
  // pi-subagents — delegated exploration is still exploration
  "subagent",
  "subagent_wait",
  "structured_output",
]);

/** Bash is allowed but write-ish invocations are refused. */
const BASH_WRITE_PATTERN =
  /\b(rm|mv|cp|dd|truncate|tee|chmod|chown|ln|mkdir|rmdir|touch|sed\s+-i|patch|install)\b|>>?\s*\S|\bgit\s+(add|commit|push|checkout|reset|merge|rebase|apply|restore|clean|stash)\b|\b(npm|pnpm|yarn|bun|pip|cargo|go|brew)\s+(i|install|add|remove|rm|uninstall|publish|update|upgrade)\b/;

export default function planModeExtension(pi: ExtensionAPI): void {
  let planMode = false;

  function render(ctx: ExtensionContext): void {
    ctx.ui.setStatus("plan-mode", planMode ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined);
  }

  function setMode(on: boolean, ctx: ExtensionContext): void {
    planMode = on;
    render(ctx);
    ctx.ui.notify(
      on
        ? "Plan mode on — research and propose only. Edits, writes and mutating shell commands are blocked."
        : "Plan mode off — full access restored.",
      "info",
    );
  }

  pi.registerCommand("plan", {
    description: "Toggle read-only plan mode (research and propose, no changes)",
    handler: async (_args, ctx) => setMode(!planMode, ctx),
  });

  pi.registerCommand("plan:status", {
    description: "Show whether plan mode is on",
    handler: async (_args, ctx) => {
      ctx.ui.notify(planMode ? "Plan mode is ON." : "Plan mode is OFF.", "info");
    },
  });

  pi.on("tool_call", async (event) => {
    if (!planMode) return;

    if (event.toolName === "bash") {
      const command = String((event.input as Record<string, unknown>)?.command ?? "");
      if (BASH_WRITE_PATTERN.test(command)) {
        return {
          block: true,
          reason:
            "Plan mode is on: this bash command looks like it modifies state. " +
            "Propose it as a plan step instead, or run /plan to leave plan mode.",
        };
      }
      return;
    }

    if (!READ_ONLY_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason:
          `Plan mode is on: "${event.toolName}" can modify state. ` +
          "Describe the change as a plan step instead, or run /plan to leave plan mode.",
      };
    }
  });

  pi.on("session_start", async (_event, ctx) => render(ctx));
}
