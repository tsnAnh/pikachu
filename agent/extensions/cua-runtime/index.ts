import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { BrowserBridgeClient } from "./src/browser-client.js";
import { CuaController } from "./src/controller.js";
import { DriverClient } from "./src/driver-client.js";
import { isForegroundAllowed } from "./src/focus-state.js";
import { ActionPolicy, type ConfirmationRequest } from "./src/policy.js";
import { GuestRuntime, type GuestRunResult } from "./src/runtime.js";
import type { HostOutput, JsonValue } from "./src/types.js";

const ReplParams = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 100_000, description: "JavaScript for the persistent sandboxed CUA runtime" }),
  title: Type.Optional(Type.String({ maxLength: 120, description: "Short user-facing description of this computer-use step" })),
}, { additionalProperties: false });

const EmptyParams = Type.Object({}, { additionalProperties: false });

const BrowserGroupParams = Type.Object({
  action: StringEnum(["create", "open", "close"] as const),
  session: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 48 })),
  url: Type.Optional(Type.String()),
}, { additionalProperties: false });

const BrowserPageParams = Type.Object({
  action: StringEnum(["navigate", "back", "snapshot", "click", "fill", "press", "scroll", "screenshot"] as const),
  session: Type.String(),
  tabId: Type.Integer({ minimum: 0 }),
  url: Type.Optional(Type.String()),
  selector: Type.Optional(Type.String({ maxLength: 1000 })),
  value: Type.Optional(Type.String({ maxLength: 4000 })),
  key: Type.Optional(Type.String({ maxLength: 64 })),
  deltaY: Type.Optional(Type.Integer({ minimum: -5000, maximum: 5000 })),
}, { additionalProperties: false });

class RuntimeService {
  private driver = new DriverClient();
  private bridge = new BrowserBridgeClient();
  private controller = new CuaController(this.driver, this.bridge);
  private policy = new ActionPolicy();
  private execution?: { signal?: AbortSignal; ctx: ExtensionContext };
  private guest = this.createGuest();

  async execute(code: string, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<GuestRunResult> {
    this.controller.clearOutput();
    this.execution = { signal, ctx };
    try { return await this.guest.run(code, signal); }
    finally { this.execution = undefined; }
  }

  async invoke(method: string, args: JsonValue[], signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<JsonValue> {
    const actionContext = this.controller.actionContext(method, args);
    const request = this.policy.classify(method, [...args, actionContext]);
    if (request) await this.confirm({ ...request, session: this.driver.session, target: exactTarget(args) }, signal, ctx);
    return this.controller.invoke(method, args, { signal, foregroundAllowed: isForegroundAllowed() });
  }

  async reset(): Promise<void> {
    await this.guest.reset();
    await this.controller.reset();
    this.policy.reset();
    this.recreate();
  }

  async endTurn(): Promise<void> {
    await this.guest.reset();
    await this.controller.endTurn();
    this.policy.reset();
    this.recreate();
  }

  async compatibility(method: "compat.group" | "compat.page", value: JsonValue, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<JsonValue> {
    return this.invoke(method, [value], signal, ctx);
  }

  private recreate(): void {
    this.driver = new DriverClient();
    this.bridge = new BrowserBridgeClient();
    this.controller = new CuaController(this.driver, this.bridge);
    this.guest = this.createGuest();
  }

  private createGuest(): GuestRuntime {
    return new GuestRuntime({
      invoke: async (method, args, guestSignal) => {
        const execution = this.execution;
        if (!execution) throw new Error("CUA host calls are only available during cua_repl_js execution");
        return this.invoke(method, args, guestSignal ?? execution.signal, execution.ctx);
      },
      takeOutput: () => {
        const output: HostOutput = { text: [...this.controller.output.text], images: [...this.controller.output.images] };
        this.controller.clearOutput();
        return output;
      },
    });
  }

  private async confirm(request: ConfirmationRequest, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<void> {
    const message = [
      request.action,
      `Destination: ${request.destination}`,
      request.data ? `Data: ${request.data}` : undefined,
      `Target: ${request.target}`,
    ].filter(Boolean).join("\n");
    const approved = await ctx.ui.confirm(`Confirm ${request.category}`, message, { signal, timeout: 120_000 });
    if (!approved) throw new Error(`User declined ${request.category} action`);
    const receipt = this.policy.issue(request);
    if (!this.policy.consume(receipt, request)) throw new Error("Confirmation receipt expired or did not match this action");
  }
}

export default function cuaRuntime(pi: ExtensionAPI): void {
  const service = new RuntimeService();

  pi.registerTool({
    name: "cua_repl_js",
    label: "Computer Use JavaScript",
    description: "Run persistent asynchronous JavaScript against CUA Driver. Start with exactly one cua.getState(), cua.getTab(), cua.createBrowserTab(), cua.getBrowser(), or cua.getApp() call after a reset. Open Chrome with cua.createBrowserTab('chrome', url, { sessionName }) or cua.createBrowserTab({ url, sessionName }). Uses the logged-in Chrome profile and native macOS apps in background focus-protected mode by default. Use nodeRepl.write() and nodeRepl.emitImage() for output. Handles and accessibility refs are stateful and fail when stale.",
    parameters: ReplParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        if (params.title) ctx.ui.setWorkingMessage(params.title);
        const result = await service.execute(params.code, signal, ctx);
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        for (const text of result.text) content.push({ type: "text", text });
        if (result.result !== null) content.push({ type: "text", text: typeof result.result === "string" ? result.result : JSON.stringify(result.result) });
        for (const image of result.images) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
        if (!content.length) content.push({ type: "text", text: "CUA JavaScript completed." });
        return { content, details: { result: result.result } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `CUA JavaScript failed: ${message}` }], details: { error: message } };
      } finally {
        ctx.ui.setWorkingMessage();
      }
    },
  });

