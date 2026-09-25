export const PAGE_ACTIONS = ["navigate", "back", "forward", "reload", "snapshot", "click", "fill", "press", "key", "typeText", "scroll", "screenshot", "locator", "evaluate", "logs", "content", "clipboard"];

const CDP_VERSION = "1.3";
const COMMAND_TIMEOUT_MS = 10_000;
const SCREENSHOT_LIMIT = 650_000;

export function validPageUrl(value) {
  if (value === "about:blank") return true;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function validatePageRequest(request) {
  if (!PAGE_ACTIONS.includes(request.action) || !Number.isInteger(request.tabId) || request.tabId < 0) {
    throw new Error("Invalid browser page action or tab ID");
  }
  if (request.action === "navigate" && (typeof request.url !== "string" || !validPageUrl(request.url))) {
    throw new Error("Only HTTP, HTTPS, and about:blank tabs are supported");
  }
  if (["click", "fill"].includes(request.action) && (typeof request.selector !== "string" || !request.selector || request.selector.length > 1000)) {
    throw new Error("A CSS selector is required");
  }
  if (request.action === "fill" && (typeof request.value !== "string" || request.value.length > 4000)) {
    throw new Error("Fill text must be at most 4000 characters");
  }
  if (["press", "key"].includes(request.action) && (typeof request.key !== "string" || !/^[A-Za-z0-9+_-]{1,64}$/.test(request.key))) {
    throw new Error("Unsupported key");
  }
  if (request.action === "typeText" && (typeof request.text !== "string" || request.text.length > 100_000)) throw new Error("Invalid browser text input");
  if (request.action === "evaluate" && (typeof request.source !== "string" || request.source.length > 10_000)) throw new Error("Invalid read-only evaluation");
  if (request.selector !== undefined && (typeof request.selector !== "string" || !request.selector || request.selector.length > 1000)) {
    throw new Error("Invalid CSS selector");
  }
  if (request.action === "scroll" && (!Number.isInteger(request.deltaY) || Math.abs(request.deltaY) > 5000)) {
    throw new Error("Scroll distance must be within 5000 pixels");
  }
  if (request.action === "locator") {
    if (!request.locator || typeof request.locator !== "object" || typeof request.operation !== "string" || !Array.isArray(request.args)) throw new Error("Invalid locator request");
    if (!new Set(["role", "text", "label", "placeholder", "testId", "css"]).has(request.locator.kind) || typeof request.locator.value !== "string" || request.locator.value.length > 1000) throw new Error("Invalid locator descriptor");
  }
}

export async function setTabIdentity(chromeApi, tabId, identity) {
  if (typeof identity !== "string" || !/^pi-[a-f0-9-]{36}$/.test(identity)) throw new Error("Invalid tab identity");
  await waitForLoad(chromeApi, tabId);
  return withDebugger(chromeApi, tabId, async (command) => evaluate(command, ({ title }) => { document.title = title; return { title: document.title }; }, { title: identity }));
}

function bounded(promise, timeoutMs = COMMAND_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Browser page operation timed out")), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function waitForLoad(chromeApi, tabId) {
  const until = Date.now() + 12_000;
  while (Date.now() < until) {
    const tab = await chromeApi.tabs.get(tabId);
    if (tab.status === "complete") return { loading: false };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { loading: true };
}

async function withDebugger(chromeApi, tabId, run) {
  const target = { tabId };
  const attachment = chromeApi.debugger.attach(target, CDP_VERSION);
  try {
    await bounded(attachment, 8_000);
  } catch (error) {
    attachment.then(() => chromeApi.debugger.detach(target).catch(() => {})).catch(() => {});
    throw error;
  }
  const command = (method, params = {}) => bounded(chromeApi.debugger.sendCommand(target, method, params));
  try {
    return await run(command);
  } finally {
    await bounded(chromeApi.debugger.detach(target), 4_000).catch(() => {});
  }
}

async function assertWebPage(command) {
  const response = await command("Runtime.evaluate", { expression: "location.href", returnByValue: true, timeout: 8000 });
  if (!validPageUrl(response?.result?.value)) throw new Error("Agent tab navigated to an unsupported page scheme");
}

async function evaluate(command, fn, arg) {
  const expression = `(${fn.toString()})(${JSON.stringify(arg)})`;
  const response = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: 8000 });
  if (response?.exceptionDetails) throw new Error(response.exceptionDetails.text ?? "Page script failed");
  const value = response?.result?.value;
  if (value?.error) throw new Error(value.error);
  return value;
}

