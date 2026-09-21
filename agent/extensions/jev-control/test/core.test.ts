import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDependencies,
  initialState,
  readyTodos,
  routeTarget,
  shortlistGroups,
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

test("tool shortlist may select multiple independent specialist groups", () => {
  assert.deepEqual(shortlistGroups("Search the latest docs, then inspect LSP diagnostics"), ["web", "code"]);
  assert.deepEqual(shortlistGroups("Ask the user to choose an option"), []);
  assert.deepEqual(shortlistGroups("ordinary local edit"), []);
});

test("all routing tiers map to the configured Luna/Sol effort ladder", () => {
  assert.deepEqual(routeTarget("easy"), { id: "gpt-5.6-luna", thinking: "low" });
  assert.deepEqual(routeTarget("routine"), { id: "gpt-5.6-sol", thinking: "low" });
  assert.deepEqual(routeTarget("demanding"), { id: "gpt-5.6-sol", thinking: "medium" });
  assert.deepEqual(routeTarget("hard"), { id: "gpt-5.6-sol", thinking: "high" });
});
