#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const socketPath = process.env.PI_BROWSER_GROUP_SOCKET ?? join(homedir(), ".pi", "agent", "browser-group.sock");
const MAX_MESSAGE = 2_000_000;
const TIMEOUT_MS = 60_000;
const clients = new Set();
const pending = new Map();
const sessionOwners = new Map();
let nextId = 1;
let input = Buffer.alloc(0);

function sendToChrome(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_MESSAGE) throw new Error("Browser group request is too large");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

function reply(client, id, payload) {
  if (!client.destroyed) client.write(`${JSON.stringify({ id, ...payload })}\n`);
}

function sendCleanup(session) {
  try { sendToChrome({ id: `cleanup-${nextId++}`, action: "close", session, preserveMarked: true }); } catch { /* Chrome is exiting. */ }
}

function handleChromeMessage(message) {
  if (message?.event === "tabVisibility") {
    if (typeof message.session !== "string" || !/^[a-f0-9-]{36}$/.test(message.session) ||
        !Number.isInteger(message.tabId) || !Number.isInteger(message.windowId) || typeof message.visible !== "boolean") return;
    const owner = sessionOwners.get(message.session);
    if (owner) reply(owner, undefined, { event: "tabVisibility", session: message.session, tabId: message.tabId, windowId: message.windowId, visible: message.visible });
    return;
  }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.ok && ["begin", "create"].includes(entry.action)) {
    if (entry.client.destroyed) sendCleanup(entry.session);
    else {
      entry.client.owned.add(entry.session);
      sessionOwners.set(entry.session, entry.client);
    }
  }
  if (message.ok && entry.action === "close") {
    entry.client.owned.delete(entry.session);
    sessionOwners.delete(entry.session);
  }
  reply(entry.client, entry.clientId, message.ok ? { ok: true, result: message.result } : { ok: false, error: message.error ?? "Browser group failed" });
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (length > MAX_MESSAGE) process.exit(1);
    if (input.length < 4 + length) break;
    const body = input.subarray(4, 4 + length);
    input = input.subarray(4 + length);
    try { handleChromeMessage(JSON.parse(body.toString("utf8"))); } catch { /* Ignore malformed extension responses. */ }
  }
});

function handleClient(client) {
  client.owned = new Set();
  clients.add(client);
  let buffer = "";
  client.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer) > MAX_MESSAGE) { client.destroy(); return; }
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const request = JSON.parse(line);
        if (typeof request.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(request.id)) throw new Error("Invalid request ID");
        if (typeof request.session !== "string" || !/^[a-f0-9-]{36}$/.test(request.session)) throw new Error("Invalid browser session ID");
        const allowed = ["begin", "create", "open", "close", "inventory", "claim", "release", "context", "tab", "closeTab", "mark", "management", "navigate", "back", "forward", "reload", "snapshot", "click", "fill", "press", "key", "typeText", "scroll", "screenshot", "locator", "evaluate", "logs", "content", "clipboard"];
        if (!allowed.includes(request.action)) throw new Error("Invalid browser action");
        const opening = ["begin", "create"].includes(request.action) && !client.owned.has(request.session);
        if (opening && (sessionOwners.has(request.session) || [...pending.values()].some((entry) => ["begin", "create"].includes(entry.action) && entry.session === request.session))) throw new Error("Browser session already exists");
        if (!opening && !client.owned.has(request.session)) throw new Error("Browser session is not owned by this client");
        const id = String(nextId++);
        const timer = setTimeout(() => {
          pending.delete(id);
          if (["begin", "create"].includes(request.action)) sendCleanup(request.session);
          reply(client, request.id, { ok: false, error: "Browser group timed out" });
        }, TIMEOUT_MS);
        pending.set(id, { client, clientId: request.id, action: request.action, session: request.session, timer });
        sendToChrome({ ...request, id });
      } catch (error) {
        let responseId = "invalid";
        try { responseId = typeof JSON.parse(line).id === "string" ? JSON.parse(line).id : responseId; } catch { /* malformed JSON */ }
        reply(client, responseId, { ok: false, error: error instanceof Error ? error.message : "Invalid request" });
      }
    }
  });
  client.on("close", () => {
    clients.delete(client);
    for (const session of client.owned) { sessionOwners.delete(session); sendCleanup(session); }
    for (const [id, entry] of pending) {
      if (entry.client === client) {
        if (["begin", "create"].includes(entry.action)) sendCleanup(entry.session);
        clearTimeout(entry.timer);
        pending.delete(id);
      }
    }
  });
  client.on("error", () => {});
}

mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
if (existsSync(socketPath)) {
  const stat = lstatSync(socketPath);
  if (!stat.isSocket()) throw new Error("Browser group socket path is occupied");
  const probe = createConnection(socketPath);
  probe.once("connect", () => { probe.destroy(); process.exit(1); });
  probe.once("error", () => {
    unlinkSync(socketPath);
    start();
  });
} else start();

function start() {
  const server = createServer(handleClient);
  server.listen(socketPath, () => chmodSync(socketPath, 0o600));
  process.stdin.on("end", () => {
    for (const client of clients) client.destroy();
    server.close();
  });
  process.on("exit", () => {
    try { if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath); } catch { /* Already gone. */ }
  });
}
