import assert from "node:assert/strict";
import test from "node:test";
import { cleanupAll, controlledTabVisibilityEvents, handleGroupRequest } from "../extension/group-lifecycle.js";

function fakeChrome() {
  const tabs = new Map([[1, { id: 1, groupId: -1, title: "User tab", url: "https://user.example", active: true, windowId: 1 }]]);
  const windows = new Map([[1, { id: 1, focused: true, state: "normal" }]]);
  const groups = new Map();
  let nextTab = 2;
  let nextGroup = 1;
  let storage = { pikachu_browser_group_sessions: {} };
  const commands = [];
  const bookmarks = new Map([["b1", { id: "b1", title: "Example", url: "https://example.com" }]]);
  const chrome = {
    tabs: {
      async query() { return [...tabs.values()]; },
      async create(options) {
        const tab = { id: nextTab++, groupId: -1, windowId: options.windowId ?? 1, status: "complete", active: true, ...options };
        tabs.set(tab.id, tab);
        return tab;
      },
      async group({ tabIds, groupId }) {
        if (groupId === undefined) { groupId = nextGroup++; groups.set(groupId, { id: groupId, title: "", windowId: tabs.get(tabIds).windowId }); }
        tabs.get(tabIds).groupId = groupId;
        return groupId;
      },
      async get(id) { if (!tabs.has(id)) throw new Error("No tab"); return tabs.get(id); },
      async remove(id) {
        const groupId = tabs.get(id)?.groupId;
        tabs.delete(id);
        if (groupId !== -1 && ![...tabs.values()].some((tab) => tab.groupId === groupId)) groups.delete(groupId);
      },
    },
    windows: {
      async get(id) { if (!windows.has(id)) throw new Error("No window"); return windows.get(id); },
      async getAll() { return [...windows.values()]; },
    },
    tabGroups: {
      async get(id) { if (!groups.has(id)) throw new Error("No group"); return groups.get(id); },
      async update(id, change) { Object.assign(groups.get(id), change); return groups.get(id); },
    },
    debugger: {
      async attach(target) { commands.push({ method: "attach", tabId: target.tabId }); },
      async detach(target) { commands.push({ method: "detach", tabId: target.tabId }); },
      async sendCommand(target, method, params) {
        commands.push({ method, tabId: target.tabId, params });
        if (method === "Runtime.evaluate") {
          if (params.expression === "location.href") return { result: { value: "https://example.com" } };
          return { result: { value: params.expression.includes("snapshotPage")
            ? { title: "Silksong", url: "https://example.com", text: "A post", elements: [], truncated: false }
            : { x: 40, y: 50 } } };
        }
        if (method === "Page.getNavigationHistory") return { currentIndex: 1, entries: [
          { id: 10, url: "https://example.com/feed" }, { id: 11, url: "https://example.com/post" },
        ] };
        return {};
      },
    },
    bookmarks: {
      async get(id) { return [bookmarks.get(id)]; },
      async remove(id) { bookmarks.delete(id); },
      async search() { return [...bookmarks.values()]; },
    },
    storage: { local: {
      async get(key) { return typeof key === "string" ? { [key]: storage[key] } : { ...storage }; },
      async set(value) { storage = { ...storage, ...value }; },
    } },
  };
  return { chrome, tabs, windows, groups, commands, bookmarks, getStorage: () => storage };
}

const session = "11111111-1111-4111-8111-111111111111";

test("creates named background group and closes only its owned tabs", async () => {
  const { chrome, tabs, windows, groups } = fakeChrome();
  const created = await handleGroupRequest(chrome, { action: "create", session, label: "🔎 Silksong", url: "https://www.reddit.com/r/Silksong" });
  assert.equal(tabs.get(created.tabId).active, false);
  assert.equal(tabs.get(created.tabId).windowId, 1);
  assert.equal(groups.get(created.groupId).title, "🔎 Silksong");
  const opened = await handleGroupRequest(chrome, { action: "open", session, url: "https://www.reddit.com/r/Silksong/comments/example" });
  assert.equal(tabs.get(opened.tabId).groupId, created.groupId);
  assert.equal(tabs.get(opened.tabId).active, false);
  const closed = await handleGroupRequest(chrome, { action: "close", session });
  assert.deepEqual(closed, { closed: true });
  assert.deepEqual([...tabs.keys()], [1]);
  assert.deepEqual([...windows.keys()], [1]);
  assert.equal(groups.size, 0);
});

test("inventories without claiming, claims exact identity, and releases without changing the tab", async () => {
  const { chrome, tabs } = fakeChrome();
  await handleGroupRequest(chrome, { action: "begin", session });
  const inventory = await handleGroupRequest(chrome, { action: "inventory", session });
  assert.equal(inventory.tabs.length, 1);
  assert.equal(typeof inventory.instanceId, "string");
  await assert.rejects(handleGroupRequest(chrome, { action: "claim", session, tabId: 1, windowId: 1, title: "wrong", url: "https://user.example" }), /title identity changed/);
  const claimed = await handleGroupRequest(chrome, { action: "claim", session, tabId: 1, windowId: 1, title: tabs.get(1).title, url: "https://user.example" });
  assert.equal(claimed.claimed, true);
  const released = await handleGroupRequest(chrome, { action: "release", session, tabId: 1 });
  assert.equal(released.released, true);
  assert.equal(tabs.has(1), true);
});

