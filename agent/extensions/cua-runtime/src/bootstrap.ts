export const GUEST_BOOTSTRAP = String.raw`
(() => {
  "use strict";
  const host = (method, ...args) => {
    const response = JSON.parse(__hostCall(method, JSON.stringify(args)));
    if (!response.ok) throw new Error(response.error || "CUA host call failed");
    return response.value;
  };
  const handleOf = (value) => typeof value === "string" ? value : value?.__handle ?? value?.handle ?? value?.id;

  class Locator {
    constructor(tab, descriptor) { this.tab = tab; this.descriptor = descriptor; }
    _chain(kind, value, options) { return new Locator(this.tab, { ...this.descriptor, chain: [...(this.descriptor.chain || []), { kind, value, options }] }); }
    getByRole(value, options) { return this._chain("role", value, options); }
    getByText(value, options) { return this._chain("text", value, options); }
    getByLabel(value, options) { return this._chain("label", value, options); }
    getByPlaceholder(value, options) { return this._chain("placeholder", value, options); }
    getByTestId(value) { return this._chain("testId", value); }
    locator(value) { return this._chain("css", value); }
    nth(index) { return new Locator(this.tab, { ...this.descriptor, nth: index }); }
    first() { return this.nth(0); }
    last() { return new Locator(this.tab, { ...this.descriptor, nth: -1 }); }
    _call(operation, ...args) { return host("tab.locator", this.tab.__handle, this.descriptor, operation, args); }
    click(options) { return this._call("click", options); }
    dblclick(options) { return this._call("dblclick", options); }
    fill(value, options) { return this._call("fill", value, options); }
    type(value, options) { return this._call("type", value, options); }
    press(value, options) { return this._call("press", value, options); }
    count() { return this._call("count"); }
    textContent() { return this._call("textContent"); }
    innerText() { return this._call("innerText"); }
    allTextContents() { return this._call("allTextContents"); }
    isVisible() { return this._call("isVisible"); }
    isEnabled() { return this._call("isEnabled"); }
    getAttribute(name) { return this._call("getAttribute", name); }
    check(options) { return this._call("check", options); }
    uncheck(options) { return this._call("uncheck", options); }
    setChecked(value, options) { return this._call("setChecked", value, options); }
    selectOption(value, options) { return this._call("selectOption", value, options); }
    waitFor(options) { return this._call("waitFor", options); }
    pressSequentially(value, options) { return this._call("type", value, options); }
    all() { return Array.from({ length: this.count() }, (_, index) => this.nth(index)); }
    filter(options) { return new Locator(this.tab, { ...this.descriptor, filter: options }); }
    and(locator) { return new Locator(this.tab, { kind: "and", operands: [this.descriptor, locator.descriptor] }); }
    or(locator) { return new Locator(this.tab, { kind: "or", operands: [this.descriptor, locator.descriptor] }); }
    evaluate(pageFunction, arg, options) { return host("tab.locatorEvaluate", this.tab.__handle, this.descriptor, String(pageFunction), arg, options); }
    evaluateAll(pageFunction, arg, options) { return host("tab.locatorEvaluateAll", this.tab.__handle, this.descriptor, String(pageFunction), arg, options); }
  }

  class Tab {
    constructor(descriptor) {
      this.__handle = handleOf(descriptor);
      this.id = descriptor?.id || this.__handle;
      this.providerTabId = descriptor?.providerTabId;
      this.ax = Object.freeze({
        get: (mode = "state", options = {}) => mode === "screenshot" ? host("tab.screenshot", this.__handle, options) : host("tab.snapshot", this.__handle, { ...options, mode, includeScreenshot: mode === "both" }),
        snapshot: (options = {}) => host("tab.snapshot", this.__handle, { ...options, mode: "state", includeScreenshot: false }),
        write: (mode = "state", options = {}) => {
          const state = mode === "screenshot" ? host("tab.screenshot", this.__handle, options) : host("tab.snapshot", this.__handle, { ...options, mode, includeScreenshot: mode === "both" });
          host("write", state?.outline || state);
          return state;
        },
        click: (ref, options) => host("tab.ax.click", this.__handle, ref?.ref ?? ref, options),
        typeText: (ref, text, options) => host("tab.ax.type", this.__handle, ref, text, options),
        setValue: (ref, value, options) => host("tab.ax.setValue", this.__handle, ref, value, options),
        pressKey: (key, options) => host("tab.ax.pressKey", this.__handle, key, options),
        scroll: (ref, options) => host("tab.ax.scroll", this.__handle, ref, options),
        drag: (from, to) => host("tab.cua", this.__handle, "drag", { from, to }),
        paste: (ref, text, options) => host("tab.ax.type", this.__handle, ref, text, { ...options, paste: true }),
      });
      this.cua = Object.freeze({
        click: options => host("tab.cua", this.__handle, "click", options),
        double_click: options => host("tab.cua", this.__handle, "double_click", options),
        move: options => host("tab.cua", this.__handle, "move", options),
        drag: options => host("tab.cua", this.__handle, "drag", options),
        type: options => host("tab.cua", this.__handle, "type", options),
        keypress: options => host("tab.cua", this.__handle, "keypress", options),
        scroll: options => host("tab.cua", this.__handle, "scroll", options),
      });
      this.dom_cua = Object.freeze({
        get_visible_dom: () => host("tab.dom", this.__handle, "get_visible_dom", {}),
        click: options => host("tab.dom", this.__handle, "click", options),
        double_click: options => host("tab.dom", this.__handle, "double_click", options),
        type: options => host("tab.dom", this.__handle, "type", options),
        keypress: options => host("tab.dom", this.__handle, "keypress", options),
        scroll: options => host("tab.dom", this.__handle, "scroll", options),
      });
      this.playwright = Object.freeze({
        getByRole: (value, options) => new Locator(this, { kind: "role", value, options }),
        getByText: (value, options) => new Locator(this, { kind: "text", value, options }),
        getByLabel: (value, options) => new Locator(this, { kind: "label", value, options }),
        getByPlaceholder: (value, options) => new Locator(this, { kind: "placeholder", value, options }),
        getByTestId: value => new Locator(this, { kind: "testId", value }),
        locator: value => new Locator(this, { kind: "css", value }),
        domSnapshot: () => host("tab.content", this.__handle, { format: "html" }),
        evaluate: (pageFunction, arg, options) => host("tab.evaluate", this.__handle, String(pageFunction), arg, options),
        waitForLoadState: options => host("tab.wait", this.__handle, "load", options),
        waitForTimeout: timeoutMs => host("tab.wait", this.__handle, "timeout", { timeoutMs }),
        waitForURL: (url, options) => host("tab.wait", this.__handle, "url", { url, ...options }),
      });
      this.clipboard = Object.freeze({ read: () => host("tab.clipboard", this.__handle, { method: "read" }), readText: () => host("tab.clipboard", this.__handle, { method: "read" }).value, write: items => host("tab.clipboard", this.__handle, { method: "write", value: items }), writeText: text => host("tab.clipboard", this.__handle, { method: "write", value: text }) });
      this.dialog = Object.freeze({ accept: promptText => host("tab.dialog", this.__handle, "accept", promptText), dismiss: () => host("tab.dialog", this.__handle, "dismiss") });
      this.dev = Object.freeze({ logs: options => host("tab.logs", this.__handle, options) });
      this.content = Object.freeze({ export: () => host("tab.export", this.__handle, "html"), exportGsuite: type => host("tab.export", this.__handle, type), exportYouTubeTranscript: () => host("tab.export", this.__handle, "youtube-transcript") });
      this.capabilities = capabilityCollection(["ax", "playwright", "cua", "dom_cua", "clipboard", "content", "dev"]);
    }
    info() { return host("tab.info", this.__handle); }
    getState(options) { return host("tab.snapshot", this.__handle, { ...options, mode: "state", includeScreenshot: false }); }
    goto(url, options) { return host("tab.goto", this.__handle, url, options); }
    goBack() { return host("tab.back", this.__handle); }
    goForward() { return host("tab.forward", this.__handle); }
    reload() { return host("tab.reload", this.__handle); }
    close() { return host("tab.close", this.__handle); }
    screenshot(options) { return host("tab.screenshot", this.__handle, options); }
    setInputFiles(selector, files) { return host("tab.setInputFiles", this.__handle, selector, files); }
    waitForDownload(action, options) { return host("tab.download", this.__handle, action, options); }
    getDeveloperLogs(options) { return host("tab.logs", this.__handle, options); }
    title() { return host("tab.info", this.__handle).title; }
    url() { return host("tab.info", this.__handle).url; }
    getJsDialog() { const value = host("tab.dialog", this.__handle, "inspect"); return value?.dialog_id ? { ...value, accept: text => host("tab.dialog", this.__handle, "accept", text), dismiss: () => host("tab.dialog", this.__handle, "dismiss") } : undefined; }
    markDeliverable() { return host("tab.mark", this.__handle, "deliverable"); }
    markHandoff() { return host("tab.mark", this.__handle, "handoff"); }
  }

  class Browser {
    constructor(descriptor = { id: "chrome" }) {
      this.id = descriptor.id || "chrome";
      this.browserId = this.id;
      this.name = descriptor.name || "Google Chrome";
      this.tabs = Object.freeze({
        list: () => host("browser.tabs", this.id),
        get: id => new Tab(host("tab.get", id)),
        new: (url = "about:blank", options) => new Tab(host("browser.createTab", this.id, url, options)),
        selected: () => { const value = host("browser.selected", this.id); return value ? new Tab(value) : undefined; },
        content: options => host("browser.tabsContent", this.id, options),
        open: (urls, options) => host("browser.openMany", this.id, urls, options).map(value => new Tab(value)),
      });
      this.user = Object.freeze({
        openTabs: options => host("browser.openTabs", this.id, options),
        claimTab: tab => new Tab(host("browser.claimTab", tab)),
        getTabContext: tab => host("browser.getTabContext", tab),
        history: options => host("browser.history", options),
      });
      this.management = Object.freeze({
        call: (namespace, method, ...args) => host("browser.management", namespace, method, args),
      });
      this.capabilities = capabilityCollection(["management"]);
    }
    nameSession(name) { return host("browser.nameSession", name); }
  }

  class NativeApp {
    constructor(descriptor) {
      this.__handle = handleOf(descriptor);
      this.pid = descriptor?.pid;
      this.name = descriptor?.name;
      this.bundleId = descriptor?.bundleId;
      this.ax = Object.freeze({
        get: options => host("app.state", this.__handle, options),
        click: (ref, options) => host("app.action", this.__handle, "click", { ref, ...options }),
        setValue: (ref, value, options) => host("app.action", this.__handle, "setValue", { ref, value, ...options }),
        typeText: (ref, text, options) => host("app.action", this.__handle, "typeText", { ref, text, ...options }),
        pressKey: (key, options) => host("app.action", this.__handle, "pressKey", { key, ...options }),
        scroll: (ref, options) => host("app.action", this.__handle, "scroll", { ref, ...options }),
      });
      this.cua = Object.freeze({
        click: (x, y, options) => host("app.action", this.__handle, "pointerClick", { x, y, ...options }),
        doubleClick: (x, y, options) => host("app.action", this.__handle, "pointerDoubleClick", { x, y, ...options }),
        drag: (from, to, options) => host("app.action", this.__handle, "drag", { from, to, ...options }),
        type: (text, options) => host("app.action", this.__handle, "typeText", { text, ...options }),
        press: (key, options) => host("app.action", this.__handle, "pressKey", { key, ...options }),
        scroll: (x, y, deltaX, deltaY, options) => host("app.action", this.__handle, "pointerScroll", { x, y, deltaX, deltaY, ...options }),
      });
    }
    windows() { return host("app.windows", this.__handle); }
    screenshot(options) { return host("app.state", this.__handle, { ...options, screenshot: true }); }
    launch(options) { return host("app.launch", this.__handle, options); }
    quit() { return host("app.kill", this.__handle); }
    menu(path) { return host("app.action", this.__handle, "menu", { path }); }
  }

  const browserTabArguments = (browser, url, options) => {
    if (browser && typeof browser === "object" && !Array.isArray(browser)) {
      const descriptor = browser;
      return [
        descriptor.browser || descriptor.browserId || "chrome",
        descriptor.url || "about:blank",
        descriptor.options || (descriptor.sessionName ? { sessionName: descriptor.sessionName } : undefined),
      ];
    }
    return [browser || "chrome", url || "about:blank", options];
  };

  const cua = Object.freeze({
    getState: () => host("state"),
    getBrowser: selector => new Browser(host("browser.get", selector)),
    createBrowserTab: (browser, url, options) => {
      const args = browserTabArguments(browser, url, options);
      return new Tab(host("browser.createTab", args[0], args[1], args[2]));
    },
    getTab: selector => new Tab(host("tab.get", selector)),
    getApp: selector => new NativeApp(host("app.get", selector)),
    cursor: Object.freeze({ state: () => host("cursor.state"), setEnabled: enabled => host("cursor.enabled", enabled) }),
  });
  function capabilityCollection(ids) { return Object.freeze({ list: () => [...ids], get: id => ids.includes(id) ? Object.freeze({ id, documentation: () => host("documentation", id) }) : undefined }); }
  const browsers = Object.freeze({ list: () => host("browser.list"), get: id => new Browser(host("browser.get", id)), getDefault: () => new Browser(host("browser.get", "chrome")), getForUrl: _url => new Browser(host("browser.get", "chrome")) });
  const agent = Object.freeze({ browsers, documentation: Object.freeze({ get: name => host("documentation", name) }) });
  const nodeRepl = Object.freeze({ write: value => host("write", value), emitImage: value => host("emitImage", value) });

  Object.assign(globalThis, { cua, agent, nodeRepl });
  for (const ctor of [Locator, Tab, Browser, NativeApp]) Object.freeze(ctor.prototype);
  for (const denied of ["process", "require", "module", "exports", "Buffer", "fetch", "WebSocket", "XMLHttpRequest", "Deno", "Bun"]) {
    Object.defineProperty(globalThis, denied, { value: undefined, writable: false, configurable: false });
  }
  Object.freeze(cua);
  Object.freeze(agent);
  Object.freeze(nodeRepl);
})();
`;