function snapshotPage() {
  const trim = (value, limit) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const selectorFor = (node) => {
    const parts = [];
    for (let current = node; current?.nodeType === 1 && parts.length < 12; current = current.parentElement) {
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      let position = 1;
      for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.localName === current.localName) position++;
      }
      parts.unshift(`${current.localName}:nth-of-type(${position})`);
    }
    return parts.join(" > ");
  };
  const elements = [];
  for (const node of document.querySelectorAll("a,button,input,textarea,select,[role='button'],[role='link'],[contenteditable='true']")) {
    if (elements.length >= 150) break;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (!rect.width || !rect.height || style.display === "none" || style.visibility === "hidden") continue;
    const entry = {
      selector: selectorFor(node),
      node_id: selectorFor(node),
      tag: node.localName,
      text: trim(node.innerText || node.textContent, 160),
    };
    if (node.getAttribute("role")) entry.role = node.getAttribute("role");
    if (node.getAttribute("aria-label")) entry.label = trim(node.getAttribute("aria-label"), 160);
    if (node.getAttribute("placeholder")) entry.placeholder = trim(node.getAttribute("placeholder"), 160);
    if (node.localName === "input") entry.inputType = node.type;
    if (node.localName === "a" && node.href) entry.href = node.href;
    elements.push(entry);
  }
  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText ?? "").slice(0, 45_000),
    elements,
    truncated: (document.body?.innerText?.length ?? 0) > 45_000,
  };
}

function interactWithElement({ selector, action, value, key }) {
  let node;
  try { node = selector ? document.querySelector(selector) : document.activeElement; }
  catch { return { error: "Invalid CSS selector" }; }
  if (!node) return { error: "Element is no longer present; take a fresh snapshot" };
  if (action === "click" || (action === "press" && key === "Enter")) {
    const link = node.closest("a[href]");
    const form = node.closest("form");
    if ((link?.target && link.target !== "_self") ||
        (form?.target && form.target !== "_self") ||
        (node.formTarget && node.formTarget !== "_self")) {
      return { error: "This control opens another tab; use cua_browser_group open with its URL" };
    }
  }
  node.scrollIntoView?.({ block: "center", inline: "center", behavior: "instant" });
  node.focus?.();
  if (action === "click") {
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height) return { error: "Element is not visible" };
    node.click();
    return { clicked: true };
  }
  if (action === "fill") {
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      if (["file", "checkbox", "radio", "submit", "button"].includes(node.type)) return { error: "Element cannot receive text" };
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
      if (!setter) return { error: "Element cannot receive text" };
      setter.call(node, value);
    } else if (node.isContentEditable) {
      node.textContent = value;
    } else return { error: "Element cannot receive text" };
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: true };
  }
  const down = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  node.dispatchEvent(down);
  if (!down.defaultPrevented && key === "Enter") {
    if (node instanceof HTMLAnchorElement || node instanceof HTMLButtonElement) node.click();
    else if (node.form?.requestSubmit) node.form.requestSubmit();
  }
  node.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  return { pressed: true };
}

function scrollPage({ selector, deltaY }) {
  let target = window;
  if (selector) {
    try { target = document.querySelector(selector); }
    catch { return { error: "Invalid CSS selector" }; }
    if (!target) return { error: "Element is no longer present; take a fresh snapshot" };
  }
  target.scrollBy({ top: deltaY, behavior: "instant" });
  return { scrollY: target === window ? window.scrollY : target.scrollTop };
}

