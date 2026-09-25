export const TODO_STATUSES = ["pending", "in_progress", "blocked", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  id: string;
  title: string;
  details?: string;
  status: TodoStatus;
  priority: number;
  blockedBy: string[];
  evidence?: string;
}

export interface ControlState {
  version: 1;
  todos: TodoItem[];
  nextId: number;
  routeMode: "auto" | "off";
  activeGroups: SpecialistGroup[];
}

export type SpecialistGroup = "android" | "computer" | "web" | "code" | "mcp";
export type RouteTier = "easy" | "routine" | "demanding" | "hard";

export function isJevDisabled(value: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(value?.trim() ?? "");
}

export function routeTarget(tier: RouteTier, computerUse = false): { id: string; thinking: "low" | "medium" | "high" } {
  if (tier === "easy") return { id: computerUse ? "gpt-5.6-sol" : "gpt-5.6-luna", thinking: "low" };
  if (tier === "routine") return { id: "gpt-5.6-sol", thinking: "low" };
  if (tier === "demanding") return { id: "gpt-5.6-sol", thinking: "medium" };
  return { id: "gpt-5.6-sol", thinking: "high" };
}

export const SPECIALIST_GROUPS: Record<SpecialistGroup, { label: string; keywords: string[] }> = {
  android: {
    label: "Android emulator lifecycle, app installation, logs, checkpoints and indexed UI automation",
    keywords: [
      "android",
      "apk",
      "adb",
      "emulator",
      "logcat",
      "ui automator",
      "mobile ui",
      "android screenshot",
      "android app",
    ],
  },
  computer: {
    label: "Cua Driver desktop app and background Chrome browser use",
    keywords: ["computer use", "jev-use", "desktop", "app automation", "browser automation", "browser use", "interact", "click", "fill form", "navigate", "operate website", "screenshot", "window"],
  },
  web: {
    label: "web research and URL retrieval",
    keywords: ["web", "internet", "online", "search", "url", "latest", "news", "source"],
  },
  code: {
    label: "LSP, diagnostics, symbols, AST and structural code analysis",
    keywords: ["lsp", "diagnostic", "symbol", "ast", "structural", "definition", "reference", "module", "analyze"],
  },
  mcp: {
    label: "configured MCP servers and external service tools",
    keywords: ["mcp", "trello", "revenuecat", "external service", "connector", "server tool"],
  },
};

export function initialState(): ControlState {
  return { version: 1, todos: [], nextId: 1, routeMode: "auto", activeGroups: [] };
}

export function copyState(state: ControlState): ControlState {
  return {
    ...state,
    todos: state.todos.map((todo) => ({ ...todo, blockedBy: [...todo.blockedBy] })),
    activeGroups: [...state.activeGroups],
  };
}

export function isControlState(value: unknown): value is ControlState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ControlState>;
  return (
    state.version === 1 &&
    Array.isArray(state.todos) &&
    Number.isInteger(state.nextId) &&
    (state.routeMode === "auto" || state.routeMode === "off") &&
    Array.isArray(state.activeGroups)
  );
}

export function normalizePriority(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(3, Math.trunc(value)));
}

export function assertDependencies(todos: TodoItem[], id: string, dependencies: string[]): void {
  const unique = new Set(dependencies);
  if (unique.size !== dependencies.length) throw new Error("blockedBy contains duplicate IDs");
  if (unique.has(id)) throw new Error(`Todo ${id} cannot depend on itself`);
  const ids = new Set(todos.map((todo) => todo.id));
  for (const dependency of dependencies) {
    if (!ids.has(dependency)) throw new Error(`Dependency ${dependency} does not exist`);
  }

  const graph = new Map(todos.map((todo) => [todo.id, [...todo.blockedBy]]));
  graph.set(id, [...dependencies]);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) throw new Error(`Dependency cycle includes ${node}`);
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node);
}

export function readyTodos(todos: TodoItem[]): TodoItem[] {
  const complete = new Set(todos.filter((todo) => todo.status === "completed").map((todo) => todo.id));
  return todos
    .filter(
      (todo) =>
        (todo.status === "pending" || todo.status === "in_progress") &&
        todo.blockedBy.every((dependency) => complete.has(dependency)),
    )
    .sort((a, b) => b.priority - a.priority || Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

export function incompleteDependencies(todos: TodoItem[], todo: TodoItem): string[] {
  const complete = new Set(todos.filter((item) => item.status === "completed").map((item) => item.id));
  return todo.blockedBy.filter((dependency) => !complete.has(dependency));
}

export function shortlistGroups(query: string): SpecialistGroup[] {
  const normalized = query.toLowerCase();
  return (Object.entries(SPECIALIST_GROUPS) as Array<[
    SpecialistGroup,
    (typeof SPECIALIST_GROUPS)[SpecialistGroup],
  ]>)
    .filter(([, group]) => group.keywords.some((keyword) => normalized.includes(keyword)))
    .map(([name]) => name);
}

export function requiredSpecialistGroups(query: string): SpecialistGroup[] {
  return /\b(?:cua_repl_(?:js|reset)|cua_browser_(?:group|page)|cua[ -]driver|browser(?: tab)? group|chrome(?: tab)? group)\b/i.test(query) ||
    /\b(?:browse|open|inspect|read)\b.{0,60}\b(?:reddit|r\/[a-z0-9_]+|chrome)\b/i.test(query)
    ? ["computer"]
    : [];
}

export function specialistGroupForTool(name: string, source: string): SpecialistGroup | undefined {
  const value = `${name} ${source}`.toLowerCase();
  if (name.startsWith("jev-android_") || value.includes("jev-android-automator")) return "android";
  if (name === "jev_choose_action" || name === "cua_repl_js" || name === "cua_repl_reset" || name === "cua_browser_group" || name === "cua_browser_page" || name.startsWith("cua-driver_") || value.includes("cua-driver") || value.includes("cua-runtime")) return "computer";
  if (value.includes("pi-web-access") || ["web_search", "fetch_content", "source_check", "get_search_content"].includes(name)) {
    return "web";
  }
  if (value.includes("pi-lens")) return "code";
  if (value.includes("pi-mcp-adapter") || name === "mcp" || name.startsWith("mcp_")) return "mcp";
  return undefined;
}

export function isSpecialistGroup(value: string): value is SpecialistGroup {
  return Object.hasOwn(SPECIALIST_GROUPS, value);
}
