import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  SPECIALIST_GROUPS,
  TODO_STATUSES,
  assertDependencies,
  copyState,
  incompleteDependencies,
  initialState,
  isControlState,
  isJevDisabled,
  isSpecialistGroup,
  normalizePriority,
  readyTodos,
  requiredSpecialistGroups,
  routeTarget,
  shortlistGroups,
  specialistGroupForTool,
  type ControlState,
  type SpecialistGroup,
  type TodoItem,
  type TodoStatus,
} from "./src/core.js";
import { chooseBoundedAction } from "./src/jev-use.js";
import { protectCuaToolCall } from "./src/cua-focus.js";
import { cuaWindowHandles } from "./src/cua-observation.js";
import { isForegroundAllowed, setForegroundAllowed } from "./src/focus-state.js";

const STATE_ENTRY = "pi-cfg-jev-control-v1";
const ROUTE_CONFIDENCE = 0.65;
const TOOL_CONFIDENCE = 0.65;
const ROUTE_TIMEOUT_MS = 10_000;
const TODO_TIMEOUT_MS = 15_000;

const LAST_MODEL_PATH = join(homedir(), ".local", "share", "pikachu", "last-model.json");

interface RememberedModel {
  version: 1;
  provider: string;
  id: string;
}

function parseRememberedModel(raw: string): RememberedModel {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("remembered model must be an object");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.provider !== "string" || !record.provider || typeof record.id !== "string" || !record.id) {
    throw new Error("remembered model is invalid");
  }
  return { version: 1, provider: record.provider, id: record.id };
}

