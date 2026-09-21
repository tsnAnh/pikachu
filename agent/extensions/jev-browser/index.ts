import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  boundedError,
  isPlanMode,
  TEXT_MODEL_ID,
  TEXT_MODEL_PROVIDER,
  parseBridgeLine,
  parseTextModelOutput,
  safeEnvironment,
  type BridgeMessage,
} from "./src/core.js";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PYTHON = join(EXTENSION_DIR, ".upstream", ".venv", "bin", "python");
const RUNNER = join(EXTENSION_DIR, "runner.py");
const DEFAULT_TIMEOUT_SECONDS = 120;

const BrowserParams = Type.Object({
  url: Type.String({ description: "Initial http(s) URL" }),
  goal: Type.String({ description: "One narrow browser-automation goal with a visibly verifiable outcome" }),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 15, maximum: 300, description: "Overall deadline; default 120 seconds" })),
});

interface BrowserParamsValue {
  url: string;
  goal: string;
  timeoutSeconds?: number;
}

interface BrowserResult {
  type: "result";
  status: string;
  page_text?: string;
  url: string;
  title?: string;
  elapsed_ms?: number;
  actions?: Array<{ step?: number; kind?: string; action?: string; text?: string; url?: string }>;
  text_models?: string[];
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

function writeMessage(child: ChildProcessWithoutNullStreams, message: unknown): void {
  if (!child.stdin.writable) throw new Error("Jev browser bridge is not writable");
  child.stdin.write(`${JSON.stringify(message)}\n`);
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
  accessSync(PYTHON, constants.X_OK);
  if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error("TYPESAFE_API_KEY is unavailable; run setup to configure Jev");

  const child = spawn(PYTHON, [RUNNER], {
    cwd: EXTENSION_DIR,
    env: { ...safeEnvironment(process.env), BH_REQUIRE_EXISTING_DAEMON: "1" },
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
    if (signal.aborted) throw new Error("Jev browser automation was cancelled");
    if (terminating && !protocolError) throw new Error(`Jev browser automation exceeded ${params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS} seconds`);
    if (protocolError) throw protocolError;
    if (exitCode !== 0 || !result) {
      const diagnostic = boundedError(stderr);
      throw new Error(`Jev browser exited with code ${exitCode}${diagnostic ? `: ${diagnostic}` : ""}`);
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

function formatResult(result: BrowserResult): string {
  const actions = (result.actions ?? []).slice(-20).map((item) => `${item.step ?? "?"}. ${item.kind ?? "action"}: ${item.action ?? ""}${item.text ? ` → ${item.text}` : ""}`).join("\n");
  const models = result.text_models?.length ? result.text_models.join(", ") : "none (no text fields required)";
  return [
    `Browser automation ${result.status}.`,
    `Final URL: ${result.url}`,
    result.title ? `Title: ${result.title}` : "",
    `Elapsed: ${result.elapsed_ms ?? "unknown"} ms`,
    `Text helper: ${models}`,
    actions ? `Actions:\n${actions}` : "Actions: none",
    result.page_text ? `Visible page text:\n${result.page_text}` : "",
    "Warning: Jev DONE means the page appeared complete; it is not independent outcome verification.",
  ].filter(Boolean).join("\n");
}

export default function jevBrowser(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "browser_use",
    label: "Jev Browser Automation",
    description: "Operate an interactive website with Jev Ultrafast. Use browser_use for clicking, typing, selecting, scrolling, and navigating—not for web research or URL fetching. Browser actions can have real external side effects; obtain explicit user confirmation before consequential actions.",
    parameters: BrowserParams,
    promptGuidelines: [
      "Use browser_use only for interactive browser automation; prefer web_search and fetch_content for research and retrieval.",
      "Give browser_use one narrow goal with a visibly verifiable outcome, and do not use it for consequential actions without explicit user confirmation.",
    ],
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (isPlanMode(ctx.sessionManager.getBranch())) {
        return { content: [{ type: "text", text: "browser_use is disabled while read-only plan mode is active." }], details: {}, isError: true };
      }
      try {
        const result = await runBrowser(params as BrowserParamsValue, signal ?? new AbortController().signal, onUpdate, ctx);
        return { content: [{ type: "text", text: formatResult(result) }], details: result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `browser_use failed: ${message}` }], details: { error: message }, isError: true };
      }
    },
  });
}
