import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import AjvModule from "ajv";
import type { JsonObject, JsonValue, RuntimeImage } from "./types.js";
import { toJsonValue } from "./types.js";

export interface DriverResponse {
  data: JsonValue;
  text: string[];
  images: RuntimeImage[];
}

export interface DriverClientOptions {
  command?: string;
  args?: string[];
  session?: string;
}

export class DriverClient {
  readonly session: string;
  private client?: Client;
  private transport?: StdioClientTransport;
  private connecting?: Promise<void>;
  private toolNames = new Set<string>();

  constructor(private readonly options: DriverClientOptions = {}) {
    this.session = options.session ?? `pi-${randomUUID().slice(0, 12)}`;
  }

  private async connect(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: this.options.command ?? process.env.CUA_DRIVER_BIN ?? "cua-driver",
        args: this.options.args ?? ["mcp"],
        stderr: "pipe",
      });
      const Ajv = ((AjvModule as unknown as { default?: new (options?: object) => any }).default ?? AjvModule) as unknown as new (options?: object) => any;
      const ajv = new Ajv({ strict: false, allErrors: true });
      ajv.addFormat("uint32", { type: "number", validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff });
      ajv.addFormat("uint64", { type: "number", validate: (value: number) => Number.isSafeInteger(value) && value >= 0 });
      ajv.addFormat("int32", { type: "number", validate: (value: number) => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff });
      ajv.addFormat("int64", { type: "number", validate: (value: number) => Number.isSafeInteger(value) });
      ajv.addFormat("double", { type: "number", validate: (value: number) => Number.isFinite(value) });
      const client = new Client({ name: "pikachu-cua-runtime", version: "1.0.0" }, { jsonSchemaValidator: new AjvJsonSchemaValidator(ajv) });
      await client.connect(transport);
      const tools = await client.listTools();
      this.toolNames = new Set(tools.tools.map((tool) => tool.name));
      this.transport = transport;
      this.client = client;
    })();
    try { await this.connecting; }
    finally { this.connecting = undefined; }
  }

  async availableTools(): Promise<string[]> {
    await this.connect();
    return [...this.toolNames].sort();
  }

  async call(name: string, args: JsonObject = {}, signal?: AbortSignal): Promise<DriverResponse> {
    await this.connect();
    if (!this.toolNames.has(name)) throw new Error(`Cua Driver tool is unavailable: ${name}`);
    const parameters = { ...args, ...("session" in args ? {} : { session: this.session }) };
    const result = await this.client!.callTool(
      { name, arguments: parameters as Record<string, unknown> },
      undefined,
      signal ? { signal, timeout: 300_000 } : { timeout: 300_000 },
    );
    const text: string[] = [];
    const images: RuntimeImage[] = [];
    const contentItems = Array.isArray(result.content) ? result.content : [];
    for (const content of contentItems as Array<{ type: string; text?: string; data?: string; mimeType?: string }>) {
      if (content.type === "text" && typeof content.text === "string") text.push(content.text);
      else if (content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string") images.push({ data: content.data, mimeType: content.mimeType });
    }
    if (result.isError) throw new Error(text.find((value) => value.trim()) ?? `${name} failed`);
    const structured = result.structuredContent;
    const data = structured && typeof structured === "object" ? toJsonValue(structured) : toJsonValue({ text });
    const record = data && typeof data === "object" && !Array.isArray(data) ? data as JsonObject : undefined;
    if (record?.status === "refused" || record?.refusal) {
      throw new Error(`Cua Driver refused ${name}: ${JSON.stringify(record.refusal ?? record)}`);
    }
    return { data, text, images };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      try { await this.callEndSession(client); } catch { /* Transport cleanup still runs. */ }
      try { await client.close(); } catch { /* Already disconnected. */ }
    }
    this.toolNames.clear();
    this.transport = undefined;
  }

  private async callEndSession(client: Client): Promise<void> {
    if (!this.toolNames.has("end_session")) return;
    await client.callTool({ name: "end_session", arguments: { session: this.session } }, undefined, { timeout: 10_000 });
  }
}
