/**
 * Prompt-driven, strictly read-only planning with an approval UI.
 *
 * `/plan <request>` enables plan mode and immediately starts planning. Every
 * subsequent user turn stays read-only until the user approves or runs
 * `/plan off`. Completed plans open a scrollable Markdown review panel.
 */

import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  matchesKey,
  truncateToWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  PLAN_READY_MARKER,
  extractCompletedPlan,
  isReadOnlyBash,
  movePlanReviewScroll,
} from "./jev-control/src/plan-mode-core.js";

const STATE_ENTRY = "pi-cfg-plan-mode-v1";

const PLAN_SYSTEM_PROMPT = `You are in enforced plan mode. Research, reason, and propose only.

Rules:
- Do not edit files, write files, install packages, change configuration, mutate session todos, run builds, or perform any external mutation.
- Use tools only to inspect existing state. If a tool is blocked, continue with available read-only evidence.
- Do not claim that you implemented or changed anything.
- Ask a concise clarification question when a material decision cannot be inferred. Do not emit the completion marker while waiting for an answer.
- When the plan is complete, return the entire self-contained plan in Markdown, including scope, concrete changes, validation, risks, and relevant assumptions.
- Put ${PLAN_READY_MARKER} alone on the final line only when the plan is ready for approval.`;

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "anchor_grep",
  "offset",
  "analyze",
  "lsp_diagnostics",
  "lsp_navigation",
  "ast_grep_search",
  "ast_grep_outline",
  "lens_diagnostics",
  "lens_diagnostic_mark",
  "symbol_search",
  "module_report",
  "project_report",
  "read_symbol",
  "read_enclosing",
  "effective_config",
  "web_search",
  "fetch_content",
  "source_check",
  "get_search_content",
  "ask_user",
  "structured_output",
  "bg_wait",
  "jev_find_tools",
]);

export type PlanDecision = "implement" | "clear-implement" | "stay";

interface PlanState {
  version: 1;
  enabled: boolean;
}

function assistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return undefined;
  if (!("content" in message) || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((part): part is { type: "text"; text: string } => {
      return Boolean(part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part);
    })
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || undefined;
}

function implementationPrompt(plan: string): string {
  return `Implement the approved plan now. The planning phase is complete: make the changes, validate them, and report the result.\n\n## Approved plan\n\n${plan}`;
}

class PlanReviewPanel {
  focused = false;
  private selected = 0;
  private scroll = 0;
  private maxScroll = 0;
  private pageSize = 4;

  private readonly actions: Array<{ decision: PlanDecision; label: string }> = [
    { decision: "implement", label: "1. Yes, implement the plan" },
    { decision: "clear-implement", label: "2. Yes, clear context and implement the plan" },
    { decision: "stay", label: "3. No, stay in plan mode" },
  ];

  constructor(
    private readonly plan: string,
    private readonly theme: Theme,
    private readonly height: number,
    private readonly keybindings: KeybindingsManager,
    private readonly requestRender: () => void,
    private readonly done: (decision: PlanDecision) => void,
  ) {}

  private scrollBy(delta: number): void {
    const next = movePlanReviewScroll(this.scroll, delta, this.maxScroll);
    if (next === this.scroll) return;
    this.scroll = next;
    this.requestRender();
  }

  private selectBy(delta: number): void {
    const count = this.actions.length;
    this.selected = (this.selected + delta + count) % count;
    this.requestRender();
  }