test("preserves marked owned tabs and removes unmarked tabs on cleanup", async () => {
  const { chrome, tabs } = fakeChrome();
  const created = await handleGroupRequest(chrome, { action: "create", session, label: "Agent", url: "about:blank" });
  const opened = await handleGroupRequest(chrome, { action: "open", session, url: "https://example.com" });
  await handleGroupRequest(chrome, { action: "mark", session, tabId: created.tabId, mark: "handoff" });
  const closed = await handleGroupRequest(chrome, { action: "close", session, preserveMarked: true });
  assert.deepEqual(closed.preserved, [created.tabId]);
  assert.equal(tabs.has(created.tabId), true);
  assert.equal(tabs.has(opened.tabId), false);
  await cleanupAll(chrome, { preserveMarked: false });
  assert.equal(tabs.has(created.tabId), false);
});

test("management records bounded before-state and undo data", async () => {
  const { chrome, bookmarks, getStorage } = fakeChrome();
  await handleGroupRequest(chrome, { action: "begin", session });
  const result = await handleGroupRequest(chrome, { action: "management", session, namespace: "bookmarks", method: "remove", args: ["b1"] });
  assert.equal(result.before[0].title, "Example");
  assert.equal(bookmarks.has("b1"), false);
  const audit = getStorage().pikachu_browser_group_audit;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].undo.method, "restore");
});

test("cleanup leaves a tab moved out of the group and rejects unsafe URLs", async () => {
  const { chrome, tabs } = fakeChrome();
  const created = await handleGroupRequest(chrome, { action: "create", session, label: "Agent", url: "about:blank" });
  tabs.get(created.tabId).groupId = -1;
  await cleanupAll(chrome);
  assert.equal(tabs.has(created.tabId), true);
  await assert.rejects(handleGroupRequest(chrome, { action: "create", session, label: "Agent", url: "chrome://settings" }), /Only HTTP/);
});

test("closing a group preserves a user tab added to its window", async () => {
  const { chrome, tabs, windows } = fakeChrome();
  const created = await handleGroupRequest(chrome, { action: "create", session, label: "Agent", url: "https://example.com" });
  const windowId = tabs.get(created.tabId).windowId;
  const userTab = await chrome.tabs.create({ windowId, url: "https://user.example/other", active: false });
  const closed = await handleGroupRequest(chrome, { action: "close", session });
  assert.deepEqual(closed, { closed: true });
  assert.equal(tabs.has(created.tabId), false);
  assert.equal(tabs.has(userTab.id), true);
  assert.equal(windows.has(windowId), true);
});

test("page actions keep working when the user opens the controlled tab", async () => {
  const { chrome, tabs, windows, commands } = fakeChrome();
  const created = await handleGroupRequest(chrome, { action: "create", session, label: "Agent", url: "https://example.com" });
  const observed = await handleGroupRequest(chrome, { action: "snapshot", session, tabId: created.tabId });
  assert.equal(observed.text, "A post");
  await handleGroupRequest(chrome, { action: "click", session, tabId: created.tabId, selector: "button" });
  const back = await handleGroupRequest(chrome, { action: "back", session, tabId: created.tabId });
  assert.equal(back.url, "https://example.com/feed");
  assert.deepEqual(commands.find((entry) => entry.method === "Page.navigateToHistoryEntry")?.params, { entryId: 10 });
  assert.equal(tabs.get(1).active, true);
  assert.equal(tabs.get(created.tabId).active, false);
  assert.deepEqual(commands.filter((entry) => entry.method === "attach" || entry.method === "detach").map(({ method, tabId }) => [method, tabId]), [
    ["attach", created.tabId], ["detach", created.tabId], ["attach", created.tabId], ["detach", created.tabId],
    ["attach", created.tabId], ["detach", created.tabId],
  ]);
  await assert.rejects(handleGroupRequest(chrome, { action: "snapshot", session, tabId: 1 }), /not owned/);
  await assert.rejects(handleGroupRequest(chrome, { action: "navigate", session, tabId: created.tabId, url: "chrome://settings" }), /Only HTTP/);
  tabs.get(created.tabId).active = true;
  tabs.get(1).active = false;
  const foreground = await handleGroupRequest(chrome, { action: "snapshot", session, tabId: created.tabId });
  assert.equal(foreground.text, "A post");
  const tabState = await handleGroupRequest(chrome, { action: "tab", session, tabId: created.tabId });
  assert.deepEqual({ active: tabState.active, focused: tabState.focused, visible: tabState.visible }, { active: true, focused: true, visible: true });
  windows.get(tabs.get(created.tabId).windowId).focused = false;
  await handleGroupRequest(chrome, { action: "snapshot", session, tabId: created.tabId });
  tabs.get(created.tabId).groupId = -1;
  await assert.rejects(handleGroupRequest(chrome, { action: "snapshot", session, tabId: created.tabId }), /no longer in/);
  assert.equal(commands.filter((entry) => entry.method === "attach").length, 5);
});

test("reports visibility changes only for controlled tabs", async () => {
  const { chrome, tabs, windows } = fakeChrome();
  const created = await handleGroupRequest(chrome, { action: "create", session, label: "Agent", url: "https://example.com" });
  assert.deepEqual(await controlledTabVisibilityEvents(chrome, { windowId: 1 }), [{
    event: "tabVisibility", session, tabId: created.tabId, windowId: 1, visible: false,
  }]);
  tabs.get(1).active = false;
  tabs.get(created.tabId).active = true;
  assert.equal((await controlledTabVisibilityEvents(chrome))[0].visible, true);
  windows.get(1).focused = false;
  assert.equal((await controlledTabVisibilityEvents(chrome))[0].visible, false);
});
