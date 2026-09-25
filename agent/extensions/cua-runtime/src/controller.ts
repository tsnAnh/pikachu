import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserBridgeClient } from "./browser-client.js";
import type { DriverClient, DriverResponse } from "./driver-client.js";
import type { BrowserTabInfo, HostOutput, JsonObject, JsonValue } from "./types.js";
import { asNumber, asObject, asString, toJsonValue } from "./types.js";

type CallContext = { signal?: AbortSignal; foregroundAllowed: boolean };
type TabMark = "deliverable" | "handoff";

interface TabRecord {
  handle: string;
  bridgeSession: string;
  chromeTabId: number;
  chromeWindowId: number;
  backend: "cua" | "extension";
  targetId: string;
  driverTabId: string;
  pid: number;
  nativeWindowId: number;
  nativeWindowWidth: number;
  nativeWindowHeight: number;
  generation: number;
  owned: boolean;
  mark?: TabMark;
  lastSnapshot?: JsonObject;
  lastImages: Array<{ data: string; mimeType: string }>;
  cursorX?: number;
  cursorY?: number;
  visible: boolean;
}

interface AppRecord {
  handle: string;
  pid: number;
  name: string;
  bundleId?: string;
  generation: number;
  lastWindowId?: number;
  lastSnapshot?: JsonObject;
}

interface BrowserBinding {
  backend: "cua" | "extension";
  targetId: string;
  tabs: JsonObject[];
  pid: number;
  windowId: number;
  windowWidth: number;
  windowHeight: number;
}

export class CuaController {
  readonly output: HostOutput = { text: [], images: [] };
  private tabs = new Map<string, TabRecord>();
  private apps = new Map<string, AppRecord>();
  private bridgeSession?: string;
  private generation = 1;
  private sessionName = "Pi Browser";
  private cursorUpdates: Promise<void> = Promise.resolve();

  constructor(
    private readonly driver: DriverClient,
    private readonly bridge: BrowserBridgeClient,
  ) {
    this.bridge.onEvent((event) => {
      this.cursorUpdates = this.cursorUpdates.catch(() => {}).then(() => this.handleBridgeEvent(event));
    });
  }

  clearOutput(): void { this.output.text.length = 0; this.output.images.length = 0; }

  actionContext(method: string, args: JsonValue[]): JsonObject {
    try {
      if (method.startsWith("tab.") && typeof args[0] === "string") {
        const tab = this.getTab(args[0]);
        const ref = args[1];
        const refs = Array.isArray(tab.lastSnapshot?.refs) ? tab.lastSnapshot!.refs.map((value) => asObject(value)) : [];
        const item = typeof ref === "number" ? refs[ref] : refs.find((candidate) => candidate.ref === ref);
        return { target: tab.handle, label: String(item?.name ?? item?.label ?? item?.text ?? "") };
      }
      if (method === "app.action" && typeof args[0] === "string") {
        const app = this.getAppRecord(args[0]);
        const options = asOptionalObject(args[2]);
        const elements = Array.isArray(app.lastSnapshot?.elements) ? app.lastSnapshot!.elements.map((value) => asObject(value)) : [];
        const ref = options.ref;
        const item = typeof ref === "number" ? elements.find((candidate) => candidate.element_index === ref) : elements.find((candidate) => candidate.element_token === ref);
        return { target: `${app.name}:${app.lastWindowId ?? "window"}`, label: String(item?.label ?? item?.title ?? item?.value ?? "") };
      }
    } catch { /* Stale state is rejected by the actual action. */ }
    return {};
  }

  async invoke(method: string, args: JsonValue[], context: CallContext): Promise<JsonValue> {
    switch (method) {
      case "state": return this.getState(context);
      case "documentation": return this.documentation(args[0]);
      case "write": this.output.text.push(formatOutput(args[0])); return null;
      case "emitImage": return this.emitImage(args[0]);
      case "browser.list": return this.browserList(context);
      case "browser.get": return this.browserGet(args[0], context);
      case "browser.nameSession": this.sessionName = asString(args[0], "Session name is required").slice(0, 64); return null;
      case "browser.createTab": return this.createTab(args, context);
      case "browser.openMany": return this.openMany(args, context);
      case "browser.tabs": return this.listTabs(context);
      case "browser.selected": return this.selectedTab(context);
      case "browser.tabsContent": return this.tabsContent(args, context);
      case "browser.openTabs": return this.openTabs(context);
      case "browser.claimTab": return this.claimTab(args[0], context);
      case "browser.getTabContext": return this.getTabContext(args[0], context);
      case "browser.history": return this.history();
      case "browser.management": return this.management(args, context);
      case "tab.info": return this.tabInfo(args[0], context);
      case "tab.get": return this.resolveTab(args[0], context);
      case "tab.goto": return this.tabNavigate(args[0], args[1], context);
      case "tab.back": return this.tabBridgeAction(args[0], "back", {}, context);
      case "tab.forward": return this.tabBridgeAction(args[0], "forward", {}, context);
      case "tab.reload": return this.tabBridgeAction(args[0], "reload", {}, context);
      case "tab.close": return this.closeTab(args[0], context);
      case "tab.mark": return this.markTab(args[0], args[1], context);
      case "tab.snapshot": return this.snapshot(args[0], args[1], context);
      case "tab.ax.click": return this.axClick(args, context);
      case "tab.ax.type": return this.axType(args, false, context);
      case "tab.ax.setValue": return this.axType(args, true, context);
      case "tab.ax.pressKey": return this.tabKey(args, context);
      case "tab.ax.scroll": return this.axScroll(args, context);
      case "tab.cua": return this.tabPointer(args, context);
      case "tab.dom": return this.tabDom(args, context);
      case "tab.locator": return this.tabLocator(args, context);
      case "tab.locatorEvaluate": return this.tabEvaluate(args, context, false);
      case "tab.locatorEvaluateAll": return this.tabEvaluate(args, context, true);
      case "tab.evaluate": return this.tabEvaluate(args, context);
      case "tab.wait": return this.tabWait(args, context);
      case "tab.export": return this.tabExport(args, context);
      case "tab.screenshot": return this.screenshot(args[0], args[1], context);
      case "tab.dialog": return this.dialog(args, context);
      case "tab.setInputFiles": return this.setInputFiles(args, context);
      case "tab.download": return this.download(args, context);
      case "tab.logs": return this.tabProperty(args[0], "logs", "logs", asOptionalObject(args[1]), context);
      case "tab.content": return this.tabProperty(args[0], "content", "content", asOptionalObject(args[1]), context);
      case "tab.clipboard": return this.tabBridgeAction(args[0], "clipboard", asOptionalObject(args[1]), context);
      case "apps.list": return this.driverData("list_apps", {}, context);
      case "app.get": return this.getApp(args[0], context);
      case "app.windows": return this.appWindows(args[0], context);
      case "app.state": return this.appState(args, context);
      case "app.action": return this.appAction(args, context);
      case "app.launch": return this.appLaunch(args, context);
      case "app.kill": return this.appKill(args[0], context);
      case "cursor.state": return this.driverData("get_agent_cursor_state", {}, context);
      case "cursor.enabled": return this.driverData("set_agent_cursor_enabled", { enabled: Boolean(args[0]) }, context);
      case "compat.group": return this.compatGroup(args[0], context);
      case "compat.page": return this.compatPage(args[0], context);
      default: throw new Error(`Unsupported CUA API method: ${method}`);
    }
  }

