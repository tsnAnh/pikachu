import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

test("native host relays a create and cleans the group when Pi disconnects", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pikachu-browser-group-"));
  const socketPath = join(directory, "bridge.sock");
  const child = spawn(process.execPath, [new URL("../native-host.mjs", import.meta.url).pathname], {
    env: { ...process.env, PI_BROWSER_GROUP_SOCKET: socketPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  });

  let bytes = Buffer.alloc(0);
  const messages = [];
  child.stdout.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32LE(0)) {
      const length = bytes.readUInt32LE(0);
      messages.push(JSON.parse(bytes.subarray(4, 4 + length).toString()));
      bytes = bytes.subarray(4 + length);
    }
  });
  async function nextMessage() {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (messages.length) return messages.shift();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("No native message");
  }

  let client;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { client = createConnection(socketPath); await once(client, "connect"); break; }
    catch { client?.destroy(); await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.ok(client, "native host socket started");
  const session = "11111111-1111-4111-8111-111111111111";
  client.write(`${JSON.stringify({ id: "client-1", action: "create", session, label: "Agent", url: "about:blank" })}\n`);
  const request = await nextMessage();
  assert.equal(request.action, "create");
  assert.equal(request.session, session);
  child.stdin.write(frame({ id: request.id, ok: true, result: { groupId: 8, tabId: 9, label: "Agent" } }));
  const [response] = await once(client, "data");
  assert.equal(JSON.parse(response.toString()).result.tabId, 9);
  child.stdin.write(frame({ event: "tabVisibility", session, tabId: 9, windowId: 4, visible: true }));
  const [visibility] = await once(client, "data");
  assert.deepEqual(JSON.parse(visibility.toString()), { event: "tabVisibility", session, tabId: 9, windowId: 4, visible: true });
  const otherClient = createConnection(socketPath);
  await once(otherClient, "connect");
  otherClient.write(`${JSON.stringify({ id: "other-1", action: "snapshot", session, tabId: 9 })}\n`);
  const [denial] = await once(otherClient, "data");
  assert.match(JSON.parse(denial.toString()).error, /not owned/);
  otherClient.destroy();
  assert.equal(messages.length, 0, "unowned request never reaches Chrome");
  client.write(`${JSON.stringify({ id: "client-2", action: "snapshot", session, tabId: 9 })}\n`);
  const pageRequest = await nextMessage();
  assert.deepEqual({ action: pageRequest.action, tabId: pageRequest.tabId }, { action: "snapshot", tabId: 9 });
  const pageText = "Silksong ".repeat(4000);
  const pageReply = new Promise((resolve) => {
    let line = "";
    const receive = (chunk) => {
      line += chunk.toString();
      if (line.includes("\n")) { client.off("data", receive); resolve(JSON.parse(line.trim())); }
    };
    client.on("data", receive);
  });
  child.stdin.write(frame({ id: pageRequest.id, ok: true, result: { tabId: 9, text: pageText } }));
  assert.equal((await pageReply).result.text, pageText);
  client.destroy();
  const cleanup = await nextMessage();
  assert.deepEqual({ action: cleanup.action, session: cleanup.session }, { action: "close", session });
});
