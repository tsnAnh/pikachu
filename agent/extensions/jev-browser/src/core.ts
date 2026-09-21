export const TEXT_MODEL_PROVIDER = "openai-codex";
export const TEXT_MODEL_ID = "gpt-5.6-sol";
export const MAX_FIELD_TEXT = 2_000;
export const MAX_STDERR = 4_000;

export const BROWSER_USE_MODEL = `${TEXT_MODEL_PROVIDER}/${TEXT_MODEL_ID}`;
export const MAX_MODEL_MESSAGES = 80;
export const MAX_MODEL_TEXT = 500_000;
export const MAX_MODEL_IMAGE = 5_000_000;
export const MAX_MODEL_SCHEMA = 100_000;
export const MAX_MODEL_RESPONSE = 200_000;

export type BrowserEngine = "browser-use" | "jev";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function selectEngine(value: unknown): BrowserEngine {
  if (value === undefined || value === "browser-use") return "browser-use";
  if (value === "jev") return "jev";
  throw new Error('engine must be "browser-use" or "jev"');
}

export function parseModelJson(raw: string, max = MAX_MODEL_RESPONSE): JsonValue {
  if (raw.length > max) throw new Error(`Model response exceeded ${max} characters`);
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    throw new Error("Browser Use model returned invalid JSON");
  }
}
export interface BridgeMessage {
  type: string;
  [key: string]: unknown;
}

export function parseBridgeLine(line: string): BridgeMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Jev browser emitted invalid bridge JSON");
  }
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
    throw new Error("Jev browser emitted an invalid bridge message");
  }
  return value as BridgeMessage;
}

export function parseTextModelOutput(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Sol text helper returned invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sol text helper must return an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.text !== "string") {
    throw new Error('Sol text helper must return exactly {"text":"..."}');
  }
  if (!record.text.trim()) throw new Error("Sol text helper returned empty text");
  if (record.text.length > MAX_FIELD_TEXT) throw new Error(`Sol text helper exceeded ${MAX_FIELD_TEXT} characters`);
  return record.text;
}

export function isPlanMode(entries: readonly unknown[]): boolean {
  let enabled = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (item.type !== "custom" || item.customType !== "pi-cfg-plan-mode-v1" || !item.data || typeof item.data !== "object") continue;
    const data = item.data as { version?: unknown; enabled?: unknown };
    if (data.version === 1 && typeof data.enabled === "boolean") enabled = data.enabled;
  }
  return enabled;
}

export function safeEnvironment(source: NodeJS.ProcessEnv, includeTypesafe = true): NodeJS.ProcessEnv {
  const allowed = ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "DISPLAY", "XDG_RUNTIME_DIR"];
  if (includeTypesafe) allowed.push("TYPESAFE_API_KEY", "TYPESAFE_MODEL");
  return Object.fromEntries(allowed.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])));
}

export function boundedError(text: string): string {
  const clean = text.trim();
  return clean.length <= MAX_STDERR ? clean : `${clean.slice(0, MAX_STDERR)}…`;
}
