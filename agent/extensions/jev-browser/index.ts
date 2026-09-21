import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  boundedError,
  BROWSER_USE_MODEL,
  isPlanMode,
  MAX_MODEL_IMAGE,
  MAX_MODEL_MESSAGES,
  MAX_MODEL_SCHEMA,
  MAX_MODEL_TEXT,
  parseBridgeLine,
  parseModelJson,
  parseTextModelOutput,
  safeEnvironment,
  selectEngine,
  TEXT_MODEL_ID,
  TEXT_MODEL_PROVIDER,
  type BridgeMessage,
  type BrowserEngine,
} from "./src/core.js";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const JEV_PYTHON = join(EXTENSION_DIR, ".upstream", ".venv", "bin", "python");
const JEV_RUNNER = join(EXTENSION_DIR, "runner.py");
const BROWSER_USE_PYTHON = join(EXTENSION_DIR, ".browser-use-upstream", ".venv", "bin", "python");
const BROWSER_USE_RUNNER = join(EXTENSION_DIR, "browser_use_runner.py");
const DEFAULT_TIMEOUT_SECONDS = 120;
let browserInUse = false;

const BrowserParams = Type.Object({
  url: Type.String({ description: "Initial http(s) URL" }),
  goal: Type.String({ description: "One narrow browser-automation goal with a visibly verifiable outcome" }),
  engine: Type.Optional(Type.Union([Type.Literal("browser-use"), Type.Literal("jev")], { description: "Default browser-use; use jev for the lower-overhead indexed-DOM engine" })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 15, maximum: 300, description: "Overall deadline; default 120 seconds" })),
}, { additionalProperties: false });

interface BrowserParamsValue {
  url: string;
  goal: string;
  engine?: BrowserEngine;
  timeoutSeconds?: number;
}
interface BrowserResult {
  type: "result";
  engine?: BrowserEngine;
  status: string;
  page_text?: string;
  final_result?: string;
  url: string;
  title?: string;
  elapsed_ms?: number;
  actions?: Array<{ step?: number; kind?: string; action?: string; text?: string; url?: string }>;
  errors?: string[];
  model?: string;
  text_models?: string[];
  tabs_before?: string[];
  tabs_after?: string[];
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") throw new Error("Sol text helper returned no message");
  const record = message as { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown };
  if (record.stopReason === "error") throw new Error(String(record.errorMessage || "Sol text helper failed"));
  if (!Array.isArray(record.content)) throw new Error("Sol text helper returned no content");
  return record.content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("")
    .trim();
}

async function generateFieldText(context: unknown, ctx: ExtensionContext, signal: AbortSignal): Promise<{ text: string; usage: unknown }> {
  const model = ctx.modelRegistry.find(TEXT_MODEL_PROVIDER, TEXT_MODEL_ID);
  if (!model) throw new Error(`${TEXT_MODEL_PROVIDER}/${TEXT_MODEL_ID} is unavailable`);
  const result = await ctx.modelRegistry.complete(
    model,
    {
      systemPrompt: 'Return strict JSON only, exactly {"text":"..."}. Choose the field value required by the browser goal. Do not add keys, Markdown, or explanation.',
      messages: [{ role: "user", content: JSON.stringify(context), timestamp: Date.now() }],
    },
    { reasoning: "low", maxTokens: 1_024, signal },
  );
  return { text: parseTextModelOutput(assistantText(result)), usage: (result as { usage?: unknown }).usage ?? {} };
}