  async reset(): Promise<void> {
    this.generation += 1;
    this.tabs.clear();
    this.apps.clear();
    this.bridgeSession = undefined;
    this.clearOutput();
    await Promise.allSettled([this.bridge.closeAll(), this.driver.close()]);
  }

  async endTurn(): Promise<void> {
    for (const tab of this.tabs.values()) {
      if (!tab.mark && !tab.owned) await this.bridge.request("release", tab.bridgeSession, { tabId: tab.chromeTabId }).catch(() => {});
    }
    this.tabs.clear();
    this.apps.clear();
    this.bridgeSession = undefined;
    this.generation += 1;
    await Promise.allSettled([this.bridge.closeTurn(), this.driver.close()]);
  }

  private async getState(context: CallContext): Promise<JsonValue> {
    const [apps, browsers, tools] = await Promise.all([
      this.driver.call("list_apps", {}, context.signal).then((value) => value.data).catch(() => []),
      this.browserList(context).catch(() => []),
      this.driver.availableTools().catch(() => []),
    ]);
    return toJsonValue({ apps, browsers, tools, focusProtection: context.foregroundAllowed ? "allow" : "protect", session: this.driver.session });
  }

  private emitImage(value: JsonValue | undefined): JsonValue {
    const input = asObject(value, "emitImage requires {data,mimeType}");
    const data = asString(input.data, "Image data is required");
    const mimeType = asString(input.mimeType, "Image MIME type is required");
    if (!/^image\/(png|jpeg|webp)$/.test(mimeType) || data.length > 2_000_000) throw new Error("Unsupported or oversized image");
    this.output.images.push({ data, mimeType });
    return null;
  }

  private async browserList(context: CallContext): Promise<JsonValue> {
    const inventory = await this.inventory(context);
    return [{ id: "chrome", name: "Google Chrome", family: "chrome", type: "extension", profileName: "Current profile", metadata: { extensionInstanceId: inventory.instanceId ?? "pikachu" } }];
  }

  private documentation(value: JsonValue | undefined): JsonValue {
    const name = typeof value === "string" ? value : "browser";
    return `Pi CUA ${name}: observe fresh state before acting; refs expire after navigation or a newer snapshot; focus protection is on by default; consequential actions require confirmation.`;
  }

  private async browserGet(value: JsonValue | undefined, context: CallContext): Promise<JsonValue> {
    const selector = value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
    const requested = typeof value === "string" ? value.toLowerCase() : String(selector.id ?? selector.name ?? "chrome").toLowerCase();
    if (!requested.includes("chrome") && requested !== "iab") throw new Error(`Browser is unavailable: ${requested}`);
    const browsers = await this.browserList(context);
    return (browsers as JsonValue[])[0];
  }

  private async openMany(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    if (!Array.isArray(args[1])) throw new Error("open requires an array of URLs");
    if (args[1].length > 20) throw new Error("A maximum of 20 tabs may be opened at once");
    const result: JsonValue[] = [];
    for (const url of args[1]) result.push(await this.createTab([args[0] ?? "chrome", url, args[2] ?? null], context));
    return result;
  }

  private async ensureBridgeSession(context: CallContext): Promise<string> {
    if (this.bridgeSession) return this.bridgeSession;
    const session = randomUUID();
    await this.bridge.request("begin", session, {}, context.signal);
    this.bridge.adopt(session);
    this.bridgeSession = session;
    return session;
  }

  private async inventory(context: CallContext): Promise<JsonObject> {
    const session = await this.ensureBridgeSession(context);
    return asObject(toJsonValue(await this.bridge.request("inventory", session, {}, context.signal)), "Chrome inventory is malformed");
  }

  private async createTab(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const url = asString(args[1] ?? args[0], "A URL is required");
    assertUrl(url);
    const options = asOptionalObject(args[2]);
    const name = typeof options.sessionName === "string" ? options.sessionName.slice(0, 48) : this.sessionName.slice(0, 48);
    const identity = `pi-${randomUUID()}`;
    const created = await this.bridge.create(name, identity, context.signal);
    const chromeTabId = Number(created.result.tabId);
    const chromeWindowId = Number(created.result.windowId);
    if (!Number.isInteger(chromeTabId) || !Number.isInteger(chromeWindowId)) throw new Error("Chrome bridge did not return an exact tab and window");
    const binding = await this.bindWindow(chromeWindowId, context, await this.requiresExtensionBinding(created.session, chromeTabId, context), identity);
    const match = binding.tabs.filter((tab) => tab.title === identity);
    if (binding.backend === "cua" && match.length !== 1) throw new Error("Could not map the new Chrome tab to one exact CUA tab");
    const driverTabId = binding.backend === "cua" ? asString(match[0].tab_id, "CUA tab identity is missing") : "";
    if (binding.backend === "cua") await this.driver.call("browser_navigate", { target_id: binding.targetId, tab_id: driverTabId, url }, context.signal);
    else await this.bridge.request("navigate", created.session, { tabId: chromeTabId, url }, context.signal);
    const handle = randomUUID();
    const record: TabRecord = {
      handle,
      bridgeSession: created.session,
      chromeTabId,
      chromeWindowId,
      backend: binding.backend,
      targetId: binding.targetId,
      driverTabId,
      pid: binding.pid,
      nativeWindowId: binding.windowId,
      nativeWindowWidth: binding.windowWidth,
      nativeWindowHeight: binding.windowHeight,
      generation: this.generation,
      owned: true,
      lastImages: [],
      visible: false,
    };
    this.tabs.set(handle, record);
    return this.tabDescriptor(record, { url });
  }

  private async listTabs(context: CallContext): Promise<JsonValue> {
    const result: JsonValue[] = [];
    for (const tab of this.tabs.values()) {
      try { result.push(await this.tabInfo(tab.handle, context)); } catch { /* stale Chrome tab omitted */ }
    }
    return result;
  }

  private async selectedTab(context: CallContext): Promise<JsonValue> {
    for (const tab of this.tabs.values()) {
      try {
        const info = asObject(await this.tabInfo(tab.handle, context));
        if (info.active === true) return info;
      } catch { /* stale tab omitted */ }
    }
    return null;
  }

