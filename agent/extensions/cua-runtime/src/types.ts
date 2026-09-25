export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface RuntimeImage {
  data: string;
  mimeType: string;
}

export interface HostOutput {
  text: string[];
  images: RuntimeImage[];
}

export interface HostRequest {
  method: string;
  args: JsonValue[];
}

export interface BrowserTabInfo {
  id: number;
  windowId: number;
  groupId: number;
  title: string;
  url: string;
  active: boolean;
  pinned: boolean;
  lastAccessed?: number;
}

export interface BrowserGroupResult {
  session?: string;
  groupId?: number;
  tabId?: number;
  label?: string;
  identity?: string;
  closed?: boolean;
  tabs?: JsonValue[];
  claimed?: boolean;
  released?: boolean;
  marked?: string;
  audit?: JsonValue[];
  [key: string]: JsonValue | undefined;
}

export function asObject(value: JsonValue | undefined, message = "Expected an object"): JsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value;
}

export function asString(value: JsonValue | undefined, message = "Expected a string"): string {
  if (typeof value !== "string" || !value) throw new Error(message);
  return value;
}

export function asNumber(value: JsonValue | undefined, message = "Expected a number"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(message);
  return value;
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) result[key] = toJsonValue(item);
    }
    return result;
  }
  return String(value);
}
