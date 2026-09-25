#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const socketPath = process.env.PI_BROWSER_GROUP_SOCKET ?? join(homedir(), ".pi", "agent", "browser-group.sock");
const expected = process.argv[2] ?? JSON.parse(readFileSync(new URL("./extension/manifest.json", import.meta.url), "utf8")).version;
const socket = createConnection(socketPath);
let buffer = "";
const session = randomUUID();
const pending = new Map();
const timeout = setTimeout(() => finish(new Error("Chrome bridge handshake timed out")), 3000);

socket.on("connect", () => request("begin").then(() => request("inventory")).then(async (inventory) => {
  if (inventory.bridgeVersion !== expected) throw new Error(`Chrome extension ${expected} is not active (reported ${inventory.bridgeVersion ?? "unknown"})`);
  await request("close", { preserveMarked: true });
  process.stdout.write(`${inventory.bridgeVersion}\n`);
  finish();
}).catch(finish));
socket.on("data", chunk => {
  buffer += chunk.toString("utf8");
  while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try {
      const message = JSON.parse(line); const entry = pending.get(message.id); if (!entry) continue;
      pending.delete(message.id); message.ok ? entry.resolve(message.result ?? {}) : entry.reject(new Error(message.error ?? "Chrome bridge failed"));
    } catch (error) { finish(error); }
  }
});
socket.on("error", finish);

function request(action, extra = {}) {
  const id = randomUUID();
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.write(`${JSON.stringify({ id, action, session, ...extra })}\n`); });
}

function finish(error) {
  clearTimeout(timeout); socket.destroy();
  if (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
