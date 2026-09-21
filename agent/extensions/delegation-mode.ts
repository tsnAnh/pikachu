import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveDelegationTools, type DelegationMode } from "./jev-control/src/delegation.js";

interface DelegationState {
  version: 1;
  mode: DelegationMode;
}

const STATE_ENTRY = "pi-cfg-delegation-v1";

function isState(value: unknown): value is DelegationState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DelegationState>;
  return candidate.version === 1 && ["auto", "herdr", "subagents", "both"].includes(candidate.mode ?? "");
}

export default function delegationMode(pi: ExtensionAPI): void {
  let state: DelegationState = { version: 1, mode: "auto" };
  let lastWarning: string | undefined;

  const persist = (): void => pi.appendEntry(STATE_ENTRY, { ...state });

  const reconstruct = (ctx: ExtensionContext): void => {
    state = { version: 1, mode: "auto" };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY && isState(entry.data)) state = { ...entry.data };
    }
  };

  const apply = (ctx: ExtensionContext, notify = false): string[] => {
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    const resolution = resolveDelegationTools(state.mode, available);
    const active = pi.getActiveTools().filter((name) => name !== "herdr" && name !== "subagent");
    pi.setActiveTools([...active, ...resolution.tools]);
    if (resolution.fallback && resolution.fallback !== lastWarning) {
      lastWarning = resolution.fallback;
      ctx.ui.notify(resolution.fallback, "warning");
    } else if (!resolution.fallback) {
      lastWarning = undefined;
    }
    if (notify) {
      ctx.ui.notify(
        resolution.tools.length ? `Delegation ${state.mode}: ${resolution.tools.join(" + ")}` : `Delegation ${state.mode}: no tool available`,
        "info",
      );
    }
    return resolution.tools;
  };

  pi.registerCommand("delegate", {
    description: "Select delegation runtime: /delegate auto|herdr|subagents|both|status",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "status") {
        apply(ctx, true);
        return;
      }
      if (!["auto", "herdr", "subagents", "both"].includes(action)) {
        ctx.ui.notify("Usage: /delegate auto|herdr|subagents|both|status", "warning");
        return;
      }
      state.mode = action as DelegationMode;
      persist();
      apply(ctx, true);
    },
  });

  pi.registerCommand("review", {
    description: "Switch to subagents and start the maintained parallel-review workflow",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the current turn to finish before starting review.", "warning");
        return;
      }
      if (!pi.getAllTools().some((tool) => tool.name === "subagent")) {
        ctx.ui.notify("pi-subagents is unavailable; review was not started.", "error");
        return;
      }
      if (!pi.getCommands().some((command) => command.name === "parallel-review")) {
        ctx.ui.notify("The pi-subagents /parallel-review prompt is unavailable.", "error");
        return;
      }
      state.mode = "subagents";
      persist();
      apply(ctx, true);
      pi.sendUserMessage("/parallel-review", { expandPromptTemplates: true });
    },
  });

  const restore = (ctx: ExtensionContext): void => {
    reconstruct(ctx);
    apply(ctx);
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
}