  private async tabsContent(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const options = asObject(args[1], "Tabs.content options are required");
    const urls = Array.isArray(options.urls) ? options.urls : [];
    if (!urls.length || urls.length > 10) throw new Error("Tabs.content requires 1-10 URLs");
    const output: JsonValue[] = [];
    for (const url of urls) {
      const descriptor = asObject(await this.createTab(["chrome", url, {}], context));
      try {
        const content = await this.tabBridgeAction(descriptor.handle, "content", { format: options.format ?? "text", maxChars: options.maxChars ?? 100_000 }, context);
        output.push(toJsonValue({ url, content }));
      } finally { await this.closeTab(descriptor.handle, context).catch(() => {}); }
    }
    return output;
  }

  private async openTabs(context: CallContext): Promise<JsonValue> {
    const inventory = await this.inventory(context);
    const tabs = Array.isArray(inventory.tabs) ? inventory.tabs : [];
    return tabs.map((value) => {
      const tab = asObject(value);
      return { providerTabId: String(tab.id), title: tab.title ?? "", url: tab.url ?? "", windowId: tab.windowId, groupId: tab.groupId, active: tab.active, lastOpened: tab.lastAccessed ?? 0 };
    });
  }

  private async claimTab(value: JsonValue | undefined, context: CallContext): Promise<JsonValue> {
    const expected = asObject(value, "claimTab requires a current openTabs result");
    const tabId = Number(expected.providerTabId ?? expected.id);
    if (!Number.isInteger(tabId)) throw new Error("claimTab requires an exact provider tab id");
    const session = await this.ensureBridgeSession(context);
    const claimed = await this.bridge.request("claim", session, {
      tabId,
      title: String(expected.title ?? ""),
      url: String(expected.url ?? ""),
      windowId: Number(expected.windowId),
    }, context.signal);
    const chromeWindowId = Number(claimed.windowId);
    const binding = await this.bindWindow(chromeWindowId, context, await this.requiresExtensionBinding(session, tabId, context));
    const matches = binding.tabs.filter((tab) => tab.title === expected.title && tab.url === expected.url);
    if (binding.backend === "cua" && matches.length !== 1) {
      await this.bridge.request("release", session, { tabId }, context.signal).catch(() => {});
      throw new Error("The user tab is no longer uniquely identifiable");
    }
    const handle = randomUUID();
    const record: TabRecord = {
      handle,
      bridgeSession: session,
      chromeTabId: tabId,
      chromeWindowId,
      backend: binding.backend,
      targetId: binding.targetId,
      driverTabId: binding.backend === "cua" ? asString(matches[0].tab_id) : "",
      pid: binding.pid,
      nativeWindowId: binding.windowId,
      nativeWindowWidth: binding.windowWidth,
      nativeWindowHeight: binding.windowHeight,
      generation: this.generation,
      owned: false,
      lastImages: [],
      visible: expected.active === true,
    };
    this.tabs.set(handle, record);
    return this.tabDescriptor(record, { title: expected.title, url: expected.url });
  }

  private async getTabContext(value: JsonValue | undefined, context: CallContext): Promise<JsonValue> {
    const expected = asObject(value, "getTabContext requires a current openTabs result");
    const tabId = Number(expected.providerTabId ?? expected.id);
    const session = await this.ensureBridgeSession(context);
    const result = await this.bridge.request("context", session, { tabId, title: expected.title, url: expected.url, windowId: expected.windowId }, context.signal);
    return toJsonValue(result);
  }

  private history(): never { throw new Error("Browser history access is disabled by policy"); }

  private async management(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const namespace = asString(args[0]);
    const method = asString(args[1]);
    const parameters = Array.isArray(args[2]) ? args[2] : [];
    const session = await this.ensureBridgeSession(context);
    return toJsonValue(await this.bridge.request("management", session, { namespace, method, args: parameters }, context.signal));
  }