async function saveRememberedModel(model: RememberedModel): Promise<void> {
  await mkdir(dirname(LAST_MODEL_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${LAST_MODEL_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(model)}\n`, { mode: 0o600 });
  await rename(temporary, LAST_MODEL_PATH);
}

async function loadRememberedModel(): Promise<RememberedModel | undefined> {
  try {
    return parseRememberedModel(await readFile(LAST_MODEL_PATH, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}
const TodoParams = Type.Object({
  action: StringEnum(["list", "add", "update", "complete", "remove", "next", "review"] as const),
  id: Type.Optional(Type.String({ description: "Stable todo ID, for example T3" })),
  title: Type.Optional(Type.String({ description: "Short outcome-oriented title" })),
  details: Type.Optional(Type.String({ description: "Optional implementation details; empty clears it" })),
  status: Type.Optional(StringEnum(TODO_STATUSES)),
  priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, description: "0 low, 1 normal, 2 high, 3 critical" })),
  blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Todo IDs that must be completed first" })),
  evidence: Type.Optional(Type.String({ description: "Completion evidence; empty clears it" })),
});

const FindToolsParams = Type.Object({
  query: Type.String({ description: "Capability needed for the next work, stated in plain language" }),
});

const JevChoiceParams = Type.Object({
  goal: Type.String({ minLength: 1, maxLength: 1000 }),
  observation: Type.String({ minLength: 1, maxLength: 5000, description: "Compact fresh Cua Driver semantic observation; omit secrets and screenshot bytes" }),
  captureId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  history: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 6 })),
  candidates: Type.Array(Type.Object({
    id: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
    description: Type.String({ minLength: 1, maxLength: 240 }),
  }, { additionalProperties: false }), { minItems: 2, maxItems: 32 }),
}, { additionalProperties: false });

interface TodoAdvisory {
  orderedIds: string[];
  messages: string[];
}

function getClient(): TypeSafeClient | undefined {
  if (isJevDisabled(process.env.JEVC_DISABLED)) return undefined;
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return undefined;
  try {
    return new TypeSafeClient({ apiKey, logLevel: "off", retry: { maxRetries: 0 } });
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTodo(todo: TodoItem): string {
  const marker = todo.status === "completed" ? "✓" : todo.status === "blocked" ? "×" : todo.status === "in_progress" ? "▶" : "○";
  const deps = todo.blockedBy.length ? ` depends:${todo.blockedBy.join(",")}` : "";
  return `${marker} ${todo.id} [p${todo.priority}] ${todo.title}${deps}`;
}

class TodoPanel {
  constructor(
    private readonly todos: TodoItem[],
    private readonly theme: Theme,
    private readonly close: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.close();
  }

  render(width: number): string[] {
    const lines = ["", this.theme.fg("accent", this.theme.bold(" Session todos ")), ""];
    if (!this.todos.length) lines.push(this.theme.fg("dim", "  No todos on this branch."));
    for (const todo of this.todos.slice(0, 20)) lines.push(`  ${formatTodo(todo)}`);
    if (this.todos.length > 20) lines.push(this.theme.fg("dim", `  … ${this.todos.length - 20} more`));
    lines.push("", this.theme.fg("dim", "  Escape closes"), "");
    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}
}

export default function jevControl(pi: ExtensionAPI): void {
  let state: ControlState = initialState();
  let advisory: TodoAdvisory = { orderedIds: [], messages: [] };
  let internalModelTarget: string | undefined;
  let restoreRememberedOnNextPrompt = false;

  const persist = (): void => pi.appendEntry(STATE_ENTRY, copyState(state));

  const reconstruct = (ctx: ExtensionContext): void => {
    state = initialState();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY && isControlState(entry.data)) {
        state = copyState(entry.data);
      }
    }
    const savedGroups = state.activeGroups as string[];
    state.activeGroups = [...new Set(savedGroups.map((group) => group === "browser" ? "computer" : group).filter(isSpecialistGroup))];
  };

  const groupTools = (): Map<SpecialistGroup, string[]> => {
    const groups = new Map<SpecialistGroup, string[]>();
    for (const name of Object.keys(SPECIALIST_GROUPS) as SpecialistGroup[]) groups.set(name, []);
    for (const tool of pi.getAllTools()) {
      if (tool.name === "herdr" || tool.name === "subagent") continue;
      const group = specialistGroupForTool(tool.name, `${tool.sourceInfo.source} ${tool.sourceInfo.path}`);
      if (group) groups.get(group)?.push(tool.name);
      // The Android direct tools do not exist until the MCP adapter has cached
      // their schemas, so expose the gateway as the group's bootstrap path.
      if (tool.name === "mcp") {
        groups.get("android")?.push(tool.name);
        groups.get("computer")?.push(tool.name);
      }
    }
    return groups;
  };

  const applyToolPolicy = (): void => {
    const groups = groupTools();
    const specialistNames = new Set([...groups.values()].flat());
    const active = new Set(pi.getActiveTools().filter((name) => !specialistNames.has(name)));
    for (const group of state.activeGroups) {
      for (const name of groups.get(group) ?? []) active.add(name);
    }
    pi.setActiveTools([...active]);
  };

  const activateGroups = (groups: SpecialistGroup[]): string[] => {
    const newlyActive = groups.filter((group) => !state.activeGroups.includes(group));
    if (!newlyActive.length) return [];
    state.activeGroups = [...state.activeGroups, ...newlyActive];
    const active = new Set(pi.getActiveTools());
    const tools = groupTools();
    for (const group of newlyActive) for (const name of tools.get(group) ?? []) active.add(name);
    pi.setActiveTools([...active]);
    persist();
    return newlyActive;
  };

  const orderedReady = (): TodoItem[] => {
    const ready = readyTodos(state.todos);
    if (!advisory.orderedIds.length) return ready;
    const order = new Map(advisory.orderedIds.map((id, index) => [id, index]));
    return [...ready].sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
  };

  const renderWidget = (ctx: ExtensionContext): void => {
    const current = state.todos.find((todo) => todo.status === "in_progress");
    const next = orderedReady().filter((todo) => todo.id !== current?.id).slice(0, 3);
    if (!current && !next.length) {
      ctx.ui.setWidget("jev-todos", undefined);
      return;
    }
    const lines = [ctx.ui.theme.fg("accent", "Todos")];
    if (current) lines.push(truncateToWidth(`▶ ${current.id} ${current.title}`, 100));
    for (const todo of next) lines.push(ctx.ui.theme.fg("dim", truncateToWidth(`○ ${todo.id} ${todo.title}`, 100)));
    ctx.ui.setWidget("jev-todos", lines, { placement: "aboveEditor" });
  };

  const reviewTodos = async (reason: string, signal?: AbortSignal): Promise<TodoAdvisory> => {
    const ready = readyTodos(state.todos);
    const client = getClient();
    if (!client || !state.todos.length) {
      return { orderedIds: ready.map((todo) => todo.id), messages: [] };
    }

    const questions: Record<string, ReturnType<typeof score> | ReturnType<typeof noul>> = {
      duplicates: noul("Do two or more active todos describe substantially the same outcome?"),
      scopeDrift: noul("Does any active todo appear unrelated to the rest of this session's work?"),
    };
    for (const todo of ready) {
      questions[`rank_${todo.id}`] = score(`How strongly should ${todo.id} be selected as the next ready task?`, [
        "not next",
        "later",
        "soon",
        "next",
      ] as const);
    }
    const recentlyCompleted = state.todos.filter((todo) => todo.status === "completed").slice(-1)[0];
    if (recentlyCompleted) {
      questions.weakEvidence = noul(
        `Is the completion evidence for ${recentlyCompleted.id} absent or too weak to support its completed status?`,
      );
    }

    try {
      const response = await client.systemOne(
        {
          state: {
            reason,
            todos: state.todos.map(({ id, title, details, status, priority, blockedBy, evidence }) => ({
              id,
              title,
              details: details ?? null,
              status,
              priority,
              blockedBy,
              evidence: evidence ?? null,
            })),
          },
          questions,
        },
        { signal, timeout: TODO_TIMEOUT_MS, retry: { maxRetries: 0 } },
      );
      const ranked = ready
        .map((todo) => {
          const answer = response.answers[`rank_${todo.id}`];
          return { todo, score: answer?.type === "score" ? answer.score : todo.priority };
        })
        .sort((a, b) => b.score - a.score || b.todo.priority - a.todo.priority)
        .map(({ todo }) => todo.id);
      const messages: string[] = [];
      const duplicates = response.answers.duplicates;
      const scopeDrift = response.answers.scopeDrift;
      const weakEvidence = response.answers.weakEvidence;
      if (duplicates?.type === "noul" && duplicates.noul >= 0.65) messages.push("Possible duplicate active todos detected.");
      if (scopeDrift?.type === "noul" && scopeDrift.noul >= 0.65) messages.push("Possible todo scope drift detected.");
      if (weakEvidence?.type === "noul" && weakEvidence.noul >= 0.65) messages.push("Latest completion may need stronger evidence.");
      return { orderedIds: ranked, messages };
    } catch {
      return { orderedIds: ready.map((todo) => todo.id), messages: [] };
    }
  };

  const runReview = async (reason: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> => {
    advisory = await reviewTodos(reason, signal);
    renderWidget(ctx);
    return advisory.messages.length ? `\nJev advisory: ${advisory.messages.join(" ")}` : "";
  };

  const findTodo = (id: string | undefined): TodoItem => {
    if (!id) throw new Error("id is required");
    const todo = state.todos.find((item) => item.id === id);
    if (!todo) throw new Error(`Todo ${id} does not exist`);
    return todo;
  };

  pi.registerTool({
    name: "todo",
    label: "Session Todo",
    description:
      "Manage branch-local session todos. Jev advises on ordering and validation but deterministic rules own all mutations.",
    parameters: TodoParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        let message = "";
        let shouldPersist = false;
        let shouldReview = false;

        switch (params.action) {
          case "list":
            message = state.todos.length ? state.todos.map(formatTodo).join("\n") : "No todos on this branch.";
            break;
          case "add": {
            const title = params.title?.trim();
            if (!title) throw new Error("title is required for add");
            const id = `T${state.nextId}`;
            const blockedBy = params.blockedBy ?? [];
            assertDependencies(state.todos, id, blockedBy);
            const todo: TodoItem = {
              id,
              title,
              details: params.details?.trim() || undefined,
              status: params.status ?? "pending",
              priority: normalizePriority(params.priority),
              blockedBy: [...blockedBy],
              evidence: params.evidence?.trim() || undefined,
            };
            state.todos.push(todo);
            state.nextId += 1;
            message = `Added ${formatTodo(todo)}`;
            shouldPersist = shouldReview = true;
            break;
          }
          case "update": {
            const todo = findTodo(params.id);
            const blockedBy = params.blockedBy ?? todo.blockedBy;
            assertDependencies(state.todos, todo.id, blockedBy);
            if (params.title !== undefined) {
              const title = params.title.trim();
              if (!title) throw new Error("title cannot be empty");
              todo.title = title;
            }
            if (params.details !== undefined) todo.details = params.details.trim() || undefined;
            if (params.status !== undefined) todo.status = params.status as TodoStatus;
            if (params.priority !== undefined) todo.priority = normalizePriority(params.priority);
            todo.blockedBy = [...blockedBy];
            if (params.evidence !== undefined) todo.evidence = params.evidence.trim() || undefined;
            message = `Updated ${formatTodo(todo)}`;
            shouldPersist = shouldReview = true;
            break;
          }
          case "complete": {
            const todo = findTodo(params.id);
            const incomplete = incompleteDependencies(state.todos, todo);
            if (incomplete.length) throw new Error(`Complete dependencies first: ${incomplete.join(", ")}`);
            todo.status = "completed";
            if (params.evidence !== undefined) todo.evidence = params.evidence.trim() || undefined;
            message = `Completed ${todo.id}: ${todo.title}`;
            shouldPersist = shouldReview = true;
            break;
          }
          case "remove": {
            const todo = findTodo(params.id);
            const dependents = state.todos.filter((item) => item.blockedBy.includes(todo.id));
            if (dependents.length) throw new Error(`Remove dependency from: ${dependents.map((item) => item.id).join(", ")}`);
            state.todos = state.todos.filter((item) => item.id !== todo.id);
            message = `Removed ${todo.id}: ${todo.title}`;
            shouldPersist = true;
            break;
          }
          case "next": {
            advisory = await reviewTodos("Select the next ready todo", signal);
            const next = orderedReady()[0];
            message = next ? `Next: ${formatTodo(next)}` : "No ready todos.";
            if (advisory.messages.length) message += `\nJev advisory: ${advisory.messages.join(" ")}`;
            break;
          }
          case "review":
            message = `Reviewed ${state.todos.length} todo(s).`;
            shouldReview = true;
            break;
        }

        if (shouldPersist) persist();
        if (shouldReview) message += await runReview(params.action, ctx, signal);
        else renderWidget(ctx);
        return { content: [{ type: "text", text: message }], details: { state: copyState(state) } };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Todo error: ${errorText(error)}` }],
          details: { state: copyState(state), error: errorText(error) },
        };
      }
    },
  });

  pi.registerTool({
    name: "jev_choose_action",
    label: "Jev Bounded Choice",
    description: "Choose one ID from complete Cua Driver action candidates. Include reobserve and abstain. No action is executed; validate the fresh target and verify the result separately. Send only compact, authorized observations to TypeSafe.",
    parameters: JevChoiceParams,
    async execute(_toolCallId, params, signal) {
      const client = getClient();
      if (!client) return { content: [{ type: "text", text: "Jev is unavailable; reobserve or abstain." }], details: undefined };
      try {
        const result = await chooseBoundedAction(client, params, signal);
        return {
          content: [{ type: "text", text: `Jev selected ${result.selectedId} (confidence ${result.confidence.toFixed(2)}). No Cua Driver action was executed.` }],
          details: result,
        };
      } catch {
        return { content: [{ type: "text", text: "Jev choice failed validation or the provider is unavailable; reobserve or abstain." }], details: undefined };
      }
    },
  });

  pi.registerTool({
    name: "jev_find_tools",
    label: "Find Specialist Tools",
    description: "Find and activate the smallest relevant specialist tool groups for a capability. Activation is additive.",
    parameters: FindToolsParams,
    async execute(_toolCallId, params, signal) {
      const required = requiredSpecialistGroups(params.query);
      let candidates = [...new Set([...required, ...shortlistGroups(params.query)])];
      if (!candidates.length) candidates = Object.keys(SPECIALIST_GROUPS) as SpecialistGroup[];
      let selected = candidates;
      const client = getClient();
      if (client && candidates.length > 1) {
        try {
          const questions = Object.fromEntries(
            candidates.map((group) => [group, noul(`Is the ${SPECIALIST_GROUPS[group].label} group needed for this request?`)]),
          );
          const response = await client.systemOne(
            { state: { request: params.query }, questions },
            { signal, timeout: ROUTE_TIMEOUT_MS, retry: { maxRetries: 0 } },
          );
          selected = candidates.filter((group) => {
            const answer = response.answers[group];
            return answer?.type === "noul" && answer.noul >= TOOL_CONFIDENCE;
          });
        } catch {
          selected = shortlistGroups(params.query);
        }
      } else {
        selected = shortlistGroups(params.query);
      }
      selected = [...new Set([...required, ...selected])];
      const activated = activateGroups(selected);
      return {
        content: [
          {
            type: "text",
            text: activated.length
              ? `Activated specialist groups: ${activated.join(", ")}`
              : selected.length
                ? `Specialist groups already active: ${selected.join(", ")}`
                : "No specialist group matched; core tools remain active.",
          },
        ],
        details: { selected, activated },
      };
    },
  });

  pi.on("tool_call", (event) => {
    if (isForegroundAllowed()) return;
    const reason = protectCuaToolCall(event.toolName, event.input as Record<string, unknown>);
    if (reason) return { block: true, reason: `${reason} Use /cua-focus allow only when the user permits focus changes.` };
  });

  pi.on("tool_result", (event) => {
    if (event.isError) return;
    const handles = cuaWindowHandles(event.toolName, event.details);
    if (handles) return { content: [...event.content, { type: "text" as const, text: handles }] };
  });

  pi.registerCommand("cua-focus", {
    description: "Control Cua Driver focus protection: /cua-focus protect|allow|status",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "status") {
        ctx.ui.notify(`Cua Driver focus protection is ${isForegroundAllowed() ? "off" : "on"} for this session.`, "info");
      } else if (action === "allow" || action === "protect") {
        setForegroundAllowed(action === "allow");
        ctx.ui.notify(`Cua Driver focus protection ${isForegroundAllowed() ? "disabled" : "enabled"} for this session.`, "info");
      } else {
        ctx.ui.notify("Usage: /cua-focus protect|allow|status", "warning");
      }
    },
  });

  pi.registerCommand("todos", {
    description: "Show branch-local session todos",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(state.todos.length ? state.todos.map(formatTodo).join(" | ") : "No todos on this branch.", "info");
        return;
      }
      await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => new TodoPanel(state.todos, theme, done));
    },
  });

  pi.registerCommand("jev-tools", {
    description: "Show or reset lazy specialist tools: /jev-tools status|reset",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "status") {
        ctx.ui.notify(
          state.activeGroups.length ? `Active specialist groups: ${state.activeGroups.join(", ")}` : "No specialist groups active.",
          "info",
        );
        return;
      }
      if (action === "reset") {
        state.activeGroups = [];
        applyToolPolicy();
        persist();
        ctx.ui.notify("Specialist tools reset; core and delegation tools were preserved.", "info");
        return;
      }
      ctx.ui.notify("Usage: /jev-tools status|reset", "warning");
    },
  });

  pi.registerCommand("jev-route", {
    description: "Control per-turn Jev routing: /jev-route auto|off|status",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "status") {
        ctx.ui.notify(`Jev routing is ${state.routeMode}.`, "info");
        return;
      }
      if (action !== "auto" && action !== "off") {
        ctx.ui.notify("Usage: /jev-route auto|off|status", "warning");
        return;
      }
      state.routeMode = action;
      persist();
      ctx.ui.notify(`Jev routing ${action === "auto" ? "enabled" : "disabled"}.`, "info");
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Reassert the lazy surface after every package has run its own startup
    // hooks. Some packages activate tools during session_start.
    applyToolPolicy();
    // Explicit specialist requests must be usable on the same turn. Requiring
    // the model to discover a tool that the request already names can leave
    // the requested surface hidden for the entire non-interactive run.
    activateGroups(requiredSpecialistGroups(event.prompt));
    if (restoreRememberedOnNextPrompt) {
      restoreRememberedOnNextPrompt = false;
      const remembered = await loadRememberedModel();
      const model = remembered ? ctx.modelRegistry.find(remembered.provider, remembered.id) : undefined;
      if (model) {
        internalModelTarget = `${model.provider}/${model.id}`;
        try {
          const changed = await pi.setModel(model);
          if (changed && state.routeMode === "auto") {
            state.routeMode = "off";
            persist();
          }
        } finally {
          internalModelTarget = undefined;
        }
      }
    }
    if (state.routeMode !== "auto" || !event.prompt.trim()) return;
    const client = getClient();
    if (!client) return;
    try {
      const response = await client.systemOne(
        {
          state: event.prompt,
          questions: {
            tier: choice("Choose the minimum model tier appropriate for completing this request reliably.", {
              easy: "Greeting, quick answer, formatting, or mechanical local edit",
              routine: "Ordinary coding work with bounded reasoning",
              demanding: "Multi-file work, debugging, integration, or careful tradeoffs",
              hard: "Subtle architecture, high-risk work, or unusually deep reasoning",
            }),
          },
        },
        { signal: ctx.signal, timeout: ROUTE_TIMEOUT_MS, retry: { maxRetries: 0 } },
      );
      const answer = response.answers.tier;
      if (answer.confidence < ROUTE_CONFIDENCE) return;
      const computerUse = state.activeGroups.includes("computer") ||
        requiredSpecialistGroups(event.prompt).includes("computer") || shortlistGroups(event.prompt).includes("computer");
      const target = routeTarget(answer.choice, computerUse);
      const model = ctx.modelRegistry.find("openai-codex", target.id);
      if (!model) return;
      internalModelTarget = `${model.provider}/${model.id}`;
      const changed = await pi.setModel(model);
      if (changed) {
        pi.setThinkingLevel(target.thinking);
        ctx.ui.notify(`Jev route: ${target.id}:${target.thinking} (${answer.choice})`, "info");
      }
      internalModelTarget = undefined;
    } catch {
      internalModelTarget = undefined;
    }
  });

  pi.on("model_select", async (event, ctx) => {
    const selected = `${event.model.provider}/${event.model.id}`;
    if (selected === internalModelTarget || event.source === "restore") return;
    try {
      await saveRememberedModel({ version: 1, provider: event.model.provider, id: event.model.id });
    } catch (error) {
      ctx.ui.notify(`Could not remember model selection: ${errorText(error)}`, "warning");
    }
    if (state.routeMode === "auto") {
      state.routeMode = "off";
      persist();
      ctx.ui.notify("Manual model selection was remembered and disabled Jev routing for this session. Use /jev-route auto to resume.", "info");
    }
  });

  const restore = (ctx: ExtensionContext): void => {
    reconstruct(ctx);
    applyToolPolicy();
    renderWidget(ctx);
  };
  pi.on("session_start", async (event, ctx) => {
    setForegroundAllowed(false);
    restore(ctx);
    restoreRememberedOnNextPrompt = event.reason === "new" || event.reason === "startup";
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
}
