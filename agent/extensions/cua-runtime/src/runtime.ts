import { parse } from "acorn";
import { generate } from "astring";
import { newAsyncContext, type QuickJSAsyncContext } from "quickjs-emscripten";
import type { HostOutput, JsonValue } from "./types.js";
import { GUEST_BOOTSTRAP } from "./bootstrap.js";

export interface GuestRunResult extends HostOutput { result: JsonValue; }
export interface GuestRuntimeOptions {
  invoke(method: string, args: JsonValue[], signal?: AbortSignal): Promise<JsonValue>;
  takeOutput(): HostOutput;
  maxSourceBytes?: number;
  maxOutputBytes?: number;
  wallTimeMs?: number;
}

export class GuestRuntime {
  private context?: QuickJSAsyncContext;
  private running = false;
  private activeAbort?: AbortController;
  private idle?: Promise<void>;
  private settleIdle?: () => void;

  constructor(private readonly options: GuestRuntimeOptions) {}

  async run(code: string, signal?: AbortSignal): Promise<GuestRunResult> {
    if (this.running) throw new Error("cua_repl_js already has an active execution");
    if (Buffer.byteLength(code, "utf8") > (this.options.maxSourceBytes ?? 100_000)) throw new Error("CUA REPL source exceeds the 100 KB limit");
    this.running = true;
    this.idle = new Promise<void>((resolve) => { this.settleIdle = resolve; });
    let context: QuickJSAsyncContext | undefined;
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    let wallAbort: AbortController | undefined;
    try {
      context = await this.ensureContext();
      const wallTimeMs = this.options.wallTimeMs ?? 120_000;
      const deadline = Date.now() + wallTimeMs;
      wallAbort = new AbortController();
      this.activeAbort = wallAbort;
      abort = () => wallAbort!.abort(signal?.reason ?? new Error("CUA REPL execution aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => wallAbort!.abort(new Error("CUA REPL wall-time limit exceeded")), wallTimeMs);
      this.activeSignal = wallAbort.signal;
      context.runtime.setInterruptHandler(() => wallAbort!.signal.aborted || Date.now() > deadline);
      const transformed = transformPersistentProgram(code);
      const initial = await context.evalCodeAsync(transformed, "cua-repl.js", { type: "global", strict: true });
      if (initial.error) throw dumpGuestError(context, initial.error);
      try {
        const result = safeJsonValue(context.dump(initial.value));
        const output = this.options.takeOutput();
        const outputBytes = Buffer.byteLength(JSON.stringify(output), "utf8");
        if (outputBytes > (this.options.maxOutputBytes ?? 1_000_000)) throw new Error("CUA REPL output exceeds the 1 MB limit");
        return { result, text: output.text, images: output.images };
      } finally {
        initial.value.dispose();
      }
    } finally {
      context?.runtime.removeInterruptHandler();
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
      if (this.activeAbort === wallAbort) this.activeAbort = undefined;
      this.activeSignal = undefined;
      this.running = false;
      const settleIdle = this.settleIdle;
      this.settleIdle = undefined;
      this.idle = undefined;
      settleIdle?.();
    }
  }

  async reset(): Promise<void> {
    if (this.running) {
      const idle = this.idle;
      this.activeAbort?.abort(new Error("CUA REPL reset interrupted the active execution"));
      await idle;
    }
    const context = this.context;
    this.context = undefined;
    context?.dispose();
  }

  private async ensureContext(): Promise<QuickJSAsyncContext> {
    if (this.context) return this.context;
    const context = await newAsyncContext();
    context.runtime.setMemoryLimit(64 * 1024 * 1024);
    context.runtime.setMaxStackSize(1024 * 1024);
    const hostCall = context.newAsyncifiedFunction("__hostCall", async (methodHandle, argsHandle) => {
      try {
        const method = context.getString(methodHandle);
        const raw = context.getString(argsHandle);
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) throw new Error("Host arguments must be an array");
        const args = parsed.map(safeJsonValue);
        const value = await this.options.invoke(method, args, this.activeSignal);
        return context.newString(JSON.stringify({ ok: true, value }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return context.newString(JSON.stringify({ ok: false, error: message.slice(0, 4_000) }));
      }
    });
    hostCall.consume((fn) => context.setProp(context.global, "__hostCall", fn));
    const bootstrap = await context.evalCodeAsync(GUEST_BOOTSTRAP, "cua-bootstrap.js", { type: "global", strict: true });
    if (bootstrap.error) {
      const error = dumpGuestError(context, bootstrap.error);
      context.dispose();
      throw error;
    }
    bootstrap.value.dispose();
    this.context = context;
    return context;
  }

  private activeSignal?: AbortSignal;
}

function transformPersistentProgram(code: string): string {
  const program = parse(code, { ecmaVersion: "latest", sourceType: "script", allowAwaitOutsideFunction: true }) as any;
  rejectDynamicImports(program);
  const body: any[] = [];
  for (const statement of program.body) {
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== "Identifier") throw new Error("Top-level destructuring is unsupported; assign through an object first");
        body.push({
          type: "ExpressionStatement",
          expression: {
            type: "AssignmentExpression",
            operator: "=",
            left: { type: "MemberExpression", object: { type: "Identifier", name: "globalThis" }, property: { type: "Identifier", name: declaration.id.name }, computed: false, optional: false },
            right: declaration.init ?? { type: "Identifier", name: "undefined" },
          },
        });
      }
    } else if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
      if (!statement.id?.name) throw new Error("Anonymous top-level declarations are unsupported");
      body.push({
        type: "ExpressionStatement",
        expression: {
          type: "AssignmentExpression",
          operator: "=",
          left: { type: "MemberExpression", object: { type: "Identifier", name: "globalThis" }, property: { type: "Identifier", name: statement.id.name }, computed: false, optional: false },
          right: statement.type === "FunctionDeclaration" ? { ...statement, type: "FunctionExpression" } : { ...statement, type: "ClassExpression" },
        },
      });
    } else body.push(statement);
  }
  const last = body.at(-1);
  if (last?.type === "ExpressionStatement") body[body.length - 1] = { type: "ReturnStatement", argument: last.expression };
  const generated = generate(normalizeAsyncSyntax({ type: "Program", body }) as any);
  return `(() => {\n${generated}\n})()`;
}

function normalizeAsyncSyntax(value: any): any {
  if (Array.isArray(value)) return value.map(normalizeAsyncSyntax);
  if (!value || typeof value !== "object") return value;
  if (value.type === "AwaitExpression") return normalizeAsyncSyntax(value.argument);
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) normalized[key] = normalizeAsyncSyntax(child);
  if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(String(normalized.type))) normalized.async = false;
  if (normalized.type === "ForOfStatement") normalized.await = false;
  return normalized;
}

function rejectDynamicImports(value: any): void {
  if (Array.isArray(value)) {
    for (const child of value) rejectDynamicImports(child);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.type === "ImportExpression") throw new Error("Dynamic import is unsupported in the CUA runtime");
  for (const child of Object.values(value)) rejectDynamicImports(child);
}

function dumpGuestError(context: QuickJSAsyncContext, handle: { dispose(): void }): Error {
  try {
    return guestError(context.dump(handle as any));
  } finally {
    handle.dispose();
  }
}

function guestError(dumped: unknown): Error {
  const value = dumped as { message?: unknown } | undefined;
  return new Error(typeof value?.message === "string" ? value.message : String(dumped));
}

function safeJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return null;
  return JSON.parse(encoded) as JsonValue;
}