  private async requiresExtensionBinding(session: string, tabId: number, context: CallContext): Promise<boolean> {
    try {
      const response = asObject(toJsonValue(await this.bridge.request("evaluate", session, {
        tabId,
        source: "function(){return navigator.userAgent;}",
        arg: null,
      }, context.signal)));
      const userAgent = typeof response.result === "string" ? response.result : "";
      const major = Number(userAgent.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1] ?? 0);
      return major >= 150;
    } catch { return false; }
  }

  private async bindWindow(chromeWindowId: number, context: CallContext, preferExtension = false, expectedTabTitle?: string): Promise<BrowserBinding> {
    const inventory = await this.inventory(context);
    const windows = Array.isArray(inventory.windows) ? inventory.windows.map((value) => asObject(value)) : [];
    const chromeWindow = windows.find((window) => window.id === chromeWindowId);
    if (!chromeWindow) throw new Error("Chrome window is no longer available");
    const apps = asRecordArray((await this.driver.call("list_apps", {}, context.signal)).data, "apps");
    const chrome = apps.find((app) => /google chrome/i.test(String(app.name ?? app.display_name ?? "")) || app.bundle_id === "com.google.Chrome");
    if (!chrome) throw new Error("Google Chrome is not running");
    const pid = Number(chrome.pid);
    if (!Number.isInteger(pid)) throw new Error("Chrome process identity is unavailable");
    const nativeWindows = asRecordArray((await this.driver.call("list_windows", { pid }, context.signal)).data, "windows");
    const bounds = asOptionalObject(chromeWindow.bounds);
    const titleProofs = [expectedTabTitle, String(chromeWindow.activeTitle ?? "")].filter((value): value is string => Boolean(value));
    const geometryCandidates = nativeWindows.filter((window) => {
      const wb = asOptionalObject(window.bounds);
      return bounds && wb && ["x", "y", "width", "height"].every((key) => Math.abs(Number(bounds[key]) - Number(wb[key])) <= 8);
    });
    const titleCandidates = titleProofs.length ? nativeWindows.filter((window) => titleProofs.some((title) => chromeWindowTitleMatches(title, String(window.title ?? "")))) : [];
    const titledGeometryCandidates = titleCandidates.filter((window) => geometryCandidates.includes(window));
    const candidates = titledGeometryCandidates.length === 1
      ? titledGeometryCandidates
      : geometryCandidates.length === 1
        ? geometryCandidates
        : titleCandidates;
    if (candidates.length !== 1) throw new Error("Chrome native window mapping is ambiguous");
    const windowId = Number(candidates[0].window_id);
    const nativeBounds = asOptionalObject(candidates[0].bounds);
    const windowWidth = Math.max(200, Number(nativeBounds.width ?? bounds.width ?? 1200));
    const windowHeight = Math.max(200, Number(nativeBounds.height ?? bounds.height ?? 800));
    if (preferExtension) return { backend: "extension", targetId: "", tabs: [], pid, windowId, windowWidth, windowHeight };
    try {
      await this.driver.call("browser_prepare", { pid, window_id: windowId, strategy: { kind: "existing_profile" } }, context.signal);
    } catch (error) {
      if (error instanceof Error && /browser_wrong_target_refused.*(?:remote-debugging|setup accessibility proof|fixed URL)/i.test(error.message)) {
        return { backend: "extension", targetId: "", tabs: [], pid, windowId, windowWidth, windowHeight };
      }
      throw error;
    }
    let bound: JsonObject;
    try {
      bound = asObject((await this.driver.call("get_browser_state", { pid, window_id: windowId }, context.signal)).data);
    } catch (error) {
      if (error instanceof Error && /browser_route_unavailable.*Browser\.getWindowForTarget.*Browser window not found/i.test(error.message)) {
        return { backend: "extension", targetId: "", tabs: [], pid, windowId, windowWidth, windowHeight };
      }
      throw error;
    }
    if (bound.binding_quality !== "exact" || bound.mutation_allowed !== true) throw new Error("CUA could not prove an exact Chrome binding");
    return { backend: "cua", targetId: asString(bound.target_id), tabs: Array.isArray(bound.tabs) ? bound.tabs.map((value) => asObject(value)) : [], pid, windowId, windowWidth, windowHeight };
  }

  private getTab(value: JsonValue | undefined): TabRecord {
    const handle = typeof value === "string" ? value : asString(asObject(value).handle);
    const tab = this.tabs.get(handle);
    if (!tab || tab.generation !== this.generation) throw new Error("Tab handle is stale or unavailable");
    return tab;
  }

  private async resolveTab(value: JsonValue | undefined, context: CallContext): Promise<JsonValue> {
    if (typeof value === "string" && this.tabs.has(value)) return this.tabDescriptor(this.getTab(value));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as JsonObject;
      if (typeof record.handle === "string" && this.tabs.has(record.handle)) return this.tabDescriptor(this.getTab(record.handle));
      return this.claimTab(value, context);
    }
    throw new Error("getTab requires a current tab descriptor or handle");
  }

  private tabDescriptor(tab: TabRecord, extra: Record<string, unknown> = {}): JsonValue {
    return toJsonValue({ handle: tab.handle, id: tab.handle, browserId: "chrome", owned: tab.owned, ...extra });
  }

  private async tabInfo(handle: JsonValue | undefined, context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(handle);
    const result = await this.bridge.request("tab", tab.bridgeSession, { tabId: tab.chromeTabId }, context.signal);
    return this.tabDescriptor(tab, result);
  }

  private async tabNavigate(handle: JsonValue | undefined, urlValue: JsonValue | undefined, context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(handle);
    const url = asString(urlValue, "A URL is required");
    assertUrl(url);
    if (tab.backend === "extension") return this.tabBridgeAction(tab.handle, "navigate", { url }, context);
    const result = await this.driver.call("browser_navigate", { target_id: tab.targetId!, tab_id: tab.driverTabId!, url }, context.signal);
    tab.lastSnapshot = undefined;
    return result.data;
  }

  private async tabBridgeAction(handle: JsonValue | undefined, action: string, extra: JsonObject, context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(handle);
    const result = await this.bridge.request(action, tab.bridgeSession, { tabId: tab.chromeTabId, ...extra }, context.signal);
    tab.lastSnapshot = undefined;
    return toJsonValue(result);
  }

  private async closeTab(handle: JsonValue | undefined, context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(handle);
    if (tab.owned) await this.bridge.request("closeTab", tab.bridgeSession, { tabId: tab.chromeTabId }, context.signal);
    else await this.bridge.request("release", tab.bridgeSession, { tabId: tab.chromeTabId }, context.signal);
    this.tabs.delete(tab.handle);
    return null;
  }

  private async markTab(handle: JsonValue | undefined, markValue: JsonValue | undefined, context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(handle);
    if (!tab.owned) return null;
    const mark = asString(markValue) as TabMark;
    if (mark !== "deliverable" && mark !== "handoff") throw new Error("Unknown tab mark");
    await this.bridge.request("mark", tab.bridgeSession, { tabId: tab.chromeTabId, mark }, context.signal);
    tab.mark = mark;
    return null;
  }

  private async snapshot(handle: JsonValue | undefined, optionsValue: JsonValue | undefined, context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(handle);
    const options = asOptionalObject(optionsValue);
    if (tab.backend === "extension") {
      const raw = asObject(toJsonValue(await this.bridge.request("snapshot", tab.bridgeSession, { tabId: tab.chromeTabId }, context.signal)));
      const snapshotId = `extension-${randomUUID()}`;
      const elements = Array.isArray(raw.elements) ? raw.elements.map((value) => asObject(value)) : [];
      const refs = elements.map((element, index) => ({
        ...element,
        ref: `${snapshotId}:${index}`,
        name: element.label ?? element.text ?? "",
        role: element.role ?? (element.tag === "a" ? "link" : element.tag === "button" ? "button" : element.tag ?? "element"),
        actions: element.inputType ? ["click", "type"] : ["click"],
      }));
      const value = toJsonValue({ snapshot: { id: snapshotId, backend: "extension" }, refs, title: raw.title, url: raw.url, text: raw.text, truncated: raw.truncated });
      tab.lastSnapshot = asObject(value);
      return value;
    }
    const input: JsonObject = { target_id: tab.targetId, tab_id: tab.driverTabId, snapshot_format: "semantic_v2" };
    if (typeof options.query === "string") input.query = options.query;
    if (typeof options.scopeRef === "string") input.scope_ref = options.scopeRef;
    if (typeof options.continuation === "string") input.continuation = options.continuation;
    if (options.includeScreenshot === true) input.include_screenshot = true;
    const response = await this.driver.call("get_browser_state", input, context.signal);
    const value = asObject(response.data, "Browser snapshot is malformed");
    tab.lastSnapshot = value;
    tab.lastImages = response.images;
    if (response.images.length) this.output.images.push(...response.images);
    return value;
  }

  private currentRef(tab: TabRecord, value: JsonValue | undefined): string {
    const ref = typeof value === "number" ? this.refForIndex(tab, value) : asString(value, "A fresh element ref is required");
    const snapshotId = asObject(tab.lastSnapshot?.snapshot, "Take a fresh accessibility snapshot first").id;
    if (typeof snapshotId !== "string" || !ref.startsWith(`${snapshotId}:`)) throw new Error("Element ref is stale; take a fresh snapshot");
    return ref;
  }

  private refEntry(tab: TabRecord, ref: string): JsonObject {
    const refs = Array.isArray(tab.lastSnapshot?.refs) ? tab.lastSnapshot!.refs.map((value) => asObject(value)) : [];
    const entry = refs.find((candidate) => candidate.ref === ref);
    if (!entry) throw new Error("Element ref is stale; take a fresh snapshot");
    return entry;
  }

  private async extensionCursorPoint(tab: TabRecord, selector: string, context: CallContext): Promise<{ x: number; y: number }> {
    const evaluated = asObject(toJsonValue(await this.bridge.request("evaluate", tab.bridgeSession, {
      tabId: tab.chromeTabId,
      source: "function(arg){const node=document.querySelector(arg.selector);if(!node)return null;const r=node.getBoundingClientRect();return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},innerWidth,innerHeight,devicePixelRatio,visualScale:visualViewport?.scale||1};}",
      arg: { selector },
    }, context.signal)));
    const metrics = asObject(evaluated.result, "The browser element geometry is unavailable");
    const rect = asObject(metrics.rect, "The browser element rectangle is unavailable");
    const capture = asObject((await this.driver.call("get_window_state", {
      pid: tab.pid,
      window_id: tab.nativeWindowId,
      include_accessibility_tree: false,
      max_dimension: 1024,
    }, context.signal)).data, "The browser window capture geometry is unavailable");
    if (capture.screenshot_frame_valid !== true) throw new Error("The browser window screenshot frame is unverified");
    const bounds = asObject(capture.window_bounds, "The browser window bounds are unavailable");
    const windowWidth = requiredPositive(bounds.width, "browser window width");
    const windowHeight = requiredPositive(bounds.height, "browser window height");
    const screenshotWidth = requiredPositive(capture.screenshot_width, "browser screenshot width");
    const screenshotHeight = requiredPositive(capture.screenshot_height, "browser screenshot height");
    const backingScale = requiredPositive(capture.screenshot_scale, "browser screenshot scale");
    const deviceScale = requiredPositive(metrics.devicePixelRatio, "browser device scale");
    const visualScale = requiredPositive(metrics.visualScale, "browser visual scale");
    const cssToWindow = deviceScale / backingScale / visualScale;
    const viewportWidth = requiredPositive(metrics.innerWidth, "browser viewport width") * cssToWindow;
    const viewportHeight = requiredPositive(metrics.innerHeight, "browser viewport height") * cssToWindow;
    const contentInsetX = Math.max(0, (windowWidth - viewportWidth) / 2);
    const contentInsetY = Math.max(0, windowHeight - viewportHeight);
    const windowX = contentInsetX + (asNumber(rect.x) + requiredPositive(rect.width, "element width") / 2) * cssToWindow;
    const windowY = contentInsetY + (asNumber(rect.y) + requiredPositive(rect.height, "element height") / 2) * cssToWindow;
    const x = windowX * screenshotWidth / windowWidth;
    const y = windowY * screenshotHeight / windowHeight;
    tab.cursorX = x;
    tab.cursorY = y;
    return { x, y };
  }

  private async syncExtensionCursor(tab: TabRecord, selector: string, context: CallContext): Promise<boolean> {
    try {
      if (!await this.syncTabCursorVisibility(tab, context)) return false;
      const point = await this.extensionCursorPoint(tab, selector, context);
      await this.driver.call("move_cursor", {
        target: { kind: "window", pid: tab.pid, window_id: tab.nativeWindowId },
        x: point.x,
        y: point.y,
      }, context.signal);
      return true;
    } catch {
      await this.driver.call("set_agent_cursor_enabled", { enabled: false }, context.signal).catch(() => {});
      return false;
    }
  }

  private async syncTabCursorVisibility(tab: TabRecord, context: CallContext): Promise<boolean> {
    const presentation = asObject(toJsonValue(await this.bridge.request("tab", tab.bridgeSession, { tabId: tab.chromeTabId }, context.signal)));
    tab.visible = presentation.visible === true;
    await this.driver.call("set_agent_cursor_enabled", { enabled: tab.visible }, context.signal);
    return tab.visible;
  }

  private async handleBridgeEvent(event: JsonObject): Promise<void> {
    if (event.event !== "tabVisibility" || typeof event.session !== "string" || typeof event.tabId !== "number" || typeof event.visible !== "boolean") return;
    const tab = [...this.tabs.values()].find((candidate) => candidate.bridgeSession === event.session && candidate.chromeTabId === event.tabId);
    if (!tab || tab.generation !== this.generation) return;
    tab.visible = event.visible;
    const visibleTab = [...this.tabs.values()].find((candidate) => candidate.visible && candidate.generation === this.generation);
    await this.driver.call("set_agent_cursor_enabled", { enabled: Boolean(visibleTab) }).catch(() => {});
    if (!visibleTab) return;
    await this.driver.call("move_cursor", {
      target: { kind: "window", pid: visibleTab.pid, window_id: visibleTab.nativeWindowId },
      x: visibleTab.cursorX ?? Math.round(visibleTab.nativeWindowWidth / 2),
      y: visibleTab.cursorY ?? Math.round(visibleTab.nativeWindowHeight / 2),
    }).catch(() => {});
  }

  private refForIndex(tab: TabRecord, index: number): string {
    const refs = Array.isArray(tab.lastSnapshot?.refs) ? tab.lastSnapshot!.refs.map((value) => asObject(value)) : [];
    const entry = refs[index];
    if (!entry) throw new Error("Accessibility element index is unavailable");
    return asString(entry.ref);
  }

  private async axClick(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(args[0]);
    const ref = this.currentRef(tab, args[1]);
    if (tab.backend === "extension") {
      const entry = this.refEntry(tab, ref);
      const selector = asString(entry.selector, "The extension element selector is unavailable");
      const cursorMoved = await this.syncExtensionCursor(tab, selector, context);
      const result = await this.bridge.request("click", tab.bridgeSession, { tabId: tab.chromeTabId, selector }, context.signal);
      tab.lastSnapshot = undefined;
      return toJsonValue({ ...result, delivery: { mode: "background" }, route: "extension_dom", cursorMoved });
    }
    await this.syncTabCursorVisibility(tab, context);
    const result = await this.driver.call("browser_click", {
      target_id: tab.targetId,
      tab_id: tab.driverTabId,
      ref,
      input_route: context.foregroundAllowed ? "trusted" : "dom_event",
    }, context.signal);
    tab.lastSnapshot = undefined;
    return result.data;
  }

  private async axType(args: JsonValue[], replace: boolean, context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(args[0]);
    const ref = this.currentRef(tab, args[1]);
    const text = typeof args[2] === "string" ? args[2] : (() => { throw new Error("Text is required"); })();
    if (tab.backend === "extension") {
      const selector = asString(this.refEntry(tab, ref).selector, "The extension element selector is unavailable");
      await this.syncExtensionCursor(tab, selector, context);
      const result = await this.bridge.request("fill", tab.bridgeSession, { tabId: tab.chromeTabId, selector, value: replace ? text : text }, context.signal);
      tab.lastSnapshot = undefined;
      return toJsonValue({ ...result, delivery: { mode: "background" }, route: "extension_dom" });
    }
    const result = await this.driver.call("browser_type", { target_id: tab.targetId, tab_id: tab.driverTabId, ref, text, replace }, context.signal);
    tab.lastSnapshot = undefined;
    return result.data;
  }

  private async tabKey(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(args[0]);
    const key = asString(args[2] ?? args[1], "Key is required");
    return this.tabBridgeAction(tab.handle, "key", { key }, context);
  }

  private async axScroll(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(args[0]);
    const target = args[1];
    const direction = asString(args[2], "Scroll direction is required");
    const pages = typeof args[3] === "number" ? args[3] : 1;
    if (tab.backend === "extension") {
      const selector = typeof target === "number" || typeof target === "string" ? asString(this.refEntry(tab, this.currentRef(tab, target)).selector) : undefined;
      const result = await this.bridge.request("scroll", tab.bridgeSession, { tabId: tab.chromeTabId, deltaY: (direction === "up" ? -1 : 1) * 700 * pages, ...(selector ? { selector } : {}) }, context.signal);
      tab.lastSnapshot = undefined;
      return toJsonValue({ ...result, delivery: { mode: "background" }, route: "extension_dom" });
    }
    const input: JsonObject = { target_id: tab.targetId, tab_id: tab.driverTabId, action: "scroll", delta_x: 0, delta_y: (direction === "up" ? -1 : 1) * 700 * pages };
    if (typeof target === "number" || typeof target === "string") input.ref = this.currentRef(tab, target);
    else if (Array.isArray(target) && target.length === 2) { input.x = Number(target[0]); input.y = Number(target[1]); }
    else throw new Error("Scroll target must be an element or [x,y]");
    const result = await this.driver.call("browser_pointer", input, context.signal);
    tab.lastSnapshot = undefined;
    return result.data;
  }

  private async tabPointer(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(args[0]);
    const action = asString(args[1]);
    const options = asOptionalObject(args[2]);
    if (action === "click") {
      await this.syncTabCursorVisibility(tab, context);
      const result = await this.driver.call("browser_click", { target_id: tab.targetId, tab_id: tab.driverTabId, ...options, input_route: context.foregroundAllowed ? "trusted" : "dom_event" }, context.signal);
      tab.lastSnapshot = undefined;
      return result.data;
    }
    if (action === "type") return this.tabBridgeAction(tab.handle, "typeText", { text: options.text }, context);
    if (action === "keypress") return this.tabBridgeAction(tab.handle, "key", { key: options.keys ?? options.key }, context);
    const normalized: JsonObject = { ...options };
    let driverAction = action === "move" ? "hover" : action;
    if (action === "drag" && Array.isArray(options.from) && Array.isArray(options.to)) {
      normalized.x = Number(options.from[0]); normalized.y = Number(options.from[1]); normalized.to_x = Number(options.to[0]); normalized.to_y = Number(options.to[1]); delete normalized.from; delete normalized.to;
    }
    if (action === "scroll") {
      normalized.delta_x = Number(options.delta_x ?? options.deltaX ?? 0); normalized.delta_y = Number(options.delta_y ?? options.deltaY ?? 0);
      delete normalized.deltaX; delete normalized.deltaY;
    }
    const result = await this.driver.call("browser_pointer", { target_id: tab.targetId, tab_id: tab.driverTabId, action: driverAction, ...normalized, input_route: context.foregroundAllowed ? "trusted" : "dom_event" }, context.signal);
    tab.lastSnapshot = undefined;
    return result.data;
  }

  private async tabDom(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(args[0]);
    const action = asString(args[1]);
    const options = asOptionalObject(args[2]);
    if (action === "get_visible_dom") return this.tabBridgeAction(tab.handle, "snapshot", {}, context);
    if (action === "click" || action === "double_click") {
      const selector = options.selector ?? options.node_id;
      if (typeof selector !== "string") throw new Error("DOM click requires a fresh node id");
      if (tab.backend === "extension") await this.syncExtensionCursor(tab, selector, context);
      return this.tabBridgeAction(tab.handle, action === "click" ? "click" : "locator", action === "click" ? { selector } : { locator: { kind: "css", value: selector }, operation: "dblclick", args: [] }, context);
    }
    if (action === "type") return this.tabBridgeAction(tab.handle, "fill", { selector: options.selector ?? options.node_id, value: options.text ?? "" }, context);
    if (action === "keypress") return this.tabBridgeAction(tab.handle, "key", { key: options.key }, context);
    if (action === "scroll") return this.tabBridgeAction(tab.handle, "scroll", { deltaY: Number(options.deltaY ?? 0), selector: options.selector }, context);
    throw new Error(`Unsupported DOM action: ${action}`);
  }

  private async tabLocator(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(args[0]);
    const locator = asObject(args[1], "Locator descriptor is required");
    const operation = asString(args[2]);
    const operationArgs = Array.isArray(args[3]) ? args[3] : [];
    if (tab.backend === "extension" && ["click", "dblclick"].includes(operation) && locator.kind === "css" && typeof locator.value === "string") {
      await this.syncExtensionCursor(tab, locator.value, context);
    }
    return this.tabProperty(tab.handle, "locator", "result", { operation, locator, args: operationArgs }, context);
  }

  private async tabEvaluate(args: JsonValue[], context: CallContext, all = false): Promise<JsonValue> {
    const tab = this.getTab(args[0]);
    if (typeof args[1] === "object" && args[1] !== null && !Array.isArray(args[1])) {
      return this.tabProperty(tab.handle, "evaluate", "result", { locator: args[1], source: args[2], arg: args[3], all }, context);
    }
    return this.tabProperty(tab.handle, "evaluate", "result", { source: args[1], arg: args[2], all: false }, context);
  }

  private async tabProperty(handle: JsonValue | undefined, action: string, property: string, extra: JsonObject, context: CallContext): Promise<JsonValue> {
    const value = asObject(await this.tabBridgeAction(handle, action, extra, context));
    return value[property] ?? null;
  }

  private async tabWait(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(args[0]);
    const kind = asString(args[1]);
    const options = asOptionalObject(args[2]);
    const timeoutMs = Math.max(0, Math.min(Number(options.timeoutMs ?? 10_000), 30_000));
    if (kind === "timeout") { await abortableDelay(timeoutMs, context.signal); return null; }
    const until = Date.now() + timeoutMs;
    while (Date.now() <= until) {
      if (context.signal?.aborted) throw new Error("CUA operation aborted");
      const info = asObject(await this.tabInfo(tab.handle, context));
      if (kind === "load" && info.status === "complete") return null;
      if (kind === "url" && typeof options.url === "string" && String(info.url).includes(options.url)) return null;
      await abortableDelay(100, context.signal);
    }
    throw new Error(`Timed out waiting for tab ${kind}`);
  }

  private async tabExport(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(args[0]);
    const format = asString(args[1]);
    if (!["html", "md", "youtube-transcript"].includes(format)) throw new Error(`Export format is unavailable: ${format}`);
    const value = asObject(await this.tabBridgeAction(tab.handle, "content", { format: format === "html" ? "html" : "text", maxChars: 500_000 }, context));
    const directory = join(homedir(), ".pi", "agent", "assets");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `browser-${randomUUID()}.${format === "html" ? "html" : "txt"}`);
    await writeFile(path, String(value.content ?? ""), { mode: 0o600 });
    return path;
  }

  private async screenshot(handle: JsonValue | undefined, _options: JsonValue | undefined, context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(handle);
    if (tab.backend === "extension") {
      const image = asObject(toJsonValue(await this.bridge.request("screenshot", tab.bridgeSession, { tabId: tab.chromeTabId }, context.signal)));
      const data = asString(image.data, "Chrome extension did not return a screenshot");
      const mimeType = asString(image.mimeType, "Chrome extension screenshot MIME type is missing");
      this.output.images.push({ data, mimeType });
      tab.lastImages = [{ data, mimeType }];
      return { data, mimeType };
    }
    const response = await this.driver.call("get_browser_state", { target_id: tab.targetId, tab_id: tab.driverTabId, snapshot_format: "semantic_v2", include_screenshot: true }, context.signal);
    if (!response.images.length) throw new Error("CUA did not return a browser screenshot");
    this.output.images.push(...response.images);
    tab.lastImages = response.images;
    return { data: response.images[0].data, mimeType: response.images[0].mimeType };
  }

  private async dialog(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(args[0]);
    if (tab.backend === "extension") throw new Error("Page dialogs require a CUA exact browser binding, which Chrome 153 does not currently expose");
    const action = asString(args[1], "Dialog action is required");
    const options: JsonObject = { action, ...(typeof args[2] === "string" ? { prompt_text: args[2] } : {}) };
    const response = await this.driver.call("browser_dialog", { target_id: tab.targetId, tab_id: tab.driverTabId, ...options, delivery_mode: context.foregroundAllowed ? "foreground" : "background" }, context.signal);
    return response.data;
  }

  private async setInputFiles(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(args[0]);
    if (tab.backend === "extension") throw new Error("File uploads require a CUA exact browser binding, which Chrome 153 does not currently expose");
    const ref = this.currentRef(tab, args[1]);
    if (!Array.isArray(args[2]) || args[2].some((value) => typeof value !== "string")) throw new Error("Files must be absolute path strings");
    return (await this.driver.call("browser_set_input_files", { target_id: tab.targetId, tab_id: tab.driverTabId, ref, files: args[2] }, context.signal)).data;
  }

  private async download(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const tab = this.getTab(args[0]);
    if (tab.backend === "extension") throw new Error("Downloads require a CUA exact browser binding, which Chrome 153 does not currently expose");
    const ref = this.currentRef(tab, args[1]);
    const destinationRoot = asString(args[2], "Approved destination directory is required");
    return (await this.driver.call("browser_download", { target_id: tab.targetId, tab_id: tab.driverTabId, ref, destination_root: destinationRoot }, context.signal)).data;
  }

  private async getApp(value: JsonValue | undefined, context: CallContext): Promise<JsonValue> {
    const query = asString(value, "App name is required");
    const apps = asRecordArray((await this.driver.call("list_apps", {}, context.signal)).data, "apps");
    const lower = query.toLowerCase();
    const matches = apps.filter((app) => [app.name, app.display_name, app.bundle_id, app.path].some((item) => typeof item === "string" && item.toLowerCase() === lower));
    const app = matches.length === 1 ? matches[0] : apps.find((candidate) => String(candidate.name ?? candidate.display_name ?? "").toLowerCase().includes(lower));
    if (!app) throw new Error(`App is unavailable: ${query}`);
    const handle = randomUUID();
    const record: AppRecord = { handle, pid: Number(app.pid ?? 0), name: String(app.name ?? app.display_name ?? query), bundleId: typeof app.bundle_id === "string" ? app.bundle_id : undefined, generation: this.generation };
    this.apps.set(handle, record);
    return toJsonValue({ handle, name: record.name, pid: record.pid, bundleId: record.bundleId, running: record.pid > 0 });
  }

  private getAppRecord(value: JsonValue | undefined): AppRecord {
    const handle = typeof value === "string" ? value : asString(asObject(value).handle);
    const app = this.apps.get(handle);
    if (!app || app.generation !== this.generation) throw new Error("App handle is stale or unavailable");
    return app;
  }

  private async appWindows(value: JsonValue | undefined, context: CallContext): Promise<JsonValue> {
    const app = this.getAppRecord(value);
    if (!app.pid) throw new Error("App is not running");
    const windows = asRecordArray((await this.driver.call("list_windows", { pid: app.pid }, context.signal)).data, "windows");
    return toJsonValue(windows.map((window) => ({ ...window, appHandle: app.handle, generation: app.generation })));
  }

  private async appState(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const app = this.getAppRecord(args[0]);
    const options = asOptionalObject(args[1]);
    const requestedWindow = Number(options.windowId ?? options.window_id);
    let windowId = Number.isInteger(requestedWindow) ? requestedWindow : undefined;
    if (!windowId) {
      const windows = asRecordArray((await this.driver.call("list_windows", { pid: app.pid }, context.signal)).data, "windows");
      if (windows.length !== 1) throw new Error("Select one exact app window before observing state");
      windowId = Number(windows[0].window_id);
    }
    const response = await this.driver.call("get_window_state", { pid: app.pid, window_id: windowId, include_accessibility_tree: options.includeAccessibilityTree !== false }, context.signal);
    const state = asObject(response.data, "Native app state is malformed");
    app.lastWindowId = windowId;
    app.lastSnapshot = state;
    if (response.images.length) this.output.images.push(...response.images);
    return state;
  }

  private async appAction(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const app = this.getAppRecord(args[0]);
    const requested = asString(args[1]);
    const aliases: Record<string, string> = { doubleClick: "double_click", rightClick: "right_click", typeText: "type_text", pressKey: "press_key", setValue: "set_value", menu: "invoke_menu", pointerClick: "click", pointerDoubleClick: "double_click", pointerScroll: "scroll" };
    const tool = aliases[requested] ?? requested;
    const options = { ...asOptionalObject(args[2]) };
    const allowed = new Set(["click", "double_click", "right_click", "drag", "type_text", "press_key", "hotkey", "scroll", "set_value", "invoke_menu", "set_window_frame", "verify_state", "zoom"]);
    if (!allowed.has(tool)) throw new Error(`Native action is unavailable: ${tool}`);
    if (!app.lastWindowId && !Number.isInteger(Number(options.window_id ?? options.windowId))) throw new Error("Observe one exact app window before acting");
    const windowId = Number(options.window_id ?? options.windowId ?? app.lastWindowId);
    delete options.windowId;
    const ref = options.ref;
    delete options.ref;
    const input: JsonObject = { pid: app.pid, window_id: windowId, ...options };
    if (ref !== undefined) this.applyNativeRef(app, ref, input);
    if (tool === "drag") {
      const from = Array.isArray(input.from) ? input.from : [];
      const to = Array.isArray(input.to) ? input.to : [];
      delete input.from; delete input.to;
      if (from.length !== 2 || to.length !== 2) throw new Error("Drag requires from and to coordinate pairs");
      [input.from_x, input.from_y, input.to_x, input.to_y] = [Number(from[0]), Number(from[1]), Number(to[0]), Number(to[1])];
    }
    if (requested === "pointerScroll") {
      const deltaX = Number(input.deltaX ?? 0); const deltaY = Number(input.deltaY ?? 0);
      delete input.deltaX; delete input.deltaY;
      input.direction = Math.abs(deltaY) >= Math.abs(deltaX) ? (deltaY < 0 ? "up" : "down") : (deltaX < 0 ? "left" : "right");
      input.amount = Math.max(1, Math.min(50, Math.round(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / 100) || 1));
    }
    if (!context.foregroundAllowed && !["verify_state", "zoom"].includes(tool)) input.delivery_mode = "background";
    const result = await this.driverData(tool, input, context);
    if (!new Set(["verify_state", "zoom"]).has(tool)) app.lastSnapshot = undefined;
    return result;
  }

  private applyNativeRef(app: AppRecord, ref: JsonValue, input: JsonObject): void {
    const snapshot = asObject(app.lastSnapshot, "Take a fresh native accessibility snapshot first");
    const snapshotId = asString(snapshot.snapshot_id, "Native snapshot identity is missing");
    if (typeof ref === "number") {
      input.element_index = ref;
      input.snapshot_id = snapshotId;
      return;
    }
    if (typeof ref !== "string") throw new Error("Native element ref must be an index or element token");
    const elements = Array.isArray(snapshot.elements) ? snapshot.elements.map((value) => asObject(value)) : [];
    const element = elements.find((candidate) => candidate.element_token === ref || String(candidate.element_index) === ref);
    if (!element || typeof element.element_token !== "string") throw new Error("Native element ref is stale or unavailable");
    input.element_token = element.element_token;
    input.snapshot_id = snapshotId;
  }

  private async appLaunch(args: JsonValue[], context: CallContext): Promise<JsonValue> {
    const app = this.getAppRecord(args[0]);
    const options = asOptionalObject(args[1]);
    const response = await this.driver.call("launch_app", { ...(app.bundleId ? { bundle_id: app.bundleId } : { name: app.name }), ...options }, context.signal);
    const result = asObject(response.data, "App launch result is malformed");
    if (Number.isInteger(Number(result.pid))) app.pid = Number(result.pid);
    const windows = Array.isArray(result.windows) ? result.windows.map((value) => asObject(value)) : [];
    if (windows.length === 1 && Number.isInteger(Number(windows[0].window_id))) app.lastWindowId = Number(windows[0].window_id);
    return result;
  }

  private async appKill(value: JsonValue | undefined, context: CallContext): Promise<JsonValue> {
    const app = this.getAppRecord(value);
    return this.driverData("kill_app", { pid: app.pid }, context);
  }

  private async driverData(tool: string, input: JsonObject, context: CallContext): Promise<JsonValue> {
    const response = await this.driver.call(tool, input, context.signal);
    if (response.images.length) this.output.images.push(...response.images);
    return response.data;
  }

  private async compatGroup(value: JsonValue | undefined, context: CallContext): Promise<JsonValue> {
    const params = asObject(value, "Compatibility group parameters are required");
    const action = asString(params.action);
    if (action === "create") {
      const label = asString(params.label, "label is required for create");
      const url = typeof params.url === "string" ? params.url : "about:blank";
      assertUrl(url);
      const created = await this.bridge.create(label, `pi-${randomUUID()}`, context.signal);
      const tabId = created.result.tabId;
      if (!Number.isInteger(tabId)) throw new Error("Chrome bridge did not return a tab id");
      if (url !== "about:blank") await this.bridge.request("navigate", created.session, { tabId: tabId!, url }, context.signal);
      return toJsonValue({ session: created.session, ...created.result });
    }
    const session = asString(params.session, "session is required");
    this.bridge.adopt(session);
    if (action === "open") {
      const url = asString(params.url, "url is required for open");
      assertUrl(url);
      return toJsonValue(await this.bridge.request("open", session, { url }, context.signal));
    }
    if (action === "close") return toJsonValue(await this.bridge.request("close", session, { preserveMarked: false }, context.signal));
    throw new Error(`Unsupported compatibility group action: ${action}`);
  }

  private async compatPage(value: JsonValue | undefined, context: CallContext): Promise<JsonValue> {
    const params = asObject(value, "Compatibility page parameters are required");
    const session = asString(params.session, "session is required");
    const action = asString(params.action, "action is required");
    this.bridge.adopt(session);
    const request = { ...params };
    delete request.session;
    delete request.action;
    return toJsonValue(await this.bridge.request(action, session, request, context.signal));
  }
}

