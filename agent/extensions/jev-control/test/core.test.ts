import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDependencies,
  initialState,
  isJevDisabled,
  readyTodos,
  requiredSpecialistGroups,
  routeTarget,
  shortlistGroups,
  specialistGroupForTool,
  type TodoItem,
} from "../src/core.js";

const todo = (id: string, overrides: Partial<TodoItem> = {}): TodoItem => ({
  id,
  title: id,
  status: "pending",
  priority: 1,
  blockedBy: [],
  ...overrides,
});

test("initial state enables routing without specialist groups", () => {
  assert.deepEqual(initialState(), {
    version: 1,
    todos: [],
    nextId: 1,
    routeMode: "auto",
    activeGroups: [],
  });
});

test("Jev can be disabled explicitly for the whole configuration", () => {
  assert.equal(isJevDisabled("1"), true);
  assert.equal(isJevDisabled("true"), true);
  assert.equal(isJevDisabled("YES"), true);
  assert.equal(isJevDisabled("0"), false);
  assert.equal(isJevDisabled(undefined), false);
});

test("dependencies reject missing IDs, self references and cycles", () => {
  const todos = [todo("T1"), todo("T2", { blockedBy: ["T1"] })];
  assert.throws(() => assertDependencies(todos, "T1", ["missing"]), /does not exist/);
  assert.throws(() => assertDependencies(todos, "T1", ["T1"]), /itself/);
  assert.throws(() => assertDependencies(todos, "T1", ["T2"]), /cycle/);
});

test("ready todos require completed dependencies and use deterministic priority order", () => {
  const todos = [
    todo("T1", { status: "completed" }),
    todo("T2", { priority: 3, blockedBy: ["T1"] }),
    todo("T3", { priority: 2, blockedBy: ["T4"] }),
    todo("T4", { status: "blocked" }),
    todo("T5", { priority: 3 }),
  ];
  assert.deepEqual(
    readyTodos(todos).map((item) => item.id),
    ["T2", "T5"],
  );
});

test("tool shortlist keeps computer use separate from web research", () => {
  assert.deepEqual(shortlistGroups("Use browser automation to click and fill form controls"), ["computer"]);
  assert.deepEqual(shortlistGroups("Use computer use to operate a desktop app"), ["computer"]);
  assert.deepEqual(shortlistGroups("Search the latest docs, then inspect LSP diagnostics"), ["web", "code"]);
  assert.deepEqual(shortlistGroups("Build the APK and test it in an Android emulator"), ["android"]);
  assert.deepEqual(shortlistGroups("Ask the user to choose an option"), []);
  assert.deepEqual(shortlistGroups("ordinary local edit"), []);
});

test("explicit Cua and Chrome group requests require the computer specialist", () => {
  assert.deepEqual(requiredSpecialistGroups("Use cua_browser_group to open a tab"), ["computer"]);
  assert.deepEqual(requiredSpecialistGroups("Use cua_browser_page to inspect a tab"), ["computer"]);
  assert.deepEqual(requiredSpecialistGroups("Create a named background Chrome tab group"), ["computer"]);
  assert.deepEqual(requiredSpecialistGroups("Use Cua Driver to inspect a window"), ["computer"]);
  assert.deepEqual(requiredSpecialistGroups("Browse Reddit r/silksong and read 10 posts"), ["computer"]);
  assert.deepEqual(requiredSpecialistGroups("Search web documentation"), []);
});

test("existing version-one state accepts new specialist groups without invalidating older state", () => {
  const state = initialState();
  state.activeGroups = ["android", "computer", "web"];
  assert.deepEqual(state.activeGroups, ["android", "computer", "web"]);
});

test("computer and Android MCP direct tools are isolated from the general MCP group", () => {
  assert.equal(specialistGroupForTool("jev-android_android_run_goal", "pi-mcp-adapter"), "android");
  assert.equal(specialistGroupForTool("mcp", "pi-mcp-adapter"), "mcp");
  assert.equal(specialistGroupForTool("cua-driver_list_apps", "pi-mcp-adapter"), "computer");
  assert.equal(specialistGroupForTool("cua-driver_browser_navigate", "pi-mcp-adapter"), "computer");
  assert.equal(specialistGroupForTool("jev_choose_action", "local jev-control"), "computer");
  assert.equal(specialistGroupForTool("cua_browser_group", "local jev-control"), "computer");
  assert.equal(specialistGroupForTool("cua_browser_page", "local jev-control"), "computer");
  assert.equal(specialistGroupForTool("cua_repl_js", "local cua-runtime"), "computer");
});

test("all routing tiers map to the configured Luna/Sol effort ladder", () => {
  assert.deepEqual(routeTarget("easy"), { id: "gpt-5.6-luna", thinking: "low" });
  assert.deepEqual(routeTarget("easy", true), { id: "gpt-5.6-sol", thinking: "low" });
  assert.deepEqual(routeTarget("routine"), { id: "gpt-5.6-sol", thinking: "low" });
  assert.deepEqual(routeTarget("demanding"), { id: "gpt-5.6-sol", thinking: "medium" });
  assert.deepEqual(routeTarget("hard"), { id: "gpt-5.6-sol", thinking: "high" });
});
