import assert from "node:assert/strict";
import test from "node:test";
import { CuaController } from "../src/controller.js";

class Driver {
  session = "test-session";
  calls: Array<{ name: string; args: any }> = [];
  async availableTools() { return []; }
  async close() {}
  async call(name: string, args: any = {}) {
    this.calls.push({ name, args });
    if (name === "list_apps") return { data: { apps: [{ name: "Calculator", bundle_id: "com.apple.calculator", pid: 20 }, { name: "Google Chrome", bundle_id: "com.google.Chrome", pid: 30 }] }, text: [], images: [] };
    if (name === "list_windows") return { data: { windows: args.pid === 30 ? [
      { window_id: 300, title: "Exact ta…Exact tab", bounds: { x: 0, y: 0, width: 800, height: 600 } },
      { window_id: 301, title: "Another tab", bounds: { x: 0, y: 0, width: 800, height: 600 } },
    ] : [{ window_id: 200, title: "Calculator", bounds: { x: 0, y: 0, width: 800, height: 600 } }] }, text: [], images: [] };
    if (name === "browser_prepare") return { data: { prepared: true }, text: [], images: [] };
    if (name === "get_browser_state" && args.pid === 30) return { data: { binding_quality: "exact", mutation_allowed: true, target_id: "target", tabs: [{ tab_id: "driver-tab", title: "Exact tab content with Exact tab", url: "https://example.com" }] }, text: [], images: [] };
    if (name === "get_window_state" && args.include_accessibility_tree === false) return { data: { screenshot_frame_valid: true, screenshot_width: 400, screenshot_height: 300, screenshot_scale: 2, window_bounds: { x: 0, y: 0, width: 800, height: 600 } }, text: [], images: [] };
    if (name === "get_window_state") return { data: { snapshot_id: "s12345678", elements: [{ element_index: 0, element_token: "token", label: "Seven" }] }, text: [], images: [] };
    return { data: { ok: true }, text: [], images: [] };
  }
}