function asOptionalObject(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function requiredPositive(value: JsonValue | undefined, label: string): number {
  const number = asNumber(value);
  if (!(number > 0)) throw new Error(`The ${label} is unavailable`);
  return number;
}

function asRecordArray(value: JsonValue, key: string): JsonObject[] {
  if (Array.isArray(value)) return value.map((item) => asObject(item));
  const record = asObject(value);
  const nested = record[key];
  return Array.isArray(nested) ? nested.map((item) => asObject(item)) : [];
}

function assertUrl(value: string): void {
  if (value === "about:blank") return;
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Only HTTP, HTTPS, and about:blank URLs are supported");
}

function formatOutput(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function chromeWindowTitleMatches(extensionTitle: string, nativeTitle: string): boolean {
  if (extensionTitle === nativeTitle) return true;
  const match = nativeTitle.match(/^(.*?)(?:…|\.\.\.)(.*)$/s);
  if (!match) return false;
  const [, prefix, suffix] = match;
  return prefix.length >= 8 && suffix.length >= 8 && extensionTitle.startsWith(prefix) && extensionTitle.endsWith(suffix);
}

function abortableDelay(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("CUA operation aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, timeoutMs);
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(new Error("CUA operation aborted")); };
    function done() { signal?.removeEventListener("abort", onAbort); resolve(); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