function locateAndAct({ descriptor, operation, args }) {
  const normalized = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const visible = node => {
    const rect = node?.getBoundingClientRect?.();
    const style = node ? getComputedStyle(node) : undefined;
    return Boolean(rect?.width && rect?.height && style?.display !== "none" && style?.visibility !== "hidden");
  };
  const candidates = (root, step) => {
    const nodes = [...root.querySelectorAll("*")];
    if (step.kind === "css") {
      try { return [...root.querySelectorAll(step.value)]; } catch { throw new Error("Invalid locator selector"); }
    }
    if (step.kind === "testId") return nodes.filter(node => node.getAttribute("data-testid") === step.value);
    if (step.kind === "placeholder") return nodes.filter(node => node.getAttribute("placeholder") === step.value);
    if (step.kind === "label") return nodes.filter(node => node.getAttribute("aria-label") === step.value || node.labels?.some(label => normalized(label.textContent) === normalized(step.value)));
    if (step.kind === "text") return nodes.filter(node => normalized(node.innerText || node.textContent).includes(normalized(step.value)));
    if (step.kind === "role") return nodes.filter(node => {
      const implicit = node.localName === "a" ? "link" : node.localName === "button" ? "button" : node.localName === "input" ? "textbox" : "";
      if ((node.getAttribute("role") || implicit) !== step.value) return false;
      const name = step.options?.name;
      return name === undefined || normalized(node.getAttribute("aria-label") || node.innerText || node.textContent).includes(normalized(name));
    });
    throw new Error("Unsupported locator kind");
  };
  const steps = [descriptor, ...(descriptor.chain || [])];
  let nodes = candidates(document, steps[0]);
  for (const step of steps.slice(1)) nodes = nodes.flatMap(node => candidates(node, step));
  if (descriptor.nth === -1) nodes = nodes.slice(-1);
  else if (Number.isInteger(descriptor.nth)) nodes = nodes.slice(descriptor.nth, descriptor.nth + 1);
  if (operation === "count") return nodes.length;
  if (operation === "allTextContents") return nodes.map(node => node.textContent ?? "");
  const node = nodes[0];
  if (!node) throw new Error("Locator no longer matches an element; reobserve the page");
  if (operation === "textContent") return node.textContent;
  if (operation === "innerText") return node.innerText;
  if (operation === "isVisible") return visible(node);
  if (operation === "isEnabled") return !node.disabled && node.getAttribute("aria-disabled") !== "true";
  if (operation === "getAttribute") return node.getAttribute(args[0]);
  if (operation === "waitFor") return { visible: visible(node) };
  node.scrollIntoView?.({ block: "center", inline: "center", behavior: "instant" });
  node.focus?.();
  if (operation === "click" || operation === "dblclick") {
    if (!visible(node)) throw new Error("Locator target is not visible");
    node.click();
    if (operation === "dblclick") node.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
    return { action: operation };
  }
  if (["fill", "type"].includes(operation)) {
    const value = String(args[0] ?? "");
    if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node.isContentEditable)) throw new Error("Locator target cannot receive text");
    if (node.isContentEditable) node.textContent = operation === "fill" ? value : `${node.textContent ?? ""}${value}`;
    else {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
      setter?.call(node, operation === "fill" ? value : `${node.value}${value}`);
    }
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return { action: operation };
  }
  if (operation === "press") {
    const key = String(args[0] ?? "");
    const down = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    node.dispatchEvent(down);
    if (!down.defaultPrevented && key === "Enter") {
      if (node instanceof HTMLAnchorElement || node instanceof HTMLButtonElement) node.click();
      else if (node.form?.requestSubmit) node.form.requestSubmit();
    }
    node.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    return { pressed: key };
  }
  if (["check", "uncheck", "setChecked"].includes(operation)) {
    if (!(node instanceof HTMLInputElement) || !["checkbox", "radio"].includes(node.type)) throw new Error("Locator target is not checkable");
    const checked = operation === "check" ? true : operation === "uncheck" ? false : Boolean(args[0]);
    if (node.checked !== checked) node.click();
    return { checked: node.checked };
  }
  if (operation === "selectOption") {
    if (!(node instanceof HTMLSelectElement)) throw new Error("Locator target is not a select element");
    const values = Array.isArray(args[0]) ? args[0].map(String) : [String(args[0])];
    for (const option of node.options) option.selected = values.includes(option.value) || values.includes(option.label);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return { values: [...node.selectedOptions].map(option => option.value) };
  }
  throw new Error("Unsupported locator operation");
}

function consoleLogs({ clear }) {
  const key = "__pikachuConsoleLog";
  if (!globalThis[key]) {
    const entries = [];
    globalThis[key] = entries;
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      const original = console[level].bind(console);
      console[level] = (...args) => { entries.push({ level, text: args.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" ").slice(0, 4000), at: Date.now() }); if (entries.length > 500) entries.shift(); original(...args); };
    }
  }
  const result = globalThis[key].slice(-200);
  if (clear) globalThis[key].length = 0;
  return result;
}