  handleInput(data: string): void {
    if (data === "1") return this.done("implement");
    if (data === "2") return this.done("clear-implement");
    if (data === "3" || this.keybindings.matches(data, "tui.select.cancel")) return this.done("stay");
    if (this.keybindings.matches(data, "tui.select.confirm")) return this.done(this.actions[this.selected]!.decision);

    if (this.keybindings.matches(data, "tui.select.up")) this.selectBy(-1);
    else if (this.keybindings.matches(data, "tui.select.down")) this.selectBy(1);
    else if (data === "k") this.scrollBy(-1);
    else if (data === "j") this.scrollBy(1);
    else if (this.keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, "ctrl+u")) this.scrollBy(-this.pageSize);
    else if (this.keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, "ctrl+d")) this.scrollBy(this.pageSize);
    else if (matchesKey(data, "home") || data === "g") this.scrollBy(-this.maxScroll);
    else if (matchesKey(data, "end") || data === "G") this.scrollBy(this.maxScroll);
    else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) this.selectBy(-1);
    else if (this.keybindings.matches(data, "tui.input.tab") || matchesKey(data, "right")) this.selectBy(1);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    this.scrollBy(event.wheelDelta);
    return { handled: true, render: true, focus: true };
  }

  render(width: number): string[] {
    const panelWidth = Math.max(12, width);
    const innerWidth = Math.max(8, panelWidth - 2);
    const actionRows = this.actions.flatMap((action, actionIndex) =>
      wrapTextWithAnsi(action.label, Math.max(8, innerWidth - 3)).map((text, rowIndex) => ({ actionIndex, rowIndex, text })),
    );
    const bodyHeight = Math.max(1, this.height - actionRows.length - 8);
    const renderedPlan = new Markdown(this.plan, 1, 0, getMarkdownTheme()).render(innerWidth);
    this.pageSize = Math.max(4, bodyHeight - 1);
    this.maxScroll = Math.max(0, renderedPlan.length - bodyHeight);
    this.scroll = movePlanReviewScroll(this.scroll, 0, this.maxScroll);

    const pad = (text: string): string => text + " ".repeat(Math.max(0, innerWidth - visibleWidth(text)));
    const row = (text = ""): string =>
      this.theme.fg("border", "│") + pad(truncateToWidth(text, innerWidth)) + this.theme.fg("border", "│");
    const border = (left: string, fill: string, right: string): string => this.theme.fg("border", `${left}${fill.repeat(innerWidth)}${right}`);
    const lines = [
      border("╭", "─", "╮"),
      row(` ${this.theme.fg("accent", this.theme.bold("Plan ready for approval"))}`),
      row(this.theme.fg("dim", ` ${this.scroll + 1}-${Math.min(this.scroll + bodyHeight, renderedPlan.length)} of ${renderedPlan.length} lines`)),
      border("├", "─", "┤"),
    ];

    const visiblePlan = renderedPlan.slice(this.scroll, this.scroll + bodyHeight);
    for (const line of visiblePlan) lines.push(row(line));
    for (let index = visiblePlan.length; index < bodyHeight; index++) lines.push(row());

    lines.push(border("├", "─", "┤"));
    for (const actionRow of actionRows) {
      const selected = actionRow.actionIndex === this.selected;
      const prefix = actionRow.rowIndex === 0 && selected ? " ▶ " : "   ";
      const label = selected ? this.theme.fg("accent", this.theme.bold(actionRow.text)) : actionRow.text;
      lines.push(row(prefix + label));
    }
    lines.push(row(this.theme.fg("dim", " ↑↓/Tab choose · j/k or wheel scroll · PgUp/PgDn page · Enter confirm")));
    lines.push(border("╰", "─", "╯"));
    return lines;
  }

  invalidate(): void {}
}