class Bridge {
  listener?: (event: any) => void;
  async closeAll() {}
  async closeTurn() {}
  adopt() {}
  onEvent(listener: (event: any) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
  emit(event: any) { this.listener?.(event); }
  async create(): Promise<any> { throw new Error("unused"); }
  async request(action: string, _session?: string, _request?: any): Promise<any> {
    if (action === "begin") return { begun: true };
    if (action === "inventory") return { instanceId: "instance", tabs: [{ id: 8, windowId: 3, title: "Exact tab content with Exact tab", url: "https://example.com", active: false }], windows: [{ id: 3, activeTitle: "Exact tab content with Exact tab", bounds: { x: 0, y: 0, width: 800, height: 600 } }] };
    if (action === "claim") return { claimed: true, windowId: 3 };
    return { ok: true };
  }
}

class Chrome153Driver extends Driver {
  override async call(name: string, args: any = {}) {
    if (name === "get_browser_state" && args.pid === 30) {
      this.calls.push({ name, args });
      throw new Error("Cua Driver refused get_browser_state: browser_route_unavailable: Browser.getWindowForTarget failed: Browser window not found");
    }
    return super.call(name, args);
  }
}

class ChromeReconnectDriver extends Driver {
  override async call(name: string, args: any = {}) {
    if (name === "browser_prepare") {
      this.calls.push({ name, args });
      throw new Error("Cua Driver refused browser_prepare: browser_wrong_target_refused: no exact Chrome remote-debugging consent sheet appeared");
    }
    return super.call(name, args);
  }
}

class Chrome153Bridge extends Bridge {
  actions: string[] = [];
  visible = false;
  override async closeTurn() { this.actions.push("close"); }
  override async create() { return { session: "owned-session", result: { tabId: 8, windowId: 3 } }; }
  override async request(action: string, _session?: string, request: any = {}) {
    this.actions.push(action);
    if (action === "snapshot") return { title: "Fixture", url: "https://example.com", text: "Open post", elements: [{ tag: "a", text: "Open post", selector: "#post" }] };
    if (action === "evaluate") return { result: String(request.source ?? "").includes("navigator.userAgent") ? "Mozilla/5.0 Chrome/153.0.0.0" : { rect: { x: 190, y: 290, width: 20, height: 20 }, innerWidth: 800, innerHeight: 500, devicePixelRatio: 2, visualScale: 1 } };
    if (action === "tab") return { tabId: 8, windowId: 3, active: this.visible, focused: this.visible, visible: this.visible };
    if (["navigate", "click", "close"].includes(action)) return { ok: true, tabId: request.tabId };
    return super.request(action);
  }
}

class LegacyBridge extends Chrome153Bridge {
  override async request(action: string, session?: string, request: any = {}) {
    if (action === "evaluate" && String(request.source ?? "").includes("navigator.userAgent")) {
      this.actions.push(action);
      return { result: "Mozilla/5.0 Chrome/149.0.0.0" };
    }
    return super.request(action, session, request);
  }
}

class IdentityBridge extends Chrome153Bridge {
  identity = "";
  override async create(_label?: string, identity?: string) {
    this.identity = String(identity ?? "");
    return { session: "owned-session", result: { tabId: 8, windowId: 3 } };
  }
  override async request(action: string, session?: string, request: any = {}) {
    if (action === "inventory") return { instanceId: "instance", tabs: [], windows: [{ id: 3, activeTitle: "Active user tab", bounds: { x: 0, y: 0, width: 800, height: 600 } }] };
    return super.request(action, session, request);
  }
}

class IdentityWindowDriver extends Driver {
  constructor(private readonly bridge: IdentityBridge) { super(); }
  override async call(name: string, args: any = {}) {
    if (name === "list_windows" && args.pid === 30) {
      this.calls.push({ name, args });
      return { data: { windows: [
        { window_id: 300, title: this.bridge.identity, bounds: { x: 0, y: 0, width: 800, height: 600 } },
        { window_id: 301, title: "Other same-size window", bounds: { x: 0, y: 0, width: 800, height: 600 } },
      ] }, text: [], images: [] };
    }
    return super.call(name, args);
  }
}

test("claims only exact user tabs and invalidates handles after reset", async () => {
  const driver = new Driver();
  const controller = new CuaController(driver as any, new Bridge() as any);
  const tabs = await controller.invoke("browser.openTabs", [], { foregroundAllowed: false }) as any[];
  const claimed = await controller.invoke("browser.claimTab", [tabs[0]], { foregroundAllowed: false }) as any;
  assert.equal(claimed.owned, false);
  assert.equal(driver.calls.find((call) => call.name === "browser_prepare")?.args.window_id, 300);
  await controller.reset();
  await assert.rejects(controller.invoke("tab.info", [claimed.handle], { foregroundAllowed: false }), /stale/);
});

test("native actions use fresh snapshot identity and protected background delivery", async () => {
  const driver = new Driver();
  const controller = new CuaController(driver as any, new Bridge() as any);
  const app = await controller.invoke("app.get", ["Calculator"], { foregroundAllowed: false }) as any;
  await controller.invoke("app.state", [app.handle, {}], { foregroundAllowed: false });
  await controller.invoke("app.action", [app.handle, "click", { ref: 0 }], { foregroundAllowed: false });
  const click = driver.calls.find((call) => call.name === "click")!;
  assert.deepEqual({ delivery: click.args.delivery_mode, snapshot: click.args.snapshot_id, index: click.args.element_index, window: click.args.window_id }, { delivery: "background", snapshot: "s12345678", index: 0, window: 200 });
  await assert.rejects(controller.invoke("app.action", [app.handle, "click", { ref: 0 }], { foregroundAllowed: false }), /fresh/);
});

test("hides the agent cursor for exact extension clicks in a background tab", async () => {
  const driver = new Chrome153Driver();
  const bridge = new LegacyBridge();
  const controller = new CuaController(driver as any, bridge as any);
  const tab = await controller.invoke("browser.createTab", ["chrome", "https://example.com", {}], { foregroundAllowed: false }) as any;
  const snapshot = await controller.invoke("tab.snapshot", [tab.handle, {}], { foregroundAllowed: false }) as any;
  const clicked = await controller.invoke("tab.ax.click", [tab.handle, snapshot.refs[0].ref], { foregroundAllowed: false }) as any;
  assert.equal(clicked.route, "extension_dom");
  assert.equal(clicked.delivery.mode, "background");
  assert.ok(bridge.actions.includes("navigate"));
  assert.ok(bridge.actions.includes("click"));
  const cursor = driver.calls.find((call) => call.name === "move_cursor");
  assert.equal(cursor, undefined);
  assert.equal([...driver.calls].reverse().find((call) => call.name === "set_agent_cursor_enabled")?.args.enabled, false);
  await controller.endTurn();
});

test("shows the agent cursor and continues when the user opens the controlled tab", async () => {
  const driver = new Chrome153Driver();
  const bridge = new Chrome153Bridge();
  const controller = new CuaController(driver as any, bridge as any);
  const tab = await controller.invoke("browser.createTab", ["chrome", "https://example.com", {}], { foregroundAllowed: false }) as any;
  const snapshot = await controller.invoke("tab.snapshot", [tab.handle, {}], { foregroundAllowed: false }) as any;
  bridge.visible = true;
  bridge.emit({ event: "tabVisibility", session: "owned-session", tabId: 8, windowId: 3, visible: true });
  await new Promise((resolve) => setImmediate(resolve));
  const clicked = await controller.invoke("tab.ax.click", [tab.handle, snapshot.refs[0].ref], { foregroundAllowed: false }) as any;
  assert.equal(clicked.cursorMoved, true);
  assert.equal([...driver.calls].reverse().find((call) => call.name === "set_agent_cursor_enabled")?.args.enabled, true);
  const cursor = [...driver.calls].reverse().find((call) => call.name === "move_cursor");
  assert.deepEqual({ target: cursor?.args.target, x: cursor?.args.x, y: cursor?.args.y }, { target: { kind: "window", pid: 30, window_id: 300 }, x: 100, y: 200 });
  assert.equal(cursor?.args.scope, undefined);
  assert.ok(bridge.actions.includes("click"));
  await controller.endTurn();
});

test("interrupts waits and still permits deterministic turn cleanup", async () => {
  const driver = new Chrome153Driver();
  const bridge = new Chrome153Bridge();
  const controller = new CuaController(driver as any, bridge as any);
  const tab = await controller.invoke("browser.createTab", ["chrome", "https://example.com", {}], { foregroundAllowed: false }) as any;
  const abort = new AbortController();
  const waiting = controller.invoke("tab.wait", [tab.handle, "timeout", { timeoutMs: 30_000 }], { foregroundAllowed: false, signal: abort.signal });
  abort.abort();
  await assert.rejects(waiting, /aborted/);
  await controller.endTurn();
  assert.ok(bridge.actions.includes("close"));
});

test("keeps the exact extension route when Chrome omits CUA reconnect consent UI", async () => {
  const controller = new CuaController(new ChromeReconnectDriver() as any, new LegacyBridge() as any);
  const tab = await controller.invoke("browser.createTab", ["chrome", "https://example.com", {}], { foregroundAllowed: false }) as any;
  assert.equal(tab.owned, true);
  await controller.endTurn();
});

test("selects the extension backend before preparation on Chrome 150 and newer", async () => {
  const driver = new Driver();
  const controller = new CuaController(driver as any, new Chrome153Bridge() as any);
  await controller.invoke("browser.createTab", ["chrome", "https://example.com", {}], { foregroundAllowed: false });
  assert.equal(driver.calls.some((call) => call.name === "browser_prepare"), false);
  await controller.endTurn();
});

test("maps an inactive owned tab when the native window title follows its unique identity", async () => {
  const bridge = new IdentityBridge();
  const driver = new IdentityWindowDriver(bridge);
  const controller = new CuaController(driver as any, bridge as any);
  const tab = await controller.invoke("browser.createTab", ["chrome", "https://example.com", {}], { foregroundAllowed: false }) as any;
  assert.equal(tab.owned, true);
  assert.match(bridge.identity, /^pi-[a-f0-9-]{36}$/);
  await controller.endTurn();
});

test("routes deprecated page wrappers through the v2 action protocol", async () => {
  const bridge = new Chrome153Bridge();
  const controller = new CuaController(new Driver() as any, bridge as any);
  await controller.invoke("compat.page", [{ action: "click", session: "legacy", tabId: 8, selector: "#post" }], { foregroundAllowed: false });
  assert.ok(bridge.actions.includes("click"));
  assert.equal(bridge.actions.includes("page"), false);
});
