import { PAGE_ACTIONS, handlePageRequest, setTabIdentity, validPageUrl } from "./page-control.js";

const STORAGE_KEY = "pikachu_browser_group_sessions";
const INSTANCE_KEY = "pikachu_browser_group_instance";
const AUDIT_KEY = "pikachu_browser_group_audit";
const UUID = /^[a-f0-9-]{36}$/;
const ACTIONS = new Set(["begin", "create", "open", "close", "inventory", "claim", "release", "context", "tab", "closeTab", "mark", "management", ...PAGE_ACTIONS]);

function validateRequest(request) {
  if (!request || typeof request !== "object" || !UUID.test(request.session ?? "")) throw new Error("Invalid browser session ID");
  if (!ACTIONS.has(request.action)) throw new Error("Invalid browser action");
  if (request.action === "create" && (typeof request.label !== "string" || !/^.{1,48}$/u.test(request.label))) throw new Error("Invalid browser group label");
  if (["create", "open"].includes(request.action) && (typeof request.url !== "string" || !validPageUrl(request.url))) throw new Error("Only HTTP, HTTPS, and about:blank tabs are supported");
}

async function readSessions(chromeApi) {
  const value = (await chromeApi.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function writeSessions(chromeApi, sessions) { await chromeApi.storage.local.set({ [STORAGE_KEY]: sessions }); }

async function ensureInstanceId(chromeApi) {
  const stored = await chromeApi.storage.local.get(INSTANCE_KEY);
  if (typeof stored[INSTANCE_KEY] === "string") return stored[INSTANCE_KEY];
  const value = crypto.randomUUID();
  await chromeApi.storage.local.set({ [INSTANCE_KEY]: value });
  return value;
}

async function audit(chromeApi, entry) {
  const stored = await chromeApi.storage.local.get(AUDIT_KEY);
  const current = Array.isArray(stored[AUDIT_KEY]) ? stored[AUDIT_KEY] : [];
  current.push({ at: Date.now(), ...entry });
  await chromeApi.storage.local.set({ [AUDIT_KEY]: current.slice(-200) });
}

async function matchingGroup(chromeApi, record) {
  if (!Number.isInteger(record?.groupId)) return undefined;
  try {
    const group = await chromeApi.tabGroups.get(record.groupId);
    return group.title === record.label ? group : undefined;
  } catch { return undefined; }
}

async function exactTab(chromeApi, expected) {
  if (!Number.isInteger(expected?.tabId)) throw new Error("An exact tab ID is required");
  const tab = await chromeApi.tabs.get(expected.tabId);
  if (expected.windowId !== undefined && tab.windowId !== expected.windowId) throw new Error("Tab window identity changed");
  if (expected.title !== undefined && tab.title !== expected.title) throw new Error("Tab title identity changed");
  if (expected.url !== undefined && tab.url !== expected.url) throw new Error("Tab URL identity changed");
  return tab;
}

async function closeOwned(chromeApi, record, preserveMarked = true) {
  if (!record || !Array.isArray(record.tabIds)) return [];
  const preserved = [];
  for (const tabId of record.tabIds) {
    if (!Number.isInteger(tabId)) continue;
    if (preserveMarked && record.marks?.[tabId]) { preserved.push(tabId); continue; }
    try {
      const tab = await chromeApi.tabs.get(tabId);
      if (!Number.isInteger(record.groupId) || tab.groupId === record.groupId) await chromeApi.tabs.remove(tabId);
    } catch { /* Already closed is clean. */ }
  }
  return preserved;
}

export async function cleanupAll(chromeApi, { preserveMarked = true } = {}) {
  const sessions = await readSessions(chromeApi);
  const retained = {};
  for (const [session, record] of Object.entries(sessions)) {
    const preserved = await closeOwned(chromeApi, record, preserveMarked);
    if (preserved.length) retained[session] = { ...record, tabIds: preserved, claimedTabIds: [], disconnected: true };
  }
  await writeSessions(chromeApi, retained);
}

async function inventory(chromeApi) {
  const [tabs, windows, instanceId] = await Promise.all([chromeApi.tabs.query({}), chromeApi.windows.getAll({ populate: false }), ensureInstanceId(chromeApi)]);
  const normalizedTabs = tabs.map(({ id, windowId, groupId, title, url, active, pinned, lastAccessed, status }) => ({ id, windowId, groupId, title: title ?? "", url: url ?? "", active: Boolean(active), pinned: Boolean(pinned), lastAccessed: lastAccessed ?? 0, status }));
  const normalizedWindows = windows.map((window) => {
    const active = normalizedTabs.find((tab) => tab.windowId === window.id && tab.active);
    return { id: window.id, focused: Boolean(window.focused), state: window.state, type: window.type, bounds: { x: window.left, y: window.top, width: window.width, height: window.height }, activeTitle: active?.title ?? "" };
  });
  return { bridgeVersion: chromeApi.runtime?.getManifest?.().version ?? "test", instanceId, generation: Date.now(), tabs: normalizedTabs, windows: normalizedWindows };
}

export async function controlledTabVisibilityEvents(chromeApi, { windowId } = {}) {
  const sessions = await readSessions(chromeApi);
  const windows = new Map();
  const events = [];
  for (const [session, record] of Object.entries(sessions)) {
    const tabIds = [...new Set([...(record.tabIds ?? []), ...(record.claimedTabIds ?? [])])];
    for (const tabId of tabIds) {
      try {
        const tab = await chromeApi.tabs.get(tabId);
        if (windowId !== undefined && tab.windowId !== windowId) continue;
        let window = windows.get(tab.windowId);
        if (!window) {
          window = await chromeApi.windows.get(tab.windowId);
          windows.set(tab.windowId, window);
        }
        events.push({ event: "tabVisibility", session, tabId, windowId: tab.windowId, visible: Boolean(tab.active && window.focused) });
      } catch { /* Closed tabs and windows are removed by normal lifecycle cleanup. */ }
    }
  }
  return events;
}

async function managementBefore(chromeApi, namespace, method, args) {
  try {
    if (namespace === "tabs" && ["update", "move", "remove"].includes(method)) return await chromeApi.tabs.get(args[0]);
    if (namespace === "windows" && ["update", "remove"].includes(method)) return await chromeApi.windows.get(args[0]);
    if (namespace === "tabGroups" && ["update", "move"].includes(method)) return await chromeApi.tabGroups.get(args[0]);
    if (namespace === "bookmarks" && ["update", "move", "remove", "removeTree"].includes(method)) return await chromeApi.bookmarks.get(args[0]);
  } catch { /* Missing before-state is explicit null. */ }
  return null;
}

function managementUndo(namespace, method, before, result) {
  if (method === "create") return { namespace, method: "remove", args: [result?.id] };
  if (before && ["update", "move"].includes(method)) return { namespace, method, before };
  if (before && ["remove", "removeTree"].includes(method)) return { namespace, method: "restore", before };
  return null;
}

async function management(chromeApi, request) {
  const namespace = request.namespace;
  const method = request.method;
  const args = Array.isArray(request.args) ? [...request.args] : [];
  const allowed = {
    tabs: new Set(["query", "get", "create", "update", "move", "group", "ungroup", "remove"]),
    windows: new Set(["get", "getAll", "create", "update", "remove"]),
    tabGroups: new Set(["query", "get", "update", "move"]),
    bookmarks: new Set(["search", "get", "getTree", "getChildren", "create", "update", "move", "remove", "removeTree"]),
  };
  if (!allowed[namespace]?.has(method) || typeof chromeApi[namespace]?.[method] !== "function") throw new Error("Browser management method is unavailable");
  if (namespace === "tabs" && method === "create") {
    if (!validPageUrl(args[0]?.url ?? "about:blank")) throw new Error("Unsupported tab URL");
    args[0] = { ...args[0], active: false };
  }
  if (namespace === "windows" && method === "create") args[0] = { ...args[0], focused: false };
  if (namespace === "windows" && method === "update") args[1] = { ...args[1], focused: false };
  const before = await managementBefore(chromeApi, namespace, method, args);
  const result = await chromeApi[namespace][method](...args);
  await audit(chromeApi, { namespace, method, args, before, undo: managementUndo(namespace, method, before, result) });
  return { result, before };
}

export async function handleGroupRequest(chromeApi, request) {
  validateRequest(request);
  const sessions = await readSessions(chromeApi);
  let existing = sessions[request.session];

  if (request.action === "begin") {
    sessions[request.session] ??= { label: "Pi Browser", tabIds: [], claimedTabIds: [], marks: {}, generation: 1 };
    await writeSessions(chromeApi, sessions);
    return { begun: true, generation: sessions[request.session].generation };
  }
  if (request.action === "inventory") return inventory(chromeApi);
  if (request.action === "management") return management(chromeApi, request);
  if (request.action === "close") {
    const preserved = existing ? await closeOwned(chromeApi, existing, request.preserveMarked !== false) : [];
    if (preserved.length) sessions[request.session] = { ...existing, tabIds: preserved, claimedTabIds: [], disconnected: true };
    else delete sessions[request.session];
    await writeSessions(chromeApi, sessions);
    return preserved.length ? { closed: true, preserved } : { closed: true };
  }

  if (request.action === "create") {
    if (existing?.tabIds?.length && await matchingGroup(chromeApi, existing)) return { groupId: existing.groupId, tabId: existing.tabIds[0], windowId: existing.windowId, label: existing.label, identity: existing.identity };
    if (existing) await closeOwned(chromeApi, existing, false);
    const tab = await chromeApi.tabs.create({ url: request.url, active: false });
    try {
      const groupId = await chromeApi.tabs.group({ tabIds: tab.id });
      await chromeApi.tabGroups.update(groupId, { title: request.label });
      if (typeof request.identity === "string" && request.identity) await setTabIdentity(chromeApi, tab.id, request.identity);
      const current = await chromeApi.tabs.get(tab.id);
      sessions[request.session] = { groupId, windowId: current.windowId, label: request.label, identity: request.identity, tabIds: [tab.id], claimedTabIds: [], marks: {}, generation: (existing?.generation ?? 0) + 1 };
      await writeSessions(chromeApi, sessions);
      return { groupId, tabId: tab.id, windowId: current.windowId, label: request.label, identity: request.identity };
    } catch (error) { await chromeApi.tabs.remove(tab.id).catch(() => {}); throw error; }
  }

  if (!existing) throw new Error("Browser session is no longer available");
  if (request.action === "claim") {
    const tab = await exactTab(chromeApi, request);
    existing.claimedTabIds ??= [];
    if (!existing.claimedTabIds.includes(tab.id)) existing.claimedTabIds.push(tab.id);
    await writeSessions(chromeApi, sessions);
    return { claimed: true, tabId: tab.id, windowId: tab.windowId, generation: existing.generation };
  }
  if (request.action === "release") {
    existing.claimedTabIds = (existing.claimedTabIds ?? []).filter((id) => id !== request.tabId);
    await writeSessions(chromeApi, sessions);
    return { released: true, tabId: request.tabId };
  }
  if (request.action === "context") {
    const tab = await exactTab(chromeApi, request);
    return handlePageRequest(chromeApi, { action: "content", tabId: tab.id, format: "text", maxChars: 45_000 }, { ...existing, tabIds: [tab.id], claimedTabIds: [tab.id] });
  }
  if (request.action === "tab") {
    const tab = await chromeApi.tabs.get(request.tabId);
    if (!existing.tabIds?.includes(tab.id) && !existing.claimedTabIds?.includes(tab.id)) throw new Error("Tab is not controlled by this session");
    const window = await chromeApi.windows.get(tab.windowId);
    return { tabId: tab.id, windowId: tab.windowId, groupId: tab.groupId, title: tab.title ?? "", url: tab.url ?? "", active: Boolean(tab.active), focused: Boolean(window.focused), visible: Boolean(tab.active && window.focused), pinned: Boolean(tab.pinned), generation: existing.generation };
  }
  if (request.action === "closeTab") {
    if (!existing.tabIds?.includes(request.tabId)) throw new Error("Tab is not owned by this session");
    await chromeApi.tabs.remove(request.tabId);
    existing.tabIds = existing.tabIds.filter((id) => id !== request.tabId);
    if (existing.marks) delete existing.marks[request.tabId];
    await writeSessions(chromeApi, sessions);
    return { closed: true, tabId: request.tabId };
  }
  if (request.action === "mark") {
    if (!existing.tabIds?.includes(request.tabId) || !["deliverable", "handoff"].includes(request.mark)) throw new Error("Only owned tabs can be preserved");
    existing.marks ??= {};
    existing.marks[request.tabId] = request.mark;
    await writeSessions(chromeApi, sessions);
    return { marked: request.mark, tabId: request.tabId };
  }
  if (request.action === "open") {
    const group = await matchingGroup(chromeApi, existing);
    if (!group) throw new Error("Browser group is no longer available");
    const tab = await chromeApi.tabs.create({ url: request.url, active: false, windowId: group.windowId });
    try {
      await chromeApi.tabs.group({ tabIds: tab.id, groupId: existing.groupId });
      existing.tabIds.push(tab.id);
      await writeSessions(chromeApi, sessions);
      return { groupId: existing.groupId, tabId: tab.id, windowId: group.windowId, label: existing.label };
    } catch (error) { await chromeApi.tabs.remove(tab.id).catch(() => {}); throw error; }
  }
  if (PAGE_ACTIONS.includes(request.action)) return handlePageRequest(chromeApi, request, existing);
  throw new Error("Invalid page request");
}