export default function planModeExtension(pi: ExtensionAPI): void {
  let planMode = false;
  let awaitingPlan = false;
  let completedPlan: string | undefined;
  let clearRequestId = 0;
  const clearRequests = new Map<string, string>();

  const render = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus("plan-mode", planMode ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined);
  };

  const persist = (): void => pi.appendEntry(STATE_ENTRY, { version: 1, enabled: planMode } satisfies PlanState);

  const setMode = (on: boolean, ctx: ExtensionContext, options: { persist?: boolean; notify?: boolean } = {}): void => {
    planMode = on;
    if (!on) {
      awaitingPlan = false;
      completedPlan = undefined;
    }
    render(ctx);
    if (options.persist !== false) persist();
    if (options.notify !== false) {
      ctx.ui.notify(
        on
          ? "Plan mode on — inspection only. A completed plan will open for approval."
          : "Plan mode off — implementation tools restored.",
        "info",
      );
    }
  };

  const restore = (ctx: ExtensionContext): void => {
    planMode = false;
    awaitingPlan = false;
    completedPlan = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
      const state = entry.data as Partial<PlanState> | undefined;
      if (state?.version === 1 && typeof state.enabled === "boolean") planMode = state.enabled;
    }
    render(ctx);
  };

  const showPlan = async (plan: string, ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Plan ready. Open this session in interactive TUI mode to approve it; plan mode remains on.", "info");
      return;
    }

    const decision = await ctx.ui.custom<PlanDecision>(
      (tui, theme, keybindings, done) => {
        const height = Math.max(12, Math.min(36, tui.terminal.rows - 4));
        return new PlanReviewPanel(plan, theme, height, keybindings, () => tui.requestRender(), done);
      },
      { overlay: true, overlayOptions: { width: "92%", maxHeight: "90%", anchor: "center", margin: 1 } },
    );

    if (decision === "stay") {
      ctx.ui.notify("Staying in plan mode. Continue chatting to revise the plan.", "info");
      return;
    }

    setMode(false, ctx);
    if (decision === "implement") {
      pi.sendUserMessage(implementationPrompt(plan));
      return;
    }

    const id = String(++clearRequestId);
    clearRequests.set(id, plan);
    pi.sendUserMessage(`/plan __apply-clear:${id}`, { expandPromptTemplates: true });
  };

  pi.registerCommand("plan", {
    description: "Create a read-only plan: /plan <request>",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (request.startsWith("__apply-clear:")) {
        const id = request.slice("__apply-clear:".length);
        const approvedPlan = clearRequests.get(id);
        clearRequests.delete(id);
        if (!approvedPlan) {
          ctx.ui.notify("That approved plan is no longer available.", "error");
          return;
        }
        const result = await ctx.newSession({
          withSession: async (fresh) => fresh.sendUserMessage(implementationPrompt(approvedPlan)),
        });
        if (result.cancelled) ctx.ui.notify("Context clearing was cancelled; plan mode remains off.", "warning");
        return;
      }
      if (!request || request === "status") {
        ctx.ui.notify(`${planMode ? "Plan mode is ON." : "Plan mode is OFF."} Usage: /plan <request> | /plan on | /plan off`, "info");
        return;
      }
      if (request === "off") {
        setMode(false, ctx);
        return;
      }
      if (request === "on") {
        setMode(true, ctx);
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current turn to finish before starting a plan.", "warning");
        return;
      }
      setMode(true, ctx);
      pi.sendUserMessage(request);
    },
  });

  pi.registerCommand("plan:status", {
    description: "Show whether plan mode is on",
    handler: async (_args, ctx) => ctx.ui.notify(planMode ? "Plan mode is ON." : "Plan mode is OFF.", "info"),
  });

  pi.on("before_agent_start", async (event) => {
    if (!planMode) return;
    awaitingPlan = true;
    completedPlan = undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_SYSTEM_PROMPT}` };
  });

  pi.on("message_end", async (event) => {
    if (!planMode || !awaitingPlan) return;
    const text = assistantText(event.message);
    if (!text) return;
    completedPlan = extractCompletedPlan(text);
    if (completedPlan && event.message.role === "assistant") {
      return {
        message: {
          ...event.message,
          content: event.message.content.map((part) =>
            part.type === "text" ? { ...part, text: part.text.replaceAll(PLAN_READY_MARKER, "").trimEnd() } : part,
          ),
        },
      };
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!planMode || !awaitingPlan) return;
    awaitingPlan = false;
    const plan = completedPlan;
    completedPlan = undefined;
    if (plan) await showPlan(plan, ctx);
  });

  pi.on("tool_call", async (event) => {
    if (!planMode) return;

    if (event.toolName === "bash") {
      const command = String((event.input as Record<string, unknown>)?.command ?? "");
      if (isReadOnlyBash(command)) return;
      return { block: true, reason: "Plan mode permits only a conservative set of inspection commands. Describe mutations as plan steps." };
    }

    if (event.toolName === "todo") {
      const action = String((event.input as Record<string, unknown>)?.action ?? "");
      if (["list", "next", "review"].includes(action)) return;
      return { block: true, reason: `Plan mode blocks the state-changing todo action "${action}".` };
    }

    if (!READ_ONLY_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Plan mode blocks "${event.toolName}" because it is not proven read-only. Describe the operation as a plan step.`,
      };
    }
  });

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
}
