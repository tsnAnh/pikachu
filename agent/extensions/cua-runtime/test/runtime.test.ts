import assert from "node:assert/strict";
import test from "node:test";
import { GuestRuntime } from "../src/runtime.js";

function guest(overrides: { invoke?: (method: string, args: any[], signal?: AbortSignal) => Promise<any>; maxOutputBytes?: number; wallTimeMs?: number } = {}) {
  const output = { text: [] as string[], images: [] as Array<{ data: string; mimeType: string }> };
  return new GuestRuntime({
    invoke: overrides.invoke ?? (async (method, args) => {
      if (method === "write") { output.text.push(String(args[0])); return null; }
      if (method === "state") return { ready: true };
      if (method === "browser.list") return [{ id: "chrome" }];
      throw new Error(`unregistered:${method}`);
    }),
    takeOutput: () => {
      const copy = { text: [...output.text], images: [...output.images] };
      output.text.length = 0; output.images.length = 0;
      return copy;
    },
    maxOutputBytes: overrides.maxOutputBytes,
    wallTimeMs: overrides.wallTimeMs,
  });
}

test("persists top-level bindings and resets the isolate", async () => {
  const runtime = guest();
  assert.equal((await runtime.run("const answer = 40; answer + 2")).result, 42);
  assert.deepEqual(await runtime.run("nodeRepl.write(answer); await cua.getState()"), { result: { ready: true }, text: ["40"], images: [] });
  await runtime.reset();
  await assert.rejects(runtime.run("answer"), /not defined/);
  await runtime.reset();
});

test("preserves controller handles across separate REPL calls", async () => {
  const runtime = guest({ invoke: async (method, args) => {
    if (method === "browser.createTab") return { handle: "tab-1", id: "tab-1" };
    if (method === "tab.snapshot") {
      assert.equal(args[0], "tab-1");
      return { snapshot: { id: "snapshot-1" }, refs: [{ ref: "snapshot-1:0" }] };
    }
    if (method === "tab.ax.click") {
      assert.deepEqual(args.slice(0, 2), ["tab-1", "snapshot-1:0"]);
      return { cursorMoved: false };
    }
    throw new Error(`unexpected:${method}`);
  } });
  await runtime.run("globalThis.tab = cua.createBrowserTab('chrome', 'https://example.com')");
  await runtime.run("globalThis.state = globalThis.tab.getState()");
  assert.deepEqual((await runtime.run("globalThis.tab.ax.click({ref: globalThis.state.refs[0].ref})")).result, { cursorMoved: false });
  await runtime.reset();
});

test("accepts the object browser-tab form used by Sol and keeps the isolate reusable", async () => {
  const calls: any[][] = [];
  const runtime = guest({ invoke: async (method, args) => {
    if (method === "browser.createTab") {
      calls.push(args);
      return { handle: "tab-sol", id: "tab-sol" };
    }
    if (method === "tab.info") return { url: "https://old.reddit.com/r/Silksong/" };
    if (method === "write") return null;
    throw new Error(`unexpected:${method}`);
  } });

  try {
    await runtime.run(`
      var solTab = await cua.createBrowserTab({
        url: "https://old.reddit.com/r/Silksong/",
        sessionName: "Reddit live test"
      });
      nodeRepl.write((await solTab.info()).url)
    `);
    assert.deepEqual(calls, [["chrome", "https://old.reddit.com/r/Silksong/", { sessionName: "Reddit live test" }]]);
    assert.equal((await runtime.run("(await solTab.info()).url")).result, "https://old.reddit.com/r/Silksong/");
  } finally {
    await runtime.reset();
  }
});

test("keeps the isolate usable after a guest API error", async () => {
  const runtime = guest();
  await assert.rejects(runtime.run("await cua.getState(); throw new Error('guest failure')"), /guest failure/);
  assert.deepEqual((await runtime.run("cua.getState()")).result, { ready: true });
  await runtime.reset();
});

test("does not expose Node, network, module, or native globals", async () => {
  const runtime = guest();
  const result = await runtime.run("[typeof process, typeof require, typeof module, typeof Buffer, typeof fetch, typeof WebSocket, typeof Deno, typeof Bun]");
  assert.deepEqual(result.result, Array(8).fill("undefined"));
  await assert.rejects(runtime.run("import('node:fs')"), /dynamic import|module|unsupported/i);
  await runtime.reset();
});

test("enforces source, output, and execution limits", async () => {
  const sourceRuntime = guest();
  await assert.rejects(sourceRuntime.run("x".repeat(100_001)), /source exceeds/);
  await sourceRuntime.reset();

  const outputRuntime = guest({ maxOutputBytes: 20 });
  await assert.rejects(outputRuntime.run("nodeRepl.write('x'.repeat(100))"), /output exceeds/);
  await outputRuntime.reset();

  const timeRuntime = guest({ wallTimeMs: 20 });
  await assert.rejects(timeRuntime.run("while (true) {}"), /interrupted|execution/i);
  await timeRuntime.reset();
});

test("waits for an active host call to stop before disposing the isolate", async () => {
  const runtime = guest({ invoke: async (_method, _args, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("host call aborted")), { once: true });
  }) });
  const running = runtime.run("await cua.getState()");
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.reset();
  await assert.rejects(running, /aborted|interrupted/);
});

test("rejects unregistered host methods without escaping the guest", async () => {
  const runtime = guest();
  await assert.rejects(runtime.run("cua.getApp('Secret')"), /unregistered:app.get/);
  const state = await runtime.run("cua.getState()");
  assert.deepEqual(state.result, { ready: true });
  await runtime.reset();
});

test("exposes Codex-compatible browser object contracts", async () => {
  const calls: string[] = [];
  const runtime = guest({ invoke: async (method, args) => {
    calls.push(method);
    if (method === "browser.list") return [{ id: "chrome", name: "Google Chrome" }];
    if (method === "browser.get") return { id: "chrome", name: "Google Chrome" };
    if (method === "browser.createTab") return { handle: "tab-1", id: "tab-1" };
    if (method === "tab.info") return { title: "Example", url: "https://example.com" };
    if (method === "documentation") return "docs";
    return null;
  } });
  const result = await runtime.run(`
    const listed = await agent.browsers.list();
    const browser = await agent.browsers.get("chrome");
    const tab = await browser.tabs.new();
    ({ listed, browserId: browser.browserId, title: await tab.title(), url: await tab.url(), capabilities: await tab.capabilities.list(), docs: await (await tab.capabilities.get("ax")).documentation() })
  `);
  assert.deepEqual(result.result, { listed: [{ id: "chrome", name: "Google Chrome" }], browserId: "chrome", title: "Example", url: "https://example.com", capabilities: ["ax", "playwright", "cua", "dom_cua", "clipboard", "content", "dev"], docs: "docs" });
  assert.deepEqual(calls, ["browser.list", "browser.get", "browser.createTab", "tab.info", "tab.info", "documentation"]);
  await runtime.reset();
});