function pageContent({ format, maxChars }) {
  const limit = Math.max(1, Math.min(Number(maxChars) || 100_000, 500_000));
  const value = format === "html" ? document.documentElement.outerHTML : document.body?.innerText ?? "";
  return { format: format === "html" ? "html" : "text", title: document.title, url: location.href, content: value.slice(0, limit), truncated: value.length > limit };
}

function locatorExpression(descriptor) {
  const encoded = JSON.stringify(descriptor);
  return `(() => { const d=${encoded}; const norm=v=>String(v??'').replace(/\\s+/g,' ').trim(); const pick=(root,s)=>{const all=[...root.querySelectorAll('*')]; if(s.kind==='css') return [...root.querySelectorAll(s.value)]; if(s.kind==='testId') return all.filter(n=>n.getAttribute('data-testid')===s.value); if(s.kind==='placeholder') return all.filter(n=>n.getAttribute('placeholder')===s.value); if(s.kind==='label') return all.filter(n=>n.getAttribute('aria-label')===s.value||[...(n.labels||[])].some(l=>norm(l.textContent)===norm(s.value))); if(s.kind==='text') return all.filter(n=>norm(n.innerText||n.textContent).includes(norm(s.value))); if(s.kind==='role') return all.filter(n=>(n.getAttribute('role')||(n.localName==='a'?'link':n.localName==='button'?'button':n.localName==='input'?'textbox':''))===s.value); return [];}; let nodes=pick(document,d); for(const s of (d.chain||[])) nodes=nodes.flatMap(n=>pick(n,s)); if(d.nth===-1) nodes=nodes.slice(-1); else if(Number.isInteger(d.nth)) nodes=nodes.slice(d.nth,d.nth+1); return nodes; })()`;
}

async function evaluateReadonly(command, request) {
  if (!/^\s*(async\s*)?(function\b|\(?[\w\s,$={}\[\]]*\)?\s*=>)/.test(request.source)) throw new Error("Read-only evaluation requires a function");
  const argument = { value: request.arg };
  if (request.locator) {
    const located = await command("Runtime.evaluate", { expression: locatorExpression(request.locator), returnByValue: false, awaitPromise: false });
    if (!located?.result?.objectId) throw new Error("Locator evaluation target is unavailable");
    const functionDeclaration = request.all
      ? `function(arg){ return (${request.source})(this, arg); }`
      : `function(arg){ return (${request.source})(this[0], arg); }`;
    const response = await command("Runtime.callFunctionOn", { objectId: located.result.objectId, functionDeclaration, arguments: [argument], returnByValue: true, awaitPromise: true, throwOnSideEffect: true });
    if (response?.exceptionDetails) throw new Error("Evaluation was rejected because it may have side effects");
    return response?.result?.value;
  }
  const expression = `(${request.source})(${JSON.stringify(request.arg)})`;
  const response = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, throwOnSideEffect: true, timeout: 8000 });
  if (response?.exceptionDetails) throw new Error("Evaluation was rejected because it may have side effects");
  return response?.result?.value;
}