async function generateBrowserUseCompletion(request: BridgeMessage, ctx: ExtensionContext, signal: AbortSignal): Promise<{ completion: unknown; usage: unknown }> {
  if (request.model !== BROWSER_USE_MODEL) throw new Error(`Browser Use requested unsupported model: ${String(request.model)}`);
  if (!Array.isArray(request.messages) || request.messages.length === 0 || request.messages.length > MAX_MODEL_MESSAGES) throw new Error("Browser Use sent an invalid or oversized message list");
  const schemaText = request.schema === null || request.schema === undefined ? "" : JSON.stringify(request.schema);
  if (schemaText.length > MAX_MODEL_SCHEMA) throw new Error("Browser Use output schema is too large");
  let totalText = 0;
  const systems: string[] = [];
  const messages: Array<{ role: "user"; content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; timestamp: number }> = [];
  for (const raw of request.messages) {
    if (!raw || typeof raw !== "object") throw new Error("Browser Use sent a malformed message");
    const message = raw as { role?: unknown; content?: unknown };
    if (!Array.isArray(message.content) || !["system", "user", "assistant"].includes(String(message.role))) throw new Error("Browser Use sent a malformed message");
    const parts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
    for (const rawPart of message.content) {
      if (!rawPart || typeof rawPart !== "object") throw new Error("Browser Use sent a malformed content part");
      const part = rawPart as { type?: unknown; text?: unknown; url?: unknown; media_type?: unknown };
      if (part.type === "text" && typeof part.text === "string") {
        totalText += part.text.length;
        parts.push({ type: "text", text: part.text });
      } else if (part.type === "image" && typeof part.url === "string") {
        const match = /^data:([^;,]+);base64,(.+)$/s.exec(part.url);
        if (!match || match[2].length > MAX_MODEL_IMAGE) throw new Error("Browser Use sent an unsupported or oversized image");
        parts.push({ type: "image", data: match[2], mimeType: match[1] });
      } else throw new Error("Browser Use sent an unsupported content part");
    }
    if (totalText > MAX_MODEL_TEXT) throw new Error("Browser Use messages are too large");
    if (message.role === "system") systems.push(parts.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n"));
    else {
      if (message.role === "assistant") parts.unshift({ type: "text", text: "[Prior assistant message]\n" });
      messages.push({ role: "user", content: parts, timestamp: Date.now() });
    }
  }
  if (messages.length === 0) throw new Error("Browser Use sent no user or assistant messages");
  const schemaInstruction = schemaText ? `\nReturn only strict JSON matching this JSON Schema exactly:\n${schemaText}` : "";
  const model = ctx.modelRegistry.find(TEXT_MODEL_PROVIDER, TEXT_MODEL_ID);
  if (!model) throw new Error(`${BROWSER_USE_MODEL} is unavailable`);
  const response = await ctx.modelRegistry.complete(model, { systemPrompt: `${systems.join("\n\n")}${schemaInstruction}`, messages }, { reasoning: "low", maxTokens: 32_000, signal });
  const text = assistantText(response);
  if (!schemaText) return { completion: text, usage: (response as { usage?: unknown }).usage ?? {} };
  const completion = parseModelJson(text);
  if (!Value.Check(request.schema as never, completion)) throw new Error("Browser Use model response failed schema validation");
  return { completion, usage: (response as { usage?: unknown }).usage ?? {} };
}

function writeMessage(child: ChildProcessWithoutNullStreams, message: unknown): void {
  if (!child.stdin.writable) throw new Error("Browser bridge is not writable");
  child.stdin.write(`${JSON.stringify(message)}\n`);
}
function exec(program: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve({ stdout, stderr });
    });
  });
}


function validateUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("browser_use requires a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("browser_use supports only http(s) URLs");
  return url.toString();
}

async function runBrowser(
  params: BrowserParamsValue,
  signal: AbortSignal,
  onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void) | undefined,
  ctx: ExtensionContext,
): Promise<BrowserResult> {
  const engine = selectEngine(params.engine);
  const python = engine === "jev" ? JEV_PYTHON : BROWSER_USE_PYTHON;
  const runner = engine === "jev" ? JEV_RUNNER : BROWSER_USE_RUNNER;
  accessSync(python, constants.X_OK);
  if (engine === "jev" && !process.env.TYPESAFE_API_KEY?.trim()) throw new Error("TYPESAFE_API_KEY is unavailable; run setup to configure Jev");
  const child = spawn(python, [runner], {
    cwd: EXTENSION_DIR,
    env: {
      ...safeEnvironment(process.env, engine === "jev"),
      ...(engine === "jev" ? { BH_REQUIRE_EXISTING_DAEMON: "1", BU_NAME: "pikachu-chromium", BU_CDP_URL: "http://127.0.0.1:9223" } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const timeoutMs = (params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1_000;
  let stderr = "";
  let result: BrowserResult | undefined;
  let protocolError: Error | undefined;
  let childError: Error | undefined;
  child.once("error", (error) => {
    childError = error;
  });
  let terminating = false;

  const terminate = (): void => {
    if (terminating || child.exitCode !== null) return;
    terminating = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2_000).unref();
  };
  const timeout = setTimeout(terminate, timeoutMs);
  const abort = (): void => terminate();
  signal.addEventListener("abort", abort, { once: true });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 4_000) stderr += chunk.toString("utf8");
  });

  try {
    writeMessage(child, { type: "start", url: validateUrl(params.url), goal: params.goal.trim() });
    if (!params.goal.trim()) throw new Error("browser_use requires a non-empty goal");

    for await (const line of lines) {
      let message: BridgeMessage;
      try {
        message = parseBridgeLine(line);
        if (message.type === "progress") {
          const status = String(message.status ?? "running");
          const url = String(message.url ?? "");
          const actions = Number(message.actions ?? 0);
          onUpdate?.({ content: [{ type: "text", text: `Browser ${status}: ${actions} action(s) · ${url}` }], details: { status, url, actions } });
        } else if (message.type === "text_request") {
          const id = message.id;
          if (typeof id !== "string") throw new Error("Jev browser sent a text request without an id");
          try {
            const helper = await generateFieldText(message.context, ctx, signal);
            writeMessage(child, { type: "text_response", id, ...helper });
          } catch (error) {
            writeMessage(child, { type: "text_response", id, error: error instanceof Error ? error.message : String(error) });
          }
        } else if (message.type === "model_request") {
          const id = message.id;
          if (engine !== "browser-use" || typeof id !== "string") throw new Error("Unexpected Browser Use model request");
          try {
            const completion = await generateBrowserUseCompletion(message, ctx, signal);
            writeMessage(child, { type: "model_response", id, ...completion });
          } catch (error) {
            writeMessage(child, { type: "model_response", id, error: error instanceof Error ? error.message : String(error) });
          }
        } else if (message.type === "result") {
          // SAFETY: The Python bridge constructs this result shape; required fields are validated before formatting.
          result = message as unknown as BrowserResult;
        } else if (message.type === "error") {
          protocolError = new Error(String(message.error ?? "Jev browser failed"));
        } else {
          throw new Error(`Unknown Jev browser bridge message: ${message.type}`);
        }
      } catch (error) {
        protocolError = error instanceof Error ? error : new Error(String(error));
        terminate();
      }
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      if (child.exitCode === null && childError === undefined) {
        child.once("close", resolve);
      } else {
        resolve(child.exitCode);
      }
    });
    if (childError) throw childError;
    if (signal.aborted) throw new Error(`${engine} browser automation was cancelled`);
    if (terminating && !protocolError) throw new Error(`${engine} browser automation exceeded ${params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS} seconds`);
    if (protocolError) throw protocolError;
    if (exitCode !== 0 || !result) {
      const diagnostic = boundedError(stderr);
      throw new Error(`${engine} browser exited with code ${exitCode}${diagnostic ? `: ${diagnostic}` : ""}`);
    }
    return result;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    lines.close();
    if (child.exitCode === null) terminate();
    child.stdin.destroy();
  }
}

