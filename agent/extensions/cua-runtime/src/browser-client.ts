import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserGroupResult, JsonObject } from "./types.js";

type Pending = { resolve: (value: BrowserGroupResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class BrowserBridgeClient {
  private socket?: Socket;
  private connecting?: Promise<Socket>;
  private buffer = "";
  private pending = new Map<string, Pending>();
  private sessions = new Set<string>();
  private eventListeners = new Set<(event: JsonObject) => void>();

  constructor(private readonly socketPath = process.env.PI_BROWSER_GROUP_SOCKET ?? join(homedir(), ".pi", "agent", "browser-group.sock")) {}

  private async connect(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const timer = setTimeout(() => socket.destroy(new Error("Chrome bridge timed out")), 3_000);
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.on("data", (chunk: Buffer) => this.receive(chunk));
        socket.on("close", () => this.failPending(new Error("Chrome bridge disconnected")));
        socket.on("error", () => {});
        resolve(socket);
      });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    try { return await this.connecting; }
    finally { this.connecting = undefined; }
  }

  private receive(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer) > 2_000_000) { this.socket?.destroy(); return; }
    while (this.buffer.includes("\n")) {
      const end = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      try {
        const response = JSON.parse(line) as { id?: string; ok?: boolean; result?: BrowserGroupResult; error?: string; event?: string; [key: string]: unknown };
        if (response.event === "tabVisibility") {
          for (const listener of this.eventListeners) listener(response as JsonObject);
          continue;
        }
        if (typeof response.id !== "string") throw new Error("Chrome bridge response is missing an id");
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        if (response.ok) pending.resolve(response.result ?? {});
        else pending.reject(new Error(response.error ?? "Chrome bridge failed"));
      } catch { this.socket?.destroy(); return; }
    }
  }

  onEvent(listener: (event: JsonObject) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.socket = undefined;
    this.buffer = "";
  }

  async request(action: string, session: string, extra: JsonObject = {}, signal?: AbortSignal): Promise<BrowserGroupResult> {
    const socket = await this.connect();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const onAbort = () => socket.destroy(new Error("Chrome bridge request aborted"));
      const timer = setTimeout(() => socket.destroy(new Error("Chrome bridge request timed out")), 65_000);
      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener("abort", onAbort); resolve(value); },
        reject: (error) => { signal?.removeEventListener("abort", onAbort); reject(error); },
        timer,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else socket.write(`${JSON.stringify({ id, action, session, ...extra })}\n`);
    });
  }

  async create(label: string, identity: string, signal?: AbortSignal): Promise<{ session: string; result: BrowserGroupResult }> {
    const session = randomUUID();
    const result = await this.request("create", session, { label, url: "about:blank", identity }, signal);
    this.sessions.add(session);
    return { session, result };
  }

  adopt(session: string): void { this.sessions.add(session); }

  async closeTurn(): Promise<void> {
    for (const session of [...this.sessions]) {
      try { await this.request("close", session, { preserveMarked: true }); } catch { /* Disconnect cleanup owns the fallback. */ }
      this.sessions.delete(session);
    }
    this.socket?.destroy();
  }

  async closeAll(): Promise<void> {
    for (const session of [...this.sessions]) {
      try { await this.request("close", session, { preserveMarked: false }); } catch { /* Best effort during reset. */ }
      this.sessions.delete(session);
    }
    this.socket?.destroy();
  }
}