  pi.registerTool({
    name: "cua_repl_reset",
    label: "Reset Computer Use",
    description: "Reset the persistent CUA JavaScript runtime, revoke handles and capabilities, end the CUA Driver session, and close unpreserved agent tabs.",
    parameters: EmptyParams,
    async execute() {
      await service.reset();
      return { content: [{ type: "text" as const, text: "CUA runtime reset; handles and sessions were revoked." }], details: { reset: true } };
    },
  });

  pi.registerTool({
    name: "cua_browser_group",
    label: "Deprecated Browser Group",
    description: "Deprecated compatibility wrapper routed through the CUA runtime. Prefer cua_repl_js and Browser.tabs.",
    parameters: BrowserGroupParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const result = await service.compatibility("compat.group", params as JsonValue, signal, ctx);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Browser compatibility action failed: ${error instanceof Error ? error.message : String(error)}` }], details: undefined };
      }
    },
  });

  pi.registerTool({
    name: "cua_browser_page",
    label: "Deprecated Browser Page",
    description: "Deprecated compatibility wrapper routed through the CUA runtime. Prefer cua_repl_js with Tab.ax, Tab.playwright, Tab.cua, or Tab.dom_cua.",
    parameters: BrowserPageParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const result = await service.compatibility("compat.page", params as JsonValue, signal, ctx);
        const record = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, JsonValue> : {};
        if (record.mimeType === "image/jpeg" && typeof record.data === "string") {
          return { content: [{ type: "text" as const, text: "Background browser screenshot." }, { type: "image" as const, data: record.data, mimeType: record.mimeType }], details: { tabId: params.tabId } };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `Browser compatibility action failed: ${error instanceof Error ? error.message : String(error)}` }], details: undefined };
      }
    },
  });

  let ending: Promise<void> | undefined;
  const endTurn = (): Promise<void> => ending ??= service.endTurn().finally(() => { ending = undefined; });
  // Pi emits turn_end after each model response in a multi-call tool loop.
  // Keep the REPL alive until the complete agent run has finished.
  pi.on("agent_end", endTurn);
  pi.on("session_shutdown", async () => { await service.reset(); });
  pi.on("session_start", async () => { await service.reset(); });

  pi.registerCommand("cua-runtime", {
    description: "Inspect or reset the CUA runtime: /cua-runtime status|reset",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "reset") {
        await service.reset();
        ctx.ui.notify("CUA runtime reset.", "info");
      } else if (action === "status") ctx.ui.notify(`CUA runtime ready; focus protection ${isForegroundAllowed() ? "off" : "on"}.`, "info");
      else ctx.ui.notify("Usage: /cua-runtime status|reset", "warning");
    },
  });
}

function exactTarget(args: JsonValue[]): string {
  const first = args[0];
  if (typeof first === "string") return first.slice(0, 160);
  return JSON.stringify(first ?? null).slice(0, 160);
}
