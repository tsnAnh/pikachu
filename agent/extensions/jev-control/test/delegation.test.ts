import assert from "node:assert/strict";
import test from "node:test";
import { resolveDelegationTools } from "../src/delegation.js";

test("auto prefers Herdr and otherwise uses subagents", () => {
  assert.deepEqual(resolveDelegationTools("auto", new Set(["herdr", "subagent"])), { tools: ["herdr"] });
  assert.deepEqual(resolveDelegationTools("auto", new Set(["subagent"])), { tools: ["subagent"] });
});

test("explicit unavailable Herdr falls back without hiding subagents", () => {
  assert.deepEqual(resolveDelegationTools("herdr", new Set(["subagent"])), {
    tools: ["subagent"],
    fallback: "Herdr is unavailable; using subagents.",
  });
});

test("both exposes exactly the available delegation tools", () => {
  assert.deepEqual(resolveDelegationTools("both", new Set(["herdr", "subagent", "bash"])), {
    tools: ["herdr", "subagent"],
    fallback: undefined,
  });
});
