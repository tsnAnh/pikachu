import { cleanupAll, controlledTabVisibilityEvents, handleGroupRequest } from "./group-lifecycle.js";

const HOST = "com.pikachu.browser_group";
let port;
let work = Promise.resolve();
let initialization;

function connect() {
  if (port) return;
  let connection;
  try { connection = chrome.runtime.connectNative(HOST); }
  catch { setTimeout(connect, 5000); return; }
  port = connection;
  connection.onMessage.addListener((message) => {
    work = work.catch(() => {}).then(async () => {
      try {
        const result = await handleGroupRequest(chrome, message);
        if (port === connection) connection.postMessage({ id: message.id, ok: true, result });
      } catch (error) {
        if (port === connection) connection.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : "Browser group failed" });
      }
    });
  });
  connection.onDisconnect.addListener(() => {
    if (port !== connection) return;
    port = undefined;
    work = work.catch(() => {}).then(() => cleanupAll(chrome)).catch(() => {}).finally(() => setTimeout(connect, 2000));
  });
}

async function publishTabVisibility(filter = {}) {
  if (!port) return;
  const events = await controlledTabVisibilityEvents(chrome, filter);
  for (const event of events) port?.postMessage(event);
}

function initialize() {
  if (!initialization) initialization = cleanupAll(chrome).catch(() => {}).finally(connect);
}

chrome.runtime.onStartup.addListener(initialize);
chrome.runtime.onInstalled.addListener(initialize);
chrome.tabs.onActivated.addListener(({ windowId }) => { publishTabVisibility({ windowId }).catch(() => {}); });
chrome.windows.onFocusChanged.addListener(() => { publishTabVisibility().catch(() => {}); });
initialize();
