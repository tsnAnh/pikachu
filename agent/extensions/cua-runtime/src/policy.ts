import { createHash, randomUUID } from "node:crypto";
import type { JsonObject, JsonValue } from "./types.js";

export type RiskCategory =
  | "delete"
  | "external-communication"
  | "financial"
  | "permission"
  | "sensitive-data"
  | "software-install"
  | "upload"
  | "download";

export interface ConfirmationRequest {
  category: RiskCategory;
  action: string;
  destination: string;
  data?: string;
  session?: string;
  target?: string;
}

type Receipt = { fingerprint: string; expiresAt: number };

const CONSEQUENCE = /\b(delete|remove|erase|cancel|unsubscribe|send|submit|post|publish|comment|reply|like|react|follow|buy|purchase|pay|checkout|confirm order|book|reserve|share|invite|install|allow|grant|save password|change password)\b/i;

export class ActionPolicy {
  private receipts = new Map<string, Receipt>();

  classify(method: string, args: JsonValue[]): ConfirmationRequest | undefined {
    const objects = args.filter((value): value is JsonObject => Boolean(value) && typeof value === "object" && !Array.isArray(value));
    const input = Object.assign({}, ...objects) as JsonObject;
    const label = [input.name, input.label, input.text, input.action, input.selector, input.url, ...args.filter((value): value is string => typeof value === "string")]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    if (method === "tab.upload" || method === "tab.setInputFiles") return this.request("upload", "Upload local files", String(input.url ?? "the current website"), "Selected local files");
    if (method === "tab.download") return this.request("download", "Download a file", String(input.destinationRoot ?? "the approved directory"));
    if (method === "tab.export") return this.request("download", "Export browser content to a local file", "~/.pi/agent/assets");
    if (method === "tab.clipboard" && input.method === "write" || method === "app.clipboardWrite") return this.request("sensitive-data", "Write data to the shared clipboard", "system clipboard", "Clipboard contents");
    if (method === "app.kill") return this.request("delete", "Force quit an application", String(input.name ?? input.pid ?? "application"));
    if (method === "tab.dialog" && args[1] === "accept") return this.request("external-communication", "Accept a website dialog", String(input.origin ?? "the current website"));
    if (method === "browser.management" && args[0] === "bookmarks" && /remove/i.test(String(args[1]))) return this.request("delete", "Delete a bookmark", String(input.id ?? "bookmark"));
    if (method === "browser.management" && ["tabs", "windows"].includes(String(args[0])) && /remove/i.test(String(args[1]))) return this.request("delete", `Remove browser ${String(args[0]).slice(0, -1)}`, String(input.id ?? input.tabId ?? input.windowId ?? "browser item"));
    if ((method === "tab.ax.click" || method === "tab.locator" || method === "tab.dom" || method === "app.action") && CONSEQUENCE.test(label)) {
      const category: RiskCategory = /buy|purchase|pay|checkout|order/i.test(label) ? "financial"
        : /install/i.test(label) ? "software-install"
          : /allow|grant|permission/i.test(label) ? "permission"
            : /delete|remove|erase|cancel|unsubscribe/i.test(label) ? "delete"
              : "external-communication";
      return this.request(category, `Activate “${label.slice(0, 120)}”`, String(input.origin ?? "the current website"));
    }
    return undefined;
  }

  issue(request: ConfirmationRequest): string {
    this.prune();
    const receipt = randomUUID();
    this.receipts.set(receipt, { fingerprint: fingerprint(request), expiresAt: Date.now() + 120_000 });
    return receipt;
  }

  consume(receipt: string | undefined, request: ConfirmationRequest): boolean {
    this.prune();
    if (!receipt) return false;
    const stored = this.receipts.get(receipt);
    this.receipts.delete(receipt);
    return stored?.fingerprint === fingerprint(request) && stored.expiresAt >= Date.now();
  }

  reset(): void { this.receipts.clear(); }

  private request(category: RiskCategory, action: string, destination: string, data?: string): ConfirmationRequest {
    return { category, action, destination, ...(data ? { data } : {}) };
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, value] of this.receipts) if (value.expiresAt < now) this.receipts.delete(id);
  }
}

function fingerprint(request: ConfirmationRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}