function formatResult(result: BrowserResult, engine: BrowserEngine): string {
  const actions = (result.actions ?? []).slice(-20).map((item) => `${item.step ?? "?"}. ${item.kind ?? "action"}: ${item.action ?? ""}${item.text ? ` → ${item.text}` : ""}`).join("\n");
  const model = result.model ?? (result.text_models?.length ? result.text_models.join(", ") : "none");
  const errors = (result.errors ?? []).slice(-10).join("\n");
  return [
    `Browser automation ${result.status} (engine: ${engine}).`,
    `Final URL: ${result.url}`,
    result.title ? `Title: ${result.title}` : "",
    `Elapsed: ${result.elapsed_ms ?? "unknown"} ms`,
    `Model: ${model}`,
    result.final_result ? `Final result:\n${result.final_result}` : "",
    actions ? `Actions:\n${actions}` : "Actions: none",
    errors ? `Errors:\n${errors}` : "",
    result.page_text ? `Visible page text:\n${result.page_text}` : "",
    `Warning: ${engine === "jev" ? "Jev DONE" : "Browser Use completion"} reflects the agent's assessment; it is not independent outcome verification.`,
  ].filter(Boolean).join("\n");
}

export default function jevBrowser(pi: ExtensionAPI): void {
  pi.registerCommand("browser-session-import", {
    description: "Confirm and import the current Chrome session into isolated Playwright Chromium",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) throw new Error("Session import requires interactive confirmation");
      const confirmed = await ctx.ui.confirm(
        "Import Chrome session?",
        "This copies Chrome cookies and origin storage into the isolated automation profile. The export is stored locally with mode 0600 and is never committed.",
      );
      if (!confirmed) {
        ctx.ui.notify("Chrome session import cancelled", "info");
        return;
      }
      try {
        const result = await exec(process.execPath, [join(EXTENSION_DIR, "session-import.mjs")]);
        const uid = process.getuid?.();
        if (uid === undefined) throw new Error("Session import requires a Unix launchd environment");
        const service = `gui/${uid}/com.pikachu.jev-browser`;
        await exec("/bin/launchctl", ["kickstart", "-k", service]);
        ctx.ui.notify(result.stdout.trim() || "Chrome session imported", "info");
      } catch (error) {
        ctx.ui.notify(`Session import failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "browser_use",
    label: "Browser Automation",
    description: "Operate an interactive website with Browser Use by default, or Jev Ultrafast with engine=jev. Use for clicking, typing, selecting, scrolling, and navigating—not research or URL fetching. Obtain explicit user confirmation before consequential actions.",
    parameters: BrowserParams,
    promptGuidelines: [
      "browser_use defaults to Browser Use for broader long-horizon workflows; select engine=jev for a lower-overhead indexed-DOM action loop.",
      "Use browser_use only for interactive browser automation; prefer web_search and fetch_content for research and retrieval.",
      "Give browser_use one narrow goal with a visibly verifiable outcome, and do not use it for consequential actions without explicit user confirmation.",
    ],
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (isPlanMode(ctx.sessionManager.getBranch())) {
        return { content: [{ type: "text", text: "browser_use is disabled while read-only plan mode is active." }], details: {}, isError: true };
      }
      if (browserInUse) {
        return { content: [{ type: "text", text: "browser_use is already operating the shared browser tab; wait for that run to finish." }], details: {}, isError: true };
      }
      browserInUse = true;
      try {
        const typedParams = params as BrowserParamsValue;
        const engine = selectEngine(typedParams.engine);
        const result = await runBrowser(typedParams, signal ?? new AbortController().signal, onUpdate, ctx);
        return { content: [{ type: "text", text: formatResult(result, engine) }], details: { ...result, engine } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `browser_use failed: ${message}` }], details: { error: message }, isError: true };
      } finally {
        browserInUse = false;
      }
    },
  });
}