export async function handlePageRequest(chromeApi, request, record) {
  validatePageRequest(request);
  const owned = record?.tabIds?.includes(request.tabId);
  const claimed = record?.claimedTabIds?.includes(request.tabId);
  if (!owned && !claimed) throw new Error("Tab is not owned or claimed by this browser session");
  const tab = await chromeApi.tabs.get(request.tabId);
  if (owned && tab.groupId !== record.groupId) throw new Error("Tab is no longer in the agent-owned group");

  if (request.action === "navigate") {
    await chromeApi.tabs.update(request.tabId, { url: request.url });
    const load = await waitForLoad(chromeApi, request.tabId);
    const navigatedTab = await chromeApi.tabs.get(request.tabId);
    if (owned && navigatedTab.groupId !== record.groupId) throw new Error("Agent tab changed while navigating");
    return { tabId: request.tabId, url: request.url, ...load };
  }
  if (request.action === "snapshot") await waitForLoad(chromeApi, request.tabId);
  const currentTab = await chromeApi.tabs.get(request.tabId);
  if (owned && currentTab.groupId !== record.groupId) throw new Error("Agent tab changed while loading");
  return withDebugger(chromeApi, request.tabId, async (command) => {
    await assertWebPage(command);
    if (request.action === "back") {
      const history = await command("Page.getNavigationHistory");
      if (!Number.isInteger(history?.currentIndex) || history.currentIndex < 1) throw new Error("No previous page in this tab");
      const previous = history.entries?.[history.currentIndex - 1];
      if (!previous || !validPageUrl(previous.url)) throw new Error("Previous page uses an unsupported scheme");
      await command("Page.navigateToHistoryEntry", { entryId: previous.id });
      return { tabId: request.tabId, back: true, url: previous.url };
    }
    if (request.action === "forward") {
      const history = await command("Page.getNavigationHistory");
      const next = history.entries?.[history.currentIndex + 1];
      if (!next || !validPageUrl(next.url)) throw new Error("No supported forward page in this tab");
      await command("Page.navigateToHistoryEntry", { entryId: next.id });
      return { tabId: request.tabId, forward: true, url: next.url };
    }
    if (request.action === "reload") {
      await command("Page.reload", { ignoreCache: false });
      return { tabId: request.tabId, reloaded: true };
    }
    if (request.action === "snapshot") return { tabId: request.tabId, ...await evaluate(command, snapshotPage) };
    if (request.action === "click") {
      await evaluate(command, interactWithElement, { selector: request.selector, action: "click" });
      return { tabId: request.tabId, clicked: request.selector };
    }
    if (request.action === "fill") {
      await evaluate(command, interactWithElement, { selector: request.selector, action: "fill", value: request.value });
      return { tabId: request.tabId, filled: request.selector };
    }
    if (request.action === "press") {
      await evaluate(command, interactWithElement, { selector: request.selector, action: "press", key: request.key });
      return { tabId: request.tabId, pressed: request.key };
    }
    if (request.action === "key") {
      await evaluate(command, interactWithElement, { selector: null, action: "press", key: request.key });
      return { tabId: request.tabId, pressed: request.key };
    }
    if (request.action === "typeText") {
      await command("Input.insertText", { text: request.text });
      return { tabId: request.tabId, typed: true };
    }
    if (request.action === "scroll") return { tabId: request.tabId, ...await evaluate(command, scrollPage, { selector: request.selector, deltaY: request.deltaY }) };
    if (request.action === "locator") return { tabId: request.tabId, result: await evaluate(command, locateAndAct, { descriptor: request.locator, operation: request.operation, args: request.args ?? [] }) };
    if (request.action === "evaluate") return { tabId: request.tabId, result: await evaluateReadonly(command, request) };
    if (request.action === "logs") return { tabId: request.tabId, logs: await evaluate(command, consoleLogs, { clear: request.clear === true }) };
    if (request.action === "content") {
      if (request.format === "mhtml") {
        const captured = await command("Page.captureSnapshot", { format: "mhtml" });
        return { tabId: request.tabId, format: "mhtml", content: String(captured.data ?? "").slice(0, 500_000), truncated: String(captured.data ?? "").length > 500_000 };
      }
      return { tabId: request.tabId, ...await evaluate(command, pageContent, { format: request.format, maxChars: request.maxChars }) };
    }
    if (request.action === "clipboard") {
      const expression = request.method === "write"
        ? `navigator.clipboard.writeText(${JSON.stringify(String(request.value ?? ""))}).then(() => ({written:true}))`
        : "navigator.clipboard.readText().then(value => ({value}))";
      const response = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: 8000 });
      if (response?.exceptionDetails) throw new Error("Clipboard access requires browser permission or foreground handoff");
      return { tabId: request.tabId, ...response?.result?.value };
    }
    let image = await command("Page.captureScreenshot", { format: "jpeg", quality: 55, captureBeyondViewport: false, fromSurface: true });
    if (image?.data?.length > SCREENSHOT_LIMIT) image = await command("Page.captureScreenshot", { format: "jpeg", quality: 25, captureBeyondViewport: false, fromSurface: true });
    if (typeof image?.data !== "string" || image.data.length > SCREENSHOT_LIMIT) throw new Error("Screenshot exceeds browser bridge size limit");
    return { tabId: request.tabId, mimeType: "image/jpeg", data: image.data };
  });
}
